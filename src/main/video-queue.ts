import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AppPaths, BackendStatus, VideoJob } from '../shared/types';
import type { VideoDraft, VideoHistoryRecord, VideoWorkflowContract } from '../shared/video-types';
import { planVideo, videoDraftSchema } from '../shared/video-plan';
import { parseVideoContract } from '../shared/video-history';
import { videoOutputCandidates } from '../shared/video-output';
import { bindVideoWorkflow, buildVideoWorkflow, safeVideoRelativeFilename } from '../shared/video-workflow';
import type { RuntimeIdentitySnapshot } from '../shared/runtime-identity';
import type { VideoAssetsService } from './video-assets';
import type { SourceImageService } from './source-images';
import type { VideoHistoryService } from './video-history';
import { VIDEO_MEDIA_LIMITS } from './video-media';
import { VIDEO_PLAYBACK_FIXTURE_ID } from './video-playback-fixture';
import { containedPath, validateRuntimePaths } from './runtime-config';

export interface VideoPrepared {
  schema: 2;
  kind: 'video';
  jobId: string;
  preparedAt: string;
  contract: VideoWorkflowContract;
}
export interface VideoQueueContext {
  kind: 'video';
  prepared: VideoPrepared;
  startedAt?: number;
  cancelRequested?: boolean;
  finalization?: {
    createdAt: string;
    outputs: unknown;
    terminalStatus: 'completed' | 'cancelled' | 'failed';
    error?: string;
    elapsedMs?: number;
  };
}
interface Engine {
  status(): BackendStatus;
  getUrl(): string | null;
  getRuntimeIdentity(): RuntimeIdentitySnapshot | undefined;
}
export interface VideoQueueOptions {
  /** True on 24 GB class cards with "Use extra graphics memory" on. */
  bigCard(): boolean;
  blockedReason?(): string | undefined;
  objectInfo?(address: string, signal: AbortSignal): Promise<Record<string, unknown>>;
}
const id = z
  .string()
  .regex(/^[a-f0-9]{32}$/)
  .refine(value => value !== VIDEO_PLAYBACK_FIXTURE_ID, 'The playback diagnostic ID is reserved.');
const finalizationSchema = z
  .object({
    createdAt: z.string().datetime(),
    outputs: z.unknown(),
    terminalStatus: z.enum(['completed', 'cancelled', 'failed']),
    error: z.string().max(16384).optional(),
    elapsedMs: z.number().int().nonnegative().optional(),
  })
  .strict();
const contextSchema = z
  .object({
    kind: z.literal('video'),
    prepared: z
      .object({
        schema: z.literal(2),
        kind: z.literal('video'),
        jobId: id,
        preparedAt: z.string().datetime(),
        contract: z.unknown(),
      })
      .strict(),
    startedAt: z.number().finite().nonnegative().optional(),
    cancelRequested: z.boolean().optional(),
    finalization: finalizationSchema.optional(),
  })
  .strict();

function engineAddress(address: string | null) {
  if (!address) throw new Error('Start the engine first.');
  const url = new URL(address);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port)
    throw new Error('Video only runs on Latent’s own engine.');
  return url.origin;
}
async function readObjectInfo(address: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${address}/object_info`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
    redirect: 'error',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`The engine didn’t answer (HTTP ${response.status}).`);
  const value = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The engine sent back nonsense.');
  return value as Record<string, unknown>;
}

/** Turns a draft into a ready-to-send engine graph and saves finished clips. JobService owns the queue itself. */
export class VideoQueueService {
  constructor(
    private paths: AppPaths,
    private assets: Pick<VideoAssetsService, 'bindings'>,
    private sources: Pick<SourceImageService, 'resolve'>,
    private engine: Engine,
    private history: Pick<VideoHistoryService, 'finalize'>,
    private options: VideoQueueOptions,
  ) {}
  async prepare(
    draft: VideoDraft,
    jobId: string,
    actualSeed: string,
    signal?: AbortSignal,
  ): Promise<VideoQueueContext> {
    signal?.throwIfAborted();
    id.parse(jobId);
    const parsed = videoDraftSchema.parse(structuredClone(draft)) as VideoDraft;
    const blocked = this.options.blockedReason?.();
    if (blocked) throw new Error(blocked);
    validateRuntimePaths(this.paths);
    if (this.engine.status().state !== 'ready') throw new Error('Start the engine first.');
    const address = engineAddress(this.engine.getUrl());
    const bindings = this.assets.bindings(parsed.profile);
    const ids = [
      ...new Set([parsed.firstFrame?.sourceId, parsed.lastFrame?.sourceId].filter((value): value is string => !!value)),
    ];
    const sources = [];
    const sourceFilenames: Record<string, string> = {};
    for (const sourceId of ids) {
      const resolved = await this.sources.resolve(sourceId);
      const filename = containedPath(this.paths.inputs, resolved.normalizedPath);
      sources.push(resolved.source);
      sourceFilenames[sourceId] = safeVideoRelativeFilename(
        path.relative(this.paths.inputs, filename).replaceAll('\\', '/'),
        '.png',
      );
    }
    const plan = planVideo(parsed, { actualSeed, sources, bigCard: this.options.bigCard() });
    const built = buildVideoWorkflow(
      {
        plan,
        jobId,
        sourceFilenames,
        globalSage: this.engine.getRuntimeIdentity()?.data.launch.sageAttention === true,
      },
      bindings,
    );
    const objects = await (this.options.objectInfo ?? readObjectInfo)(address, signal ?? new AbortController().signal);
    const contract = bindVideoWorkflow(built, objects);
    return {
      kind: 'video',
      prepared: { schema: 2, kind: 'video', jobId, preparedAt: new Date().toISOString(), contract },
    };
  }
  private outputs(context: VideoQueueContext, outputs: unknown, terminalStatus: 'completed' | 'cancelled' | 'failed') {
    const candidates = videoOutputCandidates(outputs, context.prepared.contract);
    if (terminalStatus === 'completed' && candidates.length !== 1)
      throw new Error('The engine finished without writing the clip.');
    return candidates;
  }
  validate(job: VideoJob, input: unknown): VideoQueueContext {
    let context: VideoQueueContext;
    try {
      context = contextSchema.parse(structuredClone(input)) as VideoQueueContext;
      context.prepared.contract = parseVideoContract(context.prepared.contract, job.id);
    } catch {
      throw new Error('This video was queued by an older version of Latent. Make it again from the Video page.');
    }
    id.parse(job.id);
    if (
      job.kind !== 'video' ||
      context.prepared.jobId !== job.id ||
      context.prepared.contract.plan.actualSeed !== job.actualSeed
    )
      throw new Error('The queued video doesn’t match its saved settings.');
    if (context.finalization) this.outputs(context, context.finalization.outputs, context.finalization.terminalStatus);
    return context;
  }
  /** Right before sending, rebuild against the engine as it is now (it may have restarted). */
  async revalidate(job: VideoJob, input: VideoQueueContext, signal?: AbortSignal): Promise<VideoQueueContext> {
    const context = this.validate(job, input);
    if (context.finalization) throw new Error('This clip already finished. Retry saving it instead.');
    const fresh = await this.prepare(context.prepared.contract.plan.draft, job.id, job.actualSeed, signal);
    return { ...context, prepared: fresh.prepared };
  }
  assertSubmission(job: VideoJob, input: VideoQueueContext, signal?: AbortSignal): void {
    const context = this.validate(job, input);
    signal?.throwIfAborted();
    if (context.finalization) throw new Error('This clip already finished. It can’t be sent again.');
    if (this.engine.status().state !== 'ready') throw new Error('The engine stopped. Start it and retry.');
  }
  completedOutputs(
    job: VideoJob,
    input: VideoQueueContext,
    outputs: unknown,
    terminalStatus: 'completed' | 'cancelled' | 'failed',
    error?: string,
  ): VideoQueueContext {
    const context = this.validate(job, input);
    this.outputs(context, outputs, terminalStatus);
    const receipt = finalizationSchema.parse({
      createdAt: context.finalization?.createdAt ?? new Date().toISOString(),
      outputs: structuredClone(outputs),
      terminalStatus,
      ...(error === undefined ? {} : { error }),
      ...(context.finalization?.elapsedMs !== undefined
        ? { elapsedMs: context.finalization.elapsedMs }
        : context.startedAt
          ? { elapsedMs: Math.max(0, Math.round(Date.now() - context.startedAt)) }
          : {}),
    });
    if (context.finalization && !isDeepStrictEqual(context.finalization, receipt))
      throw new Error('The finished clip’s details changed. The original was kept.');
    context.finalization = receipt;
    return context;
  }
  async recoverOutputs(job: VideoJob, input: VideoQueueContext): Promise<unknown> {
    const context = this.validate(job, input);
    validateRuntimePaths(this.paths);
    const pattern = new RegExp(`^${context.prepared.contract.output.filenamePrefix}_[0-9]{5,10}_\\.mp4$`);
    const candidates: string[] = [];
    const directory = await fs.opendir(this.paths.outputs);
    for await (const entry of directory) {
      if (!pattern.test(entry.name)) continue;
      candidates.push(entry.name);
      if (candidates.length > 1) throw new Error('Found more than one file for this clip. All were kept.');
      const stat = await fs.lstat(path.join(this.paths.outputs, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > VIDEO_MEDIA_LIMITS.maxBytes)
        throw new Error('The clip file looks wrong. It was kept as is.');
    }
    return candidates.length
      ? { '15': { images: [{ filename: candidates[0], subfolder: '', type: 'output' }], animated: [true] } }
      : {};
  }
  async finalize(job: VideoJob, input: VideoQueueContext, signal?: AbortSignal): Promise<VideoHistoryRecord> {
    const context = this.validate(job, input);
    signal?.throwIfAborted();
    if (!context.finalization) throw new Error('The clip hasn’t finished yet.');
    if (this.outputs(context, context.finalization.outputs, context.finalization.terminalStatus).length !== 1)
      throw new Error('There’s no finished clip to save.');
    return this.history.finalize(
      {
        jobId: job.id,
        createdAt: context.finalization.createdAt,
        title: context.prepared.contract.plan.draft.prompt.trim().slice(0, 160) || 'Untitled clip',
        contract: context.prepared.contract,
        outputs: context.finalization.outputs,
        evidenceKind: 'generated',
        ...(job.promptId ? { promptId: job.promptId } : {}),
        ...(context.finalization.elapsedMs !== undefined ? { elapsedMs: context.finalization.elapsedMs } : {}),
      },
      signal,
    );
  }
}

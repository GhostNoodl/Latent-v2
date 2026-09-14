import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AppPaths, VideoJob } from '../shared/types';
import type { VideoDraft, VideoHistoryRecord } from '../shared/video-types';
import { videoDraftSchema } from '../shared/video-plan';
import { parseVideoHistoryContract } from '../shared/video-history';
import { videoOutputCandidates } from '../shared/video-output';
import { canonicalRuntimeJson, runtimeIdentitySchema } from '../shared/runtime-identity';
import { VIDEO_RUNTIME_CANDIDATE, validateVideoRuntime, type VideoPreparedExecution, type VideoPreflightService } from './video-preflight';
import type { VideoHistoryService } from './video-history';
import { VIDEO_MEDIA_LIMITS } from './video-media';
import { VIDEO_PLAYBACK_FIXTURE_ID } from './video-playback-fixture';
import { validateRuntimePaths } from './runtime-config';

export interface VideoQueueContext {
  kind: 'video'; prepared: VideoPreparedExecution; startedAt?: number; cancelRequested?: boolean;
  finalization?: { createdAt: string; outputs: unknown; terminalStatus: 'completed' | 'cancelled' | 'failed'; error?: string };
}
const id = z.string().regex(/^[a-f0-9]{32}$/).refine(value => value !== VIDEO_PLAYBACK_FIXTURE_ID, 'The playback diagnostic ID is reserved.');
const preparedSchema = z.object({ schema: z.literal(1), kind: z.literal('video'), candidateId: z.literal(VIDEO_RUNTIME_CANDIDATE.id), jobId: id,
  preparedAt: z.string().datetime(), contract: z.unknown(), runtimeIdentity: runtimeIdentitySchema,
  authorizationRecordId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), capabilitiesSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const finalizationSchema = z.object({ createdAt: z.string().datetime(), outputs: z.unknown(), terminalStatus: z.enum(['completed', 'cancelled', 'failed']), error: z.string().max(16384).optional() }).strict();
const contextSchema = z.object({ kind: z.literal('video'), prepared: preparedSchema, startedAt: z.number().finite().nonnegative().optional(), cancelRequested: z.boolean().optional(), finalization: finalizationSchema.optional() }).strict();

/** Video-only queue operations. JobService owns all scheduling, submission and durable transitions. */
export class VideoQueueService {
  constructor(private paths: AppPaths, private preflight: Pick<VideoPreflightService, 'prepare' | 'revalidate' | 'assertCurrent'>, private history: Pick<VideoHistoryService, 'finalize'>) {}
  async prepare(draft: VideoDraft, jobId: string, actualSeed: string, signal?: AbortSignal): Promise<VideoQueueContext> {
    signal?.throwIfAborted();
    const prepared = await this.preflight.prepare({ draft: structuredClone(draft), jobId, actualSeed }, signal);
    const plan = prepared.contract.plan;
    return this.validate({ kind: 'video', id: jobId, video: draft, actualSeed, frames: plan.frames, durationSeconds: plan.durationSeconds } as VideoJob, { kind: 'video', prepared });
  }
  private outputs(context: VideoQueueContext, outputs: unknown, terminalStatus: 'completed' | 'cancelled' | 'failed') {
    if (!outputs || typeof outputs !== 'object' || Array.isArray(outputs) || Object.keys(outputs).some(key => key !== '15')) throw new Error('The video returned unexpected output nodes. Its original outputs were preserved.');
    const candidates = videoOutputCandidates(outputs, context.prepared.contract);
    if (terminalStatus === 'completed' && candidates.length !== 1) throw new Error('The completed video must have exactly one owned output.');
    return candidates;
  }
  validate(job: VideoJob, input: unknown): VideoQueueContext {
    const context = contextSchema.parse(structuredClone(input)) as VideoQueueContext;
    id.parse(job.id); const draft = videoDraftSchema.parse(job.video);
    if (job.kind !== 'video' || !draft.prompt.trim()) throw new Error('The queued video draft is invalid.');
    const prepared = context.prepared; prepared.contract = parseVideoHistoryContract(prepared.contract, job.id); validateVideoRuntime(prepared.runtimeIdentity);
    const plan = prepared.contract.plan;
    if (prepared.jobId !== job.id || canonicalRuntimeJson(JSON.parse(JSON.stringify(plan.draft))) !== canonicalRuntimeJson(JSON.parse(JSON.stringify(draft))) || plan.actualSeed !== job.actualSeed || plan.frames !== job.frames || plan.durationSeconds !== job.durationSeconds) throw new Error('The queued video differs from its frozen execution plan.');
    if (context.finalization) this.outputs(context, context.finalization.outputs, context.finalization.terminalStatus);
    return context;
  }
  async revalidate(job: VideoJob, input: VideoQueueContext, signal?: AbortSignal): Promise<VideoQueueContext> {
    const context = this.validate(job, input); signal?.throwIfAborted();
    if (context.finalization) throw new Error('A video with frozen outputs can only retry finalization, not generation.');
    context.prepared = await this.preflight.revalidate(context.prepared, signal);
    return this.validate(job, context);
  }
  assertSubmission(job: VideoJob, input: VideoQueueContext, signal?: AbortSignal): void {
    const context = this.validate(job, input); signal?.throwIfAborted();
    if (context.finalization) throw new Error('A video with frozen outputs cannot be submitted again.');
    this.preflight.assertCurrent(context.prepared, signal);
  }
  completedOutputs(job: VideoJob, input: VideoQueueContext, outputs: unknown, terminalStatus: 'completed' | 'cancelled' | 'failed', error?: string): VideoQueueContext {
    const context = this.validate(job, input); this.outputs(context, outputs, terminalStatus);
    const receipt = finalizationSchema.parse({ createdAt: context.finalization?.createdAt ?? new Date().toISOString(), outputs: structuredClone(outputs), terminalStatus, ...(error === undefined ? {} : { error }) });
    if (context.finalization && !isDeepStrictEqual(context.finalization, receipt)) throw new Error('The frozen video finalization receipt changed. Its original receipt must be retained.');
    context.finalization = receipt; return context;
  }
  async recoverOutputs(job: VideoJob, input: VideoQueueContext): Promise<unknown> {
    const context = this.validate(job, input); validateRuntimePaths(this.paths);
    const pattern = new RegExp(`^${context.prepared.contract.output.filenamePrefix}_[0-9]{5,10}_\\.mp4$`);
    const candidates: string[] = []; const directory = await fs.opendir(this.paths.outputs);
    for await (const entry of directory) {
      if (!pattern.test(entry.name)) continue;
      candidates.push(entry.name);
      if (candidates.length > 1) throw new Error('Multiple owned video outputs need review. Every file was preserved.');
      const stat = await fs.lstat(path.join(this.paths.outputs, entry.name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > VIDEO_MEDIA_LIMITS.maxBytes) throw new Error('The recovered video is not an independent bounded file. Its original path was preserved.');
    }
    validateRuntimePaths(this.paths);
    return candidates.length ? { '15': { images: [{ filename: candidates[0], subfolder: '', type: 'output' }], animated: [true] } } : {};
  }
  async finalize(job: VideoJob, input: VideoQueueContext, signal?: AbortSignal): Promise<VideoHistoryRecord> {
    const context = this.validate(job, input); signal?.throwIfAborted();
    if (!context.finalization) throw new Error('Persist the video output receipt before finalization.');
    if (this.outputs(context, context.finalization.outputs, context.finalization.terminalStatus).length !== 1) throw new Error('There is no owned video output to finalize.');
    const promptId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).parse(job.promptId);
    return this.history.finalize({ jobId: job.id, createdAt: context.finalization.createdAt, title: context.prepared.contract.plan.draft.prompt.trim().slice(0, 160),
      contract: context.prepared.contract, outputs: context.finalization.outputs, evidenceKind: 'generated', promptId,
      runtimeIdentity: context.prepared.runtimeIdentity, eligibilityRecordId: context.prepared.authorizationRecordId }, signal);
  }
}

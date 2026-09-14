import { z } from 'zod';
import { canonicalRuntimeJson, runtimeIdentitySchema } from './runtime-identity';
import { videoDraftSchema } from './video-plan';
import { buildVideoWorkflow } from './video-workflow';
import type { SourceImageAsset } from './source-types';
import type { VideoHistoryRecord, VideoWorkflowContract } from './video-types';

export interface VideoHistorySnapshot { records: VideoHistoryRecord[]; warnings: string[]; }
const id = z.string().regex(/^[a-f0-9]{32}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const source = z.object({
  sourceId: z.string().regex(/^src_[0-9a-f-]{36}$/), sha256: hash, role: z.enum(['first', 'last']),
  originalWidth: z.number().int().positive().max(8192), originalHeight: z.number().int().positive().max(8192),
  targetWidth: z.number().int(), targetHeight: z.number().int(), resize: z.enum(['stretch', 'center-crop']),
  algorithm: z.literal('comfy-lanczos'), originGenerationId: id.optional(),
}).strict();
const node = z.object({ class_type: z.string().min(1).max(80), inputs: z.record(z.string(), z.unknown()) }).strict();
const envelope = z.object({ schema: z.literal(1), plan: z.object({ draft: videoDraftSchema, actualSeed: z.string().max(16), sources: z.array(source).max(2) }).passthrough(), workflow: z.record(z.string(), node), output: z.unknown(), verifiedSourceFilenames: z.array(z.string().max(512)).max(2) }).strict();

/** Validate the entire versioned frozen graph, including source transforms and pins.
 * This checks a receipt's internal consistency; it does not establish execution or eligibility. */
export function parseVideoHistoryContract(value: unknown, jobId: string): VideoWorkflowContract {
  id.parse(jobId);
  const data = envelope.parse(value);
  const sources = new Map<string, SourceImageAsset>();
  const sourceFilenames: Record<string, string> = {};
  const graph = structuredClone(data.workflow);
  const filename = (nodeId: string, field: string) => {
    const value = graph[nodeId]?.inputs[field];
    if (typeof value !== 'string') throw new Error('The video receipt is missing a frozen file binding.');
    const normalized = value.replaceAll('\\', '/'); graph[nodeId].inputs[field] = normalized; return normalized;
  };
  for (const item of data.plan.sources) {
    const descriptor = { id: item.sourceId, normalized: { sha256: item.sha256, mimeType: 'image/png', width: item.originalWidth, height: item.originalHeight }, ...(item.originGenerationId ? { originGenerationId: item.originGenerationId } : {}) } as SourceImageAsset;
    const existing = sources.get(item.sourceId);
    if (existing && canonicalRuntimeJson(existing) !== canonicalRuntimeJson(descriptor)) throw new Error('The saved video source identities conflict.');
    sources.set(item.sourceId, descriptor);
    const selectedFilename = filename(item.role === 'first' ? '20' : '22', 'image');
    if (sourceFilenames[item.sourceId] && sourceFilenames[item.sourceId] !== selectedFilename) throw new Error('The saved video source bindings conflict.');
    sourceFilenames[item.sourceId] = selectedFilename;
  }
  const assets = z.array(z.object({ role: z.enum(['diffusion', 'encoder', 'videoVae', 'audioVae', 'turbo']), sha256: hash, bytes: z.number().int().positive() }).passthrough()).max(5).parse(data.plan.assets);
  const slots = { diffusion: ['1', 'unet_name'], encoder: ['2', 'clip_name'], videoVae: ['3', 'vae_name'], audioVae: ['4', 'vae_name'], turbo: ['16', 'lora_name'] } as const;
  const bindings = assets.map(asset => {
    const slot = slots[asset.role];
    // Silent H3 plans still pin the joint AV asset set; no audio loader is emitted.
    const name = asset.role === 'audioVae' && data.plan.draft.audio === 'none'
      ? z.string().parse(asset.filename).replaceAll('\\', '/') : filename(slot[0], slot[1]);
    return { role: asset.role, bytes: asset.bytes, sha256: asset.sha256, filename: name };
  });
  const expected = buildVideoWorkflow({ draft: data.plan.draft, actualSeed: data.plan.actualSeed, sources: [...sources.values()], sourceFilenames, jobId }, bindings);
  if (canonicalRuntimeJson(expected) !== canonicalRuntimeJson({ ...data, workflow: graph })) throw new Error('The video receipt differs from its frozen workflow version or source plan.');
  // Retain the submitted engine's exact filename spelling, including Windows separators.
  return structuredClone(value) as VideoWorkflowContract;
}

export const storedVideoHistorySchema = z.object({
  schema: z.literal(1), kind: z.literal('video'), id, jobId: id, createdAt: z.string().datetime(),
  evidenceKind: z.enum(['generated', 'synthetic-fixture']), title: z.string().min(1).max(160),
  relativeFilename: z.string().regex(/^Latent_[a-f0-9]{32}_video_[0-9]{5,10}_\.mp4$/),
  contract: z.custom<VideoWorkflowContract>(),
  media: z.object({
    schema: z.literal(1), mimeType: z.literal('video/mp4'), bytes: z.number().int().positive().max(512 * 1024 * 1024), sha256: hash,
    width: z.number().int().positive().max(2048), height: z.number().int().positive().max(2048), frames: z.number().int().positive().max(400),
    fps: z.object({ numerator: z.number().int().positive(), denominator: z.number().int().positive() }).strict(),
    durationSeconds: z.number().finite().positive().max(17), videoCodec: z.literal('h264'), pixelFormat: z.string().min(1).max(32),
    audio: z.array(z.object({ codec: z.literal('aac'), channels: z.number().int().min(1).max(2), sampleRate: z.number().int().min(8000).max(96000), durationSeconds: z.number().finite().min(0).max(17.25) }).strict()).max(1),
    inspection: z.object({ tool: z.literal('PyAV'), version: z.string().min(1).max(32), decodedFrames: z.number().int().positive().max(400), complete: z.literal(true) }).strict(),
  }).strict(),
  promptId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional(), runtimeIdentity: runtimeIdentitySchema.optional(),
  eligibilityRecordId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.id !== value.jobId || !value.relativeFilename.startsWith(`Latent_${value.jobId}_video_`)) ctx.addIssue({ code: 'custom', message: 'The video record and output ownership do not match.' });
  if (value.evidenceKind === 'generated' && (!value.promptId || !value.runtimeIdentity || !value.eligibilityRecordId)) ctx.addIssue({ code: 'custom', message: 'Generated video needs submitted prompt, runtime and eligibility provenance.' });
});
export type StoredVideoHistoryRecord = z.infer<typeof storedVideoHistorySchema>;

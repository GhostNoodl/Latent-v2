import { z } from 'zod';
import type { VideoHistoryRecord, VideoWorkflowContract } from './video-types';
import { videoDraftObjectSchema } from './video-plan';

export interface VideoHistorySnapshot {
  records: VideoHistoryRecord[];
  warnings: string[];
}
const id = z.string().regex(/^[a-f0-9]{32}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const node = z.object({ class_type: z.string().min(1).max(80), inputs: z.record(z.string(), z.unknown()) }).strict();

/** Shape check for a saved clip's recipe. The recipe is kept as it was run, so it isn't rebuilt here. */
export const videoContractSchema = z
  .object({
    schema: z.literal(2),
    plan: z
      .object({
        schema: z.literal(2),
        draft: videoDraftObjectSchema,
        actualSeed: z.string().regex(/^(0|[1-9][0-9]{0,15})$/),
        frames: z.number().int().positive().max(400),
        durationSeconds: z.number().finite().positive().max(17),
        width: z.number().int().positive().max(2048),
        height: z.number().int().positive().max(2048),
      })
      .passthrough(),
    workflow: z.record(z.string(), node),
    output: z
      .object({
        nodeId: z.literal('15'),
        filenamePrefix: z.string().regex(/^Latent_[a-f0-9]{32}_video$/),
        extension: z.literal('.mp4'),
      })
      .strict(),
    sourceFilenames: z.array(z.string().max(512)).max(2),
  })
  .strict();
export function parseVideoContract(value: unknown, jobId: string): VideoWorkflowContract {
  id.parse(jobId);
  const contract = videoContractSchema.parse(value) as unknown as VideoWorkflowContract;
  if (contract.output.filenamePrefix !== `Latent_${jobId}_video`)
    throw new Error('The saved clip belongs to a different job.');
  return structuredClone(contract);
}

export const storedVideoHistorySchema = z
  .object({
    schema: z.literal(2),
    kind: z.literal('video'),
    id,
    jobId: id,
    createdAt: z.string().datetime(),
    evidenceKind: z.enum(['generated', 'synthetic-fixture']),
    title: z.string().min(1).max(160),
    relativeFilename: z.string().regex(/^Latent_[a-f0-9]{32}_video_[0-9]{5,10}_\.mp4$/),
    contract: z.custom<VideoWorkflowContract>(),
    elapsedMs: z.number().int().nonnegative().optional(),
    media: z
      .object({
        schema: z.literal(1),
        mimeType: z.literal('video/mp4'),
        bytes: z
          .number()
          .int()
          .positive()
          .max(512 * 1024 * 1024),
        sha256: hash,
        width: z.number().int().positive().max(4096),
        height: z.number().int().positive().max(4096),
        frames: z.number().int().positive().max(2000),
        fps: z.object({ numerator: z.number().int().positive(), denominator: z.number().int().positive() }).strict(),
        durationSeconds: z.number().finite().positive().max(120),
        videoCodec: z.string().min(1).max(32),
        pixelFormat: z.string().min(1).max(32),
        audio: z
          .array(
            z
              .object({
                codec: z.string().min(1).max(32),
                channels: z.number().int().min(1).max(8),
                sampleRate: z.number().int().min(8000).max(192000),
                durationSeconds: z.number().finite().min(0).max(120).nullable(),
              })
              .strict(),
          )
          .max(2),
        inspection: z
          .object({
            tool: z.literal('PyAV'),
            version: z.string().min(1).max(32),
            decodedFrames: z.number().int().positive().max(2000),
            complete: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    promptId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.id !== value.jobId || !value.relativeFilename.startsWith(`Latent_${value.jobId}_video_`))
      ctx.addIssue({ code: 'custom', message: 'The clip record and its file don’t match.' });
  });
export type StoredVideoHistoryRecord = z.infer<typeof storedVideoHistorySchema>;

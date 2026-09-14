import { z } from 'zod';
import { cropInpaintPlanSchema } from './crop-inpaint-types';
import type { SourceMaskAsset } from './source-types';

export const FACE_DETAILER_LIMITS = Object.freeze({ maxPixels: 4194304, maxSide: 8192, maxFaces: 4, workingSide: 512, maxCandidates: 128 });
export const FACE_PROFILE_LABELS = { anime: 'Anime / manga · LBP', photographic: 'Photographic · YuNet' } as const;
export type FaceDetectorProfile = keyof typeof FACE_PROFILE_LABELS;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const faceDetectionRequestSchema = z.object({
  sourceId: z.string().regex(/^src_[0-9a-f-]{36}$/), sourceSha256: hash,
  profile: z.enum(['anime', 'photographic']), maxFaces: z.number().int().min(1).max(4),
  confidence: z.number().finite().min(0.1).max(0.99), expansion: z.number().finite().min(0).max(0.5), feather: z.number().int().min(0).max(32),
}).strict();
export type FaceDetectionRequest = z.infer<typeof faceDetectionRequestSchema>;
export interface FaceBox { x: number; y: number; width: number; height: number; }
export interface FaceLandmark { x: number; y: number; }
export interface DetectedFace {
  id: string; box: FaceBox; score?: number; landmarks?: FaceLandmark[];
  mask: SourceMaskAsset;
  maskGeometry: { version: 'expanded-ellipse-inward-smoothstep@1'; expansion: number; feather: number; bounds: FaceBox; selectedPixels: number };
}
export interface FaceDetectionReceipt {
  version: 'face-detection@1'; id: string; createdAt: string;
  request: FaceDetectionRequest; source: { id: string; sha256: string; width: number; height: number; originGenerationId?: string };
  detector: { profile: FaceDetectorProfile; modelSha256: string; codeRevision: string; opencv: '4.13.0'; wheelSha256: string; workerSha256: string; device: 'cpu' };
  preprocessing: { version: 'opencv-area-bgr-multiscale@1'; frames: Array<{ width: number; height: number; scaleX: number; scaleY: number }>; nmsIoU: 0.3; animeMinNeighbors: 5; animeMinSize: 24 };
  faces: DetectedFace[]; candidateCount: number; omittedCount: number; durationMs: number;
}
export interface FaceDetailerStatus {
  state: 'not-installed' | 'installing' | 'ready' | 'detecting' | 'error'; message: string;
  device: 'cpu'; experimental: true; installProgress?: number; logTail: string[];
}
/** Main resolves the saved receipt and face IDs; renderer coordinates are never accepted. */
export const faceRefinementRequestSchema = z.object({
  detectionId: z.string().uuid(), faceIds: z.array(z.string().uuid()).min(1).max(4),
  denoise: z.number().finite().min(0).max(1), contextPadding: z.number().int().min(0).max(512),
  seed: z.string().max(32).refine(value => value === 'random' || /^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), 'Use random or an integer seed between 0 and 9007199254740991.'),
}).strict().refine(value => new Set(value.faceIds).size === value.faceIds.length, 'Select each detected face once.');
export type FaceRefinementRequest = z.infer<typeof faceRefinementRequestSchema>;

const seed = z.string().max(32).regex(/^\d+$/).refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
export const faceRefinementPlanSchema = z.object({
  version: z.literal('sdxl-face-refinement@1'), detectionId: z.string().uuid(),
  source: z.object({ id: z.string().regex(/^src_[0-9a-f-]{36}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192), originGenerationId: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict(),
  passes: z.array(z.object({ faceId: z.string().uuid(), seed, crop: cropInpaintPlanSchema }).strict()).min(1).max(4),
  inputSequence: z.literal('previous-composite-in-original-coordinates'), preservation: z.literal('original-zero-union-mask-pixels-and-alpha'),
}).strict().superRefine((plan, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  if (plan.source.width * plan.source.height > 4194304) fail('Face refinement supports source canvases up to 4 megapixels.');
  if (new Set(plan.passes.map(pass => pass.faceId)).size !== plan.passes.length || new Set(plan.passes.map(pass => pass.crop.mask.id)).size !== plan.passes.length) fail('Each face and mask must appear once in a refinement plan.');
  for (const pass of plan.passes) if (pass.crop.source.id !== plan.source.id || pass.crop.source.sha256 !== plan.source.sha256 || pass.crop.source.width !== plan.source.width || pass.crop.source.height !== plan.source.height || pass.crop.working.width !== 512 || pass.crop.working.height !== 512 || pass.crop.settings.mode !== 'refine') fail('Face passes require the original source, 512 square working crops, and refine mode.');
});
export type FaceRefinementPlan = z.infer<typeof faceRefinementPlanSchema>;

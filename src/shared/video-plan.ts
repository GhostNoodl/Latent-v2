import { z } from 'zod';
import type { SourceImageAsset } from './source-types';
import type {
  VideoAssetIdentity,
  VideoAvailability,
  VideoDraft,
  VideoPlan,
  VideoSourceTransform,
  VideoSpeed,
} from './video-types';

const sourceReferenceSchema = z
  .object({
    sourceId: z.string().regex(/^src_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const DEFAULT_VIDEO_SPEED: Readonly<VideoSpeed> = Object.freeze({
  textOnGpu: 'auto',
  attention: 'sage',
  finish: 'quick',
});
export const videoSpeedSchema = z
  .object({
    textOnGpu: z.enum(['auto', 'on', 'off']).catch('auto'),
    attention: z.enum(['normal', 'sage', 'sage-sol']).catch('sage'),
    finish: z.enum(['quick', 'low-memory']).catch('quick'),
  })
  .strict();
/** The largest picture area H3 is made for (768 × 1344 either way round). */
export const VIDEO_MAX_AREA = 768 * 1344;
const draftShape = {
  schema: z.literal(2),
  provider: z.literal('local-minimax-h3'),
  mode: z.enum(['txt2vid', 'img2vid']),
  prompt: z
    .string()
    .max(8000)
    .refine(value => !value.includes('\0'), 'The prompt contains a null character.'),
  width: z.number().int().min(32).max(2048).multipleOf(32),
  height: z.number().int().min(32).max(2048).multipleOf(32),
  requestedDurationSeconds: z.number().finite().min(5).max(15),
  seed: z
    .string()
    .refine(
      value =>
        value === 'random' ||
        (/^(0|[1-9][0-9]{0,15})$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)),
      'Use random or a whole number seed.',
    ),
  profile: z.enum(['base', 'turbo8', 'fused4']),
  audio: z.enum(['none', 'stereo-candidate']),
  speed: videoSpeedSchema,
  firstFrame: sourceReferenceSchema.optional(),
  lastFrame: sourceReferenceSchema.optional(),
  resize: z.enum(['stretch', 'center-crop']),
};
/** Drafts saved before the rebuild (schema 1) move over with the same choices. */
export function upgradeVideoDraft(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const draft = value as Record<string, unknown>;
  if (draft.schema !== 1) return value;
  const { attention, decodeMode, ...rest } = draft;
  return {
    ...rest,
    schema: 2,
    speed: {
      ...DEFAULT_VIDEO_SPEED,
      ...(attention === 'sage-auto' ? { attention: 'sage' } : attention === 'default' ? { attention: 'normal' } : {}),
      ...(decodeMode === 'tiled' ? { finish: 'low-memory' } : {}),
    },
  };
}
export const videoDraftObjectSchema = z.object(draftShape).strict();
export const videoDraftSchema = z.preprocess(
  upgradeVideoDraft,
  videoDraftObjectSchema.superRefine((value, ctx) => {
    if (value.width * value.height > VIDEO_MAX_AREA)
      ctx.addIssue({
        code: 'custom',
        path: ['width'],
        message: 'That size is too big for H3. Keep it within 768 × 1344.',
      });
    if (value.mode === 'txt2vid' && (value.firstFrame || value.lastFrame))
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'Text to video can’t use frames. Clear them or pick Image.',
      });
  }),
);
export const DEFAULT_VIDEO_DRAFT: Readonly<VideoDraft> = Object.freeze({
  schema: 2,
  provider: 'local-minimax-h3',
  mode: 'txt2vid',
  prompt: '',
  width: 832,
  height: 480,
  requestedDurationSeconds: 5,
  seed: 'random',
  profile: 'fused4',
  audio: 'none',
  speed: { ...DEFAULT_VIDEO_SPEED },
  resize: 'center-crop',
});
const repository = 'Comfy-Org/MiniMax-H3';
const revision = '4cc1d817b6184899b41293954329f576cb5ae86b';
const asset = (role: VideoAssetIdentity['role'], filename: string, bytes: number, sha256: string): VideoAssetIdentity =>
  Object.freeze({
    role,
    filename,
    bytes,
    sha256,
    repository,
    revision,
    sourceUrl: `https://huggingface.co/${repository}/resolve/${revision}/${filename}`,
  });
/** Candidate identities only. This registry does not confer rights, download, or imply local availability. */
export const H3_VIDEO_CANDIDATE_ASSETS = Object.freeze([
  asset(
    'diffusion',
    'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors',
    20970379616,
    'e889202c41dafb67b10d67b97f0d8541508036a6090af23425a5c2615d03c47a',
  ),
  asset(
    'encoder',
    'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    15687142551,
    '35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6',
  ),
  asset(
    'videoVae',
    'vae/minimax_h3_video_vae_fp16.safetensors',
    5207808496,
    '7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522',
  ),
  asset(
    'audioVae',
    'vae/minimax_h3_audio_vae_fp32.safetensors',
    605254808,
    '8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48',
  ),
  asset(
    'turbo',
    'loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors',
    1956193000,
    '2339acdf19bfe123f46b971ea35d367a84adb85de43627e1eceafa5a5b2b111e',
  ),
]);
export const H3_FUSED_DIFFUSION: Readonly<VideoAssetIdentity> = Object.freeze({
  role: 'diffusion',
  filename: 'diffusion_models/minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors',
  bytes: 20980178976,
  sha256: '4262e4e9963c553fa00016bbe83961407a4fc0a888be95fd836c8d4f2304e48b',
  repository: 'MATLOWAI/minimax-h3-fused-turbo-int8-convrot',
  revision: '8a8dffaa0cd99c6184833ae0a3b4e9b0089c17b3',
  sourceUrl:
    'https://huggingface.co/MATLOWAI/minimax-h3-fused-turbo-int8-convrot/resolve/8a8dffaa0cd99c6184833ae0a3b4e9b0089c17b3/diffusion_models/minimax_h3_fused_refdelta_r1024_turbo8_mystic07_int8_convrot.safetensors',
});
export const H3_ALL_VIDEO_ASSETS = Object.freeze([...H3_VIDEO_CANDIDATE_ASSETS, H3_FUSED_DIFFUSION]);
export function videoProfileAssets(profile: VideoDraft['profile']): VideoAssetIdentity[] {
  if (!['base', 'turbo8', 'fused4'].includes(profile)) throw new Error('Choose a supported video profile.');
  return H3_VIDEO_CANDIDATE_ASSETS.filter(item => item.role !== 'turbo' || profile === 'turbo8').map(item =>
    profile === 'fused4' && item.role === 'diffusion' ? H3_FUSED_DIFFUSION : item,
  );
}
export const VIDEO_AVAILABILITY: Readonly<VideoAvailability> = Object.freeze({
  phase: 'assets-missing',
  canAcquire: true,
  canGenerate: false,
  message: 'Get the video files to start making clips.',
  licenseUrl: 'https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/42ed227ee7df40d41602854ae760620d6eb651fe/LICENSE',
  baseBytes: H3_VIDEO_CANDIDATE_ASSETS.filter(item => item.role !== 'turbo').reduce((sum, item) => sum + item.bytes, 0),
  withTurboBytes: H3_VIDEO_CANDIDATE_ASSETS.reduce((sum, item) => sum + item.bytes, 0),
});
function roundHalfEven(value: number) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  return fraction < 0.5 ? floor : fraction > 0.5 ? floor + 1 : floor % 2 === 0 ? floor : floor + 1;
}
/** Matches the pinned template's Python round followed by the native upward frame grid. */
export function resolveVideoDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 15)
    throw new Error('Choose a candidate duration between 5 and 15 seconds.');
  const requestedFrames = Math.max(5, roundHalfEven(seconds * 24));
  const frames = 5 + Math.ceil((requestedFrames - 5) / 17) * 17;
  return { frames, fps: { numerator: 24 as const, denominator: 1 as const }, durationSeconds: frames / 24 };
}
export const VIDEO_STEPS = { fused4: 4, turbo8: 8, base: 20 } as const;
/** Whether the prompt reader runs on the graphics card for this draft. */
/** Auto reads the prompt on the GPU on big cards, and always for Fast (its encoder fits and CPU takes over a minute). */
export function textOnGpu(speed: VideoSpeed, bigCard: boolean, profile?: VideoDraft['profile']): boolean {
  return speed.textOnGpu === 'on' || (speed.textOnGpu === 'auto' && (bigCard || profile === 'fused4'));
}
export function planVideo(
  input: VideoDraft,
  options: { actualSeed: string; sources: readonly SourceImageAsset[]; bigCard?: boolean },
): VideoPlan {
  const draft = videoDraftSchema.parse(input) as VideoDraft;
  if (!draft.prompt.trim()) throw new Error('Describe the video first.');
  if (
    !/^(0|[1-9][0-9]{0,15})$/.test(options.actualSeed) ||
    BigInt(options.actualSeed) > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error('The clip needs a whole number seed.');
  if (draft.seed !== 'random' && draft.seed !== options.actualSeed) throw new Error('The seed changed. Try again.');
  if (draft.mode === 'img2vid' && !draft.firstFrame && !draft.lastFrame)
    throw new Error('Pick a first frame, a last frame, or both.');
  const sources: VideoSourceTransform[] = [];
  for (const role of ['first', 'last'] as const) {
    const selected = role === 'first' ? draft.firstFrame : draft.lastFrame;
    if (!selected) continue;
    const source = options.sources.find(item => item.id === selected.sourceId);
    if (!source || source.normalized.sha256 !== selected.sha256)
      throw new Error(`The ${role} frame is missing or changed. Pick it again.`);
    const { width, height } = source.normalized;
    sources.push({
      ...selected,
      role,
      originalWidth: width,
      originalHeight: height,
      targetWidth: draft.width,
      targetHeight: draft.height,
      resize: draft.resize,
      algorithm: 'comfy-lanczos',
      ...(source.originGenerationId ? { originGenerationId: source.originGenerationId } : {}),
    });
  }
  return {
    schema: 2,
    draft: structuredClone(draft),
    actualSeed: options.actualSeed,
    ...resolveVideoDuration(draft.requestedDurationSeconds),
    width: draft.width,
    height: draft.height,
    sources,
    sampling: {
      steps: VIDEO_STEPS[draft.profile],
      sampler: 'res_multistep',
      scheduler: 'simple',
      textEncoderDevice: textOnGpu(draft.speed, options.bigCard === true, draft.profile) ? 'default' : 'cpu',
      attention: draft.speed.attention,
    },
    decode:
      draft.speed.finish === 'quick'
        ? { tiled: false }
        : { tiled: true, tileSize: 512, overlap: 64, temporalSize: 64, temporalOverlap: 8 },
    encoding: { container: 'mp4', codec: 'h264', audio: draft.audio },
    assets: structuredClone(videoProfileAssets(draft.profile)),
  };
}

import type { ComfyWorkflow } from './types';
import type { VideoAssetsStatus } from './video-assets';

export interface VideoSourceReference {
  sourceId: string;
  sha256: string;
}
/** How the engine runs the clip. Every choice is optional so older saved drafts keep working. */
export interface VideoSpeed {
  /** Read the prompt on the graphics card ("on"), on the processor ("off"), or let the card size decide. */
  textOnGpu: 'auto' | 'on' | 'off';
  attention: 'normal' | 'sage' | 'sage-sol';
  /** quick = one-pass decode, low-memory = tiled decode. */
  finish: 'quick' | 'low-memory';
}
export interface VideoDraft {
  schema: 2;
  mode: 'txt2vid' | 'img2vid';
  provider: 'local-minimax-h3';
  prompt: string;
  width: number;
  height: number;
  requestedDurationSeconds: number;
  seed: string;
  /** fused4 = Fast (4 steps), turbo8 = Better (8 steps), base = Best (20 steps). */
  profile: 'base' | 'turbo8' | 'fused4';
  audio: 'none' | 'stereo-candidate';
  speed: VideoSpeed;
  firstFrame?: VideoSourceReference;
  lastFrame?: VideoSourceReference;
  resize: 'stretch' | 'center-crop';
}
export interface VideoAvailability {
  assets?: VideoAssetsStatus;
  phase: 'assets-missing' | 'runtime-unavailable' | 'ready';
  canAcquire: boolean;
  canGenerate: boolean;
  message: string;
  licenseUrl: string;
  baseBytes: number;
  withTurboBytes: number;
  /** Graphics card has room for the roomier defaults (24 GB class). */
  bigCard?: boolean;
  /** The Sol add-on is installed in the engine. */
  solInstalled?: boolean;
}
export interface VideoSourceTransform extends VideoSourceReference {
  role: 'first' | 'last';
  originalWidth: number;
  originalHeight: number;
  targetWidth: number;
  targetHeight: number;
  resize: VideoDraft['resize'];
  algorithm: 'comfy-lanczos';
  originGenerationId?: string;
}
export interface VideoAssetIdentity {
  role: 'diffusion' | 'encoder' | 'videoVae' | 'audioVae' | 'turbo';
  filename: string;
  bytes: number;
  sha256: string;
  repository: string;
  revision: string;
  sourceUrl: string;
}
export interface VideoPlan {
  schema: 2;
  draft: VideoDraft;
  actualSeed: string;
  frames: number;
  fps: { numerator: 24; denominator: 1 };
  durationSeconds: number;
  width: number;
  height: number;
  sources: VideoSourceTransform[];
  sampling: {
    steps: 20 | 8 | 4;
    sampler: 'res_multistep';
    scheduler: 'simple';
    textEncoderDevice: 'cpu' | 'default';
    attention: VideoSpeed['attention'];
  };
  decode: { tiled: true; tileSize: 512; overlap: 64; temporalSize: 64; temporalOverlap: 8 } | { tiled: false };
  encoding: { container: 'mp4'; codec: 'h264'; audio: VideoDraft['audio'] };
  assets: VideoAssetIdentity[];
}
export interface VideoWorkflowContract {
  schema: 2;
  plan: VideoPlan;
  workflow: ComfyWorkflow;
  output: {
    nodeId: '15';
    filenamePrefix: string;
    extension: '.mp4';
  };
  sourceFilenames: string[];
}
export interface VideoMediaInfo {
  schema: 1;
  mimeType: 'video/mp4';
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  frames: number;
  fps: { numerator: number; denominator: number };
  durationSeconds: number;
  videoCodec: string;
  pixelFormat: string;
  audio: Array<{ codec: string; channels: number; sampleRate: number; durationSeconds: number | null }>;
  inspection: { tool: 'PyAV'; version: string; decodedFrames: number; complete: true };
}
export interface VideoHistoryRecord {
  schema: 2;
  kind: 'video';
  id: string;
  jobId: string;
  createdAt: string;
  promptId?: string;
  evidenceKind: 'generated' | 'synthetic-fixture';
  plan?: VideoPlan;
  /** Wall-clock time from submit to finished, when known. */
  elapsedMs?: number;
  media: VideoMediaInfo;
  mediaUrl: string;
  thumbnailUrl?: string;
  title: string;
}

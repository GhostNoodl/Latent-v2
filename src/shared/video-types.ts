import type { RuntimeIdentitySnapshot } from './runtime-identity';
import type { ComfyWorkflow } from './types';
import type { VideoAssetsStatus } from './video-assets';

export interface VideoSourceReference { sourceId: string; sha256: string; }
export interface VideoDraft {
  schema: 1; mode: 'txt2vid' | 'img2vid'; provider: 'local-minimax-h3'; prompt: string;
  width: number; height: number; requestedDurationSeconds: number; seed: string;
  profile: 'base' | 'turbo8' | 'fused4'; attention?: 'default' | 'sage-auto'; decodeMode?: 'tiled' | 'auto'; audio: 'none' | 'stereo-candidate';
  firstFrame?: VideoSourceReference; lastFrame?: VideoSourceReference; resize: 'stretch' | 'center-crop';
}
export interface VideoAvailability {
  assets?: VideoAssetsStatus;
  phase: 'eligibility-unresolved' | 'assets-missing' | 'runtime-unavailable' | 'experimental-ready'; canAcquire: boolean; canGenerate: boolean;
  message: string; hardwareEvidence: 'not-measured'; licenseUrl: string; baseBytes: number; withTurboBytes: number;
}
export interface VideoSourceTransform extends VideoSourceReference {
  role: 'first' | 'last'; originalWidth: number; originalHeight: number; targetWidth: number; targetHeight: number;
  resize: VideoDraft['resize']; algorithm: 'comfy-lanczos'; originGenerationId?: string;
}
export interface VideoAssetIdentity {
  role: 'diffusion' | 'encoder' | 'videoVae' | 'audioVae' | 'turbo'; filename: string; bytes: number; sha256: string;
  repository: string; revision: string; sourceUrl: string;
}
export interface VideoPlan {
  schema: 1; workflowVersion: 'minimax-h3-fl2va-int8@1' | 'minimax-h3-fused-int8@1'; executionStatus: 'planning-only'; draft: VideoDraft;
  actualSeed: string; frames: number; fps: { numerator: 24; denominator: 1 }; durationSeconds: number;
  width: number; height: number; sources: VideoSourceTransform[];
  sampling: { steps: 20 | 8 | 4; sampler: 'res_multistep'; scheduler: 'simple'; guidance: 'distilled-basic'; denoise: 1; textEncoderDevice: 'cpu' | 'default'; turboStrength?: 1 };
  decode: { tiled: true; tileSize: 512; overlap: 64; temporalSize: 64; temporalOverlap: 8 } | { tiled: false };
  encoding: { container: 'mp4'; codec: 'h264'; bitDepth: 8; colorSpace: 'sRGB'; audio: VideoDraft['audio'] };
  assets: VideoAssetIdentity[]; baselineComfyCommit: string; limitations: string[];
}
export interface VideoWorkflowContract {
  schema: 1; plan: VideoPlan; workflow: ComfyWorkflow;
  output: { nodeId: '15'; filenamePrefix: string; extension: '.mp4'; expectedCount: 1; historyKey: 'images'; animated: true };
  verifiedSourceFilenames: string[];
}
export interface VideoMediaInfo {
  schema: 1; mimeType: 'video/mp4'; bytes: number; sha256: string;
  width: number; height: number; frames: number; fps: { numerator: number; denominator: number };
  durationSeconds: number; videoCodec: string; pixelFormat: string; audio: Array<{ codec: string; channels: number; sampleRate: number; durationSeconds: number | null }>;
  inspection: { tool: 'PyAV'; version: string; decodedFrames: number; complete: true };
}
export interface VideoHistoryRecord {
  schema: 1; kind: 'video'; id: string; jobId: string; createdAt: string; promptId?: string;
  evidenceKind: 'generated' | 'synthetic-fixture'; plan?: VideoPlan; runtimeIdentity?: RuntimeIdentitySnapshot;
  media: VideoMediaInfo; mediaUrl: string; thumbnailUrl?: string; title: string;
}

/** Future executor must share the existing image queue; no executor is supplied by this foundation. */
export interface VideoExecutionContext {
  schema: 1; kind: 'video'; jobId: string; contract: VideoWorkflowContract;
  runtimeIdentity: RuntimeIdentitySnapshot; eligibilityRecordId: string;
  state: 'queued' | 'running' | 'finalizing' | 'completed' | 'cancelled' | 'failed';
  promptId?: string; recordId?: string;
}

import type { ComfyWorkflow } from './types';
export interface ReviewedUpscalerAsset {
  id: 'realesrgan-anime-6b-x4';
  name: string;
  filename: 'RealESRGAN_x4plus_anime_6B.pth';
  bytes: number;
  sha256: string;
  scale: 4;
  inputChannels: 3;
  outputChannels: 3;
  architecture: 'ESRGAN';
  status: 'ready';
  loaderPolicy: 'pinned-publisher-weights-only';
  provenance: { repository: string; revision: string; version: string; sourceUrl: string; licenseName: 'BSD-3-Clause'; licenseUrl: string };
  verifiedAt: string;
  validation: { pythonVersion: string; torchVersion: string; spandrelVersion: string; parameters: number; device: 'cpu' };
}
export interface UpscalerStatus {
  state: 'not-installed' | 'installing' | 'ready' | 'error';
  message: string;
  installProgress?: number;
  asset?: ReviewedUpscalerAsset;
}
export interface UpscaleSettings { mode: 'resize' | 'learned'; width: number; height: number; resize: 'stretch' | 'center-crop'; }
export interface UpscaleWorkflowInput { sourceFilename: string; sourceWidth: number; sourceHeight: number; jobId: string; settings: UpscaleSettings; }
export interface HiresFixSettings {
  workflowVersion?: 'sdxl-hires-latent@1' | 'sdxl-hires-latent@2';
  method: 'latent' | 'image';
  interpolation?: 'nearest-exact' | 'bilinear' | 'area' | 'bicubic';
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  denoise: number;
  seed: string;
}
export interface AdvancedImageOutput { nodeId: string; role: 'base' | 'final'; width: number; height: number; batchSize: number; filenamePrefix: string; }
export interface AdvancedSamplingPass {
  role: 'base' | 'refine';
  nodeId: string | null;
  enabled: boolean;
  width: number;
  height: number;
  seed: string;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  denoise: number;
}
export interface AdvancedImagePlan {
  workflow: ComfyWorkflow;
  workflowVersion: string;
  outputs: AdvancedImageOutput[];
  passes: AdvancedSamplingPass[];
  expectedOutputCount: number;
  upscaler?: ReviewedUpscalerAsset;
  hires?: HiresFixSettings;
}

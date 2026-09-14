import { z } from 'zod';
import type { ComfyWorkflow } from './types';
import type { SourceImageAsset } from './source-types';

export interface ReviewedControlNetAsset {
  id: 'xinsir-union-sdxl-1'; name: string; filename: 'xinsir-union-sdxl-1.0.safetensors';
  bytes: number; sha256: string; status: 'ready'; family: 'sdxl'; architecture: 'union-sdxl';
  loaderPolicy: 'pinned-publisher-safetensors';
  provenance: { repository: 'xinsir/controlnet-union-sdxl-1.0'; revision: string; sourceUrl: string; modelCardUrl: string; licenseName: 'Apache-2.0'; licenseUrl: string };
  verifiedAt: string;
  validation: { format: 'safetensors'; tensorCount: number; headerBytes: number; dtypes: string[]; parameters: string; architecture: 'union-sdxl' };
}
export interface ControlNetStatus { state: 'not-installed' | 'installing' | 'ready' | 'error'; message: string; installProgress?: number; asset?: ReviewedControlNetAsset; }
export interface ControlNetSettings {
  kind: 'canny' | 'depth' | 'lineart' | 'pose'; sourceId: string; sourceSha256: string; resize: 'stretch' | 'center-crop';
  strength: number; startPercent: number; endPercent: number; lowThreshold: number; highThreshold: number;
}
export interface ControlMapOutput { nodeId: string; role: 'control-map'; kind: 'canny' | 'depth' | 'lineart' | 'pose'; filenamePrefix: string; width: number; height: number; batchSize: 1; }
export interface ControlNetPlan {
  workflow: ComfyWorkflow; workflowVersion: 'sdxl-canny-controlnet@1' | 'sdxl-prepared-controlnet@1'; settings: ControlNetSettings;
  source: SourceImageAsset; asset: ReviewedControlNetAsset; controlMap: ControlMapOutput;
  samplingNodeId: '5'; applied: boolean;
}
/** Populate only after the output PNG has been safely read/hashed by the main process. */
export interface RetainedControlMap { filename: string; sha256: string; bytes: number; width: number; height: number; nodeId: string; }

export const controlNetSettingsSchema = z.object({ kind: z.enum(['canny', 'depth', 'lineart', 'pose']), sourceId: z.string().regex(/^src_[a-f0-9-]{36}$/), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), resize: z.enum(['stretch', 'center-crop']), strength: z.number().finite().min(0).max(2), startPercent: z.number().finite().min(0).max(1), endPercent: z.number().finite().min(0).max(1), lowThreshold: z.number().finite().min(0.01).max(0.99), highThreshold: z.number().finite().min(0.01).max(0.99) }).strict().refine(value => value.startPercent < value.endPercent, 'Control start must be before control end.').refine(value => value.kind !== 'canny' || value.lowThreshold < value.highThreshold, 'Canny low threshold must be below high threshold.');

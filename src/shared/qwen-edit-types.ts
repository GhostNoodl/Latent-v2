import { z } from 'zod';
import type { ComfyWorkflow } from './types';
import type { SourceImageAsset } from './source-types';
export type QwenEditProfile = 'base' | 'fast';
export const qwenEditWorkflowVersionSchema = z.enum(['qwen-image-edit-2511-int8@1', 'qwen-image-edit-2511-int8@2']);
export type QwenEditWorkflowVersion = z.infer<typeof qwenEditWorkflowVersionSchema>;
export type QwenEditAssetRole = 'diffusion' | 'encoder' | 'vae' | 'lightning';
/** Renderer-safe publisher identities; acquisition additionally verifies tensor-header pins. */
export const QWEN_EDIT_IDENTITIES = Object.freeze({
  diffusion: { filename: 'qwen-edit-2511/qwen_image_edit_2511_int8_convrot.safetensors', directory: 'diffusion_models', bytes: 20499083824, sha256: '11b5af5ac601821d73930c84846c9a158e67177356daf927ce1c8d10f3963829' },
  encoder: { filename: 'qwen-edit-2511/qwen_2.5_vl_7b_fp8_scaled.safetensors', directory: 'text_encoders', bytes: 9384670680, sha256: 'cb5636d852a0ea6a9075ab1bef496c0db7aef13c02350571e388aea959c5c0b4' },
  vae: { filename: 'qwen-edit-2511/qwen_image_vae.safetensors', directory: 'vae', bytes: 253806246, sha256: 'a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f' },
  lightning: { filename: 'qwen-edit-2511/Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', directory: 'qwen-edit-loras', bytes: 849608296, sha256: '22226e8d05d354bb356627d428809f5afd7819399b077238a2b70a82883a904f' },
});
export interface QwenEditAsset {
  role: QwenEditAssetRole; filename: string; directory: 'diffusion_models' | 'text_encoders' | 'vae' | 'qwen-edit-loras';
  bytes: number; sha256: string; format: 'safetensors'; status: 'ready';
  provenance: { repository: string; revision: string; sourceFile: string; sourceUrl: string; modelCardUrl: string; licenseName: 'Apache-2.0'; licenseUrl: string };
  validation: { headerBytes: number; headerSha256: string; tensorCount: number; dtypes: string[] };
  verifiedAt: string;
}
export interface QwenEditBundle {
  id: 'qwen-edit-2511-native-int8'; profile: QwenEditProfile;
  assets: { diffusion: QwenEditAsset; encoder: QwenEditAsset; vae: QwenEditAsset; lightning?: QwenEditAsset };
  totalBytes: number; verifiedAt: string;
  runtime: { route: 'native-int8-convrot'; comfySourceCommit: string; comfyVersion: string; torchVersion: string; comfyKitchenVersion: string; customNodes: []; cpuTextEncoder: true; memoryStatus: 'unverified-16gb' };
}
export interface QwenEditAssetsStatus {
  state: 'not-installed' | 'installing' | 'ready' | 'error'; message: string;
  baseBytes: number; fastBytes: number; baseReady: boolean; fastReady: boolean;
  installedRoles: QwenEditAssetRole[]; profile?: QwenEditProfile; activeRole?: QwenEditAssetRole;
  installProgress?: number; bundle?: QwenEditBundle;
  verification?: {
    state: 'verifying' | 'complete' | 'error' | 'cancelled'; profile: QwenEditProfile; role?: QwenEditAssetRole;
    completedBytes: number; totalBytes: number; hashedBytes: number; cachedBytes: number; progress: number;
    startedAt: string; finishedAt?: string; message: string;
  };
}
export const qwenEditSettingsSchema = z.object({ profile: z.enum(['base', 'fast']), width: z.number().int().min(256).max(1024).multipleOf(16), height: z.number().int().min(256).max(1024).multipleOf(16), seed: z.string().regex(/^\d+$/).refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)), resize: z.enum(['stretch', 'center-crop']), steps: z.number().int().min(1).max(60).optional(), guidance: z.number().finite().min(1).max(8).optional() }).strict().refine(value => value.profile !== 'fast' || (value.steps === undefined || value.steps === 4) && (value.guidance === undefined || value.guidance === 1), 'The fast profile uses its reviewed four-step, CFG 1 recipe.');
export type QwenEditSettings = z.infer<typeof qwenEditSettingsSchema>;
export const qwenEditJobRequestSchema = z.object({
  mode: z.literal('qwen-edit'), sourceId: z.string().regex(/^src_[a-f0-9-]{36}$/), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  instruction: z.string().min(1).max(4000).refine(value => value.trim().length > 0 && !value.includes('\0')), negativePrompt: z.string().max(4000).refine(value => !value.includes('\0')).optional(),
  settings: qwenEditSettingsSchema.safeExtend({ width: z.number().int().min(256).max(1024).multipleOf(64), height: z.number().int().min(256).max(1024).multipleOf(64), seed: z.string().refine(value => value === 'random' || /^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)) }),
  lineage: z.object({ conversationId: z.uuid(), branchId: z.uuid(), parentRecordId: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict(),
  assetHashes: z.object({ diffusion: z.string().regex(/^[a-f0-9]{64}$/), encoder: z.string().regex(/^[a-f0-9]{64}$/), vae: z.string().regex(/^[a-f0-9]{64}$/), lightning: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict().optional(),
  workflowVersion: qwenEditWorkflowVersionSchema.optional(),
}).strict();
export type QwenEditJobRequest = z.infer<typeof qwenEditJobRequestSchema>;
export interface QwenEditRecord { plan: QwenEditWorkflowPlan; lineage: QwenEditJobRequest['lineage'] & { version: number }; }
export interface QwenEditWorkflowInput { source: SourceImageAsset; sourceFilename: string; instruction: string; negativePrompt?: string; jobId: string; settings: QwenEditSettings; workflowVersion?: QwenEditWorkflowVersion; }
export interface QwenEditWorkflowPlan {
  workflow: ComfyWorkflow; workflowVersion: QwenEditWorkflowVersion; bundle: QwenEditBundle;
  source: SourceImageAsset; instruction: string; negativePrompt: string;
  settings: QwenEditSettings & { steps: number; guidance: number };
  sampler: { nodeId: string; name: 'euler'; scheduler: 'simple'; denoise: 1; modelShift: 3.1; cfgNorm: 1; textEncoderDevice: 'cpu' };
  output: { nodeId: '7'; filenamePrefix: string; width: number; height: number; batchSize: 1 };
  expectedOutputCount: 1;
  /** Absent only on exact legacy @1 recipes. */
  canvas?: { sourceFitting: { width: number; height: number; mode: QwenEditSettings['resize'] }; inference: { width: number; height: number }; reference: { width: number; height: number }; output: { width: number; height: number; method: 'lanczos' } };
}

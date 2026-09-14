import { z } from 'zod';
import type { AppSettings, GenerationDraft, ModelAsset } from './types';
import type { RuntimeIdentitySnapshot } from './runtime-identity';
import type { SourceImageAsset, SourceMaskAsset } from './source-types';
export const HARDWARE_DEFAULT_POLICY = 'latent-hardware-defaults@1' as const;
export interface HardwareGpu { index: number; uuid: string; name: string; vramMiB: number; driver: string; }
export interface HardwareInventory {
  observedAt: string; os: string; arch: string; ramBytes: number; gpus: HardwareGpu[];
  detection: 'nvidia' | 'unavailable' | 'ambiguous'; messages: string[];
  activeDevice?: { type: 'cuda' | 'cpu' | 'other'; index?: number; name: string; vramBytes?: number };
  selectedGpu?: HardwareGpu; runtimeIdentity?: RuntimeIdentitySnapshot; fingerprint: string;
}
export interface HardwareBackendPolicy {
  version: typeof HARDWARE_DEFAULT_POLICY; actual: AppSettings['deviceMode']; suggested?: AppSettings['deviceMode'];
  origin: 'saved-setting' | 'clean-install-policy'; applyOnCleanInstall: boolean; explanation: string; restartRequired: boolean;
}
export interface HardwareProfileEvidence {
  recordId?: string; observedAt?: string; receipt: string; workflowVersion: string; runtimeIdentitySha256?: string;
  durationMs?: number; durationScope?: string; cache: 'not-a-repeat' | 'unknown' | 'cached';
  memory?: { observedMiB: number; scope: 'single-whole-device-sample' | 'sampled-whole-device-maximum'; sampleIntervalMs?: number; sampleCount?: number };
  quality?: string; limitations: string[];
}
export interface HardwareProfile {
  id: string; title: string; workflow: 'txt2img' | 'crop-inpaint' | 'resize' | 'learned-upscale' | 'qwen-edit';
  description: string; tradeoffs: string[]; storageBytes: number; evidence?: HardwareProfileEvidence;
  expectedCheckpointSha256?: string; expectedLoras?: Array<{ sha256: string; weight: number; clipWeight: number }>;
  settings: { width: number; height: number; steps?: number; cfg?: number; sampler?: string; scheduler?: string; batchSize: 1; denoise?: number; contextPadding?: number };
}
export interface HardwareProfileRecommendation { profile: HardwareProfile; state: 'observed' | 'partial-benchmark' | 'unmeasured' | 'stale'; reasons: string[]; applicable: boolean; changedFields: string[]; }
export interface HardwareRecommendationReport { id: string; createdAt: string; inventoryFingerprint: string; draftSha256: string; backend: HardwareBackendPolicy; recommendations: HardwareProfileRecommendation[]; explanation: string; }
export interface HardwareProfilesStatus { state: 'not-checked' | 'refreshing' | 'ready' | 'error'; message: string; inventory?: HardwareInventory; backend?: HardwareBackendPolicy; report?: HardwareRecommendationReport; }
export interface HardwareProfileApplication { profileId: string; originalDraft: GenerationDraft; proposedDraft: GenerationDraft; changedFields: string[]; explanation: string; }
export interface HardwareOomAdvice { recognized: boolean; title: string; steps: string[]; suggestedProfileId?: string; changesApplied: false; }
export interface HardwareProfilesHooks {
  getRuntimeIdentity(): RuntimeIdentitySnapshot | undefined;
  getBackendUrl(): string | null;
  getSettings(): AppSettings;
  getModels(): readonly ModelAsset[];
  getSource?(id: string): Promise<SourceImageAsset>;
  getMask?(id: string): Promise<SourceMaskAsset>;
  isUpscalerReady?(): boolean;
}
export const hardwareProfileApplySchema = z.object({ reportId: z.uuid(), profileId: z.string().regex(/^[a-z0-9-]{1,80}$/) }).strict();
export const telemetrySampleSchema = z.object({ at: z.iso.datetime(), memoryMiB: z.number().finite().min(0).max(1024 * 1024), utilizationPercent: z.number().finite().min(0).max(100) }).strict();
export interface HardwareTelemetry { startedAt: string; endedAt: string; gpuUuid: string; requestedIntervalMs: number; samples: z.infer<typeof telemetrySampleSchema>[]; observedMaxMiB?: number; errors: number; limitReached: boolean; scope: 'sampled-whole-device'; instantaneousPeakKnown: false; }

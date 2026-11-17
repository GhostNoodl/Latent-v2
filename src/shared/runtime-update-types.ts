import { z } from 'zod';
export const runtimeUpdateSettingsSchema = z
  .object({ autoCheck: z.boolean(), autoApply: z.boolean(), intervalHours: z.number().int().min(1).max(168) })
  .strict();
export type RuntimeUpdateSettings = z.infer<typeof runtimeUpdateSettingsSchema>;
export const DEFAULT_RUNTIME_UPDATE_SETTINGS: RuntimeUpdateSettings = {
  autoCheck: true,
  autoApply: true,
  intervalHours: 24,
};
export interface ReviewedRuntimeSet {
  optional?: boolean;
  id: string;
  sequence: number;
  label: string;
  releasedAt: string;
  channel: 'reviewed';
  backend: { version: string; commit: string; archiveSha256: string; archiveBytes: number; archiveUrl: string };
  pythonVersion: string;
  packages: Array<{ name: string; version: string }>;
  /** Optional, indivisible package sets; every installed version must match. */
  optionalPackageSets?: Array<Array<{ name: string; version: string }>>;
  /** Reviewed free-space planning allowance for a new environment, cache and temporary files. */
  environmentPreparationBytes?: number;
  workflowContract: string;
  workflowVersions: string[];
  mandatoryNodes: string[];
  optionalCustomNodes: Array<{
    directory: string;
    repository: string;
    revision: string;
    license: string;
    files: Array<{ filename: string; bytes: number; sha256: string }>;
  }>;
  compatibility: 'reviewed-pinned-environment';
  notes: string;
}
export interface RuntimeUpdateGeneration {
  id: string;
  environmentId?: string;
  setId: string;
  label: string;
  backendVersion: string;
  activatedAt?: string;
  startupVerifiedAt?: string;
  verification: 'existing-installation' | 'startup-checked';
}
export interface RuntimeUpdateHistory {
  id: string;
  at: string;
  action: 'check' | 'stage' | 'refresh' | 'activate' | 'rollback' | 'recover' | 'cancel';
  outcome: 'success' | 'failed' | 'deferred' | 'cancelled';
  setId?: string;
  generationId?: string;
  message: string;
}
export interface RuntimeUpdateStage {
  id: string;
  environmentId?: string;
  setId: string;
  label: string;
  backendVersion: string;
  preparedAt: string;
  kind: 'update' | 'refresh';
  environmentRepair?: true;
  packageCount: number;
  sourceFiles: number;
  customNodeNames: string[];
  verification: 'hashes-and-syntax';
}
export interface RuntimeUpdateStatus {
  automaticRetryPaused?: boolean;
  environmentRepairRequired?: boolean;
  environmentRepairBytes?: number;
  state: 'idle' | 'checking' | 'staging' | 'staged' | 'applying' | 'rolling-back' | 'recovering' | 'error';
  message: string;
  settings: RuntimeUpdateSettings;
  current?: RuntimeUpdateGeneration;
  previous?: RuntimeUpdateGeneration;
  available?: { setId: string; label: string; backendVersion: string; environmentPreparationBytes?: number };
  /** Newest public ComfyUI release on GitHub. Informational only: Latent installs reviewed sets, never this directly. */
  upstream?: RuntimeUpstreamRelease;
  /** Newer Latent app version found by the app updater; new engine sets arrive with app releases. */
  appUpdateVersion?: string;
  staged?: RuntimeUpdateStage;
  lastCheckedAt?: string;
  progress?: number;
  history: RuntimeUpdateHistory[];
  recoveryRequired: boolean;
}
export interface RuntimeUpstreamRelease {
  version: string;
  url: string;
  publishedAt?: string;
  checkedAt: string;
  /** True when this release is newer than the newest engine set the app can install. */
  newer: boolean;
  /** Set when the last attempt to reach GitHub failed; the other fields keep the last good answer. */
  error?: string;
}
export interface RuntimeUpdateHooks {
  /** Ask the app updater for a newer Latent release (manual checks may refresh it). Returns its version or undefined. */
  latestAppRelease?(refresh: boolean): Promise<string | undefined>;
  isIdle(): boolean;
  /** Cold-start recovery may preserve durable queued/running records when no engine/preflight is active. */
  isRecoverySafe?(): boolean;
  /** Must gate new submissions, drain preflight and enter with the owned engine stopped. */
  withMaintenance<T>(operation: () => Promise<T>, options?: { kind: 'recover' | 'apply' }): Promise<T>;
  /** Start the selected runtime and check mandatory live /object_info capabilities. No generation. */
  startAndVerify(set: ReviewedRuntimeSet, customNodeNames?: string[]): Promise<void>;
  stopBackend(): Promise<void>;
}

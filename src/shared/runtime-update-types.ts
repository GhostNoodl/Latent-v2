import { z } from 'zod';
export const runtimeUpdateSettingsSchema = z.object({ autoCheck: z.boolean(), autoApply: z.boolean(), intervalHours: z.number().int().min(1).max(168) }).strict();
export type RuntimeUpdateSettings = z.infer<typeof runtimeUpdateSettingsSchema>;
export const DEFAULT_RUNTIME_UPDATE_SETTINGS: RuntimeUpdateSettings = { autoCheck: true, autoApply: true, intervalHours: 24 };
export interface ReviewedRuntimeSet {
  id: string; sequence: number; label: string; releasedAt: string; channel: 'reviewed';
  backend: { version: string; commit: string; archiveSha256: string; archiveBytes: number; archiveUrl: string };
  pythonVersion: string; packages: Array<{ name: string; version: string }>;
  /** Optional, indivisible package sets; every installed version must match. */
  optionalPackageSets?: Array<Array<{ name: string; version: string }>>;
  /** Reviewed free-space planning allowance for a new environment, cache and temporary files. */
  environmentPreparationBytes?: number;
  workflowContract: string; workflowVersions: string[]; mandatoryNodes: string[];
  optionalCustomNodes: Array<{ directory: string; repository: string; revision: string; license: string; files: Array<{ filename: string; bytes: number; sha256: string }> }>;
  compatibility: 'reviewed-pinned-environment'; notes: string;
}
export interface RuntimeUpdateGeneration { id: string; environmentId?: string; setId: string; label: string; backendVersion: string; activatedAt?: string; startupVerifiedAt?: string; verification: 'existing-installation' | 'startup-checked'; }
export interface RuntimeUpdateHistory { id: string; at: string; action: 'check' | 'stage' | 'refresh' | 'activate' | 'rollback' | 'recover' | 'cancel'; outcome: 'success' | 'failed' | 'deferred' | 'cancelled'; setId?: string; generationId?: string; message: string; }
export interface RuntimeUpdateStage { id: string; environmentId?: string; setId: string; label: string; backendVersion: string; preparedAt: string; kind: 'update' | 'refresh'; environmentRepair?: true; packageCount: number; sourceFiles: number; customNodeNames: string[]; verification: 'hashes-and-syntax'; }
export interface RuntimeUpdateStatus {
  automaticRetryPaused?: boolean;
  environmentRepairRequired?: boolean;
  environmentRepairBytes?: number;
  state: 'idle' | 'checking' | 'staging' | 'staged' | 'applying' | 'rolling-back' | 'recovering' | 'error'; message: string; settings: RuntimeUpdateSettings;
  current?: RuntimeUpdateGeneration; previous?: RuntimeUpdateGeneration; available?: { setId: string; label: string; backendVersion: string; environmentPreparationBytes?: number }; staged?: RuntimeUpdateStage;
  lastCheckedAt?: string; progress?: number; history: RuntimeUpdateHistory[]; recoveryRequired: boolean;
}
export interface RuntimeUpdateHooks {
  isIdle(): boolean;
  /** Cold-start recovery may preserve durable queued/running records when no engine/preflight is active. */
  isRecoverySafe?(): boolean;
  /** Must gate new submissions, drain preflight and enter with the owned engine stopped. */
  withMaintenance<T>(operation: () => Promise<T>, options?: { kind: 'recover' | 'apply' }): Promise<T>;
  /** Start the selected runtime and check mandatory live /object_info capabilities. No generation. */
  startAndVerify(set: ReviewedRuntimeSet, customNodeNames?: string[]): Promise<void>;
  stopBackend(): Promise<void>;
}

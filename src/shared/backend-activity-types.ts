import type { BackendStatus } from './types';

export interface OwnedBackendPrompt { jobId: string; promptId: string; }
export interface BackendActivitySnapshot {
  state: 'not-checked' | 'checking' | 'ready' | 'offline' | 'unknown';
  message: string;
  observedAt?: string;
  totalRunning?: number; totalPending?: number;
  foreignRunning?: number; foreignPending?: number;
  owned: Array<OwnedBackendPrompt & { state: 'running' | 'pending' | 'absent' }>;
}
export interface BackendActivityHooks {
  waitForStartup?(): Promise<void>;
  getBackend(): { state: BackendStatus['state']; url: string | null; hasOwnedProcess: boolean };
  getOwnedPrompts(): readonly OwnedBackendPrompt[];
}
export type SubmittedJobQueueState = 'submitting' | 'pending' | 'running' | 'unknown';

import { RuntimeEnvironmentMismatch } from './runtime-update-probe';
import type { BackendStatus, StudioJob } from '../shared/types';
import type { ReviewedRuntimeSet, RuntimeUpdateHooks, RuntimeUpdateStatus } from '../shared/runtime-update-types';
import { validateRuntimeUpdateCapabilities } from '../shared/runtime-update-capabilities';
import { reviewedRuntimeSet } from './reviewed-runtime-channel';
import type { ModelLibraryLease } from './model-library-lease';

interface Backend { status(): BackendStatus; getUrl(): string | null; start(): Promise<void>; stop(): Promise<void>; }
interface Queue {
  jobs(): StudioJob[];
  isProcessing(): boolean;
  isBackendIdle?(): boolean;
  withRuntimeMaintenance<T>(operation: () => Promise<T>, options: { allowRetainedJobs: boolean }): Promise<T>;
}
const activeJob = (job: StudioJob) => ['queued', 'running'].includes(job.status);

/** Main-process orchestration; transactions/source mutation remain in RuntimeUpdateService. */
export class RuntimeUpdateCoordinator {
  private recoveryChecked = false;
  private recoveryError?: string;
  private environmentMismatch = false;
  private activationPending = false;
  private maintaining = false;
  private startup = true;
  readonly hooks: RuntimeUpdateHooks;
  constructor(private library: ModelLibraryLease, private backend: Backend, private queue: Queue, private status: () => RuntimeUpdateStatus, private fetcher: typeof fetch = fetch) {
    this.hooks = {
      isIdle: () => this.isIdle(),
      isRecoverySafe: () => this.maintaining && !this.queue.isProcessing() && this.backend.status().state !== 'ready' && !this.backend.getUrl(),
      withMaintenance: (operation, options) => this.withMaintenance(operation, options?.kind === 'recover'),
      startAndVerify: (set, names) => this.startAndVerify(set, names),
      stopBackend: () => this.backend.stop(),
    };
  }
  blockedReason(): string | undefined {
    if (!this.recoveryChecked || this.recoveryError) return this.recoveryError ? `Runtime recovery needs attention: ${this.recoveryError}` : 'Checking for interrupted runtime maintenance before generation.';
    const state = this.status();
    if (state.recoveryRequired) return 'Recover the interrupted runtime update in Settings before generation.';
    if (this.maintaining || ['applying', 'rolling-back', 'recovering'].includes(state.state)) return 'Wait for runtime maintenance to finish before starting or queueing generation.';
    return undefined;
  }
  isIdle(): boolean {
    if (this.queue.isBackendIdle?.() === false) return false;
    if (this.queue.isProcessing() || this.queue.jobs().some(activeJob) || ['starting', 'installing'].includes(this.backend.status().state)) return false;
    if (this.maintaining) return true;
    const lease = this.library.status(); return this.recoveryChecked && !this.recoveryError && !this.status().recoveryRequired && !lease.exclusive && !lease.readers.length;
  }
  /** Call before JobService.start or any automatic/manual engine launch. */
  async recover(operation: () => Promise<void>): Promise<void> {
    this.recoveryChecked = false;
    try { await operation(); if (this.status().recoveryRequired) throw new Error('A runtime transaction still requires recovery.'); this.recoveryChecked = true; this.recoveryError = undefined; this.environmentMismatch = false; }
    catch (error) { this.environmentMismatch = error instanceof RuntimeEnvironmentMismatch; this.recoveryError = error instanceof Error ? error.message : String(error); throw error; }
  }
  isActivationPending() { return this.activationPending; }
  async activateAndRecover(activate: () => Promise<void>, validate: () => Promise<void>): Promise<void> {
    if (this.activationPending) throw new Error('Runtime activation is already in progress.');
    this.activationPending = true;
    try { await activate(); await this.recover(validate); } finally { this.activationPending = false; }
  }
  finishStartup() { this.startup = false; }
  canPrepareEnvironmentRepair() { return this.environmentMismatch && !this.status().recoveryRequired; }
  recoveryProblem() { return this.recoveryError; }
  private async withMaintenance<T>(operation: () => Promise<T>, recovery: boolean): Promise<T> {
    return this.library.withExclusive(recovery ? 'recovering the reviewed runtime' : 'updating the reviewed runtime', async () => {
      const state = this.backend.status().state;
      if (['starting', 'installing'].includes(state)) throw new Error('Wait for the image engine to finish starting or installing before runtime maintenance.');
      const hasJobs = this.queue.jobs().some(activeJob);
      // A cold-start recovery repairs the source before durable work can resume.
      // Later recovery may retain work only when the owned engine is stopped.
      const allowRetainedJobs = recovery && (this.startup || state === 'stopped' || state === 'not-installed') && !this.backend.getUrl();
      if (hasJobs && !allowRetainedJobs) throw new Error('Finish or cancel queued and running jobs before changing the runtime.');
      const wasRunning = state === 'ready';
      return this.queue.withRuntimeMaintenance(async () => {
        this.maintaining = true;
        let enteredMaintenance = false;
        try {
          if (wasRunning) {
            const queue = await this.readOwned('/queue');
            if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) throw new Error('The owned engine did not report a valid queue; runtime maintenance was not started.');
            if (queue.queue_running.length || queue.queue_pending.length) throw new Error('Finish or cancel work in the owned ComfyUI queue before changing the runtime.');
          }
          enteredMaintenance = true; await this.backend.stop(); return await operation();
        }
        finally {
          try {
            if (enteredMaintenance && (this.status().recoveryRequired || !wasRunning)) await this.backend.stop();
            else if (enteredMaintenance && this.backend.status().state !== 'ready') {
              const current = this.status().current;
              if (!current) throw new Error('The previous runtime identity is unavailable; start it after recovery in Settings.');
              await this.startAndVerify(reviewedRuntimeSet(current.setId));
            }
          } finally { this.maintaining = false; }
        }
      }, { allowRetainedJobs });
    });
  }
  private async startAndVerify(set: ReviewedRuntimeSet, names: string[] = []) {
    if (!this.maintaining) throw new Error('Runtime startup verification requires the exclusive maintenance gate.');
    await this.backend.start();
    const state = this.backend.status(); const address = this.backend.getUrl();
    if (state.state !== 'ready' || state.version !== set.backend.version || !address) throw new Error('The reviewed image engine did not become ready with its expected version.');
    const objects = await this.readOwned('/object_info');
    validateRuntimeUpdateCapabilities(objects, set, names);
  }
  private async readOwned(endpoint: '/object_info' | '/queue'): Promise<Record<string, any>> {
    const address = this.backend.getUrl(); if (!address || this.backend.status().state !== 'ready') throw new Error('The owned image engine is not ready for its maintenance probe.');
    const url = new URL(address);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port) || Number(url.port) < 1024 || Number(url.port) > 65535 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Runtime verification requires the owned loopback backend URL.');
    const response = await this.fetcher(new URL(endpoint, url), { signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`Runtime capability probe failed (${response.status}).`);
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    try { while (true) { const { value, done } = await reader.read(); if (done) break; length += value.byteLength; if (length > 16 * 1024 * 1024) { await reader.cancel(); throw new Error('The runtime capability response exceeded its supported size.'); } chunks.push(value); } }
    finally { reader.releaseLock(); }
    let objects: Record<string, any>; try { objects = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('The runtime capability response was invalid JSON.'); }
    if (!objects || typeof objects !== 'object' || Array.isArray(objects)) throw new Error('The runtime capability response was not an object.');
    return objects;
  }
}

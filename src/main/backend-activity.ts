import type { BackendActivityHooks, BackendActivitySnapshot, OwnedBackendPrompt } from '../shared/backend-activity-types';

/** Read only the prompt IDs needed for ownership; never expose foreign prompts/graphs. */
export function projectBackendQueue(value: unknown, owned: readonly OwnedBackendPrompt[], observedAt = new Date().toISOString()): BackendActivitySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The image engine did not report a valid shared queue.');
  const queues = value as { queue_running?: unknown; queue_pending?: unknown };
  const seen = new Set<string>();
  const ids = (rows: unknown) => {
    if (!Array.isArray(rows) || rows.length > 10000) throw new Error('The shared queue is missing or exceeds the inspection limit.');
    return rows.map(row => {
      const id = Array.isArray(row) && row[1];
      if (typeof id !== 'string' || !id || id.length > 200 || /[\x00-\x1f]/.test(id) || seen.has(id)) throw new Error('The shared queue contains an invalid or duplicated prompt identity.');
      seen.add(id); return id;
    });
  };
  const running = new Set(ids(queues.queue_running)); const pending = new Set(ids(queues.queue_pending));
  if (owned.length > 10000 || new Set(owned.map(item => item.promptId)).size !== owned.length) throw new Error('The saved studio prompt ownership is inconsistent.');
  const ownIds = new Set(owned.map(item => item.promptId));
  const foreignRunning = [...running].filter(id => !ownIds.has(id)).length; const foreignPending = [...pending].filter(id => !ownIds.has(id)).length;
  return { state: 'ready', observedAt, totalRunning: running.size, totalPending: pending.size, foreignRunning, foreignPending,
    owned: owned.map(item => ({ ...item, state: running.has(item.promptId) ? 'running' : pending.has(item.promptId) ? 'pending' : 'absent' })),
    message: foreignRunning || foreignPending ? `Ordinary ComfyUI has ${foreignRunning} running and ${foreignPending} waiting job${foreignRunning + foreignPending === 1 ? '' : 's'}. Manage that work in ComfyUI.` : running.size || pending.size ? 'The shared image engine is processing studio work.' : 'The shared image engine queue is idle.',
  };
}

/** Poll from the owning queue loop; no timers, GPU calls, submissions or cancellation. */
export class BackendActivityService {
  private current: BackendActivitySnapshot = { state: 'not-checked', message: 'Shared image engine activity has not been checked.', owned: [] };
  private pending?: Promise<BackendActivitySnapshot>;
  private shutdown = new AbortController();
  constructor(private hooks: BackendActivityHooks, private changed: () => void, private fetcher: typeof fetch = fetch) {}
  status(): BackendActivitySnapshot { return structuredClone(this.current); }
  dispose(): void { this.shutdown.abort(); }
  private publish(value: BackendActivitySnapshot) {
    const { observedAt: _previousTime, ...previous } = this.current; const { observedAt: _nextTime, ...next } = value;
    this.current = value;
    if (JSON.stringify(previous) !== JSON.stringify(next)) this.changed();
    return this.status();
  }
  refresh(): Promise<BackendActivitySnapshot> {
    if (this.pending) return this.pending.then(value => structuredClone(value));
    this.pending = this.inspect().finally(() => { this.pending = undefined; }); return this.pending.then(value => structuredClone(value));
  }
  private async inspect(): Promise<BackendActivitySnapshot> {
    const backend = this.hooks.getBackend();
    if (!backend.hasOwnedProcess && !['ready', 'starting'].includes(backend.state)) return this.publish({ state: 'offline', message: 'The private image engine is stopped.', owned: [] });
    if (this.current.state === 'not-checked' || this.current.state === 'offline') this.publish({ state: 'checking', message: 'Checking work in the shared image engine…', owned: [] });
    try {
      if (backend.state !== 'ready' || !backend.url || !backend.hasOwnedProcess) throw new Error('Shared engine activity is unknown until the owned backend connection is restored.');
      const url = new URL(backend.url);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port) || Number(url.port) < 1024 || Number(url.port) > 65535 || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('Shared queue inspection requires the owned loopback backend.');
      const response = await this.fetcher(new URL('/queue', url), { signal: AbortSignal.any([AbortSignal.timeout(8000), this.shutdown.signal]), redirect: 'error' });
      if (!response.ok || !response.body) throw new Error(`Shared engine queue inspection failed (${response.status}).`);
      const chunks: Uint8Array[] = []; let length = 0; const reader = response.body.getReader();
      try { while (true) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > 16 * 1024 * 1024) throw new Error('Shared queue response exceeds the inspection limit.'); chunks.push(item.value); } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const now = this.hooks.getBackend(); if (now.state !== 'ready' || now.url !== backend.url || !now.hasOwnedProcess) throw new Error('The owned engine changed during inspection; its activity is unknown.');
      return this.publish(projectBackendQueue(JSON.parse(Buffer.concat(chunks).toString('utf8')), this.hooks.getOwnedPrompts()));
    } catch (error) { return this.publish({ state: 'unknown', message: error instanceof Error ? error.message : String(error), owned: [] }); }
  }
  async assertNoForeignWork(action: string): Promise<void> {
    // A failed launch is not itself permission to close: inspect the resulting
    // ownership/connection state just as we do after a successful launch.
    await this.hooks.waitForStartup?.().catch(() => {});
    // An in-flight poll may describe the engine before startup settled.
    if (this.pending) await this.pending;
    const activity = await this.refresh(); if (activity.state === 'offline') return;
    if (activity.state !== 'ready') throw new Error(`Cannot ${action}: ${activity.message} Restore the connection and check ComfyUI before stopping the shared engine.`);
    if (activity.foreignRunning || activity.foreignPending) throw new Error(`Cannot ${action} while ordinary ComfyUI has ${activity.foreignRunning} running and ${activity.foreignPending} waiting jobs. Finish or cancel that work in ComfyUI first.`);
  }
  async assertIdle(action: string): Promise<void> {
    const activity = await this.refresh(); if (activity.state === 'offline') return;
    if (activity.state !== 'ready') throw new Error(`Cannot ${action}: ${activity.message}`);
    if (activity.totalRunning || activity.totalPending) throw new Error(`Cannot ${action} while the shared engine has running or waiting work. Finish or cancel studio jobs here and ordinary jobs in ComfyUI first.`);
  }
}

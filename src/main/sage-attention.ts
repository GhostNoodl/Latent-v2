import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppPaths, SageAttentionStatus } from '../shared/types';
import { downloadAssistantAsset } from './assistant-download';
import { runEnvironmentCommand } from './runtime-environment-command';
import { SAGE_ATTENTION_WHEELS, containedPath, hasSageAttention, validateRuntimePaths } from './runtime-config';
import { probeInstalledPackages } from './runtime-update-probe';
import { withStoppedBackendLock } from './reviewed-asset-lock';
import type { EnvironmentCommand } from './runtime-environments';

interface SageAttentionDeps {
  probe: typeof probeInstalledPackages;
  download: typeof downloadAssistantAsset;
  command: EnvironmentCommand;
  stoppedLock: typeof withStoppedBackendLock;
  platform: NodeJS.Platform;
}

const MESSAGES = {
  unavailable: 'Set up the engine first.',
  unsupported: 'Only available on Windows.',
  missing: 'Not installed yet. Installing restarts the engine if it is running.',
  installed: 'Installed.',
  installing: 'Installing SageAttention…',
} as const;

/** Checks for the optional SageAttention add-on and installs its pinned wheels into the private Python. */
export class SageAttentionService {
  private current: SageAttentionStatus = { state: 'checking', message: 'Checking…' };
  private controller?: AbortController;
  private refreshing?: Promise<SageAttentionStatus>;
  private deps: SageAttentionDeps;
  constructor(
    private paths: AppPaths,
    private changed: () => void,
    deps: Partial<SageAttentionDeps> = {},
  ) {
    this.deps = {
      probe: probeInstalledPackages,
      download: downloadAssistantAsset,
      command: runEnvironmentCommand,
      stoppedLock: withStoppedBackendLock,
      platform: process.platform,
      ...deps,
    };
  }
  status(): SageAttentionStatus {
    return { ...this.current };
  }
  isInstalled() {
    return this.current.state === 'installed';
  }
  private update(next: SageAttentionStatus) {
    this.current = next;
    this.changed();
  }
  refresh(): Promise<SageAttentionStatus> {
    if (this.current.state === 'installing') return Promise.resolve(this.status());
    this.refreshing ??= this.check().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }
  private async check(): Promise<SageAttentionStatus> {
    if (this.deps.platform !== 'win32') {
      this.update({ state: 'unsupported', message: MESSAGES.unsupported });
      return this.status();
    }
    try {
      await fs.access(this.paths.python);
    } catch {
      this.update({ state: 'unavailable', message: MESSAGES.unavailable });
      return this.status();
    }
    try {
      const observed = await this.deps.probe(this.paths);
      this.update(
        hasSageAttention(observed.packages)
          ? { state: 'installed', message: MESSAGES.installed }
          : { state: 'missing', message: MESSAGES.missing },
      );
    } catch {
      this.update({ state: 'error', message: "Couldn't check the engine's Python. Try again." });
    }
    return this.status();
  }
  /** The engine must be stopped; the caller stops and restarts it. */
  async install(): Promise<void> {
    if (this.current.state === 'installing') throw new Error('SageAttention is already installing.');
    if (this.deps.platform !== 'win32') throw new Error('SageAttention is only available on Windows.');
    validateRuntimePaths(this.paths);
    const controller = new AbortController();
    this.controller = controller;
    this.update({ state: 'installing', message: MESSAGES.installing });
    try {
      await this.deps.stoppedLock(this.paths, controller.signal, async signal => {
        const cache = containedPath(this.paths.root, path.join(this.paths.cache, 'sage-attention'));
        await fs.mkdir(cache, { recursive: true });
        const wheels: string[] = [];
        for (const wheel of SAGE_ATTENTION_WHEELS)
          wheels.push(await this.deps.download(wheel, cache, signal, () => {}));
        const uv = path.join(this.paths.runtime, 'tools', 'uv.exe');
        await this.deps.command(
          uv,
          ['pip', 'install', '--python', this.paths.python, '--no-deps', '--no-index', '--offline', ...wheels],
          this.paths,
          signal,
        );
        const observed = await this.deps.probe(this.paths, signal);
        if (!hasSageAttention(observed.packages)) throw new Error("SageAttention didn't install correctly. Try again.");
      });
      this.update({ state: 'installed', message: MESSAGES.installed });
    } catch (error) {
      this.update({
        state: 'error',
        message: controller.signal.aborted
          ? 'Install cancelled.'
          : `Install failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      throw error;
    } finally {
      if (this.controller === controller) this.controller = undefined;
    }
  }
  cancel() {
    this.controller?.abort();
  }
}

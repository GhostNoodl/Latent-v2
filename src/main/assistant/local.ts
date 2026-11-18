import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { AppPaths } from '../../shared/types';
import type { LocalAssistantModelId, LocalAssistantStatus } from '../../shared/assistant-types';
import {
  LOCAL_ASSISTANT_MODEL_IDS,
  LOCAL_ASSISTANT_MODELS,
  LOCAL_ASSISTANT_RUNTIME,
  recommendedLocalModel,
  type PinnedFile,
} from '../../shared/assistant-catalog';
import { assistantHash, downloadAssistantAsset } from '../assistant-download';
import { extractRuntimeZip } from '../runtime-archive';
import { reserveBackendPort } from '../managed-backend';
import { runtimeEnvironment } from '../runtime-config';

export type RuntimeKind = 'cpu' | 'cuda';
export interface LocalHardware {
  /** Set only when an NVIDIA card was found. */
  vramMiB?: number;
  ramBytes?: number;
}
interface RuntimeMarker {
  build: string;
  kind: RuntimeKind;
  files: Record<string, string>;
}
interface ModelMarker {
  id: LocalAssistantModelId;
  files: Record<string, { bytes: number; sha256: string }>;
}

/** The local model unloads after this long without a request, to give memory back to the image engine. */
export const LOCAL_IDLE_MS = 5 * 60_000;
export const LOCAL_ALIAS = 'latent-assistant';
const canceled = () => new Error('Assistant request canceled.');

export function localPaths(paths: AppPaths) {
  const runtime = path.join(paths.runtime, 'assistant-llm');
  return {
    runtime,
    runtimeFor: (kind: RuntimeKind) => path.join(runtime, kind),
    markerFor: (kind: RuntimeKind) => path.join(runtime, `${kind}.json`),
    models: path.join(paths.models, 'assistant'),
    modelDirectory: (id: LocalAssistantModelId) => path.join(paths.models, 'assistant', id),
    downloads: path.join(paths.cache, 'assistant'),
    wrapper: path.join(runtime, 'assistant-owner.cjs'),
    log: path.join(paths.logs, 'assistant.log'),
    /** Left behind by the old CPU-only assistant. */
    old: {
      runtime: path.join(paths.runtime, 'assistant'),
      model: path.join(paths.models, 'assistant', 'Qwen3-4B-Q4_K_M.gguf'),
      archive: path.join(paths.cache, 'assistant', 'llama-b10621-bin-win-cpu-x64.zip'),
    },
  };
}

/** Which device a model runs on with the given setting. */
export function resolveDevice(
  id: LocalAssistantModelId,
  setting: 'auto' | 'gpu' | 'cpu',
  hardware: LocalHardware,
): 'gpu' | 'cpu' {
  const nvidia = Number.isFinite(hardware.vramMiB);
  if (!nvidia || setting === 'cpu') return 'cpu';
  if (setting === 'gpu') return 'gpu';
  return hardware.vramMiB! >= LOCAL_ASSISTANT_MODELS[id].minVramMiB ? 'gpu' : 'cpu';
}

export function localServerArguments(
  id: LocalAssistantModelId,
  files: { model: string; vision: string },
  port: number,
  device: 'gpu' | 'cpu',
): string[] {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local assistant port.');
  const threads = String(Math.max(1, Math.min(16, os.availableParallelism() - 2)));
  const model = LOCAL_ASSISTANT_MODELS[id];
  return [
    '--model',
    files.model,
    '--mmproj',
    files.vision,
    '--alias',
    LOCAL_ALIAS,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--ctx-size',
    '12288',
    '--parallel',
    '1',
    '--jinja',
    '--reasoning',
    'off',
    '--no-webui',
    '--cache-ram',
    '512',
    '--image-max-tokens',
    '1024',
    '--threads',
    threads,
    ...(device === 'gpu'
      ? ['--n-gpu-layers', '999', ...(model.moe ? ['--cpu-moe'] : [])]
      : ['--n-gpu-layers', '0', '--device', 'none', '--no-mmproj-offload']),
  ];
}

/** Separate Node owner process so the server dies with Latent, even when Latent crashes. */
export function ownerSource(): string {
  return `const { spawn } = require('node:child_process');
const path = require('node:path');
const owner = Number(process.env.LATENT_ASSISTANT_OWNER_PID);
if (!Number.isSafeInteger(owner) || owner < 1) process.exit(1);
const executable = process.argv[2];
const args = JSON.parse(process.argv[3]);
const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
let stopped = false;
function stop() {
  if (stopped) return; stopped = true;
  if (!child.pid) return process.exit(0);
  if (process.platform === 'win32') {
    const kill = spawn(path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    kill.on('close', () => process.exit(0)); kill.on('error', () => { child.kill(); process.exit(1); });
  } else { child.kill('SIGTERM'); setTimeout(() => process.exit(0), 1500); }
}
const watcher = setInterval(() => { try { process.kill(owner, 0); } catch (error) { if (error.code === 'ESRCH') stop(); } }, 750);
process.stdin.resume(); process.stdin.once('end', stop);
child.on('error', (error) => { console.error(error.message); clearInterval(watcher); process.exit(1); });
child.on('close', (code) => { clearInterval(watcher); process.exit(code || 0); });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
`;
}

async function renameWithRetry(source: string, destination: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.promises.rename(source, destination);
      return;
    } catch (error) {
      if (attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error;
      await delay(Math.min(100 * 2 ** attempt, 1000));
    }
  }
}

/** Runs llama.cpp's server on this PC: installs it, loads a model on demand and unloads it when idle. */
export class LocalAssistant {
  private files;
  private current: LocalAssistantStatus;
  private installPromise?: Promise<void>;
  private installController?: AbortController;
  private startPromise?: Promise<void>;
  private child?: ChildProcess;
  private running?: { id: LocalAssistantModelId; device: 'gpu' | 'cpu'; url: string; token: string };
  private busy = 0;
  private idleTimer?: NodeJS.Timeout;
  private epoch = 0;
  private disposed = false;

  constructor(
    private paths: AppPaths,
    private hardware: () => LocalHardware,
    private changed: () => void,
  ) {
    this.files = localPaths(paths);
    const installed = this.installedModels();
    this.current = {
      state: 'not-installed',
      message: '',
      installed,
      recommended: recommendedLocalModel(hardware()),
      logTail: [],
    };
  }

  status(selected: LocalAssistantModelId): LocalAssistantStatus {
    const installed = this.installedModels();
    const runtimeReady = this.installedRuntime() !== undefined;
    const base = { ...this.current, installed, recommended: recommendedLocalModel(this.hardware()) };
    if (['installing', 'starting', 'ready', 'error'].includes(this.current.state)) return structuredClone(base);
    const ready = runtimeReady && installed.includes(selected);
    return structuredClone({
      ...base,
      state: ready ? 'stopped' : 'not-installed',
      message: ready ? 'Loads when you send something.' : 'Not downloaded yet.',
    });
  }
  private update(patch: Partial<LocalAssistantStatus>) {
    this.current = { ...this.current, ...patch };
    this.changed();
  }
  private log(text: string) {
    const lines = text
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => (this.running ? line.replaceAll(this.running.token, '[private]') : line));
    if (!lines.length) return;
    this.current = { ...this.current, logTail: [...this.current.logTail, ...lines].slice(-60) };
    try {
      if (fs.existsSync(this.files.log) && fs.statSync(this.files.log).size > 5_000_000)
        fs.renameSync(this.files.log, `${this.files.log}.${Date.now()}`);
      fs.appendFileSync(this.files.log, `${lines.join('\n')}\n`);
    } catch {
      /* Diagnostics never make a request fail. */
    }
  }

  private readJson<T>(filename: string): T | undefined {
    try {
      return JSON.parse(fs.readFileSync(filename, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }
  /** Runtimes on disk. CUDA also runs on the processor, so it is listed first. */
  private installedRuntimes(): RuntimeKind[] {
    return (['cuda', 'cpu'] as const).filter(kind => {
      const marker = this.readJson<RuntimeMarker>(this.files.markerFor(kind));
      return (
        marker?.build === LOCAL_ASSISTANT_RUNTIME.build &&
        marker.kind === kind &&
        fs.existsSync(path.join(this.files.runtimeFor(kind), 'llama-server.exe'))
      );
    });
  }
  private installedRuntime(device?: 'gpu' | 'cpu'): RuntimeKind | undefined {
    const kinds = this.installedRuntimes();
    return device === 'gpu' ? kinds.find(kind => kind === 'cuda') : kinds[0];
  }
  private modelFiles(id: LocalAssistantModelId) {
    const model = LOCAL_ASSISTANT_MODELS[id];
    const directory = this.files.modelDirectory(id);
    return {
      model: path.join(directory, model.model.filename),
      vision: path.join(directory, model.vision.filename),
      marker: path.join(directory, 'verified.json'),
    };
  }
  /** Models whose files were checked at download and still have the right size. */
  installedModels(): LocalAssistantModelId[] {
    return LOCAL_ASSISTANT_MODEL_IDS.filter(id => {
      const model = LOCAL_ASSISTANT_MODELS[id];
      const files = this.modelFiles(id);
      const marker = this.readJson<ModelMarker>(files.marker);
      if (marker?.id !== id) return false;
      return [
        [files.model, model.model],
        [files.vision, model.vision],
      ].every(([filename, pin]) => {
        const pinned = pin as PinnedFile;
        try {
          const stat = fs.lstatSync(filename as string);
          return (
            stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.size === pinned.bytes &&
            marker.files[pinned.filename]?.sha256 === pinned.sha256
          );
        } catch {
          return false;
        }
      });
    });
  }

  /** What still has to be downloaded for a model on the device it would use. */
  missingDownloads(id: LocalAssistantModelId, device: 'gpu' | 'cpu'): PinnedFile[] {
    const runtime = this.installedRuntime(device) ? [] : LOCAL_ASSISTANT_RUNTIME[device === 'gpu' ? 'cuda' : 'cpu'];
    const model = this.installedModels().includes(id)
      ? []
      : [LOCAL_ASSISTANT_MODELS[id].model, LOCAL_ASSISTANT_MODELS[id].vision];
    return [...runtime, ...model];
  }

  install(id: LocalAssistantModelId, device: 'gpu' | 'cpu'): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Assistant was closed.'));
    if (this.installPromise) return this.installPromise;
    if (process.platform !== 'win32' || process.arch !== 'x64')
      return Promise.reject(new Error('The local assistant needs Windows x64.'));
    const controller = new AbortController();
    this.installController = controller;
    this.installPromise = this.download(id, device, controller.signal)
      .then(() => {
        this.update({ state: 'stopped', message: 'Downloaded. Loads when you send something.', installProgress: 100 });
      })
      .catch(error => {
        const failure =
          error?.code === 'ENOSPC' ? new Error('Not enough disk space. Free some space and try again.') : error;
        this.update({
          state: controller.signal.aborted ? 'not-installed' : 'error',
          message: controller.signal.aborted ? 'Download cancelled.' : `Download failed: ${failure.message}`,
        });
        throw failure;
      })
      .finally(() => {
        this.installPromise = undefined;
        this.installController = undefined;
      });
    return this.installPromise;
  }
  cancelInstall() {
    this.installController?.abort(canceled());
  }

  private async download(id: LocalAssistantModelId, device: 'gpu' | 'cpu', signal: AbortSignal) {
    const kind: RuntimeKind = device === 'gpu' ? 'cuda' : 'cpu';
    const needRuntime = !this.installedRuntime(device);
    const needModel = !this.installedModels().includes(id);
    const queue = [
      ...(needRuntime ? LOCAL_ASSISTANT_RUNTIME[kind] : []),
      ...(needModel ? [LOCAL_ASSISTANT_MODELS[id].model, LOCAL_ASSISTANT_MODELS[id].vision] : []),
    ];
    const total = queue.reduce((sum, file) => sum + file.bytes, 0);
    let done = 0;
    this.update({
      state: 'installing',
      message: 'Getting ready…',
      installProgress: 0,
      receivedBytes: 0,
      totalBytes: total,
    });
    const fetchFile = async (file: PinnedFile, directory: string) => {
      const filename = await downloadAssistantAsset(file, directory, signal, (received, _size, verifying) =>
        this.update({
          message: verifying ? 'Checking the download…' : `Downloading ${file.filename}…`,
          installProgress: total ? (100 * (done + received)) / total : 0,
          receivedBytes: done + received,
        }),
      );
      done += file.bytes;
      return filename;
    };
    for (const directory of [this.files.runtime, this.files.downloads, this.files.models, this.paths.logs])
      await fs.promises.mkdir(directory, { recursive: true });

    if (needRuntime) {
      const archives: string[] = [];
      for (const file of LOCAL_ASSISTANT_RUNTIME[kind]) archives.push(await fetchFile(file, this.files.downloads));
      this.update({ message: 'Unpacking…' });
      const stage = path.join(this.files.runtime, `stage-${randomUUID()}`);
      await fs.promises.mkdir(stage);
      try {
        for (const archive of archives) await extractRuntimeZip(archive, stage);
        signal.throwIfAborted();
        let root = stage;
        if (!fs.existsSync(path.join(root, 'llama-server.exe'))) {
          const nested = (await fs.promises.readdir(stage, { withFileTypes: true })).filter(
            entry => entry.isDirectory() && fs.existsSync(path.join(stage, entry.name, 'llama-server.exe')),
          );
          if (nested.length !== 1) throw new Error("The download doesn't contain the assistant server.");
          root = path.join(stage, nested[0].name);
        }
        const hashes: Record<string, string> = {};
        const inventory = async (directory: string) => {
          for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
            const filename = path.join(directory, entry.name);
            if (entry.isDirectory()) await inventory(filename);
            else if (entry.isFile()) hashes[path.relative(root, filename)] = await assistantHash(filename, signal);
            else throw new Error('The download contains something unexpected.');
          }
        };
        await inventory(root);
        const destination = this.files.runtimeFor(kind);
        await fs.promises.rm(destination, { recursive: true, force: true });
        await renameWithRetry(root, destination);
        const marker: RuntimeMarker = { build: LOCAL_ASSISTANT_RUNTIME.build, kind, files: hashes };
        await fs.promises.writeFile(this.files.markerFor(kind), JSON.stringify(marker, null, 1));
      } finally {
        await fs.promises.rm(stage, { recursive: true, force: true }).catch(() => undefined);
      }
      for (const archive of archives) await fs.promises.rm(archive, { force: true }).catch(() => undefined);
    }

    if (needModel) {
      const model = LOCAL_ASSISTANT_MODELS[id];
      const directory = this.files.modelDirectory(id);
      await fs.promises.mkdir(directory, { recursive: true });
      const files = this.modelFiles(id);
      await fs.promises.rm(files.marker, { force: true });
      await fetchFile(model.model, directory);
      await fetchFile(model.vision, directory);
      const marker: ModelMarker = {
        id,
        files: Object.fromEntries(
          [model.model, model.vision].map(file => [file.filename, { bytes: file.bytes, sha256: file.sha256 }]),
        ),
      };
      await fs.promises.writeFile(files.marker, JSON.stringify(marker, null, 1));
    }
    await this.removeOldAssistant();
  }

  /** Clears out the old CPU-only assistant's files once the new one is in place. */
  async removeOldAssistant() {
    const old = this.files.old;
    await Promise.allSettled([
      fs.promises.rm(old.runtime, { recursive: true, force: true }),
      fs.promises.rm(old.model, { force: true }),
      fs.promises.rm(old.archive, { force: true }),
    ]);
  }

  /** Deletes a downloaded model. */
  async remove(id: LocalAssistantModelId) {
    if (this.running?.id === id || this.startPromise) await this.stop();
    await fs.promises.rm(this.files.modelDirectory(id), { recursive: true, force: true });
    this.changed();
  }

  /** Starts the server for this model if it isn't already running it. Returns where to send requests. */
  async ensure(
    id: LocalAssistantModelId,
    device: 'gpu' | 'cpu',
    signal: AbortSignal,
  ): Promise<{ url: string; token: string; device: 'gpu' | 'cpu' }> {
    if (this.disposed) throw new Error('Assistant was closed.');
    clearTimeout(this.idleTimer);
    if (this.running && (this.running.id !== id || this.running.device !== device)) await this.stop();
    if (!this.running) {
      this.startPromise ??= this.launch(id, device).finally(() => {
        this.startPromise = undefined;
      });
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(signal.reason ?? canceled());
        signal.addEventListener('abort', aborted, { once: true });
        this.startPromise!.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
      });
    }
    if (!this.running) throw new Error('The local assistant stopped while loading. Try again.');
    return { url: this.running.url, token: this.running.token, device: this.running.device };
  }
  /** Marks a request as running so the idle timer waits. */
  hold(): () => void {
    this.busy++;
    clearTimeout(this.idleTimer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy--;
      this.armIdle();
    };
  }
  private armIdle() {
    clearTimeout(this.idleTimer);
    if (!this.running || this.busy) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy) return;
      void this.stop('Unloaded after 5 quiet minutes to free memory. It loads again when you send.');
    }, LOCAL_IDLE_MS);
    this.idleTimer.unref?.();
  }
  /** True while the model sits in graphics memory. */
  onGpu() {
    return this.running?.device === 'gpu' || (this.current.state === 'starting' && this.current.device === 'gpu');
  }

  private async launch(id: LocalAssistantModelId, device: 'gpu' | 'cpu') {
    if (this.installPromise) await this.installPromise;
    const epoch = ++this.epoch;
    const kind = this.installedRuntime(device);
    if (!kind) throw new Error('Download the local assistant first (Settings, Assistant).');
    if (!this.installedModels().includes(id))
      throw new Error(`Download ${LOCAL_ASSISTANT_MODELS[id].name} first (Settings, Assistant).`);
    const marker = this.readJson<RuntimeMarker>(this.files.markerFor(kind));
    const binaries = this.files.runtimeFor(kind);
    const executable = path.join(binaries, 'llama-server.exe');
    this.update({ state: 'starting', device, message: `Loading ${LOCAL_ASSISTANT_MODELS[id].name}…` });
    try {
      // The server and its libraries are checked before each start; model files were checked at download.
      for (const [relative, hash] of Object.entries(marker?.files ?? {})) {
        if (!/\.(exe|dll)$/i.test(relative)) continue;
        const filename = path.join(binaries, relative);
        if (fs.lstatSync(filename).isSymbolicLink() || (await assistantHash(filename)) !== hash)
          throw new Error('Some assistant files changed. Download it again in Settings, Assistant.');
      }
      await fs.promises.writeFile(this.files.wrapper, ownerSource());
      const port = await reserveBackendPort();
      const token = randomBytes(32).toString('hex');
      const url = `http://127.0.0.1:${port}`;
      const env: NodeJS.ProcessEnv = {
        ...runtimeEnvironment(this.paths),
        ELECTRON_RUN_AS_NODE: '1',
        LATENT_ASSISTANT_OWNER_PID: String(process.pid),
        LLAMA_API_KEY: token,
      };
      for (const key of ['TEMP', 'HOME', 'APPDATA', 'LOCALAPPDATA'])
        if (env[key]) await fs.promises.mkdir(env[key]!, { recursive: true });
      const files = this.modelFiles(id);
      const child = spawn(
        process.execPath,
        [this.files.wrapper, executable, JSON.stringify(localServerArguments(id, files, port, device))],
        { cwd: binaries, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.child = child;
      let spawnError: Error | undefined;
      child.stdout?.on('data', chunk => this.log(String(chunk)));
      child.stderr?.on('data', chunk => this.log(String(chunk)));
      child.on('error', error => {
        spawnError = error;
      });
      child.on('close', code => {
        if (this.child !== child) return;
        this.child = undefined;
        this.running = undefined;
        if (epoch === this.epoch)
          this.update({
            state: 'error',
            message: `The local assistant closed (code ${code ?? 'unknown'}). Send again to restart it.`,
          });
      });
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        if (epoch !== this.epoch) throw canceled();
        if (spawnError) throw spawnError;
        if (this.child !== child || child.exitCode !== null)
          throw new Error(`It closed while loading. ${this.current.logTail.slice(-3).join(' ')}`);
        try {
          const health = await fetch(`${url}/health`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(1500),
          });
          if (health.ok) {
            this.running = { id, device, url, token };
            this.update({ state: 'ready', device, message: `${LOCAL_ASSISTANT_MODELS[id].name} is loaded.` });
            this.armIdle();
            return;
          }
        } catch {
          /* Still loading. */
        }
        await delay(300);
      }
      throw new Error('It took more than four minutes to load.');
    } catch (error) {
      if (epoch === this.epoch) {
        await this.kill();
        this.update({
          state: 'error',
          message: `Couldn't load the local assistant: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      throw error;
    }
  }

  async stop(message = 'Unloaded.') {
    clearTimeout(this.idleTimer);
    this.epoch++;
    await this.kill();
    this.update({ state: 'stopped', message, device: undefined });
  }
  private async kill() {
    const child = this.child;
    this.running = undefined;
    if (!child?.pid) {
      this.child = undefined;
      return;
    }
    if (process.platform === 'win32') {
      await new Promise<void>(resolve => {
        const killer = spawn(
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        killer.on('error', () => resolve());
        killer.on('close', () => resolve());
      });
    } else child.kill('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (this.child === child && child.exitCode === null && Date.now() < deadline) await delay(50);
    if (this.child === child) this.child = undefined;
  }
  async dispose() {
    this.disposed = true;
    this.installController?.abort(canceled());
    await this.stop();
  }
}

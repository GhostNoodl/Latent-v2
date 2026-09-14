import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AppPaths, AppSettings, BackendStatus } from '../shared/types';
import { backendArguments, containedPath, launcherSource, modelPathsYaml, RUNTIME_RELEASE, runtimeEnvironment, validateRuntimePaths } from './runtime-config';
import type { BackendModelRoot } from '../shared/model-locations';
import { extractRuntimeZip, sha256File } from './runtime-archive';
import { captureRuntimeIdentity } from './runtime-identity';
import type { RuntimeIdentitySnapshot } from '../shared/runtime-identity';
import { reviewedInstalledRuntime } from './reviewed-runtime-channel';
import { normalizePrivatePythonHome } from './python-home';
import { RuntimeCommandFailure } from './runtime-command-error';
import { REVIEWED_RUNTIME_PACKAGES } from './runtime-update-packages';
import { verifyUpdateEnvironment } from './runtime-update-probe';

interface RuntimeMarker {
  schema: number;
  comfyVersion: string;
  comfyCommit: string;
  installedAt: string;
  pythonVersion: string;
  torchVersion: string;
  cudaAvailable: boolean;
  gpuName?: string;
  sourceSha256: string;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function reserveBackendPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('Could not allocate a local backend port.')); return; }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export function isManagedSystemStats(value: unknown, paths: AppPaths, expectedVersion: string = RUNTIME_RELEASE.comfyVersion): boolean {
  if (!value || typeof value !== 'object') return false;
  const stats = value as { system?: { comfyui_version?: string; argv?: unknown[] }; devices?: unknown[] };
  const main = stats.system?.argv?.[0];
  return stats.system?.comfyui_version === expectedVersion && Array.isArray(stats.devices)
    && typeof main === 'string' && path.resolve(main) === path.resolve(paths.backend, 'main.py');
}

export class ManagedBackend {
  private current: BackendStatus;
  private setupPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private child?: ChildProcess;
  private installer?: ChildProcess;
  private abort?: AbortController;
  private heartbeat?: NodeJS.Timeout;
  private activeUrl: string | null = null;
  private stopping = false;
  private disposed = false;
  private lifecycle = 0;
  private runtimeIdentity?: RuntimeIdentitySnapshot;
  private expectedVersion: string = RUNTIME_RELEASE.comfyVersion;
  private identityAbort?: AbortController;
  private readonly markerPath: string;
  private readonly logPath: string;

  constructor(private readonly paths: AppPaths, private readonly onStatus: (status: BackendStatus) => void, private readonly getSettings?: () => AppSettings, private readonly getModelRoots?: () => Promise<readonly BackendModelRoot[]>) {
    validateRuntimePaths(paths);
    this.markerPath = path.join(paths.runtime, 'installed.json');
    this.logPath = path.join(paths.logs, 'backend.log');
    const installed = this.readMarker();
    this.current = {
      state: installed ? 'stopped' : 'not-installed',
      message: installed ? 'Your dedicated ComfyUI backend is installed.' : 'Set up your dedicated ComfyUI backend to begin.',
      ...(installed ? { version: installed.comfyVersion } : {}),
      logTail: [],
    };
  }

  status(): BackendStatus { return { ...this.current, logTail: [...this.current.logTail] }; }
  getUrl(): string | null { return this.current.state === 'ready' ? this.activeUrl : null; }
  hasOwnedProcess(): boolean { return Boolean(this.child); }
  getRuntimeIdentity(): RuntimeIdentitySnapshot | undefined { return this.current.state === 'ready' && this.runtimeIdentity ? structuredClone(this.runtimeIdentity) : undefined; }

  setup(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('The managed backend has been disposed.'));
    if (this.setupPromise) return this.setupPromise;
    if (this.child) return Promise.reject(new Error('Stop ComfyUI before changing its runtime.'));
    if (this.stopPromise) return this.stopPromise.then(() => this.setup());
    if (this.readMarker()) return Promise.resolve();
    this.setupPromise = this.install().finally(() => { this.setupPromise = undefined; });
    return this.setupPromise;
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('The managed backend has been disposed.'));
    if (this.startPromise) return this.startPromise;
    if (this.stopPromise) return this.stopPromise.then(() => this.start());
    if (this.child) return this.current.state === 'ready' ? Promise.resolve() : Promise.reject(new Error('The backend is reconnecting. Stop it before restarting.'));
    this.startPromise = this.launch().finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }

  /** Observe an existing launch without starting a stopped engine. */
  waitForStartup(): Promise<void> { return this.startPromise ?? Promise.resolve(); }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOwnedProcesses().finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  private readMarker(): RuntimeMarker | null {
    try {
      const marker = JSON.parse(fs.readFileSync(this.markerPath, 'utf8')) as RuntimeMarker;
      const reviewed = reviewedInstalledRuntime(marker);
      if (!reviewed || marker.schema !== RUNTIME_RELEASE.schema || marker.comfyVersion !== reviewed.backend.version || marker.pythonVersion !== reviewed.pythonVersion || marker.torchVersion !== reviewed.packages.find(item => item.name === 'torch')?.version) return null;
      if (!fs.existsSync(this.paths.python) || !fs.existsSync(path.join(this.paths.backend, 'main.py'))) return null;
      return marker;
    } catch { return null; }
  }

  private publish(update: Partial<BackendStatus>): void {
    this.current = { ...this.current, ...update };
    // UI teardown must not turn a successful install into a failed one.
    try { this.onStatus(this.status()); } catch { /* Renderer may have closed. */ }
  }

  private log(message: string): void {
    const clean = message.replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (!clean) return;
    const lines = clean.split(/[\r\n]+/).map((line) => line.slice(0, 2000));
    this.current.logTail = [...this.current.logTail, ...lines].slice(-100);
    try { fs.appendFileSync(this.logPath, `${new Date().toISOString()} ${lines.join('\n')}\n`, 'utf8'); } catch { /* Status still reports disk errors through the operation. */ }
    this.publish({});
  }

  private checkCancelled(): void {
    if (this.disposed || this.abort?.signal.aborted) throw new Error('Backend setup was cancelled. It can be resumed safely.');
  }

  private async ensureDirectories(): Promise<void> {
    validateRuntimePaths(this.paths);
    const env = runtimeEnvironment(this.paths);
    const directories = [this.paths.root, this.paths.runtime, this.paths.models, this.paths.outputs, this.paths.inputs, this.paths.temp, this.paths.user, this.paths.cache, this.paths.logs, path.join(this.paths.root, 'custom_nodes'),
      path.join(this.paths.runtime, 'tools'), path.join(this.paths.cache, 'runtime', 'downloads'),
      ...['HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'UV_PYTHON_INSTALL_DIR', 'UV_CACHE_DIR', 'HF_HOME', 'TORCH_HOME', 'MPLCONFIGDIR', 'TRITON_CACHE_DIR', 'CUDA_CACHE_PATH'].map((key) => env[key]!),
      ...['checkpoints', 'loras', 'vae', 'embeddings', 'controlnet', 'upscale_models', 'diffusion_models', 'text_encoders', 'clip_vision'].map((name) => path.join(this.paths.models, name)),
    ];
    for (const directory of directories) await fs.promises.mkdir(directory, { recursive: true });
    try {
      if ((await fs.promises.stat(this.logPath)).size > 5 * 1024 * 1024) {
        await fs.promises.rename(this.logPath, path.join(this.paths.logs, `backend-${Date.now()}.log`));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  private async download(url: string, filename: string, expectedSha256: string, from: number, to: number): Promise<string> {
    const target = path.join(this.paths.cache, 'runtime', 'downloads', filename);
    if (fs.existsSync(target) && await sha256File(target) === expectedSha256) return target;
    this.checkCancelled();
    const partial = `${target}.partial`;
    const response = await fetch(url, { signal: AbortSignal.any([this.abort!.signal, AbortSignal.timeout(20 * 60_000)]) });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${filename}`);
    const total = Number(response.headers.get('content-length'));
    const file = await fs.promises.open(partial, 'w');
    let received = 0;
    let lastUpdate = 0;
    try {
      for await (const chunk of response.body) {
        this.checkCancelled();
        await file.writeFile(chunk);
        received += chunk.byteLength;
        if (Date.now() - lastUpdate > 250) {
          lastUpdate = Date.now();
          this.publish({ installProgress: total ? from + Math.min(1, received / total) * (to - from) : from });
        }
      }
    } finally { await file.close(); }
    const actual = await sha256File(partial);
    if (actual !== expectedSha256) throw new Error(`Integrity check failed for ${filename}. Retry setup to download a fresh copy.`);
    this.checkCancelled();
    await fs.promises.rename(partial, target);
    this.publish({ installProgress: to });
    return target;
  }

  private async installUv(): Promise<string> {
    const toolsDirectory = path.join(this.paths.runtime, 'tools');
    const uvPath = path.join(toolsDirectory, 'uv.exe');
    const archive = await this.download(`https://github.com/astral-sh/uv/releases/download/${RUNTIME_RELEASE.uvVersion}/uv-x86_64-pc-windows-msvc.zip`, `uv-${RUNTIME_RELEASE.uvVersion}.zip`, RUNTIME_RELEASE.uvArchiveSha256, 1, 7);
    const stage = containedPath(this.paths.runtime, path.join(this.paths.runtime, `uv-stage-${crypto.randomUUID()}`));
    await fs.promises.mkdir(stage);
    try {
      await extractRuntimeZip(archive, stage);
      const candidates = await fs.promises.readdir(stage, { withFileTypes: true });
      const nested = candidates.find((entry) => entry.isDirectory());
      const extracted = fs.existsSync(path.join(stage, 'uv.exe')) ? path.join(stage, 'uv.exe') : path.join(stage, nested?.name ?? '', 'uv.exe');
      if (!fs.existsSync(extracted)) throw new Error('The official uv archive did not contain uv.exe.');
      await fs.promises.copyFile(extracted, uvPath);
    } finally { await fs.promises.rm(containedPath(this.paths.runtime, stage), { recursive: true, force: true }); }
    return uvPath;
  }

  private async installSource(): Promise<void> {
    const sourceMarker = path.join(this.paths.backend, '.latent-source.json');
    try {
      const installed = JSON.parse(await fs.promises.readFile(sourceMarker, 'utf8'));
      if (installed.commit === RUNTIME_RELEASE.comfyCommit && fs.existsSync(path.join(this.paths.backend, 'main.py'))) return;
    } catch { /* A partial or missing source tree can be staged again. */ }
    const archive = await this.download(`https://codeload.github.com/Comfy-Org/ComfyUI/zip/${RUNTIME_RELEASE.comfyCommit}`, `ComfyUI-${RUNTIME_RELEASE.comfyCommit}.zip`, RUNTIME_RELEASE.comfyArchiveSha256, 15, 20);
    const stage = containedPath(this.paths.runtime, path.join(this.paths.runtime, `comfy-stage-${crypto.randomUUID()}`));
    await fs.promises.mkdir(stage);
    try {
      await extractRuntimeZip(archive, stage, `ComfyUI-${RUNTIME_RELEASE.comfyCommit}/`);
      if (!fs.existsSync(path.join(stage, 'main.py')) || !fs.existsSync(path.join(stage, 'requirements.txt'))) throw new Error('The source archive is incomplete.');
      await fs.promises.writeFile(path.join(stage, '.latent-source.json'), JSON.stringify({ commit: RUNTIME_RELEASE.comfyCommit, sha256: RUNTIME_RELEASE.comfyArchiveSha256 }));
      this.checkCancelled();
      if (fs.existsSync(this.paths.backend)) {
        const backup = containedPath(this.paths.runtime, path.join(this.paths.runtime, `ComfyUI-backup-${Date.now()}`));
        await fs.promises.rename(containedPath(this.paths.runtime, this.paths.backend), backup);
        this.log(`Preserved previous managed source at ${backup}`);
      }
      await fs.promises.rename(stage, containedPath(this.paths.runtime, this.paths.backend));
    } finally { await fs.promises.rm(containedPath(this.paths.runtime, stage), { recursive: true, force: true }); }
  }

  private async installPython(uv: string): Promise<void> {
    const args = ['python', 'install', RUNTIME_RELEASE.pythonVersion, '--no-bin', '--no-registry'];
    try { await this.command(uv, args); }
    catch (error) {
      // uv#19622: Windows may reject uv's minor-version junction even though the
      // downloaded patch interpreter is intact. Repair only our own alias, then
      // use the verified exact interpreter; never fall back to a system Python.
      if (process.platform !== 'win32' || !errorMessage(error).includes('Missing expected target directory for Python minor version link')) throw error;
      this.checkCancelled();
      const pythonRoot = path.join(this.paths.cache, 'runtime', 'python');
      const exact = containedPath(pythonRoot, path.join(pythonRoot, `cpython-${RUNTIME_RELEASE.pythonVersion}-windows-x86_64-none`));
      const alias = containedPath(pythonRoot, path.join(pythonRoot, 'cpython-3.12-windows-x86_64-none'));
      if (!fs.existsSync(path.join(exact, 'python.exe')) || fs.lstatSync(exact).isSymbolicLink()) throw error;
      const version = await this.command(path.join(exact, 'python.exe'), ['-s', '-c', 'import sys; print(sys.version.split()[0])'], 30_000);
      if (version.trim() !== RUNTIME_RELEASE.pythonVersion) throw error;
      try {
        const stat = await fs.promises.lstat(alias);
        if (!stat.isSymbolicLink()) throw new Error('Cannot repair Python alias because it is not a managed junction.');
        const target = await fs.promises.readlink(alias);
        if (path.resolve(target) !== path.resolve(exact)) throw new Error('Cannot repair a Python alias pointing outside the expected interpreter.');
        await fs.promises.unlink(alias);
      } catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError; }
      await fs.promises.symlink(exact, alias, 'junction');
      this.log('Repaired the private Python version alias after the known uv Windows junction issue.');
      // uv install would recreate the defective alias. The downloaded exact
      // interpreter passed its version check; venv creation references it directly.
    }
    const exactPython = path.join(this.paths.cache, 'runtime', 'python', `cpython-${RUNTIME_RELEASE.pythonVersion}-windows-x86_64-none`, 'python.exe');
    await this.command(uv, ['venv', '--python', exactPython, '--no-project', '--allow-existing', path.dirname(path.dirname(this.paths.python))]);
  }

  private async command(executable: string, args: string[], timeoutMs = 30 * 60_000): Promise<string> {
    this.checkCancelled();
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, { cwd: this.paths.runtime, env: runtimeEnvironment(this.paths), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.installer = child;
      let output = '';
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        void this.terminate(child).catch((error) => {
          this.log(errorMessage(error));
          reject(new Error(`Runtime command timed out and its owned process could not be stopped: ${errorMessage(error)}`));
        });
      }, timeoutMs);
      const collect = (data: Buffer) => { const text = data.toString('utf8'); output = `${output}${text}`.slice(-64 * 1024); this.log(text); };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.once('error', (error) => { clearTimeout(timeout); if (this.installer === child) this.installer = undefined; reject(error); });
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (this.installer === child) this.installer = undefined;
        if (timedOut) reject(new Error('Runtime installation timed out. Retry setup to resume cached downloads.'));
        else if (this.abort?.signal.aborted || this.disposed) reject(new Error('Backend setup was cancelled. It can be resumed safely.'));
        else if (code !== 0) reject(new RuntimeCommandFailure(path.basename(executable), code, output));
        else resolve(output);
      });
    });
  }

  private async installPackages(uv: string, args: string[]): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      this.checkCancelled();
      try { return await this.command(uv, args); }
      catch (error) {
        if (!(error instanceof RuntimeCommandFailure) || !error.retryableLauncherFailure || attempt >= 2) throw error;
        this.checkCancelled();
        this.log(`Windows could not write a package launcher. Retrying cached package installation (${attempt + 1}/2)…`);
        await delay(500 * (attempt + 1));
      }
    }
  }

  private async install(): Promise<void> {
    this.abort = new AbortController();
    this.stopping = false;
    this.publish({ state: 'installing', message: 'Preparing your separate runtime…', installProgress: 0, url: undefined });
    try {
      if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This runtime installer currently supports Windows x64.');
      await this.ensureDirectories();
      this.log(`Installing ComfyUI ${RUNTIME_RELEASE.comfyVersion} (${RUNTIME_RELEASE.comfyCommit}) into ${this.paths.runtime}`);
      const uv = await this.installUv();
      this.checkCancelled();
      this.publish({ message: `Installing private Python ${RUNTIME_RELEASE.pythonVersion}…`, installProgress: 8 });
      await this.installPython(uv);
      this.publish({ message: `Installing ComfyUI ${RUNTIME_RELEASE.comfyVersion}…`, installProgress: 15 });
      await this.installSource();
      const constraints = path.join(this.paths.runtime, 'reviewed-runtime-requirements.txt');
      const pins = [`torch==${RUNTIME_RELEASE.torchVersion}`, `torchvision==${RUNTIME_RELEASE.torchvisionVersion}`, `torchaudio==${RUNTIME_RELEASE.torchaudioVersion}`];
      await fs.promises.writeFile(constraints, `${REVIEWED_RUNTIME_PACKAGES.map(item => `${item.name}==${item.version}`).join('\n')}\n`);
      this.publish({ message: 'Installing PyTorch with CUDA 13.0. This download is several GB…', installProgress: 22 });
      await this.installPackages(uv, ['pip', 'install', '--python', this.paths.python, '--default-index', RUNTIME_RELEASE.torchIndex, '--no-deps', ...pins]);
      this.publish({ message: 'Installing the reviewed ComfyUI dependencies…', installProgress: 65 });
      // uv splits constraint arguments on spaces (astral-sh/uv#12639), even
      // when passed as one argv entry. A file URL preserves the complete path.
      await this.installPackages(uv, ['pip', 'install', '--python', this.paths.python, '--default-index', 'https://pypi.org/simple', '--index', RUNTIME_RELEASE.torchIndex, '--index-strategy', 'unsafe-best-match', '--constraint', pathToFileURL(constraints).href, '--requirements', constraints, '--requirements', path.join(this.paths.backend, 'requirements.txt')]);
      this.publish({ message: 'Checking the Python environment and GPU…', installProgress: 92 });
      await this.command(uv, ['pip', 'check', '--python', this.paths.python]);
      await verifyUpdateEnvironment(this.paths, { pythonVersion: RUNTIME_RELEASE.pythonVersion, packages: REVIEWED_RUNTIME_PACKAGES }, this.abort.signal, 'setup');
      const verification = await this.command(this.paths.python, ['-s', '-c', "import json,sys,torch,torchvision,torchaudio,importlib.metadata; print('LATENT_VERIFY='+json.dumps({'python':sys.version.split()[0], 'torch':torch.__version__, 'cuda':torch.cuda.is_available(), 'gpu':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None, 'frontend':importlib.metadata.version('comfyui-frontend-package')}))"], 120_000);
      const line = verification.split(/\r?\n/).find((value) => value.startsWith('LATENT_VERIFY='));
      if (!line) throw new Error('The runtime did not return its verification result.');
      const checked = JSON.parse(line.slice('LATENT_VERIFY='.length));
      if (checked.python !== RUNTIME_RELEASE.pythonVersion || checked.torch !== RUNTIME_RELEASE.torchVersion) throw new Error('Installed runtime versions do not match the pinned release.');
      if (!checked.cuda && this.getSettings?.().deviceMode !== 'cpu') throw new Error('PyTorch could not access an NVIDIA CUDA GPU. Check the NVIDIA driver, or explicitly select CPU mode in Settings and retry setup.');
      await this.writeLaunchFiles();
      const marker: RuntimeMarker = { schema: RUNTIME_RELEASE.schema, comfyVersion: RUNTIME_RELEASE.comfyVersion, comfyCommit: RUNTIME_RELEASE.comfyCommit, installedAt: new Date().toISOString(), pythonVersion: checked.python, torchVersion: checked.torch, cudaAvailable: checked.cuda, gpuName: checked.gpu ?? undefined, sourceSha256: RUNTIME_RELEASE.comfyArchiveSha256 };
      const installedPackages = await this.command(uv, ['pip', 'freeze', '--python', this.paths.python]);
      await fs.promises.writeFile(path.join(this.paths.runtime, 'installed-packages.txt'), installedPackages);
      this.checkCancelled();
      await fs.promises.writeFile(`${this.markerPath}.partial`, JSON.stringify({ ...marker, release: RUNTIME_RELEASE }, null, 2));
      await fs.promises.rename(`${this.markerPath}.partial`, this.markerPath);
      this.log(`Runtime verified. ${checked.cuda ? `CUDA GPU: ${checked.gpu}` : 'CPU mode explicitly selected.'}`);
      this.publish({ state: 'stopped', message: 'Your separate ComfyUI runtime is ready to start.', version: RUNTIME_RELEASE.comfyVersion, installProgress: 100 });
    } catch (error) {
      this.log(errorMessage(error));
      this.publish({ state: 'error', message: errorMessage(error), installProgress: undefined, url: undefined });
      throw error;
    } finally { this.abort = undefined; }
  }

  private async writeLaunchFiles(): Promise<void> {
    await fs.promises.writeFile(path.join(this.paths.runtime, 'extra-model-paths.yaml'), modelPathsYaml(this.paths, await this.getModelRoots?.() ?? []));
    await fs.promises.writeFile(path.join(this.paths.runtime, 'comfy-launcher.py'), launcherSource());
  }

  private async launch(): Promise<void> {
    const lifecycle = ++this.lifecycle;
    this.stopping = false;
    this.runtimeIdentity = undefined;
    try {
      if (this.setupPromise) await this.setupPromise;
      const installed = this.readMarker(); if (!installed) throw new Error('Set up the managed runtime before starting ComfyUI.'); this.expectedVersion = installed.comfyVersion;
      if (this.disposed || lifecycle !== this.lifecycle) return;
      const homeAbort = new AbortController(); this.identityAbort = homeAbort;
      try {
        const normalized = await normalizePrivatePythonHome(this.paths, homeAbort.signal, () => !this.child && !this.installer && !this.disposed && !this.stopping && lifecycle === this.lifecycle);
        if (normalized.changed) this.log(`Verified the physical private Python home. Original config and receipt retained at ${normalized.backup} and ${normalized.receipt}`);
      } finally { if (this.identityAbort === homeAbort) this.identityAbort = undefined; }
      if (this.disposed || lifecycle !== this.lifecycle) return;
      await this.ensureDirectories();
      await this.writeLaunchFiles();
      if (this.disposed || lifecycle !== this.lifecycle) return;
      const settings = this.getSettings?.() ?? { deviceMode: 'auto' as const };
      this.publish({ state: 'starting', message: 'Recording the private runtime and dependency versions…', url: undefined });
      const identityAbort = new AbortController(); this.identityAbort = identityAbort;
      try { this.runtimeIdentity = await captureRuntimeIdentity(this.paths, settings, identityAbort.signal); }
      finally { if (this.identityAbort === identityAbort) this.identityAbort = undefined; }
      const port = await reserveBackendPort();
      if (this.disposed || lifecycle !== this.lifecycle) return;
      this.activeUrl = `http://127.0.0.1:${port}`;
      this.publish({ state: 'starting', message: 'Starting your dedicated ComfyUI backend…', url: this.activeUrl, version: this.expectedVersion });
      const environment = runtimeEnvironment(this.paths);
      environment.LATENT_PARENT_PID = String(process.pid);
      environment.LATENT_BACKEND_MAIN = path.join(this.paths.backend, 'main.py');
      environment.LATENT_BACKEND_ROOT = this.paths.root;
      const child = spawn(this.paths.python, backendArguments(this.paths, port, settings), { cwd: this.paths.backend, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child;
      let spawnError: Error | undefined;
      child.stdout?.on('data', (data: Buffer) => this.log(data.toString('utf8')));
      child.stderr?.on('data', (data: Buffer) => this.log(data.toString('utf8')));
      child.once('error', (error) => {
        spawnError = error;
        if (this.child !== child) return;
        this.log(errorMessage(error));
        this.publish({ state: 'error', message: `Could not start ComfyUI: ${errorMessage(error)}`, url: undefined });
      });
      child.once('exit', (code, signal) => {
        if (this.child !== child) return;
        this.child = undefined;
        this.activeUrl = null;
        this.clearHeartbeat();
        if (!this.stopping && !this.disposed) {
          this.log(`ComfyUI exited (${signal ?? code}).`);
          this.publish({ state: 'error', message: `ComfyUI stopped unexpectedly (exit ${signal ?? code}). Restart it to reconnect.`, url: undefined });
        }
      });
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        if (this.disposed || this.stopping || lifecycle !== this.lifecycle) return;
        if (spawnError) throw spawnError;
        if (this.child !== child || child.exitCode !== null) throw new Error(child.exitCode === 12
          ? 'Another Latent v2 backend already owns this studio. Close the other app or verification run before starting.'
          : 'ComfyUI exited during startup. See the backend log for details.');
        if (await this.probe()) {
          if (this.child !== child || this.stopping || lifecycle !== this.lifecycle) return;
          this.publish({ state: 'ready', message: 'ComfyUI is connected and ready.', url: this.activeUrl ?? undefined });
          this.monitor(child);
          return;
        }
        await delay(650);
      }
      throw new Error('ComfyUI did not become ready within three minutes. Check the backend log and retry.');
    } catch (error) {
      if (this.stopping || this.disposed || lifecycle !== this.lifecycle) return;
      if (this.child) { const child = this.child; this.child = undefined; await this.terminate(child); }
      this.activeUrl = null;
      this.runtimeIdentity = undefined;
      this.log(errorMessage(error));
      this.publish({ state: 'error', message: errorMessage(error), url: undefined });
      throw error;
    }
  }

  private async probe(): Promise<boolean> {
    if (!this.activeUrl) return false;
    try {
      const response = await fetch(`${this.activeUrl}/system_stats`, { signal: AbortSignal.timeout(2500) });
      if (!response.ok) return false;
      return isManagedSystemStats(await response.json(), this.paths, this.expectedVersion);
    } catch { return false; }
  }

  private monitor(child: ChildProcess): void {
    this.clearHeartbeat();
    let misses = 0;
    let pending = false;
    this.heartbeat = setInterval(() => {
      if (pending || this.child !== child || this.stopping || this.disposed) return;
      pending = true;
      void this.probe().then((ready) => {
        if (this.child !== child || this.stopping || this.disposed) return;
        if (ready) {
          misses = 0;
          if (this.current.state !== 'ready') this.publish({ state: 'ready', message: 'ComfyUI reconnected.', url: this.activeUrl ?? undefined });
        } else if (++misses >= 3) this.publish({ state: 'starting', message: 'Connection interrupted. Waiting for your backend to respond…', url: this.activeUrl ?? undefined });
      }).finally(() => { pending = false; });
    }, 10_000);
    this.heartbeat.unref();
  }

  private clearHeartbeat(): void { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined; }

  private async terminate(child: ChildProcess): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      // venv's launcher has a Python child on Windows: terminate only the tree we spawned.
      await new Promise<void>((resolve, reject) => {
        const taskkill = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', reject);
        killer.once('exit', (code) => {
          if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
          else reject(new Error(`Could not stop the owned backend process ${child.pid}.`));
        });
      });
    } else child.kill('SIGTERM');
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, 5000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });
    if (child.exitCode === null && child.signalCode === null) throw new Error(`The owned backend process ${child.pid} did not stop.`);
  }

  private async stopOwnedProcesses(): Promise<void> {
    this.stopping = true;
    ++this.lifecycle;
    this.abort?.abort();
    this.identityAbort?.abort();
    this.runtimeIdentity = undefined;
    this.clearHeartbeat();
    try {
      const installer = this.installer;
      const child = this.child;
      if (installer) await this.terminate(installer);
      if (child) await this.terminate(child);
      await Promise.allSettled([this.setupPromise, this.startPromise].filter(Boolean));
      this.child = undefined;
      this.installer = undefined;
      this.activeUrl = null;
      this.publish({ state: this.readMarker() ? 'stopped' : 'not-installed', message: this.readMarker() ? 'Your backend is stopped.' : 'Setup is incomplete. Run setup to resume.', url: undefined, installProgress: undefined });
    } catch (error) {
      this.log(errorMessage(error));
      this.publish({ state: 'error', message: errorMessage(error), url: undefined });
      throw error;
    } finally { this.stopping = false; }
  }
}

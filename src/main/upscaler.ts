import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AppPaths } from '../shared/types';
import type { ReviewedUpscalerAsset, UpscalerStatus } from '../shared/advanced-image-types';
import type { StudioStore } from './store';
import { assistantHash, downloadAssistantAsset } from './assistant-download';
import { containedPath, runtimeEnvironment, validateRuntimePaths } from './runtime-config';
import { withReviewedAssetLock } from './reviewed-asset-lock';

export const UPSCALER_RELEASE = Object.freeze({
  id: 'realesrgan-anime-6b-x4', name: 'Real-ESRGAN Anime 6B ×4', filename: 'RealESRGAN_x4plus_anime_6B.pth',
  bytes: 17938799, sha256: 'f872d837d3c90ed2e05227bed711af5671a6fd1c9f7d7e91c911a61f155e99da',
  url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth',
  repository: 'xinntao/Real-ESRGAN', version: 'v0.2.2.4', revision: 'f83472d0113b8af82b5c5dcaa6e5a9dc88e466a7',
  licenseUrl: 'https://raw.githubusercontent.com/xinntao/Real-ESRGAN/f83472d0113b8af82b5c5dcaa6e5a9dc88e466a7/LICENSE',
  licenseBytes: 1519, licenseSha256: '4a699ec4863d96a91fc265948a0c90033f7e8735d515524dcf3444736406e0c2',
} as const);

/** No Real-ESRGAN package, arbitrary pickle, model inference, or GPU initialization is needed. */
export function upscalerValidationProgram(): string {
  return `import os, sys, json, hashlib, importlib.metadata
os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
import torch
from spandrel import ModelLoader, ImageModelDescriptor
torch.set_num_threads(1)
torch.set_grad_enabled(False)
with open(sys.argv[1], 'rb') as file:
    if hashlib.file_digest(file, 'sha256').hexdigest() != sys.argv[2]:
        raise RuntimeError('Upscaler bytes changed before safe inspection.')
state = torch.load(sys.argv[1], map_location='cpu', weights_only=True)
model = ModelLoader().load_from_state_dict(state).eval()
parameters = sum(parameter.numel() for parameter in model.model.parameters())
if not isinstance(model, ImageModelDescriptor) or model.architecture.id != 'ESRGAN' or model.scale != 4 or model.input_channels != 3 or model.output_channels != 3 or parameters != 4467779:
    raise RuntimeError('The publisher upscaler has an unexpected architecture.')
device = str(next(model.model.parameters()).device)
if device != 'cpu': raise RuntimeError('Upscaler inspection must stay on CPU.')
print(json.dumps({'pythonVersion':sys.version.split()[0], 'torchVersion':torch.__version__, 'spandrelVersion':importlib.metadata.version('spandrel'), 'parameters':parameters, 'device':device}), flush=True)
`;
}
export function upscalerPaths(paths: AppPaths) { const runtime = path.join(paths.runtime, 'upscaler'); return { runtime, directory: path.join(paths.models, 'upscale_models'), model: path.join(paths.models, 'upscale_models', UPSCALER_RELEASE.filename), cache: path.join(paths.cache, 'upscaler'), marker: path.join(runtime, 'installed.json') }; }

export class UpscalerService {
  private files;
  private current: UpscalerStatus;
  private setupPromise?: Promise<ReviewedUpscalerAsset>;
  private verifyPromise?: Promise<ReviewedUpscalerAsset>;
  private controller?: AbortController;
  private validator?: ChildProcess;
  private disposed = false;
  constructor(private paths: AppPaths, private store: StudioStore, private changed: () => void) {
    this.files = upscalerPaths(paths); this.validatePaths(); const asset = this.receipt();
    this.current = { state: asset ? 'ready' : 'not-installed', message: asset ? 'Illustration upscaler is ready. Model files are checked before use.' : 'Optional reviewed anime upscaler (17.94 MB).', asset };
  }
  status(): UpscalerStatus { return structuredClone(this.current); }
  private update(patch: Partial<UpscalerStatus>) { this.current = { ...this.current, ...patch }; this.changed(); }
  private validatePaths() {
    validateRuntimePaths(this.paths);
    for (const target of Object.values(this.files)) { containedPath(storageBoundary(this.paths, target), target); let cursor = target; while (cursor !== storageBoundary(this.paths, target)) { try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Reviewed upscaler storage cannot use symbolic links or junctions.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } cursor = path.dirname(cursor); } }
  }
  private receipt(): ReviewedUpscalerAsset | undefined {
    try { const receipt = JSON.parse(fs.readFileSync(this.files.marker, 'utf8')) as ReviewedUpscalerAsset; const stat = fs.lstatSync(this.files.model); if (receipt.id !== UPSCALER_RELEASE.id || receipt.filename !== UPSCALER_RELEASE.filename || receipt.sha256 !== UPSCALER_RELEASE.sha256 || receipt.bytes !== UPSCALER_RELEASE.bytes || receipt.status !== 'ready' || receipt.loaderPolicy !== 'pinned-publisher-weights-only' || receipt.architecture !== 'ESRGAN' || receipt.scale !== 4 || receipt.inputChannels !== 3 || receipt.outputChannels !== 3 || receipt.provenance.repository !== UPSCALER_RELEASE.repository || receipt.provenance.revision !== UPSCALER_RELEASE.revision || receipt.provenance.sourceUrl !== UPSCALER_RELEASE.url || receipt.provenance.version !== UPSCALER_RELEASE.version || receipt.provenance.licenseName !== 'BSD-3-Clause' || receipt.provenance.licenseUrl !== UPSCALER_RELEASE.licenseUrl || receipt.validation.device !== 'cpu' || receipt.validation.parameters !== 4467779 || stat.size !== UPSCALER_RELEASE.bytes || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return undefined; return receipt; } catch { return undefined; }
  }
  setup(repair = false): Promise<ReviewedUpscalerAsset> {
    if (this.disposed) return Promise.reject(new Error('The upscaler service was disposed.'));
    if (this.setupPromise) return this.setupPromise;
    if (this.verifyPromise) return Promise.reject(new Error('Wait for the upscaler verification to finish.'));
    const controller = new AbortController(); this.controller = controller;
    this.setupPromise = this.install(controller.signal, repair).catch(error => { this.update({ state: controller.signal.aborted ? this.receipt() ? 'ready' : 'not-installed' : 'error', message: controller.signal.aborted ? 'Upscaler setup canceled.' : `Upscaler setup failed: ${error.message}`, asset: this.receipt() }); throw error; }).finally(() => { this.setupPromise = undefined; this.controller = undefined; }); return this.setupPromise;
  }
  private async install(signal: AbortSignal, repair: boolean): Promise<ReviewedUpscalerAsset> {
    this.validatePaths(); if (!fs.existsSync(this.paths.python)) throw new Error('Install the private image-engine runtime before setting up the upscaler.');
    return withReviewedAssetLock(this.paths, UPSCALER_RELEASE.id, signal, ownedSignal => this.installOwned(ownedSignal, repair));
  }
  private async installOwned(signal: AbortSignal, repair: boolean): Promise<ReviewedUpscalerAsset> {
    for (const directory of [this.files.runtime, this.files.cache, this.files.directory]) await fs.promises.mkdir(directory, { recursive: true });
    this.update({ state: 'installing', message: 'Preparing the reviewed anime upscaler…', installProgress: 0, asset: undefined });
    const asset = { url: UPSCALER_RELEASE.url, filename: UPSCALER_RELEASE.filename, bytes: UPSCALER_RELEASE.bytes, sha256: UPSCALER_RELEASE.sha256 };
    if (repair && fs.existsSync(this.files.model)) {
      const stat = await fs.promises.lstat(this.files.model);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Upscaler repair requires an independent regular model file.');
      if (await assistantHash(this.files.model, signal) !== UPSCALER_RELEASE.sha256) {
        signal.throwIfAborted(); this.validatePaths();
        const preserved = this.files.model + '.preserved-' + randomUUID();
        await fs.promises.rename(this.files.model, preserved);
        this.update({ message: 'Changed upscaler preserved beside the original path. Installing the reviewed replacement…' });
      }
    }
    const acquired = path.join(this.files.cache, `${asset.filename}.acquired`);
    if (fs.existsSync(acquired) && !fs.existsSync(this.files.model) && !fs.existsSync(`${this.files.model}.part`)) {
      if (fs.statSync(acquired).size !== asset.bytes || await assistantHash(acquired, signal) !== asset.sha256) throw new Error('The acquired upscaler does not match the reviewed publisher bytes.');
      const free = await fs.promises.statfs(this.files.directory);
      if (free.bavail * free.bsize < asset.bytes + 256 * 1024 * 1024) throw new Error('Not enough free space to install the cached illustration upscaler. Free space and retry; the cached model is preserved.');
      signal.throwIfAborted();
      await fs.promises.copyFile(acquired, `${this.files.model}.part`, fs.constants.COPYFILE_EXCL); await fs.promises.writeFile(`${this.files.model}.part.json`, JSON.stringify(asset), { flag: 'wx' });
    }
    await downloadAssistantAsset(asset, this.files.directory, signal, (received, total, verifying) => this.update({ message: verifying ? 'Verifying upscaler checksum…' : 'Downloading the reviewed anime upscaler…', installProgress: received / total * 85 }));
    await downloadAssistantAsset({ url: UPSCALER_RELEASE.licenseUrl, filename: 'LICENSE-RealESRGAN.txt', bytes: UPSCALER_RELEASE.licenseBytes, sha256: UPSCALER_RELEASE.licenseSha256 }, this.files.runtime, signal, () => undefined);
    this.update({ message: 'Inspecting the pinned tensor weights on CPU…', installProgress: 90 });
    const validation = await this.inspect(signal); signal.throwIfAborted();
    const reviewed: ReviewedUpscalerAsset = { id: UPSCALER_RELEASE.id, name: UPSCALER_RELEASE.name, filename: UPSCALER_RELEASE.filename, bytes: UPSCALER_RELEASE.bytes, sha256: UPSCALER_RELEASE.sha256, scale: 4, inputChannels: 3, outputChannels: 3, architecture: 'ESRGAN', status: 'ready', loaderPolicy: 'pinned-publisher-weights-only', provenance: { repository: UPSCALER_RELEASE.repository, revision: UPSCALER_RELEASE.revision, version: UPSCALER_RELEASE.version, sourceUrl: UPSCALER_RELEASE.url, licenseName: 'BSD-3-Clause', licenseUrl: UPSCALER_RELEASE.licenseUrl }, verifiedAt: new Date().toISOString(), validation };
    const temporary = `${this.files.marker}.${randomUUID()}.tmp`; await fs.promises.writeFile(temporary, JSON.stringify(reviewed, null, 2), { flag: 'wx' }); signal.throwIfAborted(); await fs.promises.rename(temporary, this.files.marker);
    this.store.setState('upscaler.installation', reviewed); this.update({ state: 'ready', message: 'Illustration upscaler is ready. Model files are checked before use.', asset: reviewed, installProgress: 100 }); return structuredClone(reviewed);
  }
  private async inspect(signal: AbortSignal): Promise<ReviewedUpscalerAsset['validation']> {
    const env: NodeJS.ProcessEnv = { ...runtimeEnvironment(this.paths), CUDA_VISIBLE_DEVICES: '-1' };
    for (const key of ['TEMP', 'HOME', 'APPDATA', 'LOCALAPPDATA'] as const) if (env[key]) await fs.promises.mkdir(env[key]!, { recursive: true }); signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.paths.python, ['-I', '-B', '-c', upscalerValidationProgram(), this.files.model, UPSCALER_RELEASE.sha256], { cwd: this.files.runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); this.validator = child;
      let stdout = ''; let stderr = ''; let failed: Error | undefined;
      const stop = () => { void this.killValidator().catch(error => { failed = error; }); };
      const abort = () => { failed = new Error('Upscaler inspection canceled.'); stop(); };
      const timer = setTimeout(() => { failed = new Error('Upscaler CPU inspection timed out.'); stop(); }, 90_000);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout?.on('data', chunk => { stdout += String(chunk); if (stdout.length > 64_000) { failed = new Error('Upscaler inspection exceeded its output bound.'); stop(); } });
      child.stderr?.on('data', chunk => { stderr = `${stderr}${String(chunk)}`.slice(-5000); });
      child.on('error', error => { failed = error; });
      child.on('close', code => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); if (this.validator === child) this.validator = undefined;
        if (failed || code !== 0) { reject(failed ?? new Error(stderr || `Upscaler inspector exited (${code}).`)); return; }
        try { const result = JSON.parse(stdout); if (result.device !== 'cpu' || result.parameters !== 4467779 || ![result.pythonVersion, result.torchVersion, result.spandrelVersion].every(value => typeof value === 'string')) throw new Error('Invalid upscaler inspection result.'); resolve(result); } catch (error) { reject(error); }
      });
      if (signal.aborted) abort();
    });
  }
  verify(): Promise<ReviewedUpscalerAsset> {
    if (this.disposed) return Promise.reject(new Error('The upscaler service was disposed.'));
    if (this.setupPromise) return this.setupPromise;
    if (this.verifyPromise) return this.verifyPromise;
    this.verifyPromise = (async () => { this.validatePaths(); const receipt = this.receipt(); if (!receipt) throw new Error('Install the reviewed anime upscaler before selecting learned enhancement.'); if (await assistantHash(this.files.model) !== UPSCALER_RELEASE.sha256) throw new Error('The upscaler changed after verification. Repair the illustration upscaler to preserve this file and reinstall the reviewed model.'); return structuredClone(receipt); })().catch(error => { this.update({ state: 'error', message: error.message, asset: undefined }); throw error; }).finally(() => { this.verifyPromise = undefined; }); return this.verifyPromise;
  }
  private async killValidator() { const child = this.validator; if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return; if (process.platform === 'win32') await new Promise<void>((resolve, reject) => { const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('close', () => resolve()); killer.on('error', reject); }); else child.kill('SIGTERM'); }
  async cancel(): Promise<void> { this.controller?.abort(); await this.killValidator(); await this.setupPromise?.catch(() => undefined); }
  async dispose(): Promise<void> { this.disposed = true; await this.cancel(); await this.verifyPromise?.catch(() => undefined); }
}

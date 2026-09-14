import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import type { AppPaths } from '../shared/types';
import type { SegmentationRequest, SegmentationStatus, SegmentationSuggestion } from '../shared/segmentation-types';
import type { StudioStore } from './store';
import { SourceImageService } from './source-images';
import { runtimeEnvironment, validateRuntimePaths, containedPath } from './runtime-config';
import { assistantHash, downloadAssistantAsset } from './assistant-download';
import { extractRuntimeZip } from './runtime-archive';
import { withReviewedAssetLock } from './reviewed-asset-lock';

export const SEGMENTATION_RELEASE = Object.freeze({
  schema: 1, model: 'SAM ViT-B', codeRevision: 'dca509fe793f601edb92606367a655c15ac00fdf',
  codeUrl: 'https://codeload.github.com/facebookresearch/segment-anything/zip/dca509fe793f601edb92606367a655c15ac00fdf',
  codeFilename: 'sam-source.zip', codeBytes: 19177271, codeSha256: '775a9fa2ea5441a7f532c77a9a193fec21764ef59e008bbdd595fee84e3aaab6',
  modelUrl: 'https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth', modelFilename: 'sam_vit_b_01ec64.pth',
  modelBytes: 375042383, modelSha256: 'ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912',
  license: 'Apache-2.0', maxPixels: 4194304, maxPoints: 64,
});
const requestSchema = z.object({ sourceId: z.string().regex(/^src_[0-9a-f-]{36}$/), points: z.array(z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), label: z.union([z.literal(0), z.literal(1)]) }).strict()).max(64), box: z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative(), width: z.number().finite().min(1), height: z.number().finite().min(1) }).strict().optional() }).strict().refine(value => value.points.length || value.box, 'Add a point or rectangle.');
export function validateSegmentationRequest(input: SegmentationRequest, width: number, height: number): SegmentationRequest {
  const request = requestSchema.parse(input);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > SEGMENTATION_RELEASE.maxPixels || Math.max(width, height) > 8192) throw new Error('Experimental smart masks currently support sources up to 4 megapixels.');
  if (request.points.some(point => point.x >= width || point.y >= height) || (request.box && (request.box.x + request.box.width > width || request.box.y + request.box.height > height))) throw new Error('Smart-mask prompts must stay inside the normalized source image.');
  return structuredClone(request);
}
export function segmentationPaths(paths: AppPaths) {
  const runtime = path.join(paths.runtime, 'segmentation');
  return { runtime, code: path.join(runtime, 'sam'), modelDirectory: path.join(paths.models, 'segmentation'), model: path.join(paths.models, 'segmentation', SEGMENTATION_RELEASE.modelFilename), cache: path.join(paths.cache, 'segmentation'), marker: path.join(runtime, 'installed.json'), worker: path.join(runtime, 'segmentation-worker.py'), log: path.join(paths.logs, 'segmentation.log') };
}
function workerResource(): string {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [resources && path.join(resources, 'app.asar.unpacked', 'dist-electron', 'resources', 'segmentation-worker.py'), path.join(__dirname, 'resources', 'segmentation-worker.py'), path.resolve(__dirname, '../../resources/segmentation-worker.py')].filter(Boolean) as string[];
  const found = candidates.find(filename => fs.existsSync(filename));
  if (!found) throw new Error('The application smart-mask worker resource is missing. Rebuild or reinstall the app.');
  return found;
}
type Installation = { release: typeof SEGMENTATION_RELEASE; installedAt: string; codeFiles: Record<string, string> };
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class SegmentationService {
  private files;
  private sources: SourceImageService;
  private current: SegmentationStatus;
  private child?: ChildProcess;
  private setupPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private workerPython?: string;
  private setupController?: AbortController;
  private pending = new Map<string, Pending>();
  private request?: { id: string; controller: AbortController; promise: Promise<SegmentationSuggestion>; committing: boolean };
  private epoch = 0;
  private disposed = false;
  constructor(private paths: AppPaths, private store: StudioStore, private changed: () => void, sources?: SourceImageService) {
    this.files = segmentationPaths(paths); this.validatePaths(); this.sources = sources ?? new SourceImageService(paths, store);
    const installed = Boolean(this.installation());
    this.current = { installationAvailable: installed, state: installed ? 'stopped' : 'not-installed', message: installed ? 'Smart masks installed. Start when needed.' : 'Optional experimental SAM smart masks (375 MB).', model: 'SAM ViT-B', device: 'cpu', experimental: true, logTail: [] };
  }
  status(): SegmentationStatus { return structuredClone(this.current); }
  private update(patch: Partial<SegmentationStatus>) {
    const installationAvailable = patch.state && ['error', 'stopped', 'not-installed'].includes(patch.state) ? Boolean(this.installation()) : this.current.installationAvailable;
    this.current = { ...this.current, ...patch, installationAvailable }; this.changed();
  }
  private validatePaths() {
    validateRuntimePaths(this.paths);
    for (const target of Object.values(this.files)) {
      containedPath(storageBoundary(this.paths, target), target); let cursor = target;
      while (cursor !== storageBoundary(this.paths, target)) {
        try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Smart-mask storage cannot use symbolic links or junctions.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        cursor = path.dirname(cursor);
      }
    }
  }
  private installation(): Installation | undefined {
    try { const marker = JSON.parse(fs.readFileSync(this.files.marker, 'utf8')); if (JSON.stringify(marker.release) !== JSON.stringify(SEGMENTATION_RELEASE) || !marker.codeFiles || !Object.keys(marker.codeFiles).length || fs.statSync(this.files.model).size !== SEGMENTATION_RELEASE.modelBytes) return undefined; return marker; } catch { return undefined; }
  }
  setup(repair = false): Promise<void> {
    if (this.disposed || this.stopPromise) return Promise.reject(new Error('The smart-mask service is stopping or disposed.'));
    if (this.setupPromise) return this.setupPromise;
    if (this.child) return Promise.reject(new Error('Stop smart masks before changing their installation.'));
    this.setupController = new AbortController();
    this.setupPromise = withReviewedAssetLock(this.paths, 'sam-vit-b', this.setupController.signal, signal => this.install(signal, repair)).catch(error => { if (!this.setupController?.signal.aborted) this.update({ state: 'error', message: `Smart-mask setup failed: ${error.message}` }); throw error; }).finally(() => { this.setupPromise = undefined; this.setupController = undefined; });
    return this.setupPromise;
  }
  private async install(signal: AbortSignal, repair: boolean) {
    this.validatePaths();
    if (!fs.existsSync(this.paths.python)) throw new Error('Install the private Comfy runtime first; smart masks reuse its isolated Python libraries.');
    for (const directory of [this.files.runtime, this.files.cache, this.files.modelDirectory, this.paths.logs]) await fs.promises.mkdir(directory, { recursive: true });
    this.update({ state: 'installing', message: 'Verifying the private SAM assets…', installProgress: 0 });
    const release = SEGMENTATION_RELEASE;
    const assets = [{ url: release.codeUrl, filename: release.codeFilename, bytes: release.codeBytes, sha256: release.codeSha256, directory: this.files.cache }, { url: release.modelUrl, filename: release.modelFilename, bytes: release.modelBytes, sha256: release.modelSha256, directory: this.files.modelDirectory }];
    const downloaded: string[] = [];
    for (const [index, asset] of assets.entries()) {
      // Authorized acquisition evidence can seed the same verified, resumable publication path.
      const acquired = path.join(this.files.cache, `${asset.filename}.acquired`); const target = path.join(asset.directory, asset.filename);
      if (repair && fs.existsSync(target)) {
        this.validatePaths(); const stat = await fs.promises.lstat(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('SAM repair requires independent regular files. The existing asset was preserved.');
        if (stat.size !== asset.bytes || await assistantHash(target, signal) !== asset.sha256) {
          signal.throwIfAborted(); this.validatePaths();
          await fs.promises.rename(target, `${target}.preserved-${randomUUID()}`);
        }
      }
      if (fs.existsSync(acquired) && !fs.existsSync(target) && !fs.existsSync(`${target}.part`)) {
        if (fs.statSync(acquired).size !== asset.bytes || await assistantHash(acquired, signal) !== asset.sha256) throw new Error('The acquired SAM asset failed its pinned checksum.');
        const free = await fs.promises.statfs(asset.directory);
        if (free.bavail * free.bsize < asset.bytes + 256 * 1024 * 1024) throw new Error('Not enough free space to install the cached SAM asset. Free space and retry; the cached file is preserved.');
        signal.throwIfAborted();
        await fs.promises.copyFile(acquired, `${target}.part`, fs.constants.COPYFILE_EXCL);
        await fs.promises.writeFile(`${target}.part.json`, JSON.stringify(asset), { flag: 'wx' });
      }
      downloaded.push(await downloadAssistantAsset(asset, asset.directory, signal, (received, total, verifying) => this.update({ message: `${verifying ? 'Verifying' : 'Downloading'} ${index ? 'SAM ViT-B weights' : 'official SAM source'}…`, installProgress: index ? 10 + 90 * received / total : 10 * received / total })));
    }
    const stage = path.join(this.files.runtime, `sam-stage-${randomUUID()}`); await fs.promises.mkdir(stage);
    await extractRuntimeZip(downloaded[0], stage, `segment-anything-${release.codeRevision}/`); signal.throwIfAborted();
    const codeFiles: Record<string, string> = {};
    const inventory = async (directory: string) => { for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) { const filename = containedPath(stage, path.join(directory, entry.name)); if (entry.isDirectory()) await inventory(filename); else if (entry.isFile()) codeFiles[path.relative(stage, filename)] = await assistantHash(filename, signal); else throw new Error('Unexpected entry in SAM source.'); } };
    await inventory(stage); signal.throwIfAborted();
    if (fs.existsSync(this.files.code)) await fs.promises.rename(this.files.code, `${this.files.code}.previous-${randomUUID()}`);
    await fs.promises.rename(stage, this.files.code);
    const marker: Installation = { release, installedAt: new Date().toISOString(), codeFiles };
    const temporary = `${this.files.marker}.${randomUUID()}.tmp`; await fs.promises.writeFile(temporary, JSON.stringify(marker, null, 2), { flag: 'wx' }); signal.throwIfAborted(); await fs.promises.rename(temporary, this.files.marker);
    this.store.setState('segmentation.installation', marker);
    this.update({ state: 'stopped', message: 'SAM is installed. Smart masks remain experimental and reviewable.', installProgress: 100 });
  }
  start(): Promise<void> {
    if (this.disposed || this.stopPromise) return Promise.reject(new Error('The smart-mask service is stopping or disposed.'));
    if (this.startPromise) return this.startPromise;
    // Finish accepted inference on its retained environment. The next request
    // reloads an idle worker if an update or rollback selected another Python.
    if (this.child && (this.current.state === 'segmenting' || this.current.state === 'ready' && this.workerPython === this.paths.python)) return Promise.resolve();
    const epoch = ++this.epoch;
    this.startPromise = (async () => {
      if (this.child) await this.killOwned();
      do {
        await this.launch(epoch);
        if (this.workerPython === this.paths.python) return;
        await this.killOwned();
      } while (epoch === this.epoch);
      throw new Error('Smart-mask startup canceled.');
    })().catch(async error => { if (epoch === this.epoch) { await this.killOwned(); this.update({ state: 'error', message: `Smart-mask startup failed: ${error.message}` }); } throw error; }).finally(() => { this.startPromise = undefined; });
    return this.startPromise;
  }
  private async launch(epoch: number) {
    if (this.setupPromise) await this.setupPromise;
    this.validatePaths(); const marker = this.installation(); if (!marker) throw new Error('Install SAM before starting smart masks.');
    this.update({ state: 'starting', message: 'Verifying and loading SAM on CPU…' });
    for (const [relative, expected] of Object.entries(marker.codeFiles)) { const filename = containedPath(this.files.code, path.join(this.files.code, relative)); if (!/^[a-f0-9]{64}$/.test(expected) || fs.lstatSync(filename).isSymbolicLink() || await assistantHash(filename) !== expected) throw new Error('SAM source changed after installation. Run setup to restore its pinned code.'); }
    if (await assistantHash(this.files.model) !== SEGMENTATION_RELEASE.modelSha256) throw new Error('SAM weights changed after installation. Use Verify / repair SAM to preserve this file and reinstall the reviewed weights.');
    if (epoch !== this.epoch) throw new Error('Smart-mask startup canceled.');
    await fs.promises.copyFile(workerResource(), this.files.worker);
    const env: NodeJS.ProcessEnv = { ...runtimeEnvironment(this.paths), CUDA_VISIBLE_DEVICES: '-1', PYTHONDONTWRITEBYTECODE: '1' };
    for (const key of ['TEMP', 'HOME', 'APPDATA', 'LOCALAPPDATA'] as const) if (env[key]) await fs.promises.mkdir(env[key]!, { recursive: true });
    if (epoch !== this.epoch) throw new Error('Smart-mask startup canceled.');
    const ready = this.waitFor('ready', 120_000); ready.catch(() => undefined);
    const python = this.paths.python;
    const child = spawn(python, ['-I', '-B', '-u', this.files.worker, this.paths.root, this.files.code, this.files.model, SEGMENTATION_RELEASE.modelSha256, String(process.pid), String(Math.min(8, Math.max(1, os.availableParallelism())))], { cwd: this.files.runtime, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.workerPython = python;
    this.child = child; let buffered = '';
    child.stdin?.on('error', error => this.rejectPending(error));
    child.stdout?.setEncoding('utf8'); child.stdout?.on('data', (chunk: string) => {
      buffered += chunk;
      if (buffered.length > 12_000_000) { this.rejectPending(new Error('The smart-mask worker exceeded its response bound.')); void this.killOwned(); return; }
      while (buffered.includes('\n')) { const end = buffered.indexOf('\n'); const line = buffered.slice(0, end); buffered = buffered.slice(end + 1); if (!line.trim()) continue; try { this.receive(JSON.parse(line)); } catch { this.rejectPending(new Error('The smart-mask worker returned malformed data.')); void this.killOwned(); } }
    });
    child.stderr?.on('data', chunk => { const lines = String(chunk).split(/\r?\n/).filter(Boolean); this.update({ logTail: [...this.current.logTail, ...lines].slice(-40) }); try { fs.appendFileSync(this.files.log, `${lines.join('\n')}\n`); } catch { /* Diagnostic only. */ } });
    child.on('error', error => this.rejectPending(error));
    child.on('close', code => { if (this.child !== child) return; this.child = undefined; this.rejectPending(new Error(`Smart-mask worker exited (${code ?? 'unknown'}).`)); if (epoch === this.epoch) this.update({ state: 'error', requestId: undefined, message: 'Smart-mask worker exited. Start again to retry.' }); });
    const health = await ready;
    if (epoch !== this.epoch || this.child !== child) throw new Error('Smart-mask startup canceled.');
    if (health.device !== 'cpu' || health.modelSha256 !== SEGMENTATION_RELEASE.modelSha256) throw new Error('The smart-mask worker loaded an unexpected model/device.');
    this.store.setState('segmentation.runtime', { modelSha256: health.modelSha256, device: health.device, python, pythonVersion: health.pythonVersion, torchVersion: health.torchVersion, threads: health.threads, checkedAt: new Date().toISOString() });
    this.update({ state: 'ready', message: 'Experimental SAM smart masks ready on CPU. Review every selection.' });
  }
  private waitFor(id: string, timeout: number): Promise<any> { return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Smart-mask inference timed out. Retry with a smaller source.')); void this.killOwned(); }, timeout); this.pending.set(id, { resolve, reject, timer }); }); }
  private receive(message: any) { const id = message.type === 'ready' || message.type === 'fatal' ? 'ready' : message.id; const pending = this.pending.get(id); if (!pending) return; clearTimeout(pending.timer); this.pending.delete(id); if (['error', 'fatal'].includes(message.type)) pending.reject(new Error(String(message.error).slice(0, 1000))); else if (['ready', 'result'].includes(message.type)) pending.resolve(message); else pending.reject(new Error('Unexpected smart-mask response type.')); }
  private rejectPending(error: Error) { for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); } this.pending.clear(); }
  suggest(input: SegmentationRequest): Promise<SegmentationSuggestion> {
    if (this.disposed || this.request) return Promise.reject(new Error('Wait for the current smart-mask request, or cancel it first.'));
    const parsed = requestSchema.safeParse(input); if (!parsed.success) return Promise.reject(parsed.error);
    const task = { id: randomUUID(), controller: new AbortController(), promise: undefined as unknown as Promise<SegmentationSuggestion>, committing: false }; this.request = task;
    task.promise = this.segment(structuredClone(parsed.data), task).finally(() => { if (this.request === task) { this.request = undefined; if (this.current.state === 'segmenting' && !task.controller.signal.aborted) this.update({ state: this.child ? 'ready' : 'stopped', requestId: undefined, message: this.child ? 'Smart masks ready for another selection.' : 'Smart masks stopped.' }); } });
    return task.promise;
  }
  private async segment(input: SegmentationRequest, task: NonNullable<SegmentationService['request']>): Promise<SegmentationSuggestion> {
    const started = Date.now(); const signal = task.controller.signal;
    const resolved = await this.sources.resolve(input.sourceId); signal.throwIfAborted();
    const request = validateSegmentationRequest(input, resolved.source.normalized.width, resolved.source.normalized.height);
    await this.start(); signal.throwIfAborted();
    this.update({ state: 'segmenting', message: 'Finding the selected object on CPU…', requestId: task.id });
    const response = this.waitFor(task.id, 120_000);
    this.child!.stdin!.write(`${JSON.stringify({ id: task.id, ...request, sourcePath: resolved.normalizedPath, sourceSha256: resolved.source.normalized.sha256, width: resolved.source.normalized.width, height: resolved.source.normalized.height })}\n`);
    const result = await response; signal.throwIfAborted();
    const metadata = z.object({ width: z.number().int(), height: z.number().int(), predictedQuality: z.number().finite(), selectedPixels: z.number().int().nonnegative(), pointPromptsSatisfied: z.boolean(), embeddingCacheHit: z.boolean(), embeddingMs: z.number().nonnegative(), inferenceMs: z.number().nonnegative(), png: z.string().min(1).max(10_000_000) }).parse(result);
    if (metadata.width !== resolved.source.normalized.width || metadata.height !== resolved.source.normalized.height || metadata.selectedPixels > metadata.width * metadata.height || !/^[A-Za-z0-9+/]*={0,2}$/.test(metadata.png)) throw new Error('Smart-mask output does not match its source.');
    signal.throwIfAborted(); task.committing = true;
    const mask = await this.sources.saveMask(input.sourceId, Buffer.from(metadata.png, 'base64'));
    const suggestion: SegmentationSuggestion = { id: task.id, createdAt: new Date().toISOString(), mask, request, sourceSha256: resolved.source.normalized.sha256, model: 'SAM ViT-B', modelSha256: SEGMENTATION_RELEASE.modelSha256, codeRevision: SEGMENTATION_RELEASE.codeRevision, predictedQuality: metadata.predictedQuality, selectedPixels: metadata.selectedPixels, pointPromptsSatisfied: metadata.pointPromptsSatisfied, embeddingCacheHit: metadata.embeddingCacheHit, embeddingMs: metadata.embeddingMs, inferenceMs: metadata.inferenceMs, durationMs: Date.now() - started };
    this.store.setState(`segmentation.mask:${mask.id}`, suggestion); return suggestion;
  }
  async cancel(): Promise<void> {
    const task = this.request; if (!task) return;
    if (task.committing) { await task.promise.catch(() => undefined); return; }
    task.controller.abort(new Error('Smart-mask request canceled.')); this.epoch += 1;
    await this.killOwned(); await task.promise.catch(() => undefined);
    this.update({ state: this.installation() ? 'stopped' : 'not-installed', message: 'Smart-mask request canceled. Start again when needed.', requestId: undefined });
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.epoch += 1; this.setupController?.abort(); if (!this.request?.committing) this.request?.controller.abort(new Error('Smart-mask request canceled.'));
    this.stopPromise = (async () => { await this.killOwned(); await Promise.allSettled([this.setupPromise, this.startPromise, this.request?.promise].filter(Boolean)); this.update({ state: this.installation() ? 'stopped' : 'not-installed', message: 'Smart masks stopped.', requestId: undefined }); })().finally(() => { this.stopPromise = undefined; }); return this.stopPromise;
  }
  private async killOwned() {
    this.rejectPending(new Error('Smart-mask request canceled.')); const child = this.child; if (!child?.pid) { this.child = undefined; return; }
    if (process.platform === 'win32') await new Promise<void>((resolve, reject) => { const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', reject); killer.on('close', () => resolve()); }); else child.kill('SIGTERM');
    const deadline = Date.now() + 10_000; while (this.child === child && child.exitCode === null && Date.now() < deadline) await pause(50);
    if (this.child === child && child.exitCode === null) throw new Error('The owned smart-mask worker did not stop. Retry Stop.'); if (this.child === child) this.child = undefined;
  }
  async dispose(): Promise<void> { this.disposed = true; await this.stop(); }
}

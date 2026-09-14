import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { PNG } from 'pngjs';
import type { AppPaths } from '../shared/types';
import { faceDetectionRequestSchema, faceRefinementRequestSchema, type FaceDetectionRequest, type FaceDetectionReceipt, type FaceDetailerStatus, type FaceRefinementRequest } from '../shared/face-detailer-types';
import { createCropInpaintPlan, redMaskFromRgba } from '../shared/crop-inpaint-geometry';
import { faceRefinementPlanSchema, type FaceRefinementPlan } from '../shared/face-detailer-workflow';
import { FACE_DETAILER_RELEASE } from './face-detailer-release';
import { createFaceMask, detectionFrames, mapFaceDetections } from './face-detailer-geometry';
import { SourceImageService } from './source-images';
import type { StudioStore } from './store';
import { assistantHash, downloadAssistantAsset } from './assistant-download';
import { preserveChangedReviewedAsset } from './reviewed-asset-repair';
import { containedPath, runtimeEnvironment, validateRuntimePaths } from './runtime-config';

const markerSchema = z.object({ release: z.unknown(), installedAt: z.iso.datetime(), files: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)) }).strict();
type Marker = z.infer<typeof markerSchema>;
export function faceDetailerPaths(paths: AppPaths) {
  const root = path.join(paths.runtime, 'face-detailer');
  return { root, vendor: path.join(root, 'vendor'), models: path.join(root, 'models'), marker: path.join(root, 'installed.json'), cache: path.join(paths.cache, 'face-detailer'), worker: path.join(root, 'face-detailer-worker.py'), log: path.join(paths.logs, 'face-detailer.log') };
}
function workerResource() {
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [resources && path.join(resources, 'app.asar.unpacked', 'dist-electron', 'resources', 'face-detailer-worker.py'), path.join(__dirname, 'resources', 'face-detailer-worker.py'), path.resolve(__dirname, '../../resources/face-detailer-worker.py'), path.resolve(__dirname, '../resources/face-detailer-worker.py')].filter(Boolean) as string[];
  const found = candidates.find(file => fs.existsSync(file)); if (!found) throw new Error('The face-detector worker is missing. Rebuild or reinstall the studio.'); return found;
}
/** Wheel contents are data; no package installer, .pth processing or dependency resolution runs. */
export async function extractFaceWheel(filename: string, destination: string, signal: AbortSignal) {
  const entries = new AdmZip(filename).getEntries(); let total = 0; const names = new Set<string>();
  if (!entries.length || entries.length > 3000) throw new Error('The OpenCV wheel has an unexpected number of files.');
  for (const entry of entries) {
    const name = entry.entryName;
    if (!name || name.includes('\\') || name.startsWith('/') || name.includes(':') || name.includes('\0') || name.split('/').some(part => part === '..' || part === '.' || part.endsWith(' ') || part.endsWith('.')) || ((entry.attr >>> 16) & 0xf000) === 0xa000 || names.has(name.toLowerCase())) throw new Error('The OpenCV wheel contains an unsafe or duplicate path.');
    names.add(name.toLowerCase()); total += entry.header.size;
    if (total > 300 * 1024 * 1024 || entry.header.size > 150 * 1024 * 1024) throw new Error('The OpenCV wheel exceeds its extraction limit.');
  }
  for (const entry of entries) {
    signal.throwIfAborted(); const target = containedPath(destination, path.join(destination, entry.entryName));
    let cursor = path.dirname(target);
    while (cursor !== path.dirname(destination)) { if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('The OpenCV extraction path contains a link.'); if (cursor === destination) break; cursor = path.dirname(cursor); }
    if (entry.isDirectory) await fs.promises.mkdir(target, { recursive: true });
    else { await fs.promises.mkdir(path.dirname(target), { recursive: true }); await fs.promises.writeFile(target, entry.getData(), { flag: 'wx' }); }
  }
}

export class FaceDetailerService {
  private files;
  private sources: SourceImageService;
  private current: FaceDetailerStatus;
  private setupTask?: Promise<void>;
  private setupAbort?: AbortController;
  private detectionTask?: Promise<FaceDetectionReceipt>;
  private detectionAbort?: AbortController;
  private child?: ChildProcess;
  private disposed = false;
  constructor(private paths: AppPaths, private store: StudioStore, private changed: () => void, sources?: SourceImageService) {
    this.files = faceDetailerPaths(paths); this.sources = sources ?? new SourceImageService(paths, store); this.validatePaths();
    const installed = Boolean(this.installation());
    this.current = { state: installed ? 'ready' : 'not-installed', message: installed ? 'CPU face detection is installed. Review each detected region before refining.' : 'Optional CPU face detection: approximately 41 MB, kept inside this studio.', device: 'cpu', experimental: true, logTail: [] };
  }
  status(): FaceDetailerStatus { return structuredClone(this.current); }
  private update(patch: Partial<FaceDetailerStatus>) { this.current = { ...this.current, ...patch }; this.changed(); }
  private validatePaths() {
    validateRuntimePaths(this.paths);
    for (const filename of Object.values(this.files)) this.assertPrivate(filename);
  }
  private assertPrivate(filename: string) {
    containedPath(storageBoundary(this.paths, filename), filename); let cursor = path.resolve(filename);
    while (true) {
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Face-detector storage cannot contain symbolic links or junctions.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  }
  private installation(): Marker | undefined {
    try {
      this.assertPrivate(this.files.marker); const stat = fs.lstatSync(this.files.marker); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) return undefined;
      const marker = markerSchema.parse(JSON.parse(fs.readFileSync(this.files.marker, 'utf8')));
      if (JSON.stringify(marker.release) !== JSON.stringify(FACE_DETAILER_RELEASE) || !Object.keys(marker.files).length) return undefined; return marker;
    } catch { return undefined; }
  }
  private async inventory(directory: string, signal?: AbortSignal): Promise<Record<string, string>> {
    const files: Record<string, string> = {}; let count = 0;
    const visit = async (current: string) => {
      this.assertPrivate(current);
      for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
        signal?.throwIfAborted(); if (++count > 3000) throw new Error('Face-detector inventory exceeds its file limit.');
        const target = containedPath(directory, path.join(current, entry.name)); this.assertPrivate(target); const stat = await fs.promises.lstat(target);
        if (stat.isDirectory()) await visit(target);
        else if (stat.isFile() && stat.nlink === 1) files[path.relative(directory, target).replaceAll('\\', '/')] = await assistantHash(target, signal);
        else throw new Error('Face-detector files must be independent regular files.');
      }
    };
    await visit(directory); return files;
  }
  setup(repair = false): Promise<void> {
    if (this.disposed || this.detectionTask) return Promise.reject(new Error('Wait for face detection to finish before setup.'));
    if (this.setupTask) return this.setupTask;
    const controller = new AbortController(); this.setupAbort = controller;
    this.setupTask = this.install(controller.signal, repair).catch(error => { this.update({ state: controller.signal.aborted ? this.installation() ? 'ready' : 'not-installed' : 'error', message: controller.signal.aborted ? 'Face-detector setup canceled. Downloaded parts are retained.' : `Face-detector setup failed: ${error.message}`, installProgress: undefined }); throw error; }).finally(() => { this.setupTask = undefined; this.setupAbort = undefined; });
    return this.setupTask;
  }
  private async install(signal: AbortSignal, repair: boolean) {
    this.validatePaths(); if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This reviewed CPU face-detector bundle currently requires Windows x64.');
    if (!fs.existsSync(this.paths.python)) throw new Error('Install the private Comfy runtime first; detection reuses its isolated Python and NumPy.');
    const disk = await fs.promises.statfs(this.paths.root); if (disk.bavail * disk.bsize < 512 * 1024 * 1024) throw new Error('Face-detector setup needs at least 512 MiB free for verified extraction.');
    for (const directory of [this.files.root, this.files.models, this.files.cache]) { this.assertPrivate(directory); await fs.promises.mkdir(directory, { recursive: true }); }
    this.update({ state: 'installing', message: 'Downloading and verifying the CPU detector bundle…', installProgress: 0 });
    const assets = [FACE_DETAILER_RELEASE.wheel, FACE_DETAILER_RELEASE.anime, FACE_DETAILER_RELEASE.photographic]; let receivedBefore = 0; const total = assets.reduce((n, a) => n + a.bytes, 0);
    const downloaded: string[] = [];
    for (const asset of assets) {
      if (repair) await preserveChangedReviewedAsset(this.paths, path.join(asset === FACE_DETAILER_RELEASE.wheel ? this.files.cache : this.files.models, asset.filename), asset, signal);
      downloaded.push(await downloadAssistantAsset(asset, asset === FACE_DETAILER_RELEASE.wheel ? this.files.cache : this.files.models, signal, (received, _total, verifying) => this.update({ installProgress: (receivedBefore + received) / total * 90, message: `${verifying ? 'Verifying' : 'Downloading'} ${asset.filename}…` })));
      receivedBefore += asset.bytes;
    }
    signal.throwIfAborted(); const stage = path.join(this.files.root, `vendor-stage-${randomUUID()}`); await fs.promises.mkdir(stage);
    await extractFaceWheel(downloaded[0], stage, signal); const inventory = await this.inventory(stage, signal);
    if (!inventory['cv2/__init__.py'] || !Object.keys(inventory).some(name => name.endsWith('LICENSE.txt'))) throw new Error('The extracted OpenCV package or license notice is missing.');
    signal.throwIfAborted();
    if (fs.existsSync(this.files.vendor)) { this.assertPrivate(this.files.vendor); await fs.promises.rename(this.files.vendor, `${this.files.vendor}.previous-${randomUUID()}`); }
    await fs.promises.rename(stage, this.files.vendor);
    const notices = path.join(path.dirname(workerResource()), 'face-detailer-NOTICES.txt');
    await fs.promises.copyFile(notices, path.join(this.files.models, 'NOTICES.txt'));
    const marker: Marker = { release: FACE_DETAILER_RELEASE, installedAt: new Date().toISOString(), files: inventory };
    const temporary = `${this.files.marker}.${randomUUID()}.tmp`; await fs.promises.writeFile(temporary, JSON.stringify(marker), { flag: 'wx' }); await fs.promises.rename(temporary, this.files.marker);
    this.update({ state: 'ready', message: 'CPU face detection is installed. Choose the matching face style and review detections.', installProgress: 100 });
  }
  async cancelSetup() { this.setupAbort?.abort(new Error('Face-detector setup canceled.')); await this.setupTask?.catch(() => undefined); }
  private async verifyInstallation(signal: AbortSignal) {
    this.validatePaths(); const marker = this.installation(); if (!marker) throw new Error('Install the CPU face detector before detecting faces.');
    const actual = await this.inventory(this.files.vendor, signal);
    if (Object.keys(actual).length !== Object.keys(marker.files).length || Object.entries(marker.files).some(([name, hash]) => actual[name] !== hash)) throw new Error('The CPU detector package changed. Run setup to restore its reviewed files.');
    for (const asset of [FACE_DETAILER_RELEASE.anime, FACE_DETAILER_RELEASE.photographic]) {
      const filename = path.join(this.files.models, asset.filename); this.assertPrivate(filename); const stat = await fs.promises.lstat(filename);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== asset.bytes || await assistantHash(filename, signal) !== asset.sha256) throw new Error('The face detector model changed. Its original file was preserved.');
    }
    const resource = workerResource(); const bytes = await fs.promises.readFile(resource); const temporary = `${this.files.worker}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, bytes, { flag: 'wx' }); signal.throwIfAborted(); await fs.promises.rename(temporary, this.files.worker);
    return assistantHash(this.files.worker, signal);
  }
  detect(input: FaceDetectionRequest): Promise<FaceDetectionReceipt> {
    if (this.disposed || this.setupTask || this.detectionTask) return Promise.reject(new Error('The face detector is busy. Wait or cancel its current operation.'));
    let request: FaceDetectionRequest; try { request = faceDetectionRequestSchema.parse(input); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(); this.detectionAbort = controller;
    this.detectionTask = this.performDetection(request, controller.signal).catch(error => { this.update({ state: this.installation() ? 'ready' : 'error', message: controller.signal.aborted ? 'Face detection canceled. No refinement was queued.' : `Face detection failed: ${error.message}` }); throw error; }).finally(() => { this.detectionTask = undefined; this.detectionAbort = undefined; });
    return this.detectionTask;
  }
  private async performDetection(request: FaceDetectionRequest, signal: AbortSignal) {
    const { source, normalizedPath } = await this.sources.resolve(request.sourceId);
    if (source.normalized.sha256 !== request.sourceSha256) throw new Error('The face detection source differs from its saved identity.');
    const { width, height } = source.normalized; detectionFrames(width, height, request.profile);
    this.update({ state: 'detecting', message: 'Checking detector identities and finding faces on CPU…' });
    const workerSha256 = await this.verifyInstallation(signal); signal.throwIfAborted();
    const raw = await this.runWorker(normalizedPath, width, height, request, signal); const mapped = mapFaceDetections(raw, width, height, request); signal.throwIfAborted();
    await this.sources.resolve(request.sourceId); signal.throwIfAborted();
    // Build every mask before committing any revision, so malformed geometry creates no partial receipt.
    const prepared = mapped.faces.map(face => ({ face, mask: createFaceMask(width, height, face.box, request.expansion, request.feather) }));
    const receipt: FaceDetectionReceipt = {
      version: 'face-detection@1', id: randomUUID(), createdAt: new Date().toISOString(), request: structuredClone(request),
      source: { id: source.id, sha256: source.normalized.sha256, width, height, ...(source.originGenerationId ? { originGenerationId: source.originGenerationId } : {}) },
      detector: { profile: request.profile, modelSha256: FACE_DETAILER_RELEASE[request.profile].sha256, codeRevision: FACE_DETAILER_RELEASE[request.profile].revision, opencv: FACE_DETAILER_RELEASE.opencv, wheelSha256: FACE_DETAILER_RELEASE.wheel.sha256, workerSha256, device: 'cpu' },
      preprocessing: { version: 'opencv-area-bgr-multiscale@1', frames: mapped.frames, nmsIoU: 0.3, animeMinNeighbors: 5, animeMinSize: 24 }, faces: [], candidateCount: mapped.candidateCount, omittedCount: mapped.omittedCount, durationMs: mapped.durationMs,
    };
    // Cancellation is deferred during these atomic, immutable saves; cancel waits for the complete receipt.
    for (const { face, mask: preparedMask } of prepared) {
      const mask = await this.sources.saveMask(source.id, preparedMask.png, { baseMaskId: null, edits: [] });
      receipt.faces.push({ id: randomUUID(), ...face, mask, maskGeometry: preparedMask.geometry });
    }
    this.store.setState(`face.detection:${receipt.id}`, receipt);
    for (const face of receipt.faces) this.store.setState(`face.mask:${face.mask.id}`, { detectionId: receipt.id, faceId: face.id, geometry: face.maskGeometry });
    this.update({ state: 'ready', message: receipt.faces.length ? `Found ${receipt.faces.length} face region${receipt.faces.length === 1 ? '' : 's'}. Review masks before refining.` : 'No face found. Keep the original or try the other detector profile.' }); return structuredClone(receipt);
  }
  private runWorker(filename: string, width: number, height: number, request: FaceDetectionRequest, signal: AbortSignal): Promise<unknown> {
    const model = FACE_DETAILER_RELEASE[request.profile]; const env = { ...runtimeEnvironment(this.paths), CUDA_VISIBLE_DEVICES: '-1', OPENCV_OPENCL_RUNTIME: 'disabled', OMP_NUM_THREADS: '2', OPENBLAS_NUM_THREADS: '2', PYTHONDONTWRITEBYTECODE: '1' };
    return new Promise((resolve, reject) => {
      signal.throwIfAborted(); const child = spawn(this.paths.python, ['-I', '-B', '-u', this.files.worker, this.paths.root, this.files.vendor, path.join(this.files.models, model.filename), model.sha256, String(process.pid)], { cwd: this.files.root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); this.child = child;
      let output = ''; let errorText = ''; let failure: Error | undefined;
      const stop = (reason: Error) => { failure ??= reason; child.kill(); };
      const abort = () => stop(new Error('Face detection canceled.'));
      const timer = setTimeout(() => stop(new Error('CPU face detection exceeded its two-minute limit.')), 120000);
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (data: Buffer) => { if (failure) return; if (Buffer.byteLength(output) + data.length > 256 * 1024) { stop(new Error('The face detector exceeded its output limit.')); return; } output += data.toString('utf8'); });
      child.stderr.on('data', (data: Buffer) => { errorText = (errorText + data.toString('utf8')).slice(-16000); });
      child.on('error', error => { failure = error; });
      child.on('close', code => {
        clearTimeout(timer); signal.removeEventListener('abort', abort); if (this.child === child) this.child = undefined;
        if (errorText) { this.update({ logTail: errorText.split(/\r?\n/).filter(Boolean).slice(-30) }); void fs.promises.appendFile(this.files.log, errorText).catch(() => undefined); }
        if (failure || code !== 0) { reject(failure ?? new Error(errorText.trim() || `Face detector exited with code ${code}.`)); return; }
        try { resolve(JSON.parse(output)); } catch { reject(new Error('The face detector returned invalid data.')); }
      });
      child.stdin.on('error', error => { failure ??= error; });
      child.stdin.end(JSON.stringify({ filename, sha256: request.sourceSha256, width, height, profile: request.profile, confidence: request.confidence }) + '\n');
    });
  }
  async cancelDetection() { this.detectionAbort?.abort(new Error('Face detection canceled.')); await this.detectionTask?.catch(() => undefined); }
  async getDetection(id: string): Promise<FaceDetectionReceipt> {
    z.string().uuid().parse(id); const receipt = this.store.getState<FaceDetectionReceipt | null>(`face.detection:${id}`, null);
    if (!receipt || receipt.id !== id || receipt.version !== 'face-detection@1' || !Array.isArray(receipt.faces) || receipt.faces.length > 4) throw new Error('This saved face detection is missing or invalid.');
    faceDetectionRequestSchema.parse(receipt.request); const { source } = await this.sources.resolve(receipt.source.id);
    if (receipt.source.id !== receipt.request.sourceId || source.normalized.sha256 !== receipt.request.sourceSha256 || source.normalized.sha256 !== receipt.source.sha256 || source.normalized.width !== receipt.source.width || source.normalized.height !== receipt.source.height) throw new Error('The saved face detection no longer matches its source.');
    if (receipt.source.originGenerationId !== source.originGenerationId || receipt.detector.profile !== receipt.request.profile || receipt.detector.modelSha256 !== FACE_DETAILER_RELEASE[receipt.request.profile].sha256 || receipt.detector.codeRevision !== FACE_DETAILER_RELEASE[receipt.request.profile].revision || receipt.detector.opencv !== FACE_DETAILER_RELEASE.opencv || receipt.detector.wheelSha256 !== FACE_DETAILER_RELEASE.wheel.sha256 || !/^[a-f0-9]{64}$/.test(receipt.detector.workerSha256) || receipt.detector.device !== 'cpu') throw new Error('The saved face detector provenance is inconsistent.');
    const frames = detectionFrames(receipt.source.width, receipt.source.height, receipt.request.profile).map(frame => ({ ...frame, scaleX: receipt.source.width / frame.width, scaleY: receipt.source.height / frame.height }));
    if (JSON.stringify(receipt.preprocessing) !== JSON.stringify({ version: 'opencv-area-bgr-multiscale@1', frames, nmsIoU: 0.3, animeMinNeighbors: 5, animeMinSize: 24 }) || !Number.isFinite(receipt.durationMs) || receipt.durationMs < 0 || !Number.isSafeInteger(receipt.omittedCount) || receipt.omittedCount < 0 || !Number.isSafeInteger(receipt.candidateCount) || receipt.candidateCount < receipt.faces.length || receipt.faces.length > receipt.request.maxFaces || new Set(receipt.faces.map(face => face.id)).size !== receipt.faces.length) throw new Error('The saved face detector receipt is inconsistent.');
    for (const face of receipt.faces) {
      z.string().uuid().parse(face.id);
      const { mask } = await this.sources.resolveMask(face.mask.id);
      if (mask.sha256 !== face.mask.sha256 || mask.sourceId !== source.id || mask.sourceSha256 !== source.normalized.sha256) throw new Error('A saved face mask no longer matches its source or pixels.');
      const rebuilt = createFaceMask(source.normalized.width, source.normalized.height, face.box, receipt.request.expansion, receipt.request.feather);
      if (JSON.stringify(rebuilt.geometry) !== JSON.stringify(face.maskGeometry) || createHash('sha256').update(rebuilt.png).digest('hex') !== mask.sha256) throw new Error('The face mask no longer matches its recorded detector geometry.');
      if (receipt.request.profile === 'anime' && (face.score !== undefined || face.landmarks !== undefined) || receipt.request.profile === 'photographic' && (typeof face.score !== 'number' || !Number.isFinite(face.score) || face.score < receipt.request.confidence || face.score > 1 || !Array.isArray(face.landmarks) || face.landmarks.length !== 5 || face.landmarks.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x >= source.normalized.width || point.y >= source.normalized.height))) throw new Error('The saved detector scores or landmarks are invalid.');
    }
    return structuredClone(receipt);
  }
  async createRefinementPlan(input: FaceRefinementRequest, actualSeeds: readonly string[]): Promise<FaceRefinementPlan> {
    const request = faceRefinementRequestSchema.parse(input); const seeds = [...actualSeeds]; const receipt = await this.getDetection(request.detectionId);
    const selected = receipt.faces.filter(face => request.faceIds.includes(face.id));
    if (selected.length !== request.faceIds.length || selected.length !== seeds.length) throw new Error('Select saved faces from this detection and resolve one seed for each face.');
    const { source } = await this.sources.resolve(receipt.source.id); const passes: FaceRefinementPlan['passes'] = [];
    for (const [index, face] of selected.entries()) {
      const { mask, path: filename } = await this.sources.resolveMask(face.mask.id); const decoded = PNG.sync.read(await fs.promises.readFile(filename), { checkCRC: true });
      const { plan: crop } = await createCropInpaintPlan({ source, mask, maskRed: redMaskFromRgba(decoded.data, decoded.width, decoded.height), working: { width: 512, height: 512 }, settings: { mode: 'refine', contextPadding: request.contextPadding }, denoise: request.denoise });
      passes.push({ faceId: face.id, seed: seeds[index], crop });
    }
    return faceRefinementPlanSchema.parse({ version: 'sdxl-face-refinement@1', detectionId: receipt.id, source: receipt.source, passes, inputSequence: 'previous-composite-in-original-coordinates', preservation: 'original-zero-union-mask-pixels-and-alpha' });
  }
  async dispose() { this.disposed = true; await Promise.all([this.cancelSetup(), this.cancelDetection()]); }
}

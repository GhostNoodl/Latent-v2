import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppPaths } from '../shared/types';
import {
  IMAGE_MODEL_IDS,
  IMAGE_MODEL_NAMESPACE,
  IMAGE_MODELS,
  allImageModelFiles,
  imageModel,
  imageModelBytes,
  imageModelFileKey,
  imageModelFiles,
  type ImageModelBundle,
  type ImageModelFile,
  type ImageModelId,
  type ImageModelsStatus,
} from '../shared/image-models';
import { downloadAssistantAsset } from './assistant-download';
import { containedPath, validateRuntimePaths } from './runtime-config';
import { inspectSafeTensors } from './models';
import { withReviewedAssetLock } from './reviewed-asset-lock';
import { SessionFileVerifier } from './session-file-verifier';
import { storageBoundary } from './storage-locations';

interface Receipt {
  bytes: number;
  sha256: string;
  repository: string;
  revision: string;
  verifiedAt: string;
}
type Receipts = Record<string, Receipt>;

export const imageModelFileUrl = (file: ImageModelFile) =>
  `https://huggingface.co/${file.repository}/resolve/${file.revision}/${file.sourceFile}`;
export function imageModelFilePath(paths: AppPaths, file: ImageModelFile) {
  return path.join(paths.models, file.directory, IMAGE_MODEL_NAMESPACE, file.filename);
}
const gb = (bytes: number) => (bytes / 1e9).toFixed(1);

/** Downloads and checks the pinned files for the newer image models in Create. */
export class ImageModelAssetsService {
  private marker: string;
  private current: ImageModelsStatus = { state: 'idle', message: '', ready: [], readyFiles: [] };
  private setupPromise?: Promise<ImageModelBundle>;
  private controller?: AbortController;
  private verifier: SessionFileVerifier;
  private disposed = false;
  constructor(
    private paths: AppPaths,
    private changed: () => void,
  ) {
    this.marker = path.join(paths.runtime, 'image-models', 'assets.json');
    this.verifier = new SessionFileVerifier(paths.models, 16);
    this.refresh();
  }
  status(): ImageModelsStatus {
    if (this.current.state !== 'installing') this.refresh();
    return structuredClone(this.current);
  }
  private update(patch: Partial<ImageModelsStatus>) {
    this.current = { ...this.current, ...patch };
    this.changed();
  }
  private validatePaths() {
    validateRuntimePaths(this.paths);
    for (const file of allImageModelFiles()) {
      const target = imageModelFilePath(this.paths, file);
      const boundary = storageBoundary(this.paths, target);
      containedPath(boundary, target);
      for (let current = target; current !== boundary; current = path.dirname(current))
        try {
          if (fs.lstatSync(current).isSymbolicLink())
            throw new Error('Image model storage cannot use symbolic links or junctions.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
    }
  }
  private receipts(): Receipts {
    let saved: Receipts = {};
    try {
      const stat = fs.lstatSync(this.marker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) throw new Error('Invalid receipt file.');
      const marker = JSON.parse(fs.readFileSync(this.marker, 'utf8'));
      if (marker?.schema !== 1 || typeof marker.files !== 'object' || Array.isArray(marker.files))
        throw new Error('Invalid receipt.');
      saved = marker.files;
    } catch {
      return {};
    }
    const valid: Receipts = {};
    for (const file of allImageModelFiles()) {
      const key = imageModelFileKey(file);
      const value = saved[key];
      try {
        const stat = fs.lstatSync(imageModelFilePath(this.paths, file));
        if (
          value &&
          value.bytes === file.bytes &&
          value.sha256 === file.sha256 &&
          value.repository === file.repository &&
          value.revision === file.revision &&
          Number.isFinite(Date.parse(value.verifiedAt)) &&
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          stat.size === file.bytes
        )
          valid[key] = value;
        else this.verifier.invalidate(imageModelFilePath(this.paths, file));
      } catch {
        this.verifier.invalidate(imageModelFilePath(this.paths, file));
      }
    }
    return valid;
  }
  private refresh() {
    const receipts = this.receipts();
    const ready = IMAGE_MODEL_IDS.filter(id => imageModelFiles(id).every(file => receipts[imageModelFileKey(file)]));
    this.current = {
      ...this.current,
      ready,
      readyFiles: Object.keys(receipts),
      message:
        this.current.message ||
        (ready.length ? `${ready.length} newer image model${ready.length === 1 ? '' : 's'} ready.` : ''),
    };
  }
  private bundle(id: ImageModelId, receipts = this.receipts()): ImageModelBundle | undefined {
    const definition = IMAGE_MODELS[id];
    const files = {} as ImageModelBundle['files'];
    for (const [role, file] of Object.entries(definition.files) as Array<
      [keyof ImageModelBundle['files'], ImageModelFile]
    >) {
      const receipt = receipts[imageModelFileKey(file)];
      if (!receipt) return undefined;
      files[role] = { ...file, verifiedAt: receipt.verifiedAt };
    }
    return { id, files, workflowVersion: definition.workflowVersion };
  }
  /** Bytes still to download for a model, counting files shared with other models once. */
  missingBytes(id: ImageModelId) {
    const receipts = this.receipts();
    return imageModelFiles(id)
      .filter(file => !receipts[imageModelFileKey(file)])
      .reduce((sum, file) => sum + file.bytes, 0);
  }
  setup(id: ImageModelId): Promise<ImageModelBundle> {
    if (this.disposed) return Promise.reject(new Error('Image model downloads are shut down.'));
    let definition;
    try {
      definition = imageModel(id);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.setupPromise)
      return this.current.installing === id
        ? this.setupPromise
        : Promise.reject(new Error('Wait for the current model download to finish.'));
    const controller = new AbortController();
    this.controller = controller;
    this.setupPromise = this.install(definition.id, controller.signal)
      .catch(error => {
        this.refresh();
        this.update({
          state: controller.signal.aborted ? 'idle' : 'error',
          installing: undefined,
          progress: undefined,
          message: controller.signal.aborted
            ? `${definition.name} download stopped. Finished files are kept.`
            : `${definition.name} download failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        throw error;
      })
      .finally(() => {
        this.setupPromise = undefined;
        this.controller = undefined;
      });
    return this.setupPromise;
  }
  cancel() {
    this.controller?.abort();
  }
  private async writeReceipts(receipts: Receipts, signal: AbortSignal) {
    await fs.promises.mkdir(path.dirname(this.marker), { recursive: true });
    const temporary = `${this.marker}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(temporary, JSON.stringify({ schema: 1, files: receipts }, null, 2), { flag: 'wx' });
    signal.throwIfAborted();
    await fs.promises.rename(temporary, this.marker);
  }
  private async install(id: ImageModelId, signal: AbortSignal): Promise<ImageModelBundle> {
    const definition = IMAGE_MODELS[id];
    this.validatePaths();
    const missing = this.missingBytes(id);
    await fs.promises.mkdir(this.paths.models, { recursive: true });
    const free = await fs.promises.statfs(this.paths.models);
    if (free.bavail * free.bsize < missing + 512 * 1024 * 1024)
      throw new Error(`Not enough space. ${definition.name} needs ${gb(missing)} GB more.`);
    this.update({
      state: 'installing',
      installing: id,
      progress: 0,
      message: `Getting ${definition.name} ready…`,
    });
    const files = imageModelFiles(id);
    const total = imageModelBytes(id);
    let done = 0;
    for (const file of files) {
      signal.throwIfAborted();
      const destination = imageModelFilePath(this.paths, file);
      const lock = `model-file-${createHash('sha256').update(path.resolve(destination).toLowerCase()).digest('hex')}`;
      await withReviewedAssetLock(this.paths, lock, signal, async fileSignal => {
        const receipts = this.receipts();
        if (receipts[imageModelFileKey(file)]) return;
        this.validatePaths();
        await downloadAssistantAsset(
          { url: imageModelFileUrl(file), filename: file.filename, bytes: file.bytes, sha256: file.sha256 },
          path.dirname(destination),
          fileSignal,
          (received, _total, verifying) =>
            this.update({
              progress: Math.min(99, ((done + received) / total) * 100),
              message: verifying
                ? `Checking ${definition.name} ${file.role}…`
                : `Downloading ${definition.name} ${file.role}: ${gb(received)} / ${gb(file.bytes)} GB`,
            }),
        );
        await inspectSafeTensors(destination);
        fileSignal.throwIfAborted();
        receipts[imageModelFileKey(file)] = {
          bytes: file.bytes,
          sha256: file.sha256,
          repository: file.repository,
          revision: file.revision,
          verifiedAt: new Date().toISOString(),
        };
        await this.writeReceipts(receipts, fileSignal);
      });
      done += file.bytes;
    }
    const bundle = this.bundle(id);
    if (!bundle) throw new Error(`${definition.name} files are incomplete.`);
    this.refresh();
    this.update({
      state: 'idle',
      installing: undefined,
      progress: 100,
      message: `${definition.name} is ready.`,
    });
    return structuredClone(bundle);
  }
  /** Full SHA-256 check (cached for unchanged files this session) right before a job is queued or sent. */
  async verify(id: ImageModelId, signal?: AbortSignal): Promise<ImageModelBundle> {
    const definition = imageModel(id);
    if (this.current.installing === id) throw new Error(`Wait for ${definition.name} to finish downloading.`);
    this.validatePaths();
    const bundle = this.bundle(id);
    if (!bundle) throw new Error(`Download ${definition.name} first. Open the model picker to get it.`);
    for (const file of imageModelFiles(id)) {
      const result = await this.verifier.verify(imageModelFilePath(this.paths, file), file, signal);
      if (result.sha256 !== file.sha256)
        throw new Error(`${definition.name} ${file.role} file changed on disk. Download it again.`);
    }
    return bundle;
  }
  dispose() {
    this.disposed = true;
    this.controller?.abort();
  }
}

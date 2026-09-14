import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppPaths } from '../shared/types';
import type { ControlNetStatus, ReviewedControlNetAsset } from '../shared/controlnet-types';
import type { StudioStore } from './store';
import { assistantHash, downloadAssistantAsset } from './assistant-download';
import { containedPath, validateRuntimePaths } from './runtime-config';
import { inspectSafeTensors } from './models';
import { withReviewedAssetLock } from './reviewed-asset-lock';

export const CONTROLNET_RELEASE = Object.freeze({ id: 'xinsir-union-sdxl-1', name: 'Xinsir ControlNet Union SDXL 1.0', filename: 'xinsir-union-sdxl-1.0.safetensors', bytes: 2512030408, sha256: 'a9e13fd61f3193887791c8a0dd07a07202174dc47d5ddaea94ea1344f07c7467', repository: 'xinsir/controlnet-union-sdxl-1.0', revision: '801a4a3fa3d4c936f4feea95b98607bc6726f80c', url: 'https://huggingface.co/xinsir/controlnet-union-sdxl-1.0/resolve/801a4a3fa3d4c936f4feea95b98607bc6726f80c/diffusion_pytorch_model.safetensors', modelCardUrl: 'https://huggingface.co/xinsir/controlnet-union-sdxl-1.0/resolve/801a4a3fa3d4c936f4feea95b98607bc6726f80c/README.md', cardBytes: 9857, cardSha256: '263366a14c599f908e4b9a4cad4521f679b1af1d68369872de0a9476ff6e0137', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0.txt', licenseBytes: 11358, licenseSha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' } as const);
export function controlNetPaths(paths: AppPaths) { const runtime = path.join(paths.runtime, 'controlnet'); return { runtime, directory: path.join(paths.models, 'controlnet'), model: path.join(paths.models, 'controlnet', CONTROLNET_RELEASE.filename), marker: path.join(runtime, 'installed.json') }; }

export async function inspectControlNetFile(filename: string): Promise<ReviewedControlNetAsset['validation']> {
  await inspectSafeTensors(filename);
  const file = await fs.promises.open(filename, 'r');
  try {
    const first = Buffer.alloc(8); await file.read(first, 0, 8, 0); const headerBytes = Number(first.readBigUInt64LE());
    if (headerBytes !== 112800) throw new Error('Unexpected reviewed ControlNet tensor header.');
    const bytes = Buffer.alloc(headerBytes); await file.read(bytes, 0, headerBytes, 8); const header = JSON.parse(bytes.toString('utf8'));
    const tensors = Object.entries(header).filter(([key]) => key !== '__metadata__') as Array<[string, { shape: number[]; dtype: string }]>;
    const shapes: Record<string, number[]> = { 'task_embedding': [6, 320], 'control_add_embedding.linear_1.weight': [1280, 1536], 'add_embedding.linear_1.weight': [1280, 2816], 'controlnet_cond_embedding.conv_in.weight': [16, 3, 3, 3], 'conv_in.weight': [320, 4, 3, 3] };
    if (tensors.length !== 863 || Object.entries(shapes).some(([key, shape]) => JSON.stringify(header[key]?.shape) !== JSON.stringify(shape))) throw new Error('The reviewed asset is not the expected union SDXL architecture.');
    return { format: 'safetensors', architecture: 'union-sdxl', tensorCount: tensors.length, headerBytes, dtypes: [...new Set(tensors.map(([, value]) => value.dtype))].sort(), parameters: tensors.reduce((sum, [, value]) => sum + value.shape.reduce((size, dimension) => size * BigInt(dimension), 1n), 0n).toString() };
  } finally { await file.close(); }
}

export class ControlNetService {
  private files; private current: ControlNetStatus; private setupPromise?: Promise<ReviewedControlNetAsset>; private verifyPromise?: Promise<ReviewedControlNetAsset>; private controller?: AbortController; private disposed = false;
  constructor(private paths: AppPaths, private store: StudioStore, private changed: () => void) { this.files = controlNetPaths(paths); this.validatePaths(); const asset = this.receipt(); this.current = { state: asset ? 'ready' : 'not-installed', message: asset ? 'Canny control is ready. Results vary with the checkpoint and control image.' : 'Optional Canny control: reviewed 2.51 GB union SDXL asset.', asset }; }
  status(): ControlNetStatus { return structuredClone(this.current); }
  private update(patch: Partial<ControlNetStatus>) { this.current = { ...this.current, ...patch }; this.changed(); }
  private validatePaths() { validateRuntimePaths(this.paths); for (const target of Object.values(this.files)) { containedPath(storageBoundary(this.paths, target), target); let cursor = target; while (cursor !== storageBoundary(this.paths, target)) { try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('ControlNet storage cannot use symbolic links or junctions.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } cursor = path.dirname(cursor); } } }
  private receipt(): ReviewedControlNetAsset | undefined {
    try { const receipt = JSON.parse(fs.readFileSync(this.files.marker, 'utf8')) as ReviewedControlNetAsset; const stat = fs.lstatSync(this.files.model); if (receipt.id !== CONTROLNET_RELEASE.id || receipt.filename !== CONTROLNET_RELEASE.filename || receipt.bytes !== CONTROLNET_RELEASE.bytes || receipt.sha256 !== CONTROLNET_RELEASE.sha256 || receipt.status !== 'ready' || receipt.family !== 'sdxl' || receipt.architecture !== 'union-sdxl' || receipt.loaderPolicy !== 'pinned-publisher-safetensors' || receipt.provenance.revision !== CONTROLNET_RELEASE.revision || receipt.provenance.repository !== CONTROLNET_RELEASE.repository || receipt.provenance.sourceUrl !== CONTROLNET_RELEASE.url || receipt.provenance.modelCardUrl !== CONTROLNET_RELEASE.modelCardUrl || receipt.provenance.licenseUrl !== CONTROLNET_RELEASE.licenseUrl || receipt.provenance.licenseName !== 'Apache-2.0' || receipt.validation.format !== 'safetensors' || receipt.validation.tensorCount !== 863 || receipt.validation.headerBytes !== 112800 || receipt.validation.architecture !== 'union-sdxl' || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== CONTROLNET_RELEASE.bytes) return undefined; return receipt; } catch { return undefined; }
  }
  setup(repair = false): Promise<ReviewedControlNetAsset> {
    if (this.disposed) return Promise.reject(new Error('The ControlNet service was disposed.')); if (this.setupPromise) return this.setupPromise; if (this.verifyPromise) return Promise.reject(new Error('Wait for ControlNet verification to finish.'));
    const controller = new AbortController(); this.controller = controller;
    this.setupPromise = this.install(controller.signal, repair).catch(error => { this.update({ state: controller.signal.aborted ? this.receipt() ? 'ready' : 'not-installed' : 'error', message: controller.signal.aborted ? 'ControlNet setup canceled; partial download retained.' : `ControlNet setup failed: ${error.message}`, asset: this.receipt() }); throw error; }).finally(() => { this.controller = undefined; this.setupPromise = undefined; }); return this.setupPromise;
  }
  private async install(signal: AbortSignal, repair: boolean) {
    this.validatePaths(); if (!fs.existsSync(this.paths.python)) throw new Error('Install the private image-engine runtime before setting up ControlNet.');
    return withReviewedAssetLock(this.paths, CONTROLNET_RELEASE.id, signal, async ownedSignal => {
      this.validatePaths(); for (const directory of [this.files.runtime, this.files.directory]) await fs.promises.mkdir(directory, { recursive: true });
      this.update({ state: 'installing', message: 'Preparing the reviewed union SDXL model…', installProgress: 0, asset: undefined });
      if (repair && fs.existsSync(this.files.model)) {
        const stat = await fs.promises.lstat(this.files.model);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('ControlNet repair requires an independent regular model file.');
        if (await assistantHash(this.files.model, ownedSignal) !== CONTROLNET_RELEASE.sha256) {
          ownedSignal.throwIfAborted(); this.validatePaths();
          await fs.promises.rename(this.files.model, this.files.model + '.preserved-' + randomUUID());
          this.update({ message: 'Changed ControlNet model preserved beside the original path. Installing the reviewed replacement…' });
        }
      }
      await downloadAssistantAsset({ url: CONTROLNET_RELEASE.url, filename: CONTROLNET_RELEASE.filename, bytes: CONTROLNET_RELEASE.bytes, sha256: CONTROLNET_RELEASE.sha256 }, this.files.directory, ownedSignal, (received, total, verifying) => this.update({ message: verifying ? 'Verifying full ControlNet SHA-256…' : `Downloading reviewed ControlNet: ${(received / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB`, installProgress: received / total * 90 }));
      for (const asset of [{ url: CONTROLNET_RELEASE.modelCardUrl, filename: 'MODEL-CARD.md', bytes: CONTROLNET_RELEASE.cardBytes, sha256: CONTROLNET_RELEASE.cardSha256 }, { url: CONTROLNET_RELEASE.licenseUrl, filename: 'LICENSE-Apache-2.0.txt', bytes: CONTROLNET_RELEASE.licenseBytes, sha256: CONTROLNET_RELEASE.licenseSha256 }]) await downloadAssistantAsset(asset, this.files.runtime, ownedSignal, () => {});
      this.update({ message: 'Inspecting the reviewed safetensors structure without loading GPU weights…', installProgress: 95 }); const validation = await inspectControlNetFile(this.files.model); ownedSignal.throwIfAborted();
      const reviewed: ReviewedControlNetAsset = { id: CONTROLNET_RELEASE.id, name: CONTROLNET_RELEASE.name, filename: CONTROLNET_RELEASE.filename, bytes: CONTROLNET_RELEASE.bytes, sha256: CONTROLNET_RELEASE.sha256, status: 'ready', family: 'sdxl', architecture: 'union-sdxl', loaderPolicy: 'pinned-publisher-safetensors', provenance: { repository: CONTROLNET_RELEASE.repository, revision: CONTROLNET_RELEASE.revision, sourceUrl: CONTROLNET_RELEASE.url, modelCardUrl: CONTROLNET_RELEASE.modelCardUrl, licenseName: 'Apache-2.0', licenseUrl: CONTROLNET_RELEASE.licenseUrl }, validation, verifiedAt: new Date().toISOString() };
      const temporary = `${this.files.marker}.${randomUUID()}.tmp`; await fs.promises.writeFile(temporary, JSON.stringify(reviewed, null, 2), { flag: 'wx' }); ownedSignal.throwIfAborted(); await fs.promises.rename(temporary, this.files.marker); this.store.setState('controlnet.installation', reviewed); this.update({ state: 'ready', message: 'Canny control is ready. Results vary with the checkpoint and control image.', asset: reviewed, installProgress: 100 }); return structuredClone(reviewed);
    });
  }
  verify(): Promise<ReviewedControlNetAsset> {
    if (this.disposed) return Promise.reject(new Error('The ControlNet service was disposed.')); if (this.setupPromise) return this.setupPromise; if (this.verifyPromise) return this.verifyPromise;
    const controller = new AbortController(); this.controller = controller;
    this.verifyPromise = (async () => { this.validatePaths(); const receipt = this.receipt(); if (!receipt) throw new Error('Install the reviewed ControlNet model before enabling Canny control.'); if (await assistantHash(this.files.model, controller.signal) !== CONTROLNET_RELEASE.sha256) throw new Error('The ControlNet model changed. Repair Canny ControlNet to preserve this file and reinstall the reviewed model.'); return structuredClone(receipt); })().catch(error => { if (!controller.signal.aborted) this.update({ state: 'error', message: error.message, asset: undefined }); throw error; }).finally(() => { this.verifyPromise = undefined; this.controller = undefined; }); return this.verifyPromise;
  }
  async cancel() { this.controller?.abort(); await Promise.allSettled([this.setupPromise, this.verifyPromise].filter(Boolean)); }
  async dispose() { this.disposed = true; await this.cancel(); }
}

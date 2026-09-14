import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppPaths } from '../shared/types';
import type { QwenEditAsset, QwenEditAssetRole, QwenEditAssetsStatus, QwenEditBundle, QwenEditProfile } from '../shared/qwen-edit-types';
import type { StudioStore } from './store';
import { downloadAssistantAsset, type AssistantAsset } from './assistant-download';
import { containedPath, validateRuntimePaths } from './runtime-config';
import { inspectSafeTensors } from './models';
import { withReviewedAssetLock } from './reviewed-asset-lock';
import { SessionFileVerifier } from './session-file-verifier';
import { preserveChangedReviewedAsset } from './reviewed-asset-repair';

const EDIT_REPOSITORY = 'Comfy-Org/Qwen-Image-Edit_ComfyUI'; const EDIT_REVISION = '984166f60a9b1fcede5e9b9287b7a7aebc050010';
const COMMON_REPOSITORY = 'Comfy-Org/Qwen-Image_ComfyUI'; const COMMON_REVISION = '7beb7b647f04469fbe64ba8adc2bb0d7e5e9f73f';
const LIGHTNING_REPOSITORY = 'lightx2v/Qwen-Image-Edit-2511-Lightning'; const LIGHTNING_REVISION = 'd74eba145674fd7e31b949324e148e21e7118abd';
const resolveUrl = (repository: string, revision: string, filename: string) => `https://huggingface.co/${repository}/resolve/${revision}/${filename}`;
export interface QwenEditAssetPin extends AssistantAsset { role: QwenEditAssetRole; directory: QwenEditAsset['directory']; repository: string; revision: string; sourceFile: string; headerBytes: number; headerSha256: string; tensorCount: number; dtypes: string[]; }
const pin = (value: Omit<QwenEditAssetPin, 'url'>): QwenEditAssetPin => Object.freeze({ ...value, url: resolveUrl(value.repository, value.revision, value.sourceFile) });
export const QWEN_EDIT_ASSETS: readonly QwenEditAssetPin[] = Object.freeze([
  pin({ role: 'diffusion', directory: 'diffusion_models', filename: 'qwen_image_edit_2511_int8_convrot.safetensors', repository: EDIT_REPOSITORY, revision: EDIT_REVISION, sourceFile: 'split_files/diffusion_models/qwen_image_edit_2511_int8_convrot.safetensors', bytes: 20499083824, sha256: '11b5af5ac601821d73930c84846c9a158e67177356daf927ce1c8d10f3963829', headerBytes: 420200, headerSha256: '58d2fc5625fe0e8c52dfc6d5611577cc0a1d8f29ba167605f74a9b8928932f6e', tensorCount: 3614, dtypes: ['BF16', 'F32', 'I8', 'U8'] }),
  pin({ role: 'encoder', directory: 'text_encoders', filename: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', repository: COMMON_REPOSITORY, revision: COMMON_REVISION, sourceFile: 'split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors', bytes: 9384670680, sha256: 'cb5636d852a0ea6a9075ab1bef496c0db7aef13c02350571e388aea959c5c0b4', headerBytes: 152224, headerSha256: '79c8e1502e7003bcea84ec7e2c9922dcec67730059d08157f2c58649f92bf203', tensorCount: 1446, dtypes: ['BF16', 'F32', 'F8_E4M3'] }),
  pin({ role: 'vae', directory: 'vae', filename: 'qwen_image_vae.safetensors', repository: COMMON_REPOSITORY, revision: COMMON_REVISION, sourceFile: 'split_files/vae/qwen_image_vae.safetensors', bytes: 253806246, sha256: 'a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f', headerBytes: 21176, headerSha256: '636d195d2853366f11a84e91f139695bb3aced8ea17ad00e9a7c7423a075382e', tensorCount: 194, dtypes: ['BF16'] }),
  pin({ role: 'lightning', directory: 'qwen-edit-loras', filename: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', repository: LIGHTNING_REPOSITORY, revision: LIGHTNING_REVISION, sourceFile: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', bytes: 849608296, sha256: '22226e8d05d354bb356627d428809f5afd7819399b077238a2b70a82883a904f', headerBytes: 260288, headerSha256: '431e0ecca39bc39908076a9580e090751dcbd3b81d4453fe4f1cf09bd9cde3ec', tensorCount: 2160, dtypes: ['BF16'] }),
]);
export const QWEN_EDIT_RUNTIME: QwenEditBundle['runtime'] = Object.freeze({ route: 'native-int8-convrot', comfySourceCommit: '12d5279438bfefc058a269eae805ceab6047777f', comfyVersion: '0.34.0', torchVersion: '2.11.0+cu130', comfyKitchenVersion: '0.2.31', customNodes: [] as [], cpuTextEncoder: true, memoryStatus: 'unverified-16gb' });
const LICENSE: AssistantAsset = { filename: 'LICENSE-Apache-2.0.txt', url: 'https://www.apache.org/licenses/LICENSE-2.0.txt', bytes: 11358, sha256: 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30' };
const CARDS: AssistantAsset[] = [
  { filename: 'MODEL-CARD-Comfy-Edit.md', url: resolveUrl(EDIT_REPOSITORY, EDIT_REVISION, 'README.md'), bytes: 2504, sha256: '8989944064b32750ba0a754758edd1048946014fc7613f41df1af069ce26d91c' },
  { filename: 'MODEL-CARD-Comfy-Qwen.md', url: resolveUrl(COMMON_REPOSITORY, COMMON_REVISION, 'README.md'), bytes: 1383, sha256: '0efc0626f6ff16a5625dca7491c178b34de611db550f94befeadf38921e9e30c' },
  { filename: 'MODEL-CARD-Lightning.md', url: resolveUrl(LIGHTNING_REPOSITORY, LIGHTNING_REVISION, 'README.md'), bytes: 2680, sha256: 'fdb059ee8ebd0fcc91c7ccf7f190f88fe4d231be57f3ed801abf584015b1562d' },
  { filename: 'MODEL-CARD-Qwen-2511.md', url: resolveUrl('Qwen/Qwen-Image-Edit-2511', '6f3ccc0b56e431dc6a0c2b2039706d7d26f22cb9', 'README.md'), bytes: 7179, sha256: '9724c194bef2a6d821090f0cd65774962e8f77e3acbfb2a7cbbdd58c92049902' },
];
const selected = (profile: QwenEditProfile) => { if (!['base', 'fast'].includes(profile)) throw new Error('Choose the base or fast Qwen editing profile.'); return QWEN_EDIT_ASSETS.filter(asset => profile === 'fast' || asset.role !== 'lightning'); };
export const qwenEditBytes = (profile: QwenEditProfile) => selected(profile).reduce((sum, asset) => sum + asset.bytes, 0);
export function qwenEditPaths(paths: AppPaths) { const runtime = path.join(paths.runtime, 'qwen-edit-2511'); return { runtime, marker: path.join(runtime, 'assets.json') }; }
export function qwenEditAssetPath(paths: AppPaths, asset: QwenEditAssetPin) { return path.join(paths.models, asset.directory, 'qwen-edit-2511', asset.filename); }
export async function inspectQwenEditAsset(filename: string, asset: QwenEditAssetPin): Promise<QwenEditAsset['validation']> {
  await inspectSafeTensors(filename); const file = await fs.promises.open(filename, 'r');
  try { const first = Buffer.alloc(8); await file.read(first, 0, 8, 0); const headerBytes = Number(first.readBigUInt64LE()); if (headerBytes !== asset.headerBytes) throw new Error(`Unexpected ${asset.role} safetensors header length.`); const bytes = Buffer.alloc(headerBytes); await file.read(bytes, 0, headerBytes, 8); const headerSha256 = createHash('sha256').update(bytes).digest('hex'); if (headerSha256 !== asset.headerSha256) throw new Error(`The ${asset.role} tensor header does not match the reviewed publisher file.`); const header = JSON.parse(bytes.toString()); const tensors = Object.entries(header).filter(([key]) => key !== '__metadata__') as Array<[string, { dtype: string }]>; const dtypes = [...new Set(tensors.map(([, tensor]) => tensor.dtype))].sort(); if (tensors.length !== asset.tensorCount || JSON.stringify(dtypes) !== JSON.stringify(asset.dtypes)) throw new Error(`Unexpected ${asset.role} tensor inventory.`); return { headerBytes, headerSha256, tensorCount: tensors.length, dtypes }; } finally { await file.close(); }
}

export class QwenEditAssetsService {
  private files; private current: QwenEditAssetsStatus; private setupPromise?: Promise<QwenEditBundle>; private verifyPromise?: Promise<QwenEditBundle>; private activeProfile?: QwenEditProfile; private controller?: AbortController; private verifyController?: AbortController; private disposed = false; private verifier: SessionFileVerifier;
  constructor(private paths: AppPaths, private store: StudioStore, private changed: () => void) { this.files = qwenEditPaths(paths); this.verifier = new SessionFileVerifier(paths.models, 8); this.validatePaths(); this.current = { state: 'not-installed', message: 'Optional Qwen edit: 30.14 GB base, 30.99 GB with the four-step adapter.', baseBytes: qwenEditBytes('base'), fastBytes: qwenEditBytes('fast'), baseReady: false, fastReady: false, installedRoles: [] }; this.refreshReceipts(); }
  status(): QwenEditAssetsStatus { if (this.current.state === 'not-installed' || this.current.state === 'ready') this.refreshReceipts(); return structuredClone(this.current); }
  private update(patch: Partial<QwenEditAssetsStatus>) { this.current = { ...this.current, ...patch }; this.changed(); }
  private validatePaths() { validateRuntimePaths(this.paths); for (const target of [...Object.values(this.files), ...QWEN_EDIT_ASSETS.map(asset => qwenEditAssetPath(this.paths, asset))]) { containedPath(storageBoundary(this.paths, target), target); for (let current = target; current !== storageBoundary(this.paths, target); current = path.dirname(current)) { try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Qwen edit storage cannot use symbolic links or junctions.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } } } }
  private receipts(): Partial<Record<QwenEditAssetRole, QwenEditAsset>> {
    let saved: Partial<Record<QwenEditAssetRole, QwenEditAsset>> = {};
    try {
      const stat = fs.lstatSync(this.files.marker);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 512 * 1024) throw new Error('Invalid Qwen receipt file.');
      const marker = JSON.parse(fs.readFileSync(this.files.marker, 'utf8'));
      if (marker.schema !== 1 || !marker.assets || typeof marker.assets !== 'object' || Array.isArray(marker.assets)) throw new Error('Invalid Qwen asset receipt.');
      saved = marker.assets;
    } catch { this.verifier.invalidate(); return {}; }
    const valid: Partial<Record<QwenEditAssetRole, QwenEditAsset>> = {};
    for (const pin of QWEN_EDIT_ASSETS) try { const value = saved[pin.role]; const stat = fs.lstatSync(qwenEditAssetPath(this.paths, pin)); if (value && value.role === pin.role && value.filename === `qwen-edit-2511/${pin.filename}` && value.directory === pin.directory && value.bytes === pin.bytes && value.sha256 === pin.sha256 && value.status === 'ready' && Number.isFinite(Date.parse(value.verifiedAt)) && value.format === 'safetensors' && value.provenance.repository === pin.repository && value.provenance.revision === pin.revision && value.provenance.sourceFile === pin.sourceFile && value.provenance.sourceUrl === pin.url && value.provenance.modelCardUrl === resolveUrl(pin.repository, pin.revision, 'README.md') && value.provenance.licenseName === 'Apache-2.0' && value.provenance.licenseUrl === LICENSE.url && value.validation.headerBytes === pin.headerBytes && value.validation.headerSha256 === pin.headerSha256 && value.validation.tensorCount === pin.tensorCount && JSON.stringify(value.validation.dtypes) === JSON.stringify(pin.dtypes) && stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === pin.bytes) valid[pin.role] = value; else this.verifier.invalidate(qwenEditAssetPath(this.paths, pin)); } catch { this.verifier.invalidate(qwenEditAssetPath(this.paths, pin)); /* An incomplete or changed asset is never selected. */ }
    return valid;
  }
  private bundle(profile: QwenEditProfile, receipts = this.receipts()): QwenEditBundle | undefined { if (selected(profile).some(asset => !receipts[asset.role])) return undefined; const assets: QwenEditBundle['assets'] = { diffusion: receipts.diffusion!, encoder: receipts.encoder!, vae: receipts.vae!, ...(profile === 'fast' ? { lightning: receipts.lightning! } : {}) }; return { id: 'qwen-edit-2511-native-int8', profile, assets: structuredClone(assets), totalBytes: qwenEditBytes(profile), verifiedAt: Object.values(assets).map(asset => asset.verifiedAt).sort().at(-1)!, runtime: structuredClone(QWEN_EDIT_RUNTIME) }; }
  private refreshReceipts() { const receipts = this.receipts(); const base = this.bundle('base', receipts); const fast = this.bundle('fast', receipts); this.current = { ...this.current, baseReady: Boolean(base), fastReady: Boolean(fast), installedRoles: Object.keys(receipts) as QwenEditAssetRole[], bundle: fast ?? base }; if (base && this.current.state !== 'installing') this.current = { ...this.current, state: 'ready', message: 'Reviewed Qwen editing assets installed. Memory use and results depend on the selected edit recipe.' }; else if (!base && this.current.state === 'ready') this.current = { ...this.current, state: 'not-installed', message: 'The reviewed Qwen bundle is incomplete. Run setup to restore missing assets; existing files are retained.' }; }
  setup(profile: QwenEditProfile = 'base', repair = false): Promise<QwenEditBundle> {
    if (this.disposed) return Promise.reject(new Error('The Qwen edit asset service was disposed.')); try { selected(profile); } catch (error) { return Promise.reject(error); }
    if (this.setupPromise) return this.activeProfile === profile ? this.setupPromise : Promise.reject(new Error('Wait for the current Qwen profile setup to finish.')); if (this.verifyPromise) return Promise.reject(new Error('Wait for Qwen model verification to finish.'));
    const controller = new AbortController(); this.controller = controller; this.activeProfile = profile;
    this.setupPromise = this.install(profile, controller.signal, repair).catch(error => { this.refreshReceipts(); this.update({ state: controller.signal.aborted ? this.current.baseReady ? 'ready' : 'not-installed' : 'error', message: controller.signal.aborted ? 'Qwen setup canceled; verified files and partial downloads retained.' : `Qwen setup failed: ${error.message}`, activeRole: undefined }); throw error; }).finally(() => { this.setupPromise = undefined; this.activeProfile = undefined; this.controller = undefined; }); return this.setupPromise;
  }
  private async install(profile: QwenEditProfile, signal: AbortSignal, repair: boolean) {
    this.verifier.invalidate(); this.validatePaths(); if (!fs.existsSync(this.paths.python)) throw new Error('Install the private image-engine runtime before setting up Qwen edit assets.');
    return withReviewedAssetLock(this.paths, 'qwen-edit-2511-bundle', signal, async ownedSignal => {
      this.validatePaths(); await fs.promises.mkdir(this.files.runtime, { recursive: true }); const assets = selected(profile); const total = qwenEditBytes(profile); const receipts = this.receipts();
      const missingBytes = assets.filter(asset => !receipts[asset.role]).reduce((sum, asset) => { let partial = 0; try { partial = Math.min(asset.bytes, fs.statSync(`${qwenEditAssetPath(this.paths, asset)}.part`).size); } catch { /* No owned partial. */ } return sum + asset.bytes - partial; }, 0);
      const free = await fs.promises.statfs(this.paths.models); if (free.bavail * free.bsize < missingBytes + 512 * 1024 * 1024) throw new Error(`Not enough space for the ${profile} Qwen profile (${(total / 1e9).toFixed(2)} GB plus setup headroom).`);
      this.update({ state: 'installing', profile, message: 'Preparing the reviewed native Qwen editing bundle…', installProgress: 0 });
      for (const document of [LICENSE, ...CARDS.filter(card => profile === 'fast' || card.filename !== 'MODEL-CARD-Lightning.md')]) {
        if (repair) await preserveChangedReviewedAsset(this.paths, path.join(this.files.runtime, document.filename), document, ownedSignal);
        await downloadAssistantAsset(document, this.files.runtime, ownedSignal, () => {});
      }
      let complete = 0;
      // Keep each artifact independently resumable; only a complete requested set becomes ready.
      for (const asset of assets) {
        ownedSignal.throwIfAborted(); const destination = qwenEditAssetPath(this.paths, asset); const directory = path.dirname(destination); await fs.promises.mkdir(directory, { recursive: true }); this.validatePaths();
        this.update({ activeRole: asset.role, message: `Preparing Qwen ${asset.role}…` });
        const fileLock = `model-file-${createHash('sha256').update(path.resolve(destination).toLowerCase()).digest('hex')}`;
        await withReviewedAssetLock(this.paths, fileLock, ownedSignal, async fileSignal => {
          if (repair) await preserveChangedReviewedAsset(this.paths, destination, asset, fileSignal);
          if (repair && !fs.existsSync(destination)) {
            let partial = 0;
            try { const stat = await fs.promises.lstat(`${destination}.part`); if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) partial = Math.min(asset.bytes, stat.size); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            const available = await fs.promises.statfs(directory);
            if (available.bavail * available.bsize < asset.bytes - partial + 512 * 1024 * 1024) throw new Error('Not enough space to replace this Qwen asset. The changed file is preserved; free space and retry setup.');
          }
          await downloadAssistantAsset(asset, directory, fileSignal, (received, _total, verifying) => this.update({ message: verifying ? `Verifying full SHA-256 for Qwen ${asset.role}…` : `Downloading Qwen ${asset.role}: ${(received / 1e9).toFixed(2)} / ${(asset.bytes / 1e9).toFixed(2)} GB`, installProgress: (complete + received) / total * 99 }));
          const validation = await inspectQwenEditAsset(destination, asset); fileSignal.throwIfAborted();
          receipts[asset.role] = { role: asset.role, filename: `qwen-edit-2511/${asset.filename}`, directory: asset.directory, bytes: asset.bytes, sha256: asset.sha256, format: 'safetensors', status: 'ready', provenance: { repository: asset.repository, revision: asset.revision, sourceFile: asset.sourceFile, sourceUrl: asset.url, modelCardUrl: resolveUrl(asset.repository, asset.revision, 'README.md'), licenseName: 'Apache-2.0', licenseUrl: LICENSE.url }, validation, verifiedAt: new Date().toISOString() };
          const temporary = `${this.files.marker}.${randomUUID()}.tmp`; await fs.promises.writeFile(temporary, JSON.stringify({ schema: 1, assets: receipts }, null, 2), { flag: 'wx' }); fileSignal.throwIfAborted(); await fs.promises.rename(temporary, this.files.marker);
        });
        complete += asset.bytes; this.refreshReceipts(); this.update({ installProgress: complete / total * 99 });
      }
      const bundle = this.bundle(profile, receipts)!; this.store.setState(`qwen-edit.installation.${profile}`, bundle); this.refreshReceipts(); this.update({ state: 'ready', profile, activeRole: undefined, bundle, message: `Qwen ${profile} model files are installed. Choose a source image and describe your edit.`, installProgress: 100 }); return structuredClone(bundle);
    });
  }
  verify(profile: QwenEditProfile = 'base'): Promise<QwenEditBundle> {
    if (this.disposed) return Promise.reject(new Error('The Qwen edit asset service was disposed.')); try { selected(profile); } catch (error) { return Promise.reject(error); }
    if (this.setupPromise) return this.activeProfile === profile ? this.setupPromise.then(() => this.verify(profile)) : Promise.reject(new Error('Wait for the current Qwen setup to finish.'));
    if (this.verifyPromise) return this.activeProfile === profile ? this.verifyPromise : Promise.reject(new Error('Wait for the current Qwen verification to finish.'));
    const controller = new AbortController(); this.verifyController = controller; this.activeProfile = profile;
    const startedAt = new Date().toISOString(); const totalBytes = qwenEditBytes(profile);
    this.verifyPromise = (async () => {
      let completedBytes = 0; let hashedBytes = 0; let cachedBytes = 0;
      this.update({ verification: { state: 'verifying', profile, startedAt, totalBytes, completedBytes, hashedBytes, cachedBytes, progress: 0, message: 'Checking Qwen model files before the edit is queued…' } });
      this.validatePaths(); const bundle = this.bundle(profile); if (!bundle) throw new Error(`Install the reviewed Qwen ${profile} assets before editing.`);
      for (const asset of selected(profile)) {
        controller.signal.throwIfAborted(); let lastUpdate = 0;
        this.update({ verification: { ...this.current.verification!, role: asset.role, message: `Checking Qwen ${asset.role}…` } });
        const result = await this.verifier.verify(qwenEditAssetPath(this.paths, asset), asset, controller.signal, value => {
          if (Date.now() - lastUpdate < 250 && value.bytes !== value.totalBytes) return; lastUpdate = Date.now();
          this.update({ verification: { state: 'verifying', profile, role: asset.role, startedAt, totalBytes, completedBytes: completedBytes + value.bytes, hashedBytes: hashedBytes + (value.cached ? 0 : value.bytes), cachedBytes: cachedBytes + (value.cached ? value.bytes : 0), progress: Math.min(100, (completedBytes + value.bytes) / totalBytes * 100), message: value.cached ? `Qwen ${asset.role}: unchanged since its full check this session.` : `Verifying Qwen ${asset.role}: ${(value.bytes / 1e9).toFixed(2)} / ${(value.totalBytes / 1e9).toFixed(2)} GB` } });
        });
        if (result.sha256 !== asset.sha256) throw new Error(`Qwen ${asset.role} bytes changed. The existing file was preserved.`);
        completedBytes += asset.bytes; if (result.cached) cachedBytes += asset.bytes; else hashedBytes += asset.bytes;
      }
      this.validatePaths(); const current = this.bundle(profile);
      if (!current || JSON.stringify(current.assets) !== JSON.stringify(bundle.assets)) throw new Error('Qwen installation receipts changed during verification. Recheck the selected bundle.');
      this.refreshReceipts();
      this.update({ verification: { state: 'complete', profile, startedAt, finishedAt: new Date().toISOString(), totalBytes, completedBytes, hashedBytes, cachedBytes, progress: 100, message: cachedBytes === totalBytes ? 'Qwen files are unchanged since their full check this session.' : 'Qwen file verification complete.' } });
      return structuredClone(bundle);
    })().catch(error => {
      this.verifier.invalidate();
      this.update({ ...(controller.signal.aborted ? {} : { state: 'error' as const, message: error.message }), verification: { state: controller.signal.aborted ? 'cancelled' : 'error', profile, startedAt, finishedAt: new Date().toISOString(), totalBytes, completedBytes: this.current.verification?.completedBytes ?? 0, hashedBytes: this.current.verification?.hashedBytes ?? 0, cachedBytes: this.current.verification?.cachedBytes ?? 0, progress: this.current.verification?.progress ?? 0, message: controller.signal.aborted ? 'Qwen verification was cancelled.' : error.message } }); throw error;
    }).finally(() => { this.verifyPromise = undefined; this.verifyController = undefined; this.activeProfile = undefined; }); return this.verifyPromise;
  }
  /** The setup Cancel action must never interrupt queue/preflight verification. */
  async cancel() { this.controller?.abort(); await Promise.allSettled([this.setupPromise].filter(Boolean)); }
  async dispose() { this.disposed = true; this.verifyController?.abort(); await this.cancel(); await this.verifier.dispose(); await Promise.allSettled([this.verifyPromise].filter(Boolean)); }
}

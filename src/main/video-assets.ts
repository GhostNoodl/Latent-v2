import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AppPaths } from '../shared/types';
import type { VideoAssetIdentity, VideoDraft } from '../shared/video-types';
import type { VideoAcquisitionAuthorization, VideoAssetBundle, VideoAssetReceipt, VideoAssetsStatus } from '../shared/video-assets';
import { VIDEO_ASSET_DIRECTORIES } from '../shared/video-assets';
import { H3_ALL_VIDEO_ASSETS, videoProfileAssets, VIDEO_AVAILABILITY } from '../shared/video-plan';
import { downloadAssistantAsset } from './assistant-download';
import { inspectSafeTensors } from './models';
import { containedPath, validateRuntimePaths } from './runtime-config';
import { withReviewedAssetLock } from './reviewed-asset-lock';
import { SessionFileVerifier } from './session-file-verifier';

const authorizationSchema = z.object({ schema: z.literal(1), recordId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), licenseUrl: z.literal(VIDEO_AVAILABILITY.licenseUrl), resolvedAt: z.string().datetime(), scope: z.enum(['acquisition-and-use', 'local-files-only']) }).strict();
const profileSchema = z.enum(['base', 'turbo8', 'fused4']);
export function videoAssetPath(paths: AppPaths, asset: VideoAssetIdentity) { return path.join(paths.models, VIDEO_ASSET_DIRECTORIES[asset.role], 'minimax-h3', path.posix.basename(asset.filename)); }
export function videoAssetBinding(asset: VideoAssetIdentity) { return { role: asset.role, filename: `minimax-h3/${path.posix.basename(asset.filename)}`, bytes: asset.bytes, sha256: asset.sha256 }; }
export function videoAssetsMarker(paths: AppPaths) { return path.join(paths.runtime, 'minimax-h3', 'assets.json'); }

/** No download or write on construction/status. A missing main-owned authority always denies acquisition.
 * This service supplies verified assets only; it never starts a runtime, accepts a license or queues inference. */
export class VideoAssetsService {
  private current: VideoAssetsStatus = { state: 'not-installed', canAcquire: false, canGenerate: false, basePresent: false, turboPresent: false, installedRoles: [], warnings: [], message: 'Video model files are not installed.' };
  private pending?: Promise<VideoAssetBundle>; private operationKind?: 'setup' | 'verify' | 'local-verify'; private activeProfile?: VideoDraft['profile'];
  private controller?: AbortController; private disposed = false; private verifier: SessionFileVerifier;
  constructor(private paths: AppPaths, private authority: () => VideoAcquisitionAuthorization | undefined = () => undefined, private changed: () => void = () => {}) {
    this.verifier = new SessionFileVerifier(paths.models, 8); this.validatePaths();
  }
  private selected(profile: VideoDraft['profile']) { profileSchema.parse(profile); return videoProfileAssets(profile); }
  private authorization() { const parsed = authorizationSchema.safeParse(this.authority()); if (!parsed.success) throw new Error('MiniMax H3 licensing eligibility is unresolved. Model acquisition and use remain unavailable.'); return parsed.data; }
  /** Main/queue may recheck permission immediately before submission without repeating model I/O. */
  authorizationRecordId() { return this.authorization().recordId; }
  private stillAuthorized(expected: VideoAcquisitionAuthorization, signal: AbortSignal) {
    signal.throwIfAborted(); if (!isDeepStrictEqual(this.authorization(), expected)) throw new Error('MiniMax H3 eligibility changed during this operation. Existing files were retained.');
  }
  private validatePaths() {
    validateRuntimePaths(this.paths);
    for (const target of [videoAssetsMarker(this.paths), ...H3_ALL_VIDEO_ASSETS.map(asset => videoAssetPath(this.paths, asset))]) {
      containedPath(storageBoundary(this.paths, target), target);
      for (let current = target; current !== storageBoundary(this.paths, target); current = path.dirname(current)) {
        try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Video model storage cannot use symbolic links or junctions.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    }
  }
  private readMarker(): { schema: 1; assets: VideoAssetReceipt[] } {
    const filename = videoAssetsMarker(this.paths);
    try {
      const before = fs.lstatSync(filename);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 64 * 1024) throw new Error('Invalid receipt file.');
      const value = JSON.parse(fs.readFileSync(filename, 'utf8')); const after = fs.lstatSync(filename);
      if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw new Error('Receipt changed while reading.');
      if (value.schema !== 1 || !Array.isArray(value.assets) || value.assets.length > H3_ALL_VIDEO_ASSETS.length || Object.keys(value).some(key => !['schema', 'assets'].includes(key))) throw new Error('Unsupported receipt.');
      const roles = new Set<string>();
      for (const receipt of value.assets) {
        const pin = H3_ALL_VIDEO_ASSETS.find(item => item.role === receipt?.asset?.role && item.sha256 === receipt?.asset?.sha256);
        if (!pin || roles.has(pin.sha256) || !isDeepStrictEqual(receipt.asset, pin) || !isDeepStrictEqual(receipt.binding, videoAssetBinding(pin)) || !z.string().datetime().safeParse(receipt.verifiedAt).success || !z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).safeParse(receipt.authorizationRecordId).success || Object.keys(receipt).some(key => !['asset', 'binding', 'verifiedAt', 'authorizationRecordId'].includes(key))) throw new Error('Changed video asset provenance.');
        roles.add(pin.sha256);
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: 1, assets: [] };
      throw new Error('The saved video asset receipt is invalid or changed. Its original data was preserved.');
    }
  }
  private present(receipt: VideoAssetReceipt) {
    try { const stat = fs.lstatSync(videoAssetPath(this.paths, receipt.asset)); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === receipt.asset.bytes; } catch { return false; }
  }
  status(): VideoAssetsStatus {
    let canAcquire = false, canVerify = false; try { canAcquire = this.authorization().scope === 'acquisition-and-use'; canVerify = true; } catch { /* No renderer-supplied eligibility. */ }
    let assets: VideoAssetReceipt[] = []; const warnings: string[] = [];
    try { this.validatePaths(); const marker = this.readMarker(); assets = marker.assets.filter(receipt => this.present(receipt)); if (assets.length !== marker.assets.length) warnings.push('Some saved video model files are missing or changed. Setup preserves existing files and can restore missing ones.'); }
    catch (error) { warnings.push((error as Error).message); this.verifier.invalidate(); }
    const installedRoles = assets.map(receipt => receipt.asset.role);
    const basePresent = this.selected('base').every(asset => assets.some(receipt => isDeepStrictEqual(receipt.asset, asset)));
    const turboPresent = basePresent && installedRoles.includes('turbo');
    const fusedPresent = this.selected('fused4').every(asset => assets.some(receipt => isDeepStrictEqual(receipt.asset, asset)));
    const state = this.operationKind || ['cancelled', 'error'].includes(this.current.state) ? this.current.state : basePresent || fusedPresent ? 'installed' : assets.length ? 'partial' : 'not-installed';
    return structuredClone({ ...this.current, state, canAcquire, canVerify, canGenerate: false, basePresent, turboPresent, fusedPresent, installedRoles, warnings,
      ...(!this.operationKind && !['cancelled', 'error'].includes(state) ? { message: !canVerify ? 'MiniMax H3 eligibility is unresolved. Setup and generation remain unavailable.' : !canAcquire ? 'Local files only. Place the selected H3 components in the listed private model folders, then verify them. Automatic downloads are disabled.' : basePresent || fusedPresent ? 'Video model files are present. Verify their full contents before use; runtime and GPU support remain unverified.' : 'Video model files are incomplete. Setup can resume verified partial downloads.' } : {}) });
  }
  private update(patch: Partial<VideoAssetsStatus>) { this.current = { ...this.current, ...patch }; this.changed(); }
  setup(profile: VideoDraft['profile'] = 'base') { return this.operation('setup', profile); }
  verify(profile: VideoDraft['profile'] = 'base') { return this.operation('verify', profile); }
  /** User-owned verification can be cancelled without interrupting queue preflight. */
  verifyLocal(profile: VideoDraft['profile'] = 'base') { return this.operation('local-verify', profile); }
  private operation(kind: 'setup' | 'verify' | 'local-verify', profile: VideoDraft['profile']): Promise<VideoAssetBundle> {
    if (this.disposed) return Promise.reject(new Error('The video asset service is closed.'));
    let authorization: VideoAcquisitionAuthorization;
    try { this.selected(profile); authorization = this.authorization(); if (kind === 'setup' && authorization.scope === 'local-files-only') throw new Error('Automatic H3 downloads are disabled. Supply local model files, then verify them.'); } catch (error) { return Promise.reject(error); }
    if (this.pending) return this.operationKind === kind && this.activeProfile === profile ? this.pending : Promise.reject(new Error('Wait for the current video asset operation to finish.'));
    this.controller = new AbortController(); const signal = this.controller.signal; this.operationKind = kind; this.activeProfile = profile;
    this.update({ state: kind === 'setup' ? 'installing' : 'verifying', profile, progress: 0, activeRole: undefined, message: kind === 'setup' ? 'Preparing the selected video model files…' : 'Verifying the selected video model files…' });
    this.pending = this.run(kind, profile, authorization, signal).catch(error => {
      this.verifier.invalidate(); this.update({ state: signal.aborted ? 'cancelled' : 'error', activeRole: undefined, message: signal.aborted ? kind === 'local-verify' ? 'Local video verification cancelled. Existing model files were retained.' : 'Video setup cancelled; verified files and resumable downloads were retained.' : (error as Error).message }); throw error;
    }).finally(() => { this.pending = undefined; this.operationKind = undefined; this.activeProfile = undefined; this.controller = undefined; this.changed(); });
    return this.pending;
  }
  private async run(kind: 'setup' | 'verify' | 'local-verify', profile: VideoDraft['profile'], authorization: VideoAcquisitionAuthorization, signal: AbortSignal): Promise<VideoAssetBundle> {
    this.validatePaths(); this.stillAuthorized(authorization, signal);
    if (!fs.existsSync(this.paths.python)) throw new Error('Install the private image-engine runtime before setting up video assets.');
    return withReviewedAssetLock(this.paths, 'minimax-h3-assets', signal, async ownedSignal => {
      this.stillAuthorized(authorization, ownedSignal); this.validatePaths();
      const initial = this.readMarker(); const receipts = structuredClone(initial.assets); const assets = this.selected(profile);
      const total = assets.reduce((sum, asset) => sum + asset.bytes, 0); let completed = 0;
      if (kind === 'setup') {
        const missing = assets.reduce((sum, asset) => sum + this.remainingBytes(asset), 0);
        const free = await fs.promises.statfs(this.paths.models);
        if (free.bavail * free.bsize < missing + 512 * 1024 * 1024) throw new Error('Not enough free space for the selected video model files and setup headroom. Existing files were retained.');
      }
      let expectedMarker = initial;
      for (const asset of assets) {
        this.stillAuthorized(authorization, ownedSignal); this.validatePaths();
        const destination = videoAssetPath(this.paths, asset); const directory = path.dirname(destination);
        this.update({ activeRole: asset.role, message: `${kind === 'setup' ? 'Preparing' : 'Verifying'} video ${asset.role}…` });
        const fileLock = `model-file-${createHash('sha256').update(path.resolve(destination).toLowerCase()).digest('hex')}`;
        await withReviewedAssetLock(this.paths, fileLock, ownedSignal, async fileSignal => {
          if (kind === 'setup') {
            await fs.promises.mkdir(directory, { recursive: true }); this.validatePaths(); this.stillAuthorized(authorization, fileSignal);
            await downloadAssistantAsset({ filename: path.basename(destination), bytes: asset.bytes, sha256: asset.sha256, url: asset.sourceUrl }, directory, fileSignal, received => {
              // Progress may run from a stream event; signal cancellation rather than throwing out of that event.
              try { this.stillAuthorized(authorization, fileSignal); } catch (error) { this.controller?.abort(error); return; }
              this.update({ progress: Math.min(99, (completed + received) / total * 100) });
            });
          } else if (authorization.scope !== 'local-files-only' && !receipts.some(receipt => isDeepStrictEqual(receipt.asset, asset) && this.present(receipt))) throw new Error('Install the complete selected video profile before verification.');
          this.stillAuthorized(authorization, fileSignal); this.validatePaths();
          const verified = await this.verifier.verify(destination, asset, fileSignal);
          if (verified.sha256 !== asset.sha256) throw new Error('Video model contents changed. The existing file was preserved.');
          await inspectSafeTensors(destination);
          await this.verifier.verify(destination, asset, fileSignal);
          this.stillAuthorized(authorization, fileSignal); this.validatePaths();
          if (!isDeepStrictEqual(this.readMarker(), expectedMarker)) throw new Error('Video asset receipts changed during verification. Their original data was preserved.');
          if (kind === 'setup' || authorization.scope === 'local-files-only' && !receipts.some(receipt => isDeepStrictEqual(receipt.asset, asset) && receipt.authorizationRecordId === authorization.recordId)) {
            const receipt: VideoAssetReceipt = { asset: structuredClone(asset), binding: videoAssetBinding(asset), verifiedAt: new Date().toISOString(), authorizationRecordId: authorization.recordId };
            const previous = receipts.findIndex(item => isDeepStrictEqual(item.asset, asset)); if (previous < 0) receipts.push(receipt); else receipts[previous] = receipt;
            const marker = videoAssetsMarker(this.paths); await fs.promises.mkdir(path.dirname(marker), { recursive: true }); this.validatePaths();
            const temporary = `${marker}.${randomUUID()}.tmp`; const handle = await fs.promises.open(temporary, 'wx');
            try { await handle.writeFile(JSON.stringify({ schema: 1, assets: receipts }, null, 2)); await handle.sync(); } finally { await handle.close(); }
            this.stillAuthorized(authorization, fileSignal); this.validatePaths();
            if (!isDeepStrictEqual(this.readMarker(), expectedMarker)) throw new Error('Video asset receipts changed before publication. Both receipts were preserved.');
            await fs.promises.rename(temporary, marker); expectedMarker = { schema: 1, assets: structuredClone(receipts) };
          }
        });
        completed += asset.bytes; this.update({ progress: completed / total * 100 });
      }
      // Earlier assets may have changed while later files downloaded. Recheck the full set using session fingerprints.
      for (const asset of assets) await this.verifier.verify(videoAssetPath(this.paths, asset), asset, ownedSignal);
      this.stillAuthorized(authorization, ownedSignal); this.validatePaths();
      if (!isDeepStrictEqual(this.readMarker(), expectedMarker)) throw new Error('Video asset receipts changed before completion.');
      const bundle: VideoAssetBundle = { schema: 1, profile, assets: receipts.filter(receipt => assets.some(asset => isDeepStrictEqual(asset, receipt.asset))), authorizationRecordId: authorization.recordId, runtimeVerified: false };
      this.update({ state: 'installed', progress: 100, activeRole: undefined, message: 'Selected video files passed full verification. Runtime integration and GPU support remain unverified.' });
      return structuredClone(bundle);
    });
  }
  private remainingBytes(asset: VideoAssetIdentity) {
    const destination = videoAssetPath(this.paths, asset);
    const regular = (filename: string) => { const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Video download paths must be independent regular files.'); return stat; };
    try { regular(destination); return 0; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try {
      const partial = regular(`${destination}.part`); const manifest = `${destination}.part.json`; const stat = regular(manifest);
      if (stat.size > 64 * 1024) return asset.bytes;
      const saved = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      return partial.size <= asset.bytes && saved.url === asset.sourceUrl && saved.bytes === asset.bytes && saved.sha256 === asset.sha256 ? asset.bytes - partial.size : asset.bytes;
    } catch (error) { if ((error as Error).message.includes('independent regular')) throw error; return asset.bytes; }
  }
  /** Setup cancel never cancels an executor's independent verification. */
  async cancel() { if (this.operationKind !== 'setup' && this.operationKind !== 'local-verify') return; this.controller?.abort(); await Promise.allSettled([this.pending].filter(Boolean)); }
  async dispose() { this.disposed = true; this.controller?.abort(); await Promise.allSettled([this.pending].filter(Boolean)); await this.verifier.dispose(); }
}

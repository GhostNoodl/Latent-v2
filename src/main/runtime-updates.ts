import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AppPaths } from '../shared/types';
import type { StudioStore } from './store';
import { DEFAULT_RUNTIME_UPDATE_SETTINGS, runtimeUpdateSettingsSchema, type ReviewedRuntimeSet, type RuntimeUpdateGeneration, type RuntimeUpdateHistory, type RuntimeUpdateHooks, type RuntimeUpdateSettings, type RuntimeUpdateStage, type RuntimeUpdateStatus } from '../shared/runtime-update-types';
import { latestReviewedRuntimeSet, reviewedInstalledRuntime, reviewedRuntimeSet } from './reviewed-runtime-channel';
import { assistantHash, downloadAssistantAsset } from './assistant-download';
import { extractRuntimeZip } from './runtime-archive';
import { withReviewedAssetLock } from './reviewed-asset-lock';
import { prepareRuntimeEnvironment, runtimeEnvironmentPaths, verifiedRuntimeEnvironment } from './runtime-environments';
import { runEnvironmentCommand } from './runtime-environment-command';
import { validateRuntimePaths } from './runtime-config';
import { RuntimeEnvironmentMismatch, verifyUpdateEnvironment, verifyUpdateSyntax } from './runtime-update-probe';
import { assertUpdateTree, copyUpdateTree, inspectReviewedCustomNodes, inspectUpdateTree, readUpdateJson, reviewedArchiveManifest, safeUpdatePath, updateExists, writeUpdateJson, type UpdateTreeManifest } from './runtime-update-storage';

const uuid = z.uuid(); const id = z.union([uuid, z.literal('legacy')]);
const generationSchema = z.object({ id, environmentId: uuid.optional(), setId: z.string().min(1).max(100), label: z.string().max(200), backendVersion: z.string().max(40), activatedAt: z.iso.datetime().optional(), startupVerifiedAt: z.iso.datetime().optional(), verification: z.enum(['existing-installation', 'startup-checked']) }).strict();
const treeSchema = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), files: z.array(z.object({ path: z.string().min(1).max(512), bytes: z.number().int().min(0).max(64 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(30000) }).strict();
const stagePublicSchema = z.object({ id: uuid, environmentId: uuid.optional(), setId: z.string().max(100), label: z.string().max(200), backendVersion: z.string().max(40), preparedAt: z.iso.datetime(), kind: z.enum(['update', 'refresh']), environmentRepair: z.literal(true).optional(), packageCount: z.number().int().min(0).max(2048), sourceFiles: z.number().int().min(1).max(30000), customNodeNames: z.array(z.string().regex(/^[\w-]+$/)).max(50), verification: z.literal('hashes-and-syntax') }).strict();
const stageSchema = z.object({ public: stagePublicSchema, initial: generationSchema, baseBackend: treeSchema, baseCustom: treeSchema, targetBackend: treeSchema, targetCustom: treeSchema }).strict();
const stateSchema = z.object({ schema: z.literal(1), current: generationSchema, previous: generationSchema.extend({ archiveId: uuid, backend: treeSchema, custom: treeSchema, installedMarker: z.record(z.string(), z.unknown()) }).strict().optional(), staged: stageSchema.optional() }).strict();
type SavedState = z.infer<typeof stateSchema>; type StageReceipt = z.infer<typeof stageSchema>;
const journalSchema = z.object({ schema: z.literal(1), id: uuid, kind: z.enum(['activate', 'rollback']), phase: z.string().max(80), committed: z.boolean(), priorEnvironmentUnverified: z.literal(true).optional(), prior: stateSchema, targetId: uuid, targetKind: z.enum(['staged', 'history']), targetSetId: z.string().max(100), markerBefore: z.record(z.string(), z.unknown()), markerAfter: z.record(z.string(), z.unknown()), targetGeneration: generationSchema, backendBefore: treeSchema, customBefore: treeSchema, backendAfter: treeSchema, customAfter: treeSchema }).strict();
type Journal = z.infer<typeof journalSchema>;
const text = (error: unknown) => error instanceof Error ? error.message : String(error);
export function runtimeUpdatePaths(paths: AppPaths) { const root = path.join(paths.runtime, 'updates'); return { root, state: path.join(root, 'state.json'), journal: path.join(root, 'transaction.json'), marker: path.join(paths.runtime, 'installed.json'), custom: path.join(paths.root, 'custom_nodes'), downloads: path.join(root, 'downloads'), staged: path.join(root, 'staged'), history: path.join(root, 'history'), failed: path.join(root, 'failed') }; }

export class RuntimeUpdateService {
  private files; private current: RuntimeUpdateStatus; private operation?: Promise<unknown>; private controller?: AbortController; private disposed = false;
  constructor(private paths: AppPaths, private store: StudioStore, private changed: () => void, private hooks: RuntimeUpdateHooks) {
    validateRuntimePaths(paths); this.files = runtimeUpdatePaths(paths);
    const settings = runtimeUpdateSettingsSchema.safeParse(store.getState('runtime-updates.settings', DEFAULT_RUNTIME_UPDATE_SETTINGS));
    this.current = { state: 'idle', message: 'Check the app’s reviewed runtime channel.', settings: settings.success ? settings.data : DEFAULT_RUNTIME_UPDATE_SETTINGS, automaticRetryPaused: store.getState<boolean>('runtime-updates.automatic-paused', false) === true, history: store.getState<RuntimeUpdateHistory[]>('runtime-updates.history', []).slice(-500), lastCheckedAt: store.getState<string | undefined>('runtime-updates.last-check', undefined), recoveryRequired: false };
  }
  status(): RuntimeUpdateStatus { return structuredClone(this.current); }
  private pauseAutomatic(paused: boolean) { this.store.setState('runtime-updates.automatic-paused', paused); this.update({ automaticRetryPaused: paused }); }
  private update(value: Partial<RuntimeUpdateStatus>) { this.current = { ...this.current, ...value }; this.changed(); }
  private history(action: RuntimeUpdateHistory['action'], outcome: RuntimeUpdateHistory['outcome'], message: string, extra: Partial<RuntimeUpdateHistory> = {}) { const event = { id: randomUUID(), at: new Date().toISOString(), action, outcome, message, ...extra }; this.current.history = [...this.current.history, event].slice(-500); this.store.setState('runtime-updates.history', this.current.history); this.changed(); }
  async saveSettings(input: Partial<RuntimeUpdateSettings>) {
    // Merge at the authoritative write boundary: renderer broadcasts can lag a
    // completed save, so unrelated values from its last snapshot are stale.
    const patch = runtimeUpdateSettingsSchema.partial().parse(input);
    const settings = runtimeUpdateSettingsSchema.parse({ ...this.current.settings, ...patch });
    this.store.setState('runtime-updates.settings', settings); this.update({ settings }); return settings;
  }
  /** Locate a retained environment for preservation only; never authorizes execution. */
  private async retainedEnvironment(generation: { environmentId?: string }): Promise<AppPaths> {
    const selected = generation.environmentId ? runtimeEnvironmentPaths(this.paths, generation.environmentId).paths : { ...this.paths, python: path.join(this.paths.runtime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') };
    validateRuntimePaths(selected); await safeUpdatePath(this.paths.root, selected.python, false); return selected;
  }
  private async environment(generation: { environmentId?: string; setId: string }, signal?: AbortSignal): Promise<AppPaths> {
    const set = reviewedRuntimeSet(generation.setId);
    if (generation.environmentId) return verifiedRuntimeEnvironment(this.paths, generation.environmentId, set, signal);
    const selected = { ...this.paths, python: path.join(this.paths.runtime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') };
    validateRuntimePaths(selected); await verifyUpdateEnvironment(selected, set, signal); return selected;
  }
  private async load(): Promise<SavedState> {
    validateRuntimePaths(this.paths); for (const value of Object.values(this.files)) await safeUpdatePath(this.paths.root, value);
    const marker = await readUpdateJson<Record<string, any>>(this.paths.root, this.files.marker); const set = marker && reviewedInstalledRuntime(marker);
    if (!set || marker?.schema !== 1 || marker.comfyVersion !== set.backend.version || marker.pythonVersion !== set.pythonVersion) throw new Error('Install or restore the reviewed private runtime before using its update channel.');
    const raw = await readUpdateJson(this.paths.root, this.files.state); const saved = raw ? stateSchema.parse(raw) : { schema: 1 as const, current: { id: 'legacy', setId: set.id, label: set.label, backendVersion: set.backend.version, verification: 'existing-installation' as const } };
    reviewedRuntimeSet(saved.current.setId); if (saved.previous) reviewedRuntimeSet(saved.previous.setId); if (saved.staged) reviewedRuntimeSet(saved.staged.public.setId);
    if (saved.current.environmentId !== marker.environmentId || saved.current.setId !== set.id || (marker.updateGenerationId ?? 'legacy') !== saved.current.id) throw new Error('Runtime update metadata is inconsistent. Recover its pending transaction before starting the engine.');
    this.update({ current: saved.current, previous: saved.previous, staged: saved.staged?.public, recoveryRequired: await updateExists(this.files.journal) }); return saved;
  }
  private async action<T>(state: RuntimeUpdateStatus['state'], action: RuntimeUpdateHistory['action'], operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error('The runtime updater was disposed.'); if (this.operation) throw new Error('Another runtime maintenance operation is in progress.');
    const controller = new AbortController(); this.controller = controller; this.update({ state, progress: undefined });
    const running = withReviewedAssetLock(this.paths, 'runtime-compatible-set-update', controller.signal, operation).catch(error => { this.pauseAutomatic(true); this.update({ state: 'error', message: text(error), progress: undefined }); this.history(action, controller.signal.aborted ? 'cancelled' : 'failed', text(error)); throw error; }).finally(() => { this.operation = undefined; this.controller = undefined; }); this.operation = running; return running;
  }
  async check(): Promise<RuntimeUpdateStatus> {
    if (!await updateExists(this.files.marker)) throw new Error('Set up the private image engine before checking its runtime channel.');
    return this.action('checking', 'check', async () => { const saved = await this.load(); if (this.current.recoveryRequired) throw new Error('A runtime update was interrupted. Recover it before checking for another update.'); const latest = latestReviewedRuntimeSet(); const installed = reviewedRuntimeSet(saved.current.setId); const available = latest.sequence > installed.sequence ? { setId: latest.id, label: latest.label, backendVersion: latest.backend.version, environmentPreparationBytes: latest.environmentPreparationBytes } : undefined; const at = new Date().toISOString(); this.store.setState('runtime-updates.last-check', at); const message = available ? `${available.label} is available in this app’s reviewed channel.` : 'No newer reviewed runtime set is included in this app release.'; this.update({ state: saved.staged ? 'staged' : 'idle', available, lastCheckedAt: at, message }); this.history('check', 'success', message); this.pauseAutomatic(false); return this.status(); });
  }
  private async archive(set: ReviewedRuntimeSet, signal: AbortSignal): Promise<{ filename: string; manifest: UpdateTreeManifest }> {
    await fs.mkdir(this.files.downloads, { recursive: true }); const filename = `ComfyUI-${set.backend.commit}.zip`; const target = path.join(this.files.downloads, filename); const existing = path.join(this.paths.cache, 'runtime', 'downloads', filename);
    if (!await updateExists(target) && await updateExists(existing)) { await safeUpdatePath(this.paths.root, existing, false); if (await assistantHash(existing, signal) === set.backend.archiveSha256) await fs.copyFile(existing, target, fs.constants.COPYFILE_EXCL); }
    await downloadAssistantAsset({ filename, url: set.backend.archiveUrl, sha256: set.backend.archiveSha256, bytes: set.backend.archiveBytes }, this.files.downloads, signal, (received, total, verifying) => this.update({ message: verifying ? 'Verifying the reviewed source archive…' : 'Downloading the reviewed source archive…', progress: received / total * 30 }));
    return { filename: target, manifest: reviewedArchiveManifest(target, set) };
  }
  stage(kind: 'update' | 'refresh' = 'update'): Promise<RuntimeUpdateStage> { return this.prepareStage(kind, false); }
  /** Explicit repair preparation only; never changes the active interpreter. */
  prepareEnvironmentRepair(): Promise<RuntimeUpdateStage> { return this.prepareStage('refresh', true); }
  private prepareStage(kind: 'update' | 'refresh', repairEnvironment: boolean): Promise<RuntimeUpdateStage> {
    return this.action('staging', kind === 'refresh' ? 'refresh' : 'stage', async signal => {
      // A hard exit may skip catch/finally. Persist the retry barrier before any
      // preparation work; successful staging clears it below.
      this.store.setState('runtime-updates.automatic-paused', true);
      if (!['update', 'refresh'].includes(kind)) throw new Error('Choose a reviewed update or a same-version runtime refresh.'); const saved = await this.load(); if (this.current.recoveryRequired) throw new Error('Recover the interrupted runtime transaction before staging another set.');
      const baseline = reviewedRuntimeSet(saved.current.setId); const target = kind === 'refresh' ? baseline : latestReviewedRuntimeSet(); if (kind === 'update' && target.sequence <= baseline.sequence) throw new Error('No newer reviewed runtime set is available. A verified refresh can reinstall the current set.');
      this.update({ message: 'Checking the active private Python/package environment…' });
      if (repairEnvironment) {
        let mismatch = false;
        try { await this.environment(saved.current, signal); } catch (error) { if (!(error instanceof RuntimeEnvironmentMismatch)) throw error; mismatch = true; }
        if (!mismatch) throw new Error('The active environment already matches its reviewed versions. No repair was prepared.');
      } else await this.environment(saved.current, signal);
      const original = await this.archive(baseline, signal); const archive = target.id === baseline.id ? original : await this.archive(target, signal);
      const baseBackend = await inspectUpdateTree(this.paths.backend, signal); assertUpdateTree(baseBackend, original.manifest, 'The active backend'); const baseCustom = await inspectReviewedCustomNodes(this.files.custom, baseline, signal); await inspectReviewedCustomNodes(this.files.custom, target, signal);
      const stageId = randomUUID(); const destination = path.join(this.files.staged, stageId); await safeUpdatePath(this.paths.root, destination); await fs.mkdir(path.join(destination, 'backend'), { recursive: true }); await fs.mkdir(path.join(destination, 'custom_nodes'));
      const free = await fs.statfs(this.paths.runtime); const requiredBytes = archive.manifest.files.reduce((sum, file) => sum + file.bytes, 0) + baseCustom.files.reduce((sum, file) => sum + file.bytes, 0) + 64 * 1024 * 1024; if (free.bavail * free.bsize < requiredBytes) throw new Error('Not enough free space to stage the reviewed runtime while preserving the active version.');
      this.update({ message: 'Staging the reviewed backend and existing reviewed custom nodes…', progress: 40 }); await extractRuntimeZip(archive.filename, path.join(destination, 'backend'), `ComfyUI-${target.backend.commit}/`); await fs.writeFile(path.join(destination, 'backend', '.latent-source.json'), JSON.stringify({ commit: target.backend.commit, sha256: target.backend.archiveSha256 }));
      assertUpdateTree(await inspectUpdateTree(path.join(destination, 'backend'), signal), archive.manifest, 'The staged backend'); await copyUpdateTree(this.files.custom, path.join(destination, 'custom_nodes'), baseCustom, signal); await verifyUpdateSyntax(this.paths, [path.join(destination, 'backend'), path.join(destination, 'custom_nodes')], signal); signal.throwIfAborted();
      let environmentId = saved.current.environmentId;
      const differentPackages = !isDeepStrictEqual(baseline.packages, target.packages) || baseline.pythonVersion !== target.pythonVersion;
      if (repairEnvironment || differentPackages || environmentId && baseline.id !== target.id) {
        this.update({ message: 'Preparing an independent private Python environment; the active engine is unchanged…', progress: undefined });
        environmentId = (await prepareRuntimeEnvironment(this.paths, target, path.join(destination, 'backend', 'requirements.txt'), runEnvironmentCommand, signal, message => this.update({ message, progress: undefined }))).id;
      }
      const prepared: RuntimeUpdateStage = { id: stageId, ...(environmentId ? { environmentId } : {}), setId: target.id, label: target.label, backendVersion: target.backend.version, preparedAt: new Date().toISOString(), kind, ...(repairEnvironment ? { environmentRepair: true as const } : {}), packageCount: target.packages.length, sourceFiles: archive.manifest.files.length, customNodeNames: [...new Set(baseCustom.files.map(file => file.path.split('/')[0]))], verification: 'hashes-and-syntax' };
      const receipt: StageReceipt = { public: prepared, initial: saved.current, baseBackend, baseCustom, targetBackend: archive.manifest, targetCustom: baseCustom }; await writeUpdateJson(this.paths.root, path.join(destination, 'receipt.json'), receipt); saved.staged = receipt; await writeUpdateJson(this.paths.root, this.files.state, saved);
      this.update({ state: 'staged', staged: prepared, message: 'Verified runtime is staged. Apply while idle to check engine startup and capabilities; generation reverification remains separate.', progress: 100 }); this.history(kind === 'refresh' ? 'refresh' : 'stage', 'success', 'Reviewed source, syntax and dependency preparation checked; the active runtime was unchanged.', { setId: target.id, generationId: stageId }); this.pauseAutomatic(false); return prepared;
    });
  }
  activate(): Promise<void> { return this.action('applying', 'activate', signal => this.hooks.withMaintenance(() => this.apply('activate', signal), { kind: 'apply' })); }
  rollback(): Promise<void> { return this.action('rolling-back', 'rollback', signal => this.hooks.withMaintenance(() => this.apply('rollback', signal), { kind: 'apply' })); }
  private async recoverPreviousSource(previous: NonNullable<SavedState['previous']>, signal: AbortSignal) {
    const destination = path.join(this.files.history, previous.archiveId);
    const trees = [['backend', previous.backend], ['custom_nodes', previous.custom]] as const;
    const missing = [];
    for (const [name, expected] of trees) {
      if (await updateExists(path.join(destination, name))) assertUpdateTree(await inspectUpdateTree(path.join(destination, name), signal), expected, 'Existing previous runtime source');
      else missing.push([name, expected] as const);
    }
    if (!missing.length) return;
    this.update({ message: 'Checking preserved recovery files for the exact previous runtime…' });
    await safeUpdatePath(this.paths.root, this.files.failed);
    const entries = await fs.readdir(this.files.failed, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of entries.filter(item => item.isDirectory() && !item.isSymbolicLink() && uuid.safeParse(item.name).success).slice(0, 100)) {
      signal.throwIfAborted(); const candidate = path.join(this.files.failed, entry.name);
      let matches = true;
      for (const [name, expected] of missing) {
        try { assertUpdateTree(await inspectUpdateTree(path.join(candidate, name), signal), expected, 'Preserved previous source'); }
        catch { signal.throwIfAborted(); matches = false; break; }
      }
      if (!matches) continue;
      const required = missing.reduce((sum, [, tree]) => sum + tree.files.reduce((n, file) => n + file.bytes, 0), 64 * 1024 * 1024);
      const space = await fs.statfs(this.paths.runtime);
      if (space.bavail * space.bsize < required) throw new Error('Not enough space to restore the previous runtime while preserving its recovery files.');
      await safeUpdatePath(this.paths.root, destination); await fs.mkdir(destination, { recursive: true });
      for (const [name, expected] of missing) {
        const temporary = path.join(destination, `${name}.restore-${randomUUID()}`);
        await copyUpdateTree(path.join(candidate, name), temporary, expected, signal);
        await safeUpdatePath(this.paths.root, path.join(destination, name));
        if (await updateExists(path.join(destination, name))) throw new Error('The previous runtime destination changed during recovery. All copies were preserved.');
        await fs.rename(temporary, path.join(destination, name));
      }
      return;
    }
    throw new Error('The previous runtime source is missing and no exact preserved recovery copy was found. The current runtime and all retained files were preserved.');
  }
  private async apply(kind: 'activate' | 'rollback', signal: AbortSignal): Promise<void> {
    if (!this.hooks.isIdle()) throw new Error('Wait until the studio queue is idle before changing the runtime.'); const saved = await this.load(); if (this.current.recoveryRequired) throw new Error('Recover the interrupted transaction before changing the runtime.');
    const stage = saved.staged; const previous = saved.previous;
    if (kind === 'activate' && !stage || kind === 'rollback' && !previous) throw new Error(kind === 'activate' ? 'Stage a reviewed runtime set before applying it.' : 'No previous runtime generation is available to restore.');
    const targetId = kind === 'activate' ? stage!.public.id : previous!.archiveId; const targetKind = kind === 'activate' ? 'staged' : 'history'; const targetSet = reviewedRuntimeSet(kind === 'activate' ? stage!.public.setId : previous!.setId); const directory = path.join(this.files[targetKind], targetId);
    const currentSet = reviewedRuntimeSet(saved.current.setId);
    let priorEnvironmentUnverified = false;
    try { await this.environment(saved.current, signal); } catch (error) {
      if (!(error instanceof RuntimeEnvironmentMismatch) || kind !== 'activate' || !stage?.public.environmentRepair || !stage.public.environmentId || stage.public.environmentId === saved.current.environmentId) throw error;
      await this.retainedEnvironment(saved.current); priorEnvironmentUnverified = true;
    }
    const targetEnvironmentId = kind === 'activate' ? stage!.public.environmentId : previous!.environmentId; const selected = await this.environment({ setId: targetSet.id, environmentId: targetEnvironmentId }, signal); const oldArchive = await this.archive(currentSet, signal); const newArchive = targetSet.id === currentSet.id ? oldArchive : await this.archive(targetSet, signal);
    const backendBefore = await inspectUpdateTree(this.paths.backend, signal); assertUpdateTree(backendBefore, oldArchive.manifest, 'The active backend'); const customBefore = await inspectReviewedCustomNodes(this.files.custom, currentSet, signal);
    if (kind === 'rollback') await this.recoverPreviousSource(previous!, signal);
    const backendAfter = await inspectUpdateTree(path.join(directory, 'backend'), signal); assertUpdateTree(backendAfter, newArchive.manifest, 'The staged/previous backend'); const customAfter = await inspectReviewedCustomNodes(path.join(directory, 'custom_nodes'), targetSet, signal);
    if (kind === 'activate') { if (stage!.initial.id !== saved.current.id) throw new Error('The active runtime changed after staging. Stage this update again.'); assertUpdateTree(backendBefore, stage!.baseBackend, 'The active backend since staging'); assertUpdateTree(customBefore, stage!.baseCustom, 'Custom nodes since staging'); assertUpdateTree(customAfter, stage!.targetCustom, 'Staged custom nodes'); }
    if (kind === 'rollback') { assertUpdateTree(backendAfter, previous!.backend, 'The retained previous backend'); assertUpdateTree(customAfter, previous!.custom, 'The retained previous custom nodes'); }
    const markerBefore = (await readUpdateJson<Record<string, any>>(this.paths.root, this.files.marker))!; const transactionId = randomUUID(); const generationId = randomUUID();
    const generation: RuntimeUpdateGeneration = { id: generationId, ...(targetEnvironmentId ? { environmentId: targetEnvironmentId } : {}), setId: targetSet.id, label: targetSet.label, backendVersion: targetSet.backend.version, activatedAt: new Date().toISOString(), verification: 'startup-checked' };
    const markerAfter = { ...(kind === 'rollback' ? previous!.installedMarker : markerBefore), comfyVersion: targetSet.backend.version, comfyCommit: targetSet.backend.commit, sourceSha256: targetSet.backend.archiveSha256, updateSetId: targetSet.id, updateGenerationId: generationId, pythonVersion: targetSet.pythonVersion };
    delete (markerAfter as Record<string, unknown>).environmentId; if (targetEnvironmentId) (markerAfter as Record<string, unknown>).environmentId = targetEnvironmentId;
    const transaction: Journal = { schema: 1, id: transactionId, kind, phase: 'prepared', committed: false, ...(priorEnvironmentUnverified ? { priorEnvironmentUnverified: true as const } : {}), prior: saved, targetId, targetKind, targetSetId: targetSet.id, markerBefore, markerAfter, targetGeneration: generation, backendBefore, customBefore, backendAfter, customAfter };
    await writeUpdateJson(this.paths.root, this.files.journal, transaction); this.update({ recoveryRequired: true });
    try {
      await fs.mkdir(path.join(this.files.history, transactionId), { recursive: true });
      await this.move(transaction, this.paths.backend, path.join(this.files.history, transactionId, 'backend'), 'retain-previous-backend');
      await this.move(transaction, path.join(directory, 'backend'), this.paths.backend, 'activate-backend');
      if (!await updateExists(this.files.custom)) await fs.mkdir(this.files.custom, { recursive: true });
      await this.move(transaction, this.files.custom, path.join(this.files.history, transactionId, 'custom_nodes'), 'retain-previous-custom-nodes');
      await this.move(transaction, path.join(directory, 'custom_nodes'), this.files.custom, 'activate-custom-nodes');
      transaction.phase = 'write-active-marker'; await writeUpdateJson(this.paths.root, this.files.journal, transaction); await writeUpdateJson(this.paths.root, this.files.marker, markerAfter); this.paths.python = selected.python;
      transaction.phase = 'verify-startup'; await writeUpdateJson(this.paths.root, this.files.journal, transaction); this.update({ message: 'Checking the activated engine and mandatory capabilities…' }); await this.hooks.startAndVerify(targetSet, [...new Set(customAfter.files.map(file => file.path.split('/')[0]))]);
      generation.startupVerifiedAt = new Date().toISOString(); const next: SavedState = { schema: 1, current: generation, previous: { ...saved.current, archiveId: transactionId, backend: backendBefore, custom: customBefore, installedMarker: markerBefore } };
      transaction.phase = 'commit-state'; await writeUpdateJson(this.paths.root, this.files.journal, transaction); await writeUpdateJson(this.paths.root, this.files.state, next); transaction.committed = true; transaction.phase = 'committed'; await writeUpdateJson(this.paths.root, this.files.journal, transaction);
      this.history(kind, 'success', 'Engine startup and mandatory capabilities passed. Model-generation reverification is recorded separately.', { setId: targetSet.id, generationId }); await fs.unlink(this.files.journal); this.update({ state: 'idle', current: generation, previous: next.previous, available: undefined, staged: undefined, recoveryRequired: false, message: kind === 'rollback' ? 'Previous runtime restored and startup checked.' : 'Runtime applied and startup checked. The previous generation is retained for rollback.', progress: undefined });
    } catch (error) {
      if (transaction.committed) throw new Error(`The runtime was committed but its history could not be finalized. Restart to finish recovery: ${text(error)}`);
      await this.hooks.stopBackend(); try { await this.restore(transaction); if (transaction.priorEnvironmentUnverified) await this.environment(transaction.prior.current); await this.hooks.startAndVerify(currentSet, [...new Set(customBefore.files.map(file => file.path.split('/')[0]))]); this.history('recover', 'success', 'Activation failed; the prior runtime was restored and startup checked.', { generationId: saved.current.id, setId: currentSet.id }); } catch (recovery) { this.update({ recoveryRequired: await updateExists(this.files.journal) }); throw new Error(`${text(error)} Recovery also needs attention: ${text(recovery)}`); } throw error;
    }
  }
  private async move(transaction: Journal, source: string, destination: string, phase: string) { await safeUpdatePath(this.paths.root, source, false); await safeUpdatePath(this.paths.root, destination); if (await updateExists(destination)) throw new Error('A runtime maintenance destination already exists; all files were preserved.'); transaction.phase = phase; await writeUpdateJson(this.paths.root, this.files.journal, transaction); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.rename(source, destination); }
  private async restore(transaction: Journal) {
    const priorEnvironment = transaction.priorEnvironmentUnverified ? await this.retainedEnvironment(transaction.prior.current) : await this.environment(transaction.prior.current);
    const backup = path.join(this.files.history, transaction.id); const failed = path.join(this.files.failed, transaction.id);
    for (const [name, live] of [['backend', this.paths.backend], ['custom_nodes', this.files.custom]]) {
      const retained = path.join(backup, name); const expected = name === 'backend' ? transaction.backendBefore : transaction.customBefore;
      if (!await updateExists(retained)) { assertUpdateTree(await inspectUpdateTree(live), expected, 'Already restored runtime source'); continue; }
      assertUpdateTree(await inspectUpdateTree(retained), expected, 'Retained rollback source');
      if (await updateExists(live)) await this.move(transaction, live, path.join(failed, name), `preserve-failed-${name}`);
      await this.move(transaction, retained, live, `restore-${name}`);
    }
    assertUpdateTree(await inspectUpdateTree(this.paths.backend), transaction.backendBefore, 'Restored backend');
    assertUpdateTree(await inspectUpdateTree(this.files.custom), transaction.customBefore, 'Restored custom nodes');
    // A rollback consumed the previous generation's directory when it became
    // live. Put its verified source back before restoring that same reference.
    // Otherwise recovery works once but the next explicit rollback sees ENOENT.
    if (transaction.kind === 'rollback') {
      const target = path.join(this.files.history, transaction.targetId);
      for (const [name, expected] of [['backend', transaction.backendAfter], ['custom_nodes', transaction.customAfter]] as const) {
        const destination = path.join(target, name);
        if (await updateExists(destination)) {
          assertUpdateTree(await inspectUpdateTree(destination), expected, 'Retained previous runtime source');
        } else {
          const source = path.join(failed, name);
          assertUpdateTree(await inspectUpdateTree(source), expected, 'Previous runtime source preserved during recovery');
          await this.move(transaction, source, destination, `restore-previous-${name}`);
        }
      }
    }
    transaction.phase = 'restore-prior-state'; await writeUpdateJson(this.paths.root, this.files.journal, transaction); await writeUpdateJson(this.paths.root, this.files.marker, transaction.markerBefore); this.paths.python = priorEnvironment.python;
    const prior = { ...transaction.prior, staged: undefined }; await writeUpdateJson(this.paths.root, this.files.state, prior); await fs.unlink(this.files.journal); this.update({ current: prior.current, previous: prior.previous, staged: undefined, recoveryRequired: false });
  }
  private async verifyCommitted(transaction: Journal) {
    const saved = await this.load();
    const selected = await this.environment(saved.current); if (transaction.priorEnvironmentUnverified) await this.retainedEnvironment(transaction.prior.current); else await this.environment(transaction.prior.current);
    const previous = { ...transaction.prior.current, archiveId: transaction.id, backend: transaction.backendBefore, custom: transaction.customBefore, installedMarker: transaction.markerBefore };
    const marker = await readUpdateJson(this.paths.root, this.files.marker);
    if (!isDeepStrictEqual(saved.current, transaction.targetGeneration) || !isDeepStrictEqual(saved.previous, previous) || saved.staged || !isDeepStrictEqual(marker, transaction.markerAfter)) throw new Error('Committed runtime metadata is inconsistent with its pending transaction. All files and the recovery journal were preserved.');
    assertUpdateTree(await inspectUpdateTree(this.paths.backend), transaction.backendAfter, 'The committed backend');
    assertUpdateTree(await inspectUpdateTree(this.files.custom), transaction.customAfter, 'The committed custom nodes');
    this.paths.python = selected.python;
    const retained = path.join(this.files.history, transaction.id);
    await safeUpdatePath(this.paths.root, retained, false);
    assertUpdateTree(await inspectUpdateTree(path.join(retained, 'backend')), transaction.backendBefore, 'The retained rollback backend');
    assertUpdateTree(await inspectUpdateTree(path.join(retained, 'custom_nodes')), transaction.customBefore, 'The retained rollback custom nodes');
  }
  async recover(): Promise<void> {
    if (!await updateExists(this.files.marker) && !await updateExists(this.files.journal)) { await safeUpdatePath(this.paths.root, this.files.root); this.update({ state: 'idle', message: 'Set up the private image engine before checking its runtime channel.' }); return; }
    return this.action('recovering', 'recover', async () => {
      const raw = await readUpdateJson(this.paths.root, this.files.journal); if (!raw) { if (!await updateExists(this.files.marker)) { this.update({ state: 'idle', message: 'Set up the private image engine before checking its runtime channel.' }); return; } const saved = await this.load(); this.paths.python = (await this.environment(saved.current)).python; this.update({ state: this.current.staged ? 'staged' : 'idle', message: 'The reviewed runtime has no interrupted update.' }); return; }
      const transaction = journalSchema.parse(raw); reviewedRuntimeSet(transaction.targetSetId); this.update({ recoveryRequired: true });
      await this.hooks.withMaintenance(async () => { if (!(this.hooks.isRecoverySafe?.() ?? this.hooks.isIdle())) throw new Error('The runtime must be idle and stopped before update recovery.'); if (transaction.committed) { await this.verifyCommitted(transaction); await fs.unlink(this.files.journal); } else { await this.restore(transaction); if (transaction.priorEnvironmentUnverified) await this.environment(transaction.prior.current); } }, { kind: 'recover' });
      this.history('recover', 'success', transaction.committed ? 'Finished recording an already committed runtime update.' : 'An interrupted update was rolled back before engine startup.'); await this.load(); this.update({ state: 'idle', recoveryRequired: false, message: 'Runtime update recovery completed. The previous working files were preserved.' });
    });
  }
  async automaticCheck(): Promise<void> {
    const { settings, lastCheckedAt } = this.current; if (this.operation || this.disposed || this.current.automaticRetryPaused) return;
    if (this.current.staged?.kind === 'update' && settings.autoApply && this.hooks.isIdle()) { await this.activate(); return; }
    if (this.current.available && settings.autoApply && this.hooks.isIdle()) { await this.stage('update'); if (this.current.settings.autoApply && this.hooks.isIdle()) await this.activate(); return; }
    const elapsed = lastCheckedAt ? Date.now() - Date.parse(lastCheckedAt) : NaN;
    // A corrected system clock must not postpone checks until a future saved date.
    const checkedRecently = elapsed >= 0 && elapsed < settings.intervalHours * 3600000;
    if (!settings.autoCheck || checkedRecently || !await updateExists(this.files.marker)) return;
    await this.check(); if (!this.current.available || !this.current.settings.autoApply) return;
    if (!this.hooks.isIdle()) { this.history('activate', 'deferred', 'Automatic application deferred because studio work is active or queued.'); return; }
    await this.stage('update'); if (!this.current.settings.autoApply) return;
    if (!this.hooks.isIdle()) { this.history('activate', 'deferred', 'The update remains staged until the studio is idle.'); return; } await this.activate();
  }
  async cancel() { if (!['checking', 'staging'].includes(this.current.state)) throw new Error('Activation and recovery must finish safely. Use rollback after they complete.'); this.controller?.abort(); await Promise.allSettled([this.operation].filter(Boolean)); }
  async dispose() { this.disposed = true; if (['checking', 'staging'].includes(this.current.state)) this.controller?.abort(); await Promise.allSettled([this.operation].filter(Boolean)); }
}

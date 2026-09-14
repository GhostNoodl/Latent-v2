import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AppPaths, ModelKind } from '../shared/types';
import type { CreateModelFolderRequest, ModelFolder, ModelLocationBinding, ModelLocationLookup, ModelLocationsSnapshot, MoveModelRequest } from '../shared/model-locations';
import { ModelService, hashFile, inspectSafeTensors } from './models';
import type { StudioStore } from './store';
import { inside } from './paths';
import { ExternalModelRegistry } from './external-model-locations';

const STATE_KEY = 'model-locations.v1';
const kindSchema = z.enum(['checkpoint', 'lora']);
const shaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const segmentSchema = z.string().min(1).max(120).refine(value => !/[<>:"/\\|?*\u0000-\u001f\u007f]/.test(value) && !/[. ]$/.test(value) && !/^\.{1,2}$/.test(value) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value), 'Use a folder or file name without reserved characters, device names, or trailing dots/spaces.');
const relativeSchema = z.string().max(400).refine(value => !value || (value.split('/').length <= 12 && value.split('/').every(segment => segmentSchema.safeParse(segment).success)), 'Choose a relative private model path with at most 12 levels.');
const modelPathSchema = relativeSchema.refine(value => value.toLowerCase().endsWith('.safetensors'), 'Choose a safetensors model.');
const bindingSchema = z.object({ modelId: z.string().min(1).max(500), kind: kindSchema, relativePath: modelPathSchema, sha256: shaSchema, aliases: z.array(modelPathSchema).min(1).max(256), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict();
const identitySchema = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/), size: z.string().regex(/^\d+$/) }).strict();
const journalSchema = z.object({ stage: z.enum(['prepared', 'committed']), source: modelPathSchema, destination: modelPathSchema, identity: identitySchema, before: bindingSchema.optional(), after: bindingSchema }).strict();
const indexSchema = z.object({ schemaVersion: z.literal(1), bindings: z.array(bindingSchema).max(10000), pending: journalSchema.optional() }).strict();
type Index = z.infer<typeof indexSchema>;
type Journal = z.infer<typeof journalSchema>;
type Identity = z.infer<typeof identitySchema>;
const emptyIndex: Index = { schemaVersion: 1, bindings: [] };
const fileKey = (kind: ModelKind, relative: string) => `${kind}:${process.platform === 'win32' ? relative.toLowerCase() : relative}`;
const samePath = (kind: ModelKind, a: string, b: string) => fileKey(kind, a) === fileKey(kind, b);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const identity = (stat: fs.BigIntStats): Identity => ({ dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size) });
const sameIdentity = (stat: fs.BigIntStats, expected: Identity) => String(stat.dev) === expected.dev && String(stat.ino) === expected.ino && String(stat.size) === expected.size;

export interface ModelLocationOptions {
  /** Must verify the owned backend is stopped and no jobs are queued/running. */
  assertChangesAllowed: () => void | Promise<void>;
  changeBlockedReason?: () => string | undefined;
}

/** Private-only physical folders. A SQLite journal reserves every former name
 * while a hardlink move keeps the model's stable ID and historical recipes.
 * Call initialize before backend auto-start; refresh ModelService after actions.
 */
export class ModelLocationService implements ModelLocationLookup {
  private folders: ModelFolder[] = [];
  private initialized = false;
  private lastError?: string;
  private external: ExternalModelRegistry;
  constructor(private paths: AppPaths, private store: StudioStore, private models: ModelService, private options: ModelLocationOptions, private changed: () => void = () => {}) {
    this.external = new ExternalModelRegistry(paths, store, () => this.scanBindings());
    models.setLocationRegistry(this);
  }

  snapshot(): ModelLocationsSnapshot {
    try {
      const index = this.read();
      const external = this.external.snapshot();
      return { schemaVersion: 1, folders: structuredClone(this.folders), bindings: index.bindings, recoveryRequired: Boolean(index.pending), changeBlockedReason: this.options.changeBlockedReason?.(), error: this.lastError ?? external.error, externalRoots: external.roots };
    } catch (error) {
      return { schemaVersion: 1, folders: structuredClone(this.folders), bindings: [], recoveryRequired: true, error: `The model location registry could not be read. Files and stored data are preserved. ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  async initialize(): Promise<ModelLocationsSnapshot> {
    try {
      if (this.read().pending) return await this.recover();
      return await this.models.library.withShared('reading private model folders', async () => {
        this.readyIndex(); await this.readFolders(); await this.external.scan(); this.initialized = true; this.lastError = undefined; return this.emit();
      });
    } catch (error) { this.lastError = error instanceof Error ? error.message : String(error); throw error; }
  }
  scanBindings(): readonly ModelLocationBinding[] {
    const index = this.read();
    if (index.pending) throw new Error('A model move needs recovery. Stop the backend and recover model folders before refreshing or generating.');
    return index.bindings;
  }
  async assertDestinationAvailable(kind: ModelKind, relativePath: string) {
    kindSchema.parse(kind); modelPathSchema.parse(relativePath);
    const bindings = this.scanBindings();
    const owner = bindings.find(binding => binding.kind === kind && binding.aliases.some(alias => samePath(kind, alias, relativePath)));
    if (owner && !samePath(kind, owner.relativePath, relativePath)) throw new Error('This filename belongs to a model that was moved. Choose another filename; its former name is reserved for saved recipes.');
    await this.external.assertDestinationAvailable(kind, relativePath);
  }
  async scanExternalModels() { return this.external.scan(); }
  async verifyExternalModels(modelIds: readonly string[]) { this.readyIndex(); return this.external.verifySelected(modelIds); }
  async backendRoots() { this.readyIndex(); return this.external.backendRoots(); }
  /** The absolute path must come directly from a main-process directory dialog. */
  async registerExternalRoot(kind: ModelKind, absolutePathFromMainDialog: string) {
    return this.structural('registering a read-only model directory', async () => {
      this.readyIndex(); await this.readFolders(); await this.external.register(kind, absolutePathFromMainDialog); this.initialized = true; this.lastError = undefined; return this.emit();
    }, true);
  }
  async unregisterExternalRoot(rootId: string) {
    return this.structural('disconnecting a read-only model directory', async () => {
      this.readyIndex(); await this.readFolders(); this.external.unregister(rootId); this.initialized = true; this.lastError = undefined; return this.emit();
    }, true);
  }
  async createFolder(input: CreateModelFolderRequest): Promise<ModelLocationsSnapshot> {
    const request = z.object({ kind: kindSchema, parent: relativeSchema, name: segmentSchema }).strict().parse(input);
    const relative = relativeSchema.parse([request.parent, request.name].filter(Boolean).join('/'));
    return this.structural('creating a private model folder', async () => {
      this.readyIndex(); await this.readFolders();
      if (this.folders.length >= 1000) throw new Error('Keep at most 1,000 private model folders.');
      const parent = await this.directory(request.kind, request.parent);
      const destination = path.join(parent, request.name);
      if (await this.statIfPresent(destination)) throw new Error('A file or folder already uses that name. Choose another folder name.');
      await this.options.assertChangesAllowed();
      await fsp.mkdir(destination); await this.readFolders(); return this.emit();
    });
  }
  async moveModel(input: MoveModelRequest): Promise<ModelLocationsSnapshot> {
    const request = z.object({ modelId: z.string().min(1).max(500), destinationFolder: relativeSchema, expectedSha256: shaSchema }).strict().parse(input);
    return this.structural('moving a private model', async () => {
      const index = this.readyIndex();
      const model = this.models.assets.find(asset => asset.id === request.modelId);
      if (model?.id.startsWith('external:')) throw new Error('This model belongs to a read-only external directory. Its original file cannot be moved by Latent.');
      if (!model || model.status !== 'ready' || model.sha256 !== request.expectedSha256) throw new Error('This model is missing or changed. Refresh the library and review it before moving.');
      const before = index.bindings.find(binding => binding.modelId === model.id);
      const sourceRelative = modelPathSchema.parse(model.filename);
      if ((before && (!samePath(model.kind, before.relativePath, sourceRelative) || before.sha256 !== request.expectedSha256)) || (!before && model.id !== `${model.kind}:${sourceRelative}`)) throw new Error('The model identity no longer matches its current file. Refresh the library.');
      const destinationRelative = modelPathSchema.parse([request.destinationFolder, path.posix.basename(sourceRelative)].filter(Boolean).join('/'));
      if (samePath(model.kind, sourceRelative, destinationRelative)) throw new Error('This model is already in that folder.');
      await this.external.assertDestinationAvailable(model.kind, destinationRelative);
      if (index.bindings.some(binding => binding.modelId !== model.id && binding.kind === model.kind && binding.aliases.some(alias => samePath(model.kind, alias, destinationRelative)))) throw new Error('That destination name is reserved for another model and its saved recipes.');
      const source = await this.filePath(model.kind, sourceRelative);
      const destination = path.join(await this.directory(model.kind, request.destinationFolder), path.posix.basename(sourceRelative));
      const release = await this.models.leaseFiles([source, destination]);
      try {
        if (await this.statIfPresent(destination)) throw new Error('A model already exists at the destination. No files were changed.');
        const stat = await this.verifiedFile(source, request.expectedSha256);
        if (stat.nlink !== 1n) throw new Error('Only independent private model files can be moved; linked models are preserved.');
        const aliases = [...(before?.aliases ?? [sourceRelative])];
        if (!aliases.some(alias => samePath(model.kind, alias, destinationRelative))) aliases.push(destinationRelative);
        if (aliases.length > 256) throw new Error('This model has reached 256 reserved locations. Keep it in its current folder.');
        const now = new Date().toISOString();
        const after: ModelLocationBinding = { modelId: model.id, kind: model.kind, relativePath: destinationRelative, sha256: request.expectedSha256, aliases, createdAt: before?.createdAt ?? now, updatedAt: now };
        const journal: Journal = { stage: 'prepared', source: sourceRelative, destination: destinationRelative, identity: identity(stat), before, after };
        await this.options.assertChangesAllowed();
        this.write({ ...index, pending: journal });
        try {
          // link is an atomic, no-overwrite publication on this private volume.
          await this.filePath(model.kind, sourceRelative); await this.directory(model.kind, request.destinationFolder);
          await fsp.link(source, destination);
          await this.verifiedFile(source, after.sha256, journal.identity); await this.verifiedFile(destination, after.sha256, journal.identity);
          const committed: Index = { schemaVersion: 1, bindings: this.replaceBinding(index.bindings, after), pending: { ...journal, stage: 'committed' } };
          this.write(committed);
          await this.unlinkVerified(model.kind, sourceRelative, journal);
          this.write({ schemaVersion: 1, bindings: committed.bindings });
        } catch (error) {
          this.changed();
          const code = (error as NodeJS.ErrnoException)?.code;
          const accessAdvice = ['EACCES', 'EPERM', 'EBUSY'].includes(code ?? '')
            ? 'Check permissions on the source and destination folders, and close any other app using the model file. '
            : '';
          throw new Error(`The move was interrupted; its files are preserved for recovery. ${accessAdvice}Stop the backend and choose Recover interrupted move before retrying. ${error instanceof Error ? error.message : String(error)}`);
        }
        await this.readFolders(); return this.emit();
      } finally { await release(); }
    });
  }
  async recover(): Promise<ModelLocationsSnapshot> {
    return this.structural('recovering an interrupted model move', async () => {
      await this.reconcile(this.read()); await this.readFolders(); await this.external.scan(); this.initialized = true; this.lastError = undefined; return this.emit();
    }, true);
  }

  private async structural<T>(label: string, task: () => Promise<T>, allowUninitialized = false): Promise<T> {
    if (!allowUninitialized && !this.initialized) throw new Error('Initialize private model folders before changing them.');
    return this.models.library.withExclusive(label, async () => {
      await this.options.assertChangesAllowed(); await this.directory('checkpoint', ''); await this.directory('lora', '');
      const release = await this.models.leaseFiles([path.join(this.paths.models, '.latent-library-change')]);
      try { await this.options.assertChangesAllowed(); return await task(); } finally { await release(); }
    });
  }
  private async reconcile(index: Index) {
    const journal = index.pending; if (!journal) return;
    const kind = journal.after.kind;
    const source = await this.filePath(kind, journal.source); const destination = await this.filePath(kind, journal.destination);
    const release = await this.models.leaseFiles([source, destination]);
    try {
      const sourceStat = await this.statIfPresent(source); const destinationStat = await this.statIfPresent(destination);
      // Unknown/replaced paths are never removed, even when their bytes match.
      if (sourceStat) await this.verifiedFile(source, journal.after.sha256, journal.identity);
      if (destinationStat) await this.verifiedFile(destination, journal.after.sha256, journal.identity);
      await this.options.assertChangesAllowed();
      if (journal.stage === 'prepared') {
        if (!sourceStat) throw new Error('Recovery needs the original model file. No files were removed; restore its original file identity before retrying.');
        if (destinationStat) await this.unlinkVerified(kind, journal.destination, journal);
        this.write({ schemaVersion: 1, bindings: index.bindings });
      } else {
        if (destinationStat) {
          if (sourceStat) await this.unlinkVerified(kind, journal.source, journal);
          this.write({ schemaVersion: 1, bindings: index.bindings });
        } else if (sourceStat) {
          // Destination disappeared after commit: restore the old registry only.
          const bindings = index.bindings.filter(binding => binding.modelId !== journal.after.modelId);
          if (journal.before) bindings.push(journal.before);
          this.write({ schemaVersion: 1, bindings });
        } else throw new Error('Both paths for this interrupted move are missing. Restore the model before recovery; the journal is retained.');
      }
    } finally { await release(); }
  }
  private readyIndex() {
    const index = this.read(); if (index.pending) throw new Error('Recover the interrupted model move before changing folders.'); return index;
  }
  private read(): Index {
    const index = indexSchema.parse(this.store.getState<unknown>(STATE_KEY, emptyIndex));
    const ids = new Set<string>(); const aliases = new Map<string, string>();
    for (const binding of index.bindings) {
      this.validateBinding(binding);
      if (ids.has(binding.modelId)) throw new Error('The model location registry contains duplicate identities. Restore a valid studio index.');
      ids.add(binding.modelId);
      for (const alias of binding.aliases) {
        const key = fileKey(binding.kind, alias);
        if (aliases.has(key)) throw new Error('The model location registry contains colliding reserved paths. Restore a valid studio index.');
        aliases.set(key, binding.modelId);
      }
    }
    if (index.pending) {
      const pending = index.pending; this.validateBinding(pending.after); if (pending.before) this.validateBinding(pending.before);
      const existing = index.bindings.find(binding => binding.modelId === pending.after.modelId);
      if (!samePath(pending.after.kind, pending.after.relativePath, pending.destination) || samePath(pending.after.kind, pending.source, pending.destination) || !pending.after.aliases.some(alias => samePath(pending.after.kind, alias, pending.source)) || (pending.before && (pending.before.modelId !== pending.after.modelId || pending.before.sha256 !== pending.after.sha256 || !samePath(pending.after.kind, pending.before.relativePath, pending.source))) || (pending.stage === 'committed' ? JSON.stringify(existing) !== JSON.stringify(pending.after) : JSON.stringify(existing) !== JSON.stringify(pending.before))) throw new Error('The interrupted model move journal does not match the registry. Files have been preserved.');
      for (const alias of pending.after.aliases) if (aliases.has(fileKey(pending.after.kind, alias)) && aliases.get(fileKey(pending.after.kind, alias)) !== pending.after.modelId) throw new Error('The interrupted model move collides with a reserved identity. Files have been preserved.');
    }
    return index;
  }
  private validateBinding(binding: ModelLocationBinding) {
    const prefix = `${binding.kind}:`; const original = binding.modelId.startsWith(prefix) ? binding.modelId.slice(prefix.length) : '';
    if (!modelPathSchema.safeParse(original).success || !binding.aliases.some(alias => samePath(binding.kind, alias, original)) || !binding.aliases.some(alias => samePath(binding.kind, alias, binding.relativePath)) || new Set(binding.aliases.map(alias => fileKey(binding.kind, alias))).size !== binding.aliases.length) throw new Error('A model location binding has invalid identity aliases. Restore a valid studio index.');
  }
  private write(index: Index) { this.store.setState(STATE_KEY, indexSchema.parse(index)); }
  private replaceBinding(bindings: ModelLocationBinding[], binding: ModelLocationBinding) { return [...bindings.filter(item => item.modelId !== binding.modelId), binding]; }
  private emit() { const snapshot = this.snapshot(); this.changed(); return snapshot; }
  private async statIfPresent(filename: string) {
    try { return await fsp.lstat(filename, { bigint: true }); } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  private async directory(kind: ModelKind, relative: string) {
    kindSchema.parse(kind); relativeSchema.parse(relative);
    const base = this.models.folder(kind); const target = path.resolve(base, relative);
    if (!inside(base, target)) throw new Error('The folder must stay inside the private model library.');
    for (const directory of [this.paths.root, this.paths.models, base, ...relative.split('/').filter(Boolean).map((_, index, parts) => path.join(base, ...parts.slice(0, index + 1)))]) {
      const stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Private model folder paths cannot contain symbolic links or junctions.');
    }
    if (!inside(await fsp.realpath(this.paths.models), await fsp.realpath(target))) throw new Error('The model folder resolved outside this private studio.');
    return target;
  }
  private async filePath(kind: ModelKind, relative: string) {
    modelPathSchema.parse(relative);
    const parent = path.posix.dirname(relative); return path.join(await this.directory(kind, parent === '.' ? '' : parent), path.posix.basename(relative));
  }
  private async verifiedFile(filename: string, sha256: string, expected?: Identity) {
    const stat = await fsp.lstat(filename, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || (expected && !sameIdentity(stat, expected))) throw new Error('A model path was replaced or linked. Its files were preserved; restore the expected private file before recovery.');
    await inspectSafeTensors(filename);
    if (await hashFile(filename) !== sha256) throw new Error('The model bytes changed. Its files were preserved; review the model before continuing.');
    const after = await fsp.lstat(filename, { bigint: true });
    if (!sameIdentity(after, identity(stat)) || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) throw new Error('The model changed while it was being verified. Retry when no other program is editing it.');
    return after;
  }
  private async unlinkVerified(kind: ModelKind, relative: string, journal: Journal) {
    const filename = await this.filePath(kind, relative);
    await this.verifiedFile(filename, journal.after.sha256, journal.identity);
    // Recheck all private ancestors immediately before the single-file unlink.
    await this.filePath(kind, relative); await fsp.unlink(filename);
  }
  private async readFolders() {
    const folders: ModelFolder[] = [];
    const visit = async (kind: ModelKind, relative: string) => {
      if (folders.length >= 1000) throw new Error('The model library exceeds 1,000 supported folders.');
      const directory = await this.directory(kind, relative); folders.push({ kind, relativePath: relative });
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          const nested = [relative, entry.name].filter(Boolean).join('/');
          if (relativeSchema.safeParse(nested).success) await visit(kind, nested);
        }
      }
    };
    await visit('checkpoint', ''); await visit('lora', '');
    this.folders = folders.sort((a, b) => a.kind.localeCompare(b.kind) || a.relativePath.localeCompare(b.relativePath));
  }
}

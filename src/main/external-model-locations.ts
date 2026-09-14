import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppPaths, ModelKind } from '../shared/types';
import type { BackendModelRoot, ExternalModelFile, ExternalModelRoot, ModelLocationBinding } from '../shared/model-locations';
import type { StudioStore } from './store';
import { hashFile, inspectSafeTensors } from './models';
import { inside } from './paths';

const STATE_KEY = 'external-model-roots.v1';
const rootIdSchema = z.string().regex(/^root_[a-f0-9-]{36}$/);
const fileIdSchema = z.string().regex(/^external:root_[a-f0-9-]{36}:[a-f0-9-]{36}$/);
const kindSchema = z.enum(['checkpoint', 'lora']);
const relativeSchema = z.string().min(1).max(400).refine(value => value.split('/').length <= 12 && value.split('/').every(segment => segment.length > 0 && segment.length <= 120 && !/[<>:"\\|?*\u0000-\u001f\u007f]/.test(segment) && !/^\.{1,2}$/.test(segment) && !/[. ]$/.test(segment)), 'A reusable model filename is outside supported relative path bounds.');
const fileSchema = z.object({ id: fileIdSchema, filename: relativeSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(), createdAt: z.iso.datetime() }).strict();
const rootSchema = z.object({ id: rootIdSchema, kind: kindSchema, path: z.string().min(1).max(2000), label: z.string().min(1).max(250), active: z.boolean(), dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), files: z.array(fileSchema).max(10000) }).strict();
const indexSchema = z.object({ schemaVersion: z.literal(1), roots: z.array(rootSchema).max(32) }).strict();
type Root = z.infer<typeof rootSchema>;
type Index = z.infer<typeof indexSchema>;
interface Entry { filename: string; absolute: string; stat: fs.BigIntStats; }
interface Verified { sha256: string; header: Record<string, string>; stat: fs.BigIntStats; }
const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
const nameKey = (kind: ModelKind, filename: string) => `${kind}:${key(filename)}`;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const sameStat = (a: fs.BigIntStats, b: fs.BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** Read-only filesystem access to explicitly chosen roots. Persistent writes
 * affect only the private SQLite registry. Structural guards live in the owner.
 */
export class ExternalModelRegistry {
  private errors = new Map<string, string>();
  private cache = new Map<string, Verified>();
  private scanError?: string;
  constructor(private paths: AppPaths, private store: StudioStore, private privateBindings: () => readonly ModelLocationBinding[]) {}

  snapshot(): { roots: ExternalModelRoot[]; error?: string } {
    try {
      return { roots: this.read().roots.map(root => ({ id: root.id, kind: root.kind, path: root.path, label: root.label, active: root.active, modelCount: root.files.length, error: this.errors.get(root.id) })), error: this.scanError };
    } catch (error) { return { roots: [], error: `The reusable model directory registry could not be read. Stored data and original files are preserved. ${this.message(error)}` }; }
  }
  async register(kind: ModelKind, absolutePathFromMainDialog: string) {
    kindSchema.parse(kind);
    const directory = await this.approvedDirectory(absolutePathFromMainDialog);
    const index = this.read();
    const existing = index.roots.find(root => root.kind === kind && key(root.path) === key(directory.path));
    const overlaps = index.roots.find(root => root.active && root.id !== existing?.id && (inside(root.path, directory.path) || inside(directory.path, root.path)));
    if (overlaps) throw new Error(`That directory overlaps the registered ${overlaps.label} directory. Choose distinct checkpoint and LoRA roots.`);
    if (!existing && index.roots.length >= 32) throw new Error('At most 32 reusable directory identities are supported, including disconnected roots.');
    const now = new Date().toISOString();
    const root: Root = existing ? structuredClone(existing) : { id: `root_${randomUUID()}`, kind, path: directory.path, label: path.basename(directory.path), active: true, dev: String(directory.stat.dev), ino: String(directory.stat.ino), createdAt: now, updatedAt: now, files: [] };
    root.active = true; root.dev = String(directory.stat.dev); root.ino = String(directory.stat.ino); root.updatedAt = now;
    const candidate: Index = { schemaVersion: 1, roots: [...index.roots.filter(item => item.id !== root.id), root] };
    await this.inventory(candidate, true);
    this.store.setState(STATE_KEY, candidate); this.scanError = undefined; this.errors.delete(root.id);
  }
  unregister(rootId: string) {
    rootIdSchema.parse(rootId); const index = this.read(); const root = index.roots.find(item => item.id === rootId);
    if (!root) throw new Error('That reusable model directory is no longer registered.');
    root.active = false; root.updatedAt = new Date().toISOString();
    this.store.setState(STATE_KEY, index); this.errors.delete(root.id); this.scanError = undefined;
  }
  async scan(): Promise<ExternalModelFile[]> {
    const index = this.read();
    try {
      const before = JSON.stringify(index); const files = await this.inventory(index);
      if (JSON.stringify(index) !== before) this.store.setState(STATE_KEY, index);
      this.scanError = undefined; return files;
    } catch (error) { this.scanError = this.message(error); throw error; }
  }
  async backendRoots(): Promise<BackendModelRoot[]> {
    await this.scan();
    return this.read().roots.filter(root => root.active).map(root => ({ id: root.id, kind: root.kind, path: root.path }));
  }
  async verifySelected(modelIds: readonly string[]) {
    const ids = z.array(z.string().min(1).max(500)).max(100).parse(modelIds).filter(id => id.startsWith('external:'));
    if (!ids.length) return;
    const inventory = await this.scan(); const index = this.read();
    for (const id of new Set(ids)) {
      const asset = inventory.find(file => file.id === id);
      if (!asset || asset.status !== 'ready') throw new Error('A selected read-only model is disconnected, missing, or changed. Re-select an available model before generating.');
      const root = index.roots.find(item => item.id === asset.rootId && item.active)!;
      const absolute = path.join(root.path, asset.filename);
      await this.assertDirectoryChain(path.dirname(absolute));
      if (!inside(root.path, await fsp.realpath(absolute))) throw new Error('A selected read-only model resolved outside its approved directory.');
      const stat = await fsp.lstat(absolute, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('A selected read-only model was replaced by a link or non-file.');
      const verified = await this.verify({ absolute, filename: asset.filename, stat }, true);
      if (verified.sha256 !== asset.sha256) throw new Error(`The selected read-only model ${asset.filename} changed bytes. Its saved model hash was kept; choose the intended version before generating.`);
      const actual = await this.approvedDirectory(root.path);
      if (String(actual.stat.dev) !== root.dev || String(actual.stat.ino) !== root.ino) throw new Error('The approved read-only model directory changed during verification.');
    }
  }
  async assertDestinationAvailable(kind: ModelKind, filename: string) {
    const index = this.read(); await this.inventory(index);
    for (const root of index.roots.filter(root => root.active && root.kind === kind)) {
      if (root.files.some(file => key(file.filename) === key(filename))) throw new Error(`This filename is used by the read-only ${root.label} directory. Choose another private filename or disconnect that directory first.`);
    }
  }
  private read(): Index {
    const index = indexSchema.parse(this.store.getState<unknown>(STATE_KEY, { schemaVersion: 1, roots: [] }));
    const roots = new Set<string>(); const paths = new Set<string>(); const fileIds = new Set<string>(); let count = 0;
    for (const root of index.roots) {
      const locationKey = `${root.kind}:${key(root.path)}`;
      if (roots.has(root.id) || paths.has(locationKey) || !path.isAbsolute(root.path) || path.resolve(root.path) !== root.path || /[\r\n\u0000]/.test(root.path)) throw new Error('The reusable model directory index contains invalid or duplicate identities.');
      roots.add(root.id); paths.add(locationKey); const names = new Set<string>();
      for (const file of root.files) {
        if (!file.id.startsWith(`external:${root.id}:`) || fileIds.has(file.id) || names.has(key(file.filename)) || !file.filename.toLowerCase().endsWith('.safetensors')) throw new Error('The reusable model index has conflicting file identities.');
        fileIds.add(file.id); names.add(key(file.filename)); count++;
      }
    }
    if (count > 20000) throw new Error('The reusable model registry exceeds 20,000 retained model identities.');
    return index;
  }
  private async inventory(index: Index, registering = false): Promise<ExternalModelFile[]> {
    this.errors.clear();
    const reserved = new Map<string, string>();
    const checkPrivateNames = index.roots.some(root => root.active) || fs.existsSync(path.join(this.paths.models, 'qwen-edit-loras'));
    // Every actual private name participates, including the dedicated Qwen LoRA root.
    for (const [kind, relative] of [['checkpoint', 'checkpoints'], ['lora', 'loras'], ['lora', 'qwen-edit-loras']] as const) {
      if (!checkPrivateNames) continue;
      const root = path.join(this.paths.models, relative);
      try { await this.assertDirectoryChain(root); }
      catch (error) { if (relative === 'qwen-edit-loras' && missing(error)) continue; throw error; }
      for (const entry of await this.walk(root)) {
        const k = nameKey(kind, entry.filename);
        if (reserved.has(k)) throw new Error(`Model filename collision: ${entry.filename} appears in both ${reserved.get(k)} and private ${relative}. Keep model filenames unique before starting the engine.`);
        reserved.set(k, `private ${relative}`);
      }
    }
    for (const binding of this.privateBindings()) for (const alias of binding.aliases) if (!reserved.has(nameKey(binding.kind, alias))) reserved.set(nameKey(binding.kind, alias), 'a reserved private model location');
    const result: ExternalModelFile[] = []; let retained = index.roots.reduce((sum, root) => sum + root.files.length, 0);
    for (const root of index.roots) {
      if (!root.active) { result.push(...root.files.map(file => this.asset(root, file, 'missing'))); continue; }
      try {
        const actual = await this.approvedDirectory(root.path);
        if (String(actual.stat.dev) !== root.dev || String(actual.stat.ino) !== root.ino || key(actual.path) !== key(root.path)) throw new Error('The selected directory was replaced or remounted. Disconnect it and choose the intended directory again to review it.');
        const entries = await this.walk(root.path); const present = new Set<string>();
        for (const entry of entries) {
          const k = nameKey(root.kind, entry.filename);
          if (reserved.has(k)) throw new Error(`Model filename collision: ${entry.filename} appears in ${root.label} and ${reserved.get(k)}. Disconnect a reusable directory or rename the conflicting external file yourself; Latent will not choose one silently.`);
          reserved.set(k, root.label); present.add(key(entry.filename));
          const verified = await this.verify(entry); let binding = root.files.find(file => key(file.filename) === key(entry.filename));
          if (!binding) {
            if (root.files.length >= 10000 || retained >= 20000) throw new Error('The reusable directory model identity limit has been reached.');
            binding = { id: `external:${root.id}:${randomUUID()}`, filename: entry.filename, sha256: verified.sha256, bytes: Number(verified.stat.size), createdAt: new Date().toISOString() };
            root.files.push(binding); retained++;
          }
          if (binding.sha256 !== verified.sha256) {
            if (registering) throw new Error(`The original model bytes changed at ${entry.filename}. Reconnection cannot replace a saved model identity. Restore that version or choose a separately named model.`);
            this.errors.set(root.id, 'One or more model files changed bytes. Their original identities are shown as missing.');
            result.push(this.asset(root, binding, 'missing')); continue;
          }
          result.push({ ...this.asset(root, binding, 'ready'), header: verified.header });
        }
        for (const binding of root.files) if (!present.has(key(binding.filename))) result.push(this.asset(root, binding, 'missing'));
      } catch (error) {
        const message = `Read-only model directory ${root.label}: ${this.message(error)}`;
        this.errors.set(root.id, message); throw new Error(message);
      }
    }
    return result;
  }
  private asset(root: Root, file: Root['files'][number], status: 'ready' | 'missing'): ExternalModelFile { return { id: file.id, rootId: root.id, kind: root.kind, filename: file.filename, sha256: file.sha256, bytes: file.bytes, status }; }
  private async approvedDirectory(input: string) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.length > 2000 || /[\r\n\u0000]/.test(input) || input.startsWith('\\\\') || path.resolve(input) === path.parse(input).root) throw new Error('Choose a local absolute model directory through the directory picker. Network and whole-drive roots are not supported.');
    const selected = path.resolve(input); await this.assertDirectoryChain(selected);
    const canonical = await fsp.realpath(selected); const privateRoot = await fsp.realpath(this.paths.root);
    if (inside(privateRoot, canonical) || inside(canonical, privateRoot)) throw new Error('Choose a separate external model directory. This studio and its ancestor directories cannot be registered for reuse.');
    return { path: canonical, stat: await fsp.lstat(canonical, { bigint: true }) };
  }
  private async assertDirectoryChain(directory: string) {
    let current = path.resolve(directory);
    while (true) {
      const stat = await fsp.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Reusable model paths cannot contain symbolic links or junctions.');
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
  }
  private async walk(root: string): Promise<Entry[]> {
    const canonicalRoot = await fsp.realpath(root);
    const result: Entry[] = []; let visited = 0;
    const visit = async (directory: string, depth: number) => {
      if (depth > 12 || ++visited > 25000) throw new Error('The model directory exceeds its supported depth or entry count.');
      for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
        if (++visited > 25000) throw new Error('The model directory exceeds 25,000 inspected entries.');
        const absolute = path.join(directory, entry.name); const stat = await fsp.lstat(absolute, { bigint: true });
        if (stat.isSymbolicLink()) throw new Error('Model directories cannot contain symbolic links or junctions, including nested links.');
        if (!inside(canonicalRoot, await fsp.realpath(absolute))) throw new Error('A model entry resolved outside its selected directory.');
        if (stat.isDirectory()) { await visit(absolute, depth + 1); continue; }
        if (!entry.name.toLowerCase().endsWith('.safetensors')) continue;
        if (!stat.isFile() || stat.nlink !== 1n) throw new Error('Reusable models must be independent regular safetensors files; linked files are not supported.');
        const filename = relativeSchema.parse(path.relative(canonicalRoot, absolute).replaceAll('\\', '/'));
        result.push({ filename, absolute, stat }); if (result.length > 10000) throw new Error('A model root may contain at most 10,000 safetensors files.');
      }
    };
    await visit(canonicalRoot, 0); return result;
  }
  private async verify(entry: Entry, forceHash = false): Promise<Verified> {
    await this.assertDirectoryChain(path.dirname(entry.absolute));
    const cached = this.cache.get(entry.absolute); if (!forceHash && cached && sameStat(cached.stat, entry.stat)) return cached;
    const header = await inspectSafeTensors(entry.absolute); const sha256 = await hashFile(entry.absolute); const after = await fsp.lstat(entry.absolute, { bigint: true });
    if (!sameStat(entry.stat, after) || after.isSymbolicLink() || after.nlink !== 1n) throw new Error('A reusable model changed while it was being verified. Retry when the other application has finished editing it.');
    await this.assertDirectoryChain(path.dirname(entry.absolute));
    const verified = { header, sha256, stat: after }; this.cache.set(entry.absolute, verified); return verified;
  }
  private message(error: unknown) { return error instanceof Error ? error.message : String(error); }
}

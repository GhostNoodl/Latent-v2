import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { AppPaths, DownloadStatus, ModelAsset, ModelDownloadRequest, ModelFamily, ModelKind } from '../shared/types';
import { downloadSchema } from '../shared/validation';
import { MODEL_CATALOG, catalogDownload } from '../shared/model-catalog';
import { MODEL_DOWNLOAD_RESERVE_BYTES } from '../shared/model-download-space';
import { containedPath, inside } from './paths';
import type { StudioStore } from './store';
import type { ModelLocationLookup } from '../shared/model-locations';
import { modelLibraryLease, type ModelLibraryLease } from './model-library-lease';
import { ModelTransferCancelledError, ModelTransferJournal, modelSourceIdentity, prepareModelTransfer, safeModelTransferError, validateModelTransferRetry } from './model-transfers';
import type { ModelTransferRecord, ModelTransferRecovery } from '../shared/model-transfer-types';

interface Metadata extends Pick<ModelAsset, 'sourceUrl' | 'licenseUrl' | 'provenance' | 'civitai'> { family: ModelFamily | 'unknown'; triggers: string[]; sha256?: string; size?: number; mtimeMs?: number; ctimeMs?: number; }
interface DownloadManifest { url?: string; sourceIdentity?: string; sha256?: string; etag?: string; lastModified?: string; totalBytes?: number; }
/** Main-process options only; renderer requests still use strict downloadSchema. */
export interface ModelDownloadOptions { headers?: { Authorization?: string }; signal?: AbortSignal; }
/** Resolver stays in main and must re-fetch exact remote identity and credentials. */
export type ModelTransferResolver = (record: Readonly<ModelTransferRecord>) => Promise<{ request: ModelDownloadRequest; options?: ModelDownloadOptions }>;
const RESERVE_BYTES = MODEL_DOWNLOAD_RESERVE_BYTES;
const DTYPE_BITS: Record<string, number> = {
  BOOL: 8, F4: 4, F6_E2M3: 6, F6_E3M2: 6, U8: 8, I8: 8, F8_E5M2: 8, F8_E4M3: 8,
  F8_E8M0: 8, F8_E4M3FNUZ: 8, F8_E5M2FNUZ: 8, I16: 16, U16: 16, F16: 16, BF16: 16,
  I32: 32, U32: 32, F32: 32, C64: 64, F64: 64, I64: 64, U64: 64,
};
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function isMissing(error: unknown) { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
async function fileStat(filename: string, singleLink = false) {
  try {
    const stat = await fsp.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (singleLink && stat.nlink !== 1)) throw new Error('A model or staging path is not an independent regular file.');
    return stat;
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}
// JSON.parse alone silently accepts duplicate keys, unlike the safetensors format.
function rejectDuplicateKeys(json: string) {
  const stack: Array<Set<string> | null> = [];
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (char === '{') stack.push(new Set());
    else if (char === '[') stack.push(null);
    else if (char === '}' || char === ']') stack.pop();
    else if (char === '"') {
      const start = i;
      while (++i < json.length) { if (json[i] === '\\') i++; else if (json[i] === '"') break; }
      let next = i + 1; while (next < json.length && /\s/.test(json[next])) next++;
      if (json[next] === ':') {
        const key = JSON.parse(json.slice(start, i + 1)) as string; const keys = stack.at(-1);
        if (keys?.has(key)) throw new Error('Duplicate safetensors header key.');
        keys?.add(key);
      }
    }
  }
}
export async function hashFile(filename: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) { signal?.throwIfAborted(); hash.update(chunk); }
  signal?.throwIfAborted(); return hash.digest('hex');
}
export async function inspectSafeTensors(filename: string): Promise<Record<string, string>> {
  const file = await fsp.open(filename, 'r');
  try {
    const stat = await file.stat(); const first = Buffer.alloc(8);
    if ((await file.read(first, 0, 8, 0)).bytesRead !== 8) throw new Error('Incomplete safetensors header.');
    const length = Number(first.readBigUInt64LE());
    if (!Number.isSafeInteger(length) || length < 2 || length > 16 * 1024 * 1024 || length + 8 > stat.size) throw new Error('Invalid safetensors header length.');
    const bytes = Buffer.alloc(length);
    if ((await file.read(bytes, 0, length, 8)).bytesRead !== length) throw new Error('Incomplete safetensors metadata.');
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (json[0] !== '{') throw new Error('Invalid safetensors header object.');
    const header: unknown = JSON.parse(json); rejectDuplicateKeys(json);
    if (!isObject(header)) throw new Error('Invalid safetensors header object.');
    if (header.__metadata__ !== undefined && (!isObject(header.__metadata__) || Object.values(header.__metadata__).some(value => typeof value !== 'string'))) throw new Error('Safetensors metadata must contain string values.');
    const entries = Object.entries(header).filter(([name]) => name !== '__metadata__');
    if (!entries.length) throw new Error('The file contains no model tensors.');
    const ranges: Array<[number, number]> = [];
    for (const [, tensor] of entries) {
      if (!isObject(tensor)) throw new Error('The model has an invalid tensor description.');
      const offsets = tensor.data_offsets; const shape = tensor.shape;
      if (!Array.isArray(offsets) || offsets.length !== 2 || !offsets.every(Number.isSafeInteger) || offsets[0] < 0 || offsets[1] < offsets[0] || offsets[1] > stat.size - length - 8 || typeof tensor.dtype !== 'string' || !Object.hasOwn(DTYPE_BITS, tensor.dtype) || !Array.isArray(shape) || !shape.every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('The model has an invalid or incomplete tensor payload.');
      const elements = shape.reduce<bigint>((size, dimension) => size * BigInt(dimension), 1n);
      if (elements * BigInt(DTYPE_BITS[tensor.dtype]) !== BigInt(offsets[1] - offsets[0]) * 8n) throw new Error('Tensor dimensions do not match its payload size.');
      ranges.push([offsets[0], offsets[1]]);
    }
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let end = 0;
    for (const [start, next] of ranges) { if (start !== end) throw new Error('Tensor payloads overlap or contain gaps.'); end = next; }
    if (end !== stat.size - length - 8) throw new Error('The safetensors file contains unindexed or trailing data.');
    return (header.__metadata__ ?? {}) as Record<string, string>;
  } finally { await file.close(); }
}
async function publish(staging: string, destination: string) {
  // Same-directory hardlink publication refuses existing files and exposes only
  // complete weights. It does not allocate a second full model copy.
  const file = await fsp.open(staging, 'r+');
  try { await file.sync(); } finally { await file.close(); }
  await fsp.link(staging, destination); await fsp.unlink(staging);
}
function inferFamily(filename: string, header: Record<string, string>): Metadata['family'] {
  const identity = `${header['modelspec.architecture'] ?? ''} ${header.ss_base_model_version ?? ''}`.toLowerCase();
  const classify = (name: string): Metadata['family'] => name.includes('illustrious') ? 'illustrious' : /sdxl|xl_base|stable.diffusion.xl/.test(name) ? 'sdxl' : 'unknown';
  return classify(identity) !== 'unknown' ? classify(identity) : classify(filename.toLowerCase());
}
function identifyImportedModel(kind: ModelKind, filename: string, header: Record<string, string>, sha256: string): Pick<Metadata, 'family' | 'triggers' | 'sourceUrl' | 'licenseUrl' | 'provenance'> {
  // An exact catalog hash is more specific than a derivative's generic SDXL header.
  // This initializes new content only; refresh must retain saved user overrides.
  const known = MODEL_CATALOG.find(item => item.kind === kind && item.sha256 === sha256);
  return known
    ? { ...sourceMetadata(catalogDownload(known)), family: known.family, triggers: [...(known.triggers ?? [])] }
    : { family: inferFamily(filename, header), triggers: [] };
}
function strongEtag(value: unknown) { return typeof value === 'string' && /^"[^\r\n]*"$/.test(value) ? value : undefined; }
function lastModified(value: unknown) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined; }
function contentLength(response: Response) {
  const value = response.headers.get('content-length');
  if (value === null) return undefined;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number)) throw new Error('The server returned an invalid content length.');
  return number;
}
function sourceMetadata(input: ModelDownloadRequest) {
  return { ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}), ...(input.licenseUrl ? { licenseUrl: input.licenseUrl } : {}), ...(input.provenance ? { provenance: { ...input.provenance } } : {}), ...(input.civitai ? { civitai: structuredClone(input.civitai) } : {}) };
}
async function downloadResponse(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  let current = new URL(url); const forwarded = { ...headers };
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(current.href, { headers: { ...forwarded }, signal, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel(); const location = response.headers.get('location');
    if (!location || redirects === 5) throw new Error('The model server returned too many or invalid redirects.');
    let next: URL;
    try { next = new URL(location, current); } catch { throw new Error('The model server returned an invalid redirect.'); }
    if (next.protocol !== 'https:' || next.username || next.password) throw new Error('The download redirected to an insecure connection.');
    if (next.origin !== current.origin) delete forwarded.Authorization;
    current = next;
  }
  throw new Error('The model server returned too many redirects.');
}
export class ModelService {
  readonly library: ModelLibraryLease;
  private locations?: ModelLocationLookup;
  assets: ModelAsset[] = [];
  downloads: DownloadStatus[] = [];
  private controllers = new Map<string, AbortController>();
  private destinations = new Set<string>();
  private refreshPromise?: Promise<ModelAsset[]>;
  private transferJournal: ModelTransferJournal;
  private transfers = new Map<string, ModelTransferRecord>();
  private transferWarnings: string[] = [];
  constructor(private paths: AppPaths, private store: StudioStore, private changed: () => void) {
    this.library = modelLibraryLease(fs.realpathSync(paths.models)); this.transferJournal = new ModelTransferJournal(paths);
    const recovered = this.transferJournal.load(); this.transferWarnings = recovered.warnings;
    for (const record of recovered.transfers) { this.transfers.set(record.id, record); this.downloads.push(this.transferStatus(record)); }
  }
  private transferStatus(record: ModelTransferRecord): DownloadStatus {
    return { id: record.id, name: record.request.filename, modelKind: record.request.kind, destinationDirectory: this.folder(record.request.kind), state: record.state === 'interrupted' ? 'failed' : record.state, receivedBytes: record.receivedBytes, totalBytes: record.totalBytes, error: record.error };
  }
  transferRecovery(): ModelTransferRecovery { return { transfers: structuredClone([...this.transfers.values()]), warnings: [...this.transferWarnings] }; }
  async retryTransfer(id: string, resolveFresh?: ModelTransferResolver, signal?: AbortSignal): Promise<void> {
    z.uuid().parse(id); signal?.throwIfAborted(); if (this.controllers.has(id)) throw new Error('This transfer is already active.');
    const saved = this.transferJournal.get(id);
    if (saved.state === 'completed') throw new Error('This transfer already completed. Refresh the verified model library.');
    const resolution = saved.source.kind === 'direct' ? { request: { ...saved.request, url: saved.source.url! } } : resolveFresh ? await resolveFresh(structuredClone(saved)) : undefined;
    if (!resolution) throw new Error(saved.source.kind === 'civitai' ? 'Refresh this exact Civitai model, version and file through the catalog before retrying. Its current access and credentials must be checked again.' : 'This source URL may expire. Choose a fresh URL for the same file before retrying.');
    signal?.throwIfAborted(); const request = validateModelTransferRetry(saved, resolution.request);
    const options = { ...resolution.options, signal: signal && resolution.options?.signal ? AbortSignal.any([signal, resolution.options.signal]) : signal ?? resolution.options?.signal };
    return this.library.withShared('retrying a model transfer', () => this.downloadUnlocked(request, options, saved.id));
  }
  setLocationRegistry(locations: ModelLocationLookup) { this.locations = locations; }
  async leaseFiles(filenames: string[]): Promise<() => Promise<void>> {
    const releases: Array<() => Promise<void>> = [];
    try { for (const filename of [...new Set(filenames)].sort()) releases.push(await this.reserve(filename)); }
    catch (error) { for (const release of releases.reverse()) await release(); throw error; }
    return async () => { for (const release of releases.reverse()) await release(); };
  }
  folder(kind: ModelKind) { z.enum(['checkpoint', 'lora']).parse(kind); return path.join(this.paths.models, kind === 'checkpoint' ? 'checkpoints' : 'loras'); }
  private async managedFolder(kind: ModelKind) {
    const folder = this.folder(kind);
    for (const directory of [this.paths.root, this.paths.models, folder]) {
      const stat = await fsp.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed model directories cannot be symbolic links.');
    }
    if (!inside(await fsp.realpath(this.paths.models), await fsp.realpath(folder))) throw new Error('The model directory is outside this studio.');
    return folder;
  }
  private async reserve(destination: string) {
    const canonical = path.join(await fsp.realpath(path.dirname(destination)), path.basename(destination));
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (this.destinations.has(key)) throw new Error('This model is already downloading or importing.');
    this.destinations.add(key);
    const identity = createHash('sha256').update(key).digest('hex');
    // Windows named pipes are exclusive in libuv (FIRST_PIPE_INSTANCE) and
    // disappear on process exit. No stale lock file can race a new writer.
    // Linux abstract sockets share those automatic crash-release semantics.
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\latentv2-model-${identity}`
      : process.platform === 'linux' ? `\0latentv2-model-${identity}`
        : path.join(os.tmpdir(), `latentv2-${identity.slice(0, 40)}.sock`);
    const lease = net.createServer(socket => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        lease.once('error', reject);
        lease.listen({ path: endpoint, exclusive: true }, resolve);
      });
    } catch (error) {
      this.destinations.delete(key);
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error('This model is already downloading or importing in another window or process. Wait for it to finish and retry.');
      throw error;
    }
    lease.unref(); let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { await new Promise<void>((resolve, reject) => lease.close(error => error ? reject(error) : resolve())); }
      finally { this.destinations.delete(key); }
    };
  }
  async refresh(afterCurrent = false): Promise<ModelAsset[]> {
    if (this.refreshPromise) { if (!afterCurrent) return this.refreshPromise; await this.refreshPromise; }
    this.refreshPromise = this.library.withShared('refreshing models', () => this.scan()).finally(() => { this.refreshPromise = undefined; }); return this.refreshPromise;
  }
  async verifyExternalModels(modelIds: readonly string[]): Promise<void> {
    await this.library.withShared('verifying selected read-only models', async () => {
      try { await this.locations?.verifyExternalModels?.(modelIds); }
      catch (error) { await this.refresh().catch(() => {}); throw error; }
    });
  }
  private async scan() {
    const result: ModelAsset[] = [];
    const bindings = this.locations?.scanBindings() ?? [];
    const external = await this.locations?.scanExternalModels?.() ?? [];
    const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    const bindingPaths = new Map(bindings.map(binding => [key(`${binding.kind}:${binding.relativePath}`), binding]));
    const reservedPaths = new Set(bindings.flatMap(binding => binding.aliases.map(alias => key(`${binding.kind}:${alias}`))));
    for (const kind of ['checkpoint', 'lora'] as const) {
      const base = await this.managedFolder(kind);
      const visit = async (folder: string): Promise<void> => {
        for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const full = containedPath(base, path.relative(base, folder), entry.name);
          if (entry.isDirectory()) { if (inside(await fsp.realpath(base), await fsp.realpath(full))) await visit(full); continue; }
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.safetensors')) continue;
          const filename = path.relative(base, full).replaceAll('\\', '/'); const binding = bindingPaths.get(key(`${kind}:${filename}`));
          if (!binding && reservedPaths.has(key(`${kind}:${filename}`))) { await fsp.appendFile(path.join(this.paths.logs, 'models.log'), `Reserved former model path skipped: ${filename}\n`); continue; }
          const id = binding?.modelId ?? `${kind}:${filename}`;
          try {
            const stat = await fileStat(full); if (!stat) continue;
            let metadata = this.store.modelMetadata<Metadata>(id);
            if (!metadata || metadata.size !== stat.size || metadata.mtimeMs !== stat.mtimeMs || metadata.ctimeMs !== stat.ctimeMs || !metadata.sha256) {
              const header = await inspectSafeTensors(full); const sha256 = await hashFile(full);
              if (binding && binding.sha256 !== sha256) { await fsp.appendFile(path.join(this.paths.logs, 'models.log'), `Moved model bytes changed: ${filename}\n`); continue; }
              const sameContent = metadata?.sha256 === sha256;
              metadata = { ...(sameContent ? metadata! : identifyImportedModel(kind, filename, header, sha256)), sha256, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
              this.store.saveModelMetadata(id, metadata);
            }
            if (binding && metadata.sha256 !== binding.sha256) continue;
            // Known byte identities can acquire publisher provenance after an
            // older app imported them, without changing the user's family/triggers.
            if (!metadata.sourceUrl || !metadata.licenseUrl || !metadata.provenance) {
              const known = MODEL_CATALOG.find(item => item.kind === kind && item.sha256 === metadata!.sha256);
              if (known) {
                metadata = { ...sourceMetadata(catalogDownload(known)), ...metadata };
                this.store.saveModelMetadata(id, metadata);
              }
            }
            result.push({ id, filename, name: path.basename(filename, path.extname(filename)), kind, family: metadata.family, bytes: stat.size, sha256: metadata.sha256, triggers: metadata.triggers, sourceUrl: metadata.sourceUrl, licenseUrl: metadata.licenseUrl, provenance: metadata.provenance, civitai: metadata.civitai, status: 'ready' });
          } catch (error) { await fsp.appendFile(path.join(this.paths.logs, 'models.log'), `${new Date().toISOString()} Rejected ${filename}: ${String(error)}\n`); }
        }
      };
      await visit(base);
    }
    for (const binding of bindings) if (!result.some(asset => asset.id === binding.modelId)) {
      const metadata = this.store.modelMetadata<Metadata>(binding.modelId);
      result.push({ id: binding.modelId, kind: binding.kind, filename: binding.relativePath, name: path.basename(binding.relativePath, path.extname(binding.relativePath)), family: metadata?.family ?? 'unknown', triggers: metadata?.triggers ?? [], bytes: metadata?.size ?? 0, sha256: binding.sha256, sourceUrl: metadata?.sourceUrl, licenseUrl: metadata?.licenseUrl, provenance: metadata?.provenance, civitai: metadata?.civitai, status: 'missing' });
    }
    for (const file of external) {
      let metadata = this.store.modelMetadata<Metadata>(file.id);
      if (!metadata && file.status === 'ready') {
        metadata = { ...identifyImportedModel(file.kind, file.filename, file.header ?? {}, file.sha256), sha256: file.sha256, size: file.bytes };
        this.store.saveModelMetadata(file.id, metadata);
      }
      result.push({ id: file.id, kind: file.kind, filename: file.filename, name: path.basename(file.filename, path.extname(file.filename)), family: metadata?.family ?? 'unknown', bytes: file.bytes, sha256: file.sha256, triggers: metadata?.triggers ?? [], sourceUrl: metadata?.sourceUrl, licenseUrl: metadata?.licenseUrl, provenance: metadata?.provenance, civitai: metadata?.civitai, status: file.status });
    }
    this.assets = result.sort((a, b) => a.name.localeCompare(b.name)); this.changed(); return this.assets;
  }
  async update(id: string, changes: { family?: ModelFamily | 'unknown'; triggers?: string[] }) {
    return this.library.withShared('editing model metadata', () => this.updateUnlocked(id, changes));
  }
  private async updateUnlocked(id: string, changes: { family?: ModelFamily | 'unknown'; triggers?: string[] }) {
    const parsed = z.object({ family: z.enum(['sdxl', 'illustrious', 'unknown']).optional(), triggers: z.array(z.string().trim().min(1).max(200)).max(50).optional() }).strict().parse(changes);
    const asset = this.assets.find(model => model.id === id); if (!asset) throw new Error('That model is no longer installed.');
    this.store.saveModelMetadata(id, { ...this.store.modelMetadata<Metadata>(id), ...parsed }); await this.refresh();
  }
  async importFiles(files: string[], kind: ModelKind) {
    return this.library.withShared('importing models', () => this.importUnlocked(files, kind));
  }
  private async importUnlocked(files: string[], kind: ModelKind) {
    const folder = await this.managedFolder(kind);
    for (const source of files) {
      if (!source.toLowerCase().endsWith('.safetensors')) throw new Error('Only safetensors models can be imported.');
      const stat = await fileStat(source); if (!stat) throw new Error('The source model no longer exists.');
      const destination = containedPath(folder, path.basename(source));
      if (inside(this.paths.models, await fsp.realpath(source))) continue;
      await this.locations?.assertDestinationAvailable(kind, path.basename(source));
      const release = await this.reserve(destination); const staging = `${destination}.${randomUUID()}.part`;
      try {
        if (await fileStat(destination)) throw new Error(`A model named ${path.basename(source)} already exists. The original was preserved.`);
        await inspectSafeTensors(source);
        const free = await fsp.statfs(this.paths.models);
        if (free.bavail * free.bsize < stat.size + RESERVE_BYTES) throw new Error('Not enough space to copy this model safely.');
        await fsp.copyFile(source, staging, fs.constants.COPYFILE_EXCL);
        await inspectSafeTensors(staging); await publish(staging, destination);
      } finally { try { await fsp.rm(staging, { force: true }); } finally { await release(); } }
    }
    await this.refresh();
  }
  private async quarantine(part: string, manifest: string, reason: string) {
    const suffix = `.quarantine-${randomUUID()}`;
    for (const filename of [part, manifest]) {
      if (await fileStat(filename, true)) { await fsp.link(filename, `${filename}${suffix}`); await fsp.unlink(filename); }
    }
    await fsp.appendFile(path.join(this.paths.logs, 'models.log'), `${new Date().toISOString()} Preserved ${path.basename(part)}${suffix}: ${reason}\n`);
  }
  private async writeManifest(filename: string, value: DownloadManifest) {
    await fileStat(filename, true);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { await fsp.writeFile(temporary, JSON.stringify(value), { flag: 'wx' }); await fsp.rename(temporary, filename); }
    finally { await fsp.rm(temporary, { force: true }); }
  }
  async download(input: ModelDownloadRequest, options: ModelDownloadOptions = {}) {
    return this.library.withShared('downloading a model', () => this.downloadUnlocked(input, options));
  }
  private async downloadUnlocked(input: ModelDownloadRequest, options: ModelDownloadOptions = {}, retryId?: string) {
    const internalHeaders = z.object({ Authorization: z.string().min(8).max(4103).regex(/^Bearer [^\s\x00-\x1f\x7f]+$/).optional() }).strict().parse(options.headers ?? {});
    options.signal?.throwIfAborted();
    const request = downloadSchema.parse(input); const folder = await this.managedFolder(request.kind);
    await this.locations?.assertDestinationAvailable(request.kind, request.filename);
    if (internalHeaders.Authorization && new URL(request.url).origin !== 'https://civitai.com') throw new Error('Authenticated model downloads are restricted to the Civitai origin.');
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(request.filename)) throw new Error('Choose a filename that is not a reserved device name.');
    const destination = containedPath(folder, request.filename); const part = `${destination}.part`; const manifest = `${part}.json`;
    const release = await this.reserve(destination);
    let status: DownloadStatus | undefined; let controller: AbortController | undefined; let record: ModelTransferRecord | undefined; let persistenceFailure: unknown;
    const persist = () => {
      if (!record || !status) return;
      record.updatedAt = new Date().toISOString(); record.state = status.state; record.receivedBytes = status.receivedBytes; record.totalBytes = status.totalBytes; record.error = status.error;
      this.transferJournal.save(record); this.transfers.set(record.id, structuredClone(record));
    };
    const abortExternal = () => controller?.abort();
    try {
      const prepared = prepareModelTransfer(request, Boolean(internalHeaders.Authorization));
      const recovery = this.transferJournal.load(); this.transferWarnings = recovery.warnings;
      const previous = retryId ? this.transferJournal.get(retryId) : recovery.transfers.find(item => item.identity === prepared.identity);
      if (retryId && previous) validateModelTransferRetry(previous, request);
      const now = new Date().toISOString();
      record = { version: 1, id: previous?.id ?? randomUUID(), createdAt: previous?.createdAt ?? now, updatedAt: now, attempt: (previous?.attempt ?? 0) + 1, ...prepared, state: 'downloading', receivedBytes: 0, totalBytes: 0 };
      status = this.transferStatus(record); persist();
      const existingStatus = this.downloads.findIndex(item => item.id === status!.id);
      if (existingStatus >= 0) this.downloads[existingStatus] = status; else this.downloads.push(status);
      this.changed(); controller = new AbortController(); this.controllers.set(status.id, controller);
      options.signal?.addEventListener('abort', abortExternal, { once: true });
      if (options.signal?.aborted) controller.abort(); controller.signal.throwIfAborted();
      if (await fileStat(destination)) {
        if (request.sha256 && await hashFile(destination, controller.signal) === request.sha256.toLowerCase()) {
          await inspectSafeTensors(destination); controller.signal.throwIfAborted(); await this.refresh();
          const id = `${request.kind}:${request.filename}`; const existing = this.store.modelMetadata<Metadata>(id);
          if (existing) this.store.saveModelMetadata(id, { ...existing, ...sourceMetadata(request) });
          status.receivedBytes = (await fsp.stat(destination)).size; status.totalBytes = status.receivedBytes; status.state = 'completed'; persist(); await this.refresh(); return;
        }
        throw new Error('That filename already exists. Choose another name; existing models are never overwritten.');
      }
      let offset = (await fileStat(part, true))?.size ?? 0;
      let saved: DownloadManifest | undefined;
      if (await fileStat(manifest, true)) {
        try { const parsed: unknown = JSON.parse(await fsp.readFile(manifest, 'utf8')); if (isObject(parsed)) saved = parsed as unknown as DownloadManifest; } catch { /* Preserve and restart malformed manifests below. */ }
      }
      const sameRequest = (saved?.sourceIdentity === modelSourceIdentity(request.url) || saved?.url === request.url) && (typeof saved?.sha256 === 'string' ? saved.sha256.toLowerCase() : undefined) === request.sha256?.toLowerCase();
      if (offset && (!sameRequest || (!strongEtag(saved?.etag) && !lastModified(saved?.lastModified)))) {
        await this.quarantine(part, manifest, 'Missing, changed or unvalidated resume metadata; restarting safely.'); offset = 0; saved = undefined;
      } else if (!offset && (await fileStat(part, true) || await fileStat(manifest, true))) {
        await this.quarantine(part, manifest, 'Empty or orphaned download state; restarting safely.'); saved = undefined;
      }
      // A retry may fail before any response arrives. Retain the usable prefix
      // and its known total instead of replacing recovery progress with zero.
      status.receivedBytes = offset;
      status.totalBytes = Number.isSafeInteger(saved?.totalBytes) && saved!.totalBytes! >= offset ? saved!.totalBytes! : 0;
      persist();
      // A completed transfer can survive a crash before publication.
      const alreadyComplete = offset > 0 && Number.isSafeInteger(saved?.totalBytes) && offset === saved?.totalBytes;
      let expectedBytes = alreadyComplete ? offset : undefined;
      if (!alreadyComplete) {
        let response: Response | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
          const validator = strongEtag(saved?.etag) ?? lastModified(saved?.lastModified);
          response = await downloadResponse(request.url, { 'Accept-Encoding': 'identity', ...internalHeaders, ...(offset && validator ? { Range: `bytes=${offset}-`, 'If-Range': validator } : {}) }, controller.signal);
          if (new URL(response.url).protocol !== 'https:') { await response.body?.cancel(); throw new Error('The download redirected to an insecure connection.'); }
          const resumed = offset > 0 && response.status === 206;
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
          const numbers = range?.slice(1).map(Number);
          const validRange = numbers && numbers.every(Number.isSafeInteger) && numbers[0] === offset && numbers[1] >= offset && numbers[2] > numbers[1] && numbers[1] + 1 === numbers[2] && (saved?.totalBytes === undefined || saved.totalBytes === numbers[2]);
          const sameValidator = strongEtag(saved?.etag) ? response.headers.get('etag') === saved!.etag : response.headers.get('last-modified') === saved?.lastModified;
          if (offset && (response.status === 416 || (resumed && (!validRange || !sameValidator)))) {
            await response.body?.cancel(); await this.quarantine(part, manifest, 'The server changed the source or returned an invalid resume range.'); offset = 0; saved = undefined; response = undefined; continue;
          }
          if (!response.ok || !response.body || (response.status !== 200 && !resumed)) {
            await response.body?.cancel();
            if (new URL(request.url).origin === 'https://civitai.com' && response.status === 401) throw new Error('Civitai download was not authorized (HTTP 401). Check access on the creator’s page and add or update your key in Civitai settings before retrying.');
            if (new URL(request.url).origin === 'https://civitai.com' && response.status === 403) throw new Error('Civitai denied this download (HTTP 403). Check the creator’s access rules and your account or regional restrictions before retrying.');
            throw new Error(`Download server returned HTTP ${response.status}.`);
          }
          if (offset && !resumed) { await this.quarantine(part, manifest, 'The source changed or the server cannot resume; restarting from its full response.'); offset = 0; saved = undefined; }
          const encoding = response.headers.get('content-encoding');
          if (encoding && encoding !== 'identity') { await response.body.cancel(); throw new Error('The server returned an encoded download instead of the original model bytes.'); }
          let length: number | undefined;
          try { length = contentLength(response); } catch (error) { await response.body.cancel(); throw error; }
          const total = resumed ? numbers![2] : length;
          if (resumed && length !== undefined && length !== total! - offset) { await response.body.cancel(); throw new Error('The server returned an inconsistent resume length.'); }
          expectedBytes = total; status.receivedBytes = offset; status.totalBytes = total ?? 0;
          const free = await fsp.statfs(this.paths.models);
          if (total !== undefined && free.bavail * free.bsize < total - offset + RESERVE_BYTES) { await response.body.cancel(); throw new Error('There is not enough free space for this model.'); }
          await this.writeManifest(manifest, { sourceIdentity: modelSourceIdentity(request.url), sha256: request.sha256?.toLowerCase(), etag: strongEtag(response.headers.get('etag')), lastModified: lastModified(response.headers.get('last-modified')), totalBytes: total });
          let lastUpdate = 0; let lastPersist = 0; const source = Readable.fromWeb(response.body as never); const activeStatus = status; persist();
          source.on('data', (chunk: Buffer) => {
            activeStatus.receivedBytes += chunk.length;
            if (Date.now() - lastPersist > 2000) { lastPersist = Date.now(); try { persist(); } catch (error) { persistenceFailure = error; controller!.abort(); } }
            if (Date.now() - lastUpdate > 350) { lastUpdate = Date.now(); this.changed(); }
          });
          try {
            await pipeline(source, fs.createWriteStream(part, { flags: offset ? 'a' : 'wx' }), { signal: controller.signal });
          } catch (error) {
            // Stream data events can precede disk writes. Once the writer closes,
            // report the actual preserved prefix, including partial ENOSPC writes.
            try { status.receivedBytes = (await fileStat(part, true))?.size ?? 0; }
            catch { this.transferWarnings.push('The partial file could not be measured after interruption. Saved progress may be outdated.'); }
            throw error;
          }
          break;
        }
        if (!response) throw new Error('The download server could not provide a consistent model file. Retry the download.');
      } else { status.receivedBytes = offset; status.totalBytes = offset; }
      status.state = 'verifying'; persist(); this.changed();
      let sha256: string;
      try {
        if (expectedBytes !== undefined && status.receivedBytes !== expectedBytes) throw new Error('Downloaded size does not match the expected size.');
        await inspectSafeTensors(part); sha256 = await hashFile(part, controller.signal);
        if (request.sha256 && sha256 !== request.sha256.toLowerCase()) throw new Error('Model checksum mismatch.');
      } catch (error) {
        if (!controller.signal.aborted) {
          await this.quarantine(part, manifest, String(error));
          throw new Error(`${error instanceof Error ? error.message : String(error)} The invalid file was preserved outside model selection. Retry to download a fresh copy.`);
        }
        throw error;
      }
      controller.signal.throwIfAborted(); await publish(part, destination); await fsp.rm(manifest, { force: true });
      const stat = await fsp.stat(destination);
      this.store.saveModelMetadata(`${request.kind}:${request.filename}`, { ...sourceMetadata(request), family: request.family, triggers: request.triggers ?? [], sha256, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
      status.state = 'completed'; persist(); await this.refresh();
    } catch (error) {
      if (status) { status.state = controller?.signal.aborted && !persistenceFailure ? 'cancelled' : 'failed'; status.error = safeModelTransferError(persistenceFailure ?? error, request, internalHeaders.Authorization); try { persist(); } catch { this.transferWarnings.push('Transfer progress could not be saved. The model and any partial file remain preserved.'); } }
      if (controller?.signal.aborted && !persistenceFailure) throw new ModelTransferCancelledError();
      throw new Error(safeModelTransferError(persistenceFailure ?? error, request, internalHeaders.Authorization));
    } finally { options.signal?.removeEventListener('abort', abortExternal); if (status) this.controllers.delete(status.id); await release(); this.changed(); }
  }
  cancelDownload(id: string) { this.controllers.get(id)?.abort(); }
  dispose() { for (const controller of this.controllers.values()) controller.abort(); }
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppPaths, ModelDownloadRequest } from '../shared/types';
import type { ModelTransferRecord, ModelTransferRecovery } from '../shared/model-transfer-types';
import { downloadSchema } from '../shared/validation';
import { inside } from './paths';

const MAX_RECORDS = 2000;
/** Keep deliberate cancellation distinct from transfer/storage failures at desktop boundaries. */
export class ModelTransferCancelledError extends Error {
  constructor() { super('Transfer cancelled. Its saved request and any partial file remain available.'); this.name = 'ModelTransferCancelledError'; }
}
const MAX_BYTES = 64 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const recordSchema = z.object({
  version: z.literal(1), id: z.uuid(), identity: digest, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), attempt: integer.min(1),
  state: z.enum(['downloading', 'verifying', 'completed', 'failed', 'cancelled', 'interrupted']),
  request: downloadSchema.omit({ url: true }),
  source: z.object({ kind: z.enum(['direct', 'civitai', 'refresh-required']), origin: z.url(), identity: digest, url: z.url().optional(), usedAuthentication: z.boolean() }).strict(),
  receivedBytes: integer, totalBytes: integer, error: z.string().max(2000).optional(),
}).strict();

export function modelSourceIdentity(url: string): string { return createHash('sha256').update(new URL(url).href).digest('hex'); }
function publicLink(value: string | undefined) {
  if (!value) return undefined;
  const url = new URL(value); url.search = ''; url.hash = ''; return url.href;
}
function assertFilename(value: string) {
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) throw new Error('The saved model filename is a reserved device name.');
}
function requiresFreshUrl(url: URL) {
  return Boolean(url.search || url.hash || /(?:^|\.)(?:amazonaws\.com|cloudfront\.net|xethub\.hf\.co)$/.test(url.hostname) || url.hostname.startsWith('cdn-lfs') || /^\/(?:signed|token|auth|temporary|download-token)\//i.test(url.pathname));
}
function identity(request: Omit<ModelDownloadRequest, 'url'>, source: ModelTransferRecord['source']) {
  const remote = request.civitai ? { modelId: request.civitai.modelId, versionId: request.civitai.versionId, fileId: request.civitai.fileId } : source.identity;
  return createHash('sha256').update(JSON.stringify({ kind: request.kind, filename: process.platform === 'win32' ? request.filename.toLowerCase() : request.filename, family: request.family, sha256: request.sha256?.toLowerCase(), remote })).digest('hex');
}
export function prepareModelTransfer(input: ModelDownloadRequest, usedAuthentication: boolean): Pick<ModelTransferRecord, 'identity' | 'request' | 'source'> {
  const parsed = downloadSchema.parse(input); assertFilename(parsed.filename); const url = new URL(parsed.url);
  if (usedAuthentication && url.origin !== 'https://civitai.com') throw new Error('Authenticated model downloads require the Civitai credential path.');
  if (parsed.civitai && url.origin !== 'https://civitai.com') throw new Error('Civitai transfer provenance requires its reviewed source endpoint.');
  const kind = parsed.civitai || url.origin === 'https://civitai.com' ? 'civitai' : requiresFreshUrl(url) || usedAuthentication ? 'refresh-required' : 'direct';
  const { url: _url, ...metadata } = parsed;
  const request: ModelTransferRecord['request'] = { ...metadata, sha256: parsed.sha256?.toLowerCase(), sourceUrl: publicLink(parsed.sourceUrl), licenseUrl: publicLink(parsed.licenseUrl) };
  // Preserve only Civitai's explicit public version selector, never arbitrary query fields.
  if (request.civitai) request.civitai.sourceUrl = `https://civitai.com/models/${request.civitai.modelId}?modelVersionId=${request.civitai.versionId}`;
  const source: ModelTransferRecord['source'] = { kind, origin: url.origin, identity: modelSourceIdentity(url.href), usedAuthentication, ...(kind === 'direct' ? { url: url.href } : {}) };
  return { request, source, identity: identity(request, source) };
}
export function parseModelTransfer(value: unknown): ModelTransferRecord {
  const parsed = recordSchema.parse(value) as ModelTransferRecord; assertFilename(parsed.request.filename);
  const origin = new URL(parsed.source.origin);
  if (origin.protocol !== 'https:' || origin.origin !== parsed.source.origin || origin.username || origin.password) throw new Error('The saved transfer origin is invalid.');
  if (parsed.source.kind === 'direct') {
    if (!parsed.source.url || parsed.source.usedAuthentication) throw new Error('The saved public transfer source is invalid.');
    const url = new URL(parsed.source.url);
    if (url.protocol !== 'https:' || url.username || url.password || requiresFreshUrl(url) || url.origin === 'https://civitai.com' || parsed.request.civitai || url.origin !== origin.origin || modelSourceIdentity(url.href) !== parsed.source.identity) throw new Error('The saved public transfer source changed.');
  } else if (parsed.source.url) throw new Error('Refreshing transfers cannot retain an expiring or authenticated URL.');
  if (parsed.source.kind === 'civitai' && origin.origin !== 'https://civitai.com' || parsed.request.civitai && parsed.source.kind !== 'civitai') throw new Error('The saved Civitai source is inconsistent.');
  if (identity(parsed.request, parsed.source) !== parsed.identity) throw new Error('The saved transfer identity is inconsistent.');
  return parsed;
}
export function validateModelTransferRetry(saved: ModelTransferRecord, fresh: ModelDownloadRequest): ModelDownloadRequest {
  parseModelTransfer(saved); const next = downloadSchema.parse(fresh); assertFilename(next.filename);
  if (saved.source.kind === 'refresh-required' && !saved.request.sha256) throw new Error('This expiring transfer has no saved expected checksum. Start a new download to review its replacement source.');
  if (next.kind !== saved.request.kind || next.filename !== saved.request.filename || next.family !== saved.request.family || next.sha256?.toLowerCase() !== saved.request.sha256) throw new Error('The refreshed transfer changed its target, family or checksum. Start a new download deliberately.');
  const old = saved.request.civitai; const current = next.civitai;
  if (Boolean(old) !== Boolean(current) || old && current && (old.modelId !== current.modelId || old.versionId !== current.versionId || old.fileId !== current.fileId || old.baseModel !== current.baseModel)) throw new Error('The refreshed transfer is a different Civitai model, version or file.');
  if (saved.source.kind === 'direct' && modelSourceIdentity(next.url) !== saved.source.identity) throw new Error('The saved public download source changed. Start a new transfer deliberately.');
  if (saved.source.kind === 'civitai' && new URL(next.url).origin !== 'https://civitai.com') throw new Error('A fresh Civitai download must use the reviewed Civitai endpoint.');
  if (new URL(next.url).origin !== saved.source.origin) throw new Error('The refreshed download changed its source origin. Start a new transfer deliberately.');
  return next;
}
export function safeModelTransferError(error: unknown, request?: ModelDownloadRequest, authorization?: string): string {
  if ((error as NodeJS.ErrnoException | null)?.code === 'ENOSPC') return 'There is not enough disk space to finish this download. Any partial file was preserved. Free space, then use Retry / Resume.';
  let message = error instanceof Error ? error.message : String(error);
  const querySecrets = request ? [...new URL(request.url).searchParams.values()].filter(value => value.length >= 8) : [];
  for (const secret of [authorization, authorization?.replace(/^Bearer /, ''), request?.url && new URL(request.url).search.slice(1), ...querySecrets].filter((item): item is string => Boolean(item))) message = message.split(secret).join('[redacted]');
  message = message.replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]').replace(/https:\/\/[^\s<>"']+/gi, value => { try { return publicLink(value)!; } catch { return '[source]'; } });
  return message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').slice(0, 2000);
}

/** One bounded atomic file per transfer; writers must hold ModelService's destination lease. */
export class ModelTransferJournal {
  private directory: string;
  constructor(private paths: AppPaths) { this.directory = path.join(paths.cache, 'model-transfers'); }
  private guard(create = false): boolean {
    for (const directory of [this.paths.root, this.paths.cache]) {
      const stat = fs.lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Transfer metadata directories cannot be links.');
    }
    if (!fs.existsSync(this.directory)) { if (!create) return false; try { fs.mkdirSync(this.directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(fs.realpathSync(this.paths.root), fs.realpathSync(this.directory))) throw new Error('Transfer metadata is outside the private studio.');
    return true;
  }
  private filename(id: string) { return path.join(this.directory, `${z.uuid().parse(id)}.json`); }
  private readFile(id: string): ModelTransferRecord {
    const file = this.filename(id); const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error('Transfer metadata is not a bounded independent file.');
    const record = parseModelTransfer(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (record.id !== id) throw new Error('Transfer metadata ID does not match its file.'); return record;
  }
  /** Read-only recovery snapshot; never rewrite another process's journal. */
  private recoverProgress(record: ModelTransferRecord): void {
    if (record.state === 'completed') return;
    const folder = path.join(this.paths.models, record.request.kind === 'checkpoint' ? 'checkpoints' : 'loras');
    for (const directory of [this.paths.root, this.paths.models, folder]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The private model directory cannot be safely inspected.');
    }
    if (!inside(fs.realpathSync(this.paths.models), fs.realpathSync(folder))) throw new Error('The model directory is outside this studio.');
    const target = path.join(folder, record.request.filename), partial = `${target}.part`, manifest = `${partial}.json`;
    let before: fs.Stats;
    try { before = fs.lstatSync(partial); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A crash can occur after publication but before the completed journal.
      // Presence alone does not verify that destination against this request.
      try { fs.lstatSync(target); } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing;
        record.receivedBytes = 0; return;
      }
      throw new Error('A destination exists and needs explicit retry verification.');
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || !Number.isSafeInteger(before.size)) throw new Error('The partial is not an independent measurable file.');
    const metadataStat = fs.lstatSync(manifest);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.nlink !== 1 || metadataStat.size > MAX_BYTES) throw new Error('Resume metadata is not a bounded independent file.');
    const fd = fs.openSync(manifest, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let metadata: Record<string, unknown>;
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== metadataStat.dev || opened.ino !== metadataStat.ino || opened.size !== metadataStat.size || opened.nlink !== 1) throw new Error('Resume metadata changed while opening.');
      const bytes = Buffer.alloc(metadataStat.size + 1);
      const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
      const after = fs.fstatSync(fd);
      if (count !== metadataStat.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Resume metadata changed while reading.');
      metadata = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    } finally { fs.closeSync(fd); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Resume metadata is invalid.');
    const identity = metadata.sourceIdentity ?? (typeof metadata.url === 'string' ? modelSourceIdentity(metadata.url) : undefined);
    const checksum = typeof metadata.sha256 === 'string' ? metadata.sha256.toLowerCase() : undefined;
    const validator = typeof metadata.etag === 'string' && /^"[^\r\n]*"$/.test(metadata.etag) || typeof metadata.lastModified === 'string' && Number.isFinite(Date.parse(metadata.lastModified));
    if (identity !== record.source.identity || checksum !== record.request.sha256 || !validator || !Number.isSafeInteger(metadata.totalBytes) || Number(metadata.totalBytes) < before.size) throw new Error('The partial cannot be matched to a validated resume request.');
    const after = fs.lstatSync(partial), metadataAfter = fs.lstatSync(manifest);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.nlink !== 1 || metadataAfter.dev !== metadataStat.dev || metadataAfter.ino !== metadataStat.ino || metadataAfter.mtimeMs !== metadataStat.mtimeMs || metadataAfter.ctimeMs !== metadataStat.ctimeMs) throw new Error('Resume files changed while measuring.');
    record.receivedBytes = before.size; record.totalBytes = Number(metadata.totalBytes);
  }
  load(): ModelTransferRecovery {
    if (!this.guard()) return { transfers: [], warnings: [] };
    const files = fs.readdirSync(this.directory).filter(name => /^[a-f0-9-]{36}\.json$/i.test(name)).sort();
    const result: ModelTransferRecovery = { transfers: [], warnings: [] };
    if (files.length > MAX_RECORDS) result.warnings.push('The transfer archive exceeds its safe read limit. Some older entries are not displayed; their files remain preserved.');
    for (const name of files.slice(0, MAX_RECORDS)) {
      try {
        const record = this.readFile(name.slice(0, -5));
        if (record.state === 'downloading' || record.state === 'verifying') { record.state = 'interrupted'; record.error = 'This transfer needs an explicit retry after interruption. Any verified partial remains preserved; another process may still own it.'; }
        try { this.recoverProgress(record); }
        catch {
          const warning = `${record.request.filename}: current partial progress could not be verified. Displayed counts are the last saved values; explicit retry will recheck the files.`;
          result.warnings.push(warning); record.error = `${record.error ? record.error + ' ' : ''}${warning}`.slice(0, 2000);
        }
        result.transfers.push(record);
      }
      catch { result.warnings.push(`Transfer metadata ${name} is invalid and was preserved. Re-select its source to start a verified download.`); }
    }
    result.transfers.sort((a, b) => a.createdAt.localeCompare(b.createdAt)); return result;
  }
  get(id: string): ModelTransferRecord { if (!this.guard()) throw new Error('The saved transfer was not found.'); return this.readFile(id); }
  save(input: ModelTransferRecord): void {
    const record = parseModelTransfer(input); const bytes = JSON.stringify(record); if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('The transfer metadata exceeds its safe size.');
    this.guard(true); const target = this.filename(record.id);
    if (fs.existsSync(target)) this.readFile(record.id);
    else if (fs.readdirSync(this.directory).filter(name => name.endsWith('.json')).length >= MAX_RECORDS) throw new Error('The private transfer archive is full. Existing transfers and model files were preserved.');
    const temporary = `${target}.${randomUUID()}.tmp`; let fd: number | undefined;
    try { fd = fs.openSync(temporary, 'wx'); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temporary, target); }
    finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
}

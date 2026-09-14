import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { AppPaths, ModelFamily } from '../shared/types';
import type { CivitaiFile, CivitaiModel, CivitaiReadResult, CivitaiSearchPage, CivitaiSearchRequest, CivitaiVersion } from '../shared/civitai-types';
import { inside } from './paths';

const ORIGIN = 'https://civitai.com';
const MAX_BODY = 4 * 1024 * 1024;
const MAX_CACHE_AGE = 30 * 24 * 60 * 60 * 1000;
const PREVIEW_HOSTS = new Set(['image.civitai.com', 'imagecache.civitai.com']);
const searchSchema = z.object({ includeMature: z.boolean().default(true), username: z.string().trim().max(100).optional(), tag: z.string().trim().max(100).optional(), period: z.enum(['AllTime', 'Year', 'Month', 'Week', 'Day']).optional(), query: z.string().trim().max(200).optional(), kind: z.enum(['checkpoint', 'lora']).optional(), family: z.enum(['sdxl', 'illustrious']).optional(), cursor: z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/).optional(), limit: z.number().int().min(1).max(20).default(12), sort: z.enum(['Most Downloaded', 'Highest Rated', 'Newest']).default('Most Downloaded') }).strict();
function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function array(value: unknown, maximum: number) { return Array.isArray(value) ? value.slice(0, maximum) : []; }
function id(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null; }
function nullableBool(value: unknown) { return typeof value === 'boolean' ? value : null; }
function plain(value: unknown, maximum = 500): string {
  if (typeof value !== 'string') return '';
  // This result is plain text, never trusted HTML. Decode basic entities only
  // after stripping markup so encoded text remains text in a React text node.
  return value.slice(0, 40_000).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<br\s*\/?\s*>|<\/(?:p|div|li|h[1-6]|blockquote|pre|tr)\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[entity]!).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, maximum).trim();
}
function texts(value: unknown, count: number, maximum: number) { return array(value, count).filter((item): item is string => typeof item === 'string').map(item => plain(item, maximum)).filter(Boolean); }
function safeUrl(value: unknown, purpose: 'download' | 'preview' | 'source'): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
    if (purpose === 'preview') return PREVIEW_HOSTS.has(url.hostname) && ![...url.searchParams.keys()].some(key => /token|key|auth/i.test(key)) ? url.href : null;
    if (url.origin !== ORIGIN) return null;
    if (purpose === 'source') return /^\/models\/\d+$/.test(url.pathname) && [...url.searchParams.keys()].every(key => key === 'modelVersionId') ? url.href : null;
    if (!/^\/api\/download\/models\/\d+$/.test(url.pathname)) return null;
    // Never persist a remote token or arbitrary query arguments in a download URL.
    if (![...url.searchParams.keys()].every(key => ['type', 'format', 'size', 'fp', 'fileId'].includes(key))) return null;
    if (url.searchParams.has('fileId') && !/^[1-9]\d*$/.test(url.searchParams.get('fileId')!)) return null;
    return url.href;
  } catch { return null; }
}
export function civitaiFamily(baseModel: string): ModelFamily | 'unknown' {
  if (baseModel === 'Illustrious') return 'illustrious';
  if (['SDXL 0.9', 'SDXL 1.0', 'SDXL 1.0 LCM', 'SDXL Lightning', 'SDXL Hyper', 'SDXL Turbo', 'SDXL Distilled'].includes(baseModel)) return 'sdxl';
  return 'unknown';
}
function normalizeFile(value: unknown, versionId: number): CivitaiFile | null {
  const raw = object(value); const fileId = id(raw.id); if (!fileId) return null;
  const metadata = object(raw.metadata); const hashes = object(raw.hashes);
  const sizeKB = typeof raw.sizeKB === 'number' && Number.isFinite(raw.sizeKB) && raw.sizeKB > 0 && raw.sizeKB * 1024 <= Number.MAX_SAFE_INTEGER ? raw.sizeKB : null;
  const name = plain(raw.name, 240);
  // Some current API files omit format; only infer an absent value from the exact extension.
  const format = plain(metadata.format, 40) || (name.toLowerCase().endsWith('.safetensors') ? 'SafeTensor' : '');
  const safeName = !!name && raw.name === name && !/[\\/:*?"<>|]/.test(name) && !/[. ]$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name);
  const download = safeName ? safeUrl(raw.downloadUrl, 'download') : null;
  const downloadIdentityMatches = download && new URL(download).pathname === `/api/download/models/${versionId}` && (!new URL(download).searchParams.has('fileId') || new URL(download).searchParams.getAll('fileId').length === 1 && new URL(download).searchParams.get('fileId') === String(fileId));
  return { id: fileId, name, type: plain(raw.type, 80), format, fp: plain(metadata.fp, 40), sizeKB, estimatedBytes: sizeKB === null ? null : Math.round(sizeKB * 1024), sha256: typeof hashes.SHA256 === 'string' && /^[a-fA-F0-9]{64}$/.test(hashes.SHA256) ? hashes.SHA256.toLowerCase() : null, downloadUrl: downloadIdentityMatches ? download : null, primary: raw.primary === true, safeTensor: safeName && name.toLowerCase().endsWith('.safetensors') && format === 'SafeTensor' };
}
function normalizeVersion(value: unknown, modelId: number, blocked: boolean): CivitaiVersion | null {
  const raw = object(value); const versionId = id(raw.id); if (!versionId || (raw.modelId !== undefined && raw.modelId !== modelId)) return null;
  const baseModel = plain(raw.baseModel, 100); const availability = plain(raw.availability, 100);
  const previews = array(raw.images, 12).flatMap(value => {
    const image = object(value); const url = safeUrl(image.url, 'preview');
    return !blocked && url && image.type !== 'video' ? [{ url, width: id(image.width), height: id(image.height) }] : [];
  }).slice(0, 6);
  const earlyAccessEndsAt = typeof raw.earlyAccessEndsAt === 'string' && Number.isFinite(Date.parse(raw.earlyAccessEndsAt)) ? new Date(raw.earlyAccessEndsAt).toISOString() : null;
  return { id: versionId, modelId, name: plain(raw.name, 200), description: plain(raw.description, 8000), baseModel, family: civitaiFamily(baseModel), baseModelType: plain(raw.baseModelType, 80), trainedWords: texts(raw.trainedWords, 50, 200), availability, status: plain(raw.status, 60), earlyAccessEndsAt, publiclyListed: !blocked && availability === 'Public' && !earlyAccessEndsAt && !raw.earlyAccessConfig, files: blocked ? [] : array(raw.files, 30).map(value => normalizeFile(value, versionId)).filter((file): file is CivitaiFile => !!file), previews, sourceUrl: `${ORIGIN}/models/${modelId}?modelVersionId=${versionId}` };
}
export function normalizeCivitaiModel(value: unknown): CivitaiModel | null {
  const raw = object(value); const modelId = id(raw.id);
  if (!modelId || !['Checkpoint', 'LORA'].includes(String(raw.type))) return null;
  const mode = plain(raw.mode, 60) || null; const blocked = !!mode;
  const commercial = typeof raw.allowCommercialUse === 'string' ? raw.allowCommercialUse.replace(/[{}]/g, '').split(',').map(value => value.trim()).filter(Boolean) : raw.allowCommercialUse;
  const versions = array(raw.modelVersions, 50).map(value => normalizeVersion(value, modelId, blocked)).filter((version): version is CivitaiVersion => !!version);
  // Thumbnail ratings do not filter images; listing filters remain separate.
  return { id: modelId, name: plain(raw.name, 200), description: plain(raw.description, 8000), kind: raw.type === 'Checkpoint' ? 'checkpoint' : 'lora', creator: plain(object(raw.creator).username, 150), tags: texts(raw.tags, 50, 80), sourceUrl: `${ORIGIN}/models/${modelId}`, availability: plain(raw.availability, 100), mode, permissions: { allowNoCredit: nullableBool(raw.allowNoCredit), allowDerivatives: nullableBool(raw.allowDerivatives), allowDifferentLicense: nullableBool(raw.allowDifferentLicense), allowCommercialUse: Array.isArray(commercial) ? texts(commercial, 20, 80) : null }, versions };
}

const source = z.string().refine(value => safeUrl(value, 'source') === value);
const fileSchema = z.object({ id: z.number().int().positive(), name: z.string().max(240), type: z.string().max(80), format: z.string().max(40), fp: z.string().max(40), sizeKB: z.number().positive().nullable(), estimatedBytes: z.number().int().positive().nullable(), sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), downloadUrl: z.string().refine(value => safeUrl(value, 'download') === value).nullable(), primary: z.boolean(), safeTensor: z.boolean() });
const versionSchema = z.object({ id: z.number().int().positive(), modelId: z.number().int().positive(), name: z.string().max(200), description: z.string().max(8000), baseModel: z.string().max(100), family: z.enum(['sdxl', 'illustrious', 'unknown']), baseModelType: z.string().max(80), trainedWords: z.array(z.string().max(200)).max(50), availability: z.string().max(100), status: z.string().max(60), earlyAccessEndsAt: z.iso.datetime().nullable(), publiclyListed: z.boolean(), files: z.array(fileSchema).max(30), previews: z.array(z.object({ url: z.string().refine(value => safeUrl(value, 'preview') === value), width: z.number().int().positive().nullable(), height: z.number().int().positive().nullable() })).max(6), sourceUrl: source });
const modelSchema: z.ZodType<CivitaiModel> = z.object({ id: z.number().int().positive(), name: z.string().max(200), description: z.string().max(8000), kind: z.enum(['checkpoint', 'lora']), creator: z.string().max(150), tags: z.array(z.string().max(80)).max(50), sourceUrl: source, availability: z.string().max(100), mode: z.string().max(60).nullable(), permissions: z.object({ allowNoCredit: z.boolean().nullable(), allowDerivatives: z.boolean().nullable(), allowDifferentLicense: z.boolean().nullable(), allowCommercialUse: z.array(z.string().max(80)).max(20).nullable() }), versions: z.array(versionSchema).max(50) });
const pageSchema: z.ZodType<CivitaiSearchPage> = z.object({ items: z.array(modelSchema).max(20), nextCursor: z.string().max(512).regex(/^[^\x00-\x1f\x7f]+$/).nullable() });
export class CivitaiError extends Error {
  constructor(message: string, readonly code: 'auth' | 'forbidden' | 'rate-limit' | 'offline' | 'timeout' | 'cancelled' | 'not-found' | 'response' | 'cache', readonly status?: number, readonly retryAfterSeconds?: number) { super(message); this.name = 'CivitaiError'; }
}
interface ClientOptions { apiKey?: string; timeoutMs?: number; fetch?: typeof globalThis.fetch; now?: () => number; }
export class CivitaiClient {
  #apiKey?: string;
  private requestFetch: typeof globalThis.fetch;
  private timeoutMs: number;
  private now: () => number;
  constructor(private paths: Pick<AppPaths, 'cache'>, options: ClientOptions = {}) {
    if (options.apiKey !== undefined && (!options.apiKey.trim() || options.apiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(options.apiKey))) throw new Error('Enter a valid Civitai API key without spaces or line breaks.');
    this.#apiKey = options.apiKey; this.requestFetch = options.fetch ?? globalThis.fetch; this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new Error('Civitai timeout must be between 1 and 30000 milliseconds.');
  }
  async search(input: CivitaiSearchRequest = {}, signal?: AbortSignal): Promise<CivitaiReadResult<CivitaiSearchPage>> {
    const request = searchSchema.parse(input); const url = new URL('/api/v1/models', ORIGIN);
    url.searchParams.set('limit', String(request.limit)); url.searchParams.set('nsfw', String(request.includeMature)); url.searchParams.set('earlyAccess', 'false'); url.searchParams.set('sort', request.sort);
    if (request.query) url.searchParams.set('query', request.query);
    for (const key of ['username', 'tag', 'period'] as const) if (request[key]) url.searchParams.set(key, request[key]!);
    if (request.cursor) url.searchParams.set('cursor', request.cursor);
    if (request.kind) url.searchParams.set('types', request.kind === 'checkpoint' ? 'Checkpoint' : 'LORA');
    else { url.searchParams.append('types', 'Checkpoint'); url.searchParams.append('types', 'LORA'); }
    if (request.family) url.searchParams.set('baseModels', request.family === 'illustrious' ? 'Illustrious' : 'SDXL 1.0');
    return this.read(url, pageSchema, raw => {
      if (!Array.isArray(object(raw).items)) throw new CivitaiError('Civitai returned an invalid search response.', 'response');
      const next = object(object(raw).metadata).nextCursor;
      return { items: array(object(raw).items, request.limit).map(normalizeCivitaiModel).filter((model): model is CivitaiModel => !!model), nextCursor: typeof next === 'string' && next.length > 0 && next.length <= 512 && !/[\x00-\x1f\x7f]/.test(next) && next !== request.cursor ? next : null };
    }, signal);
  }
  async versionByHash(hash: string, signal?: AbortSignal) {
    if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('A complete model checksum is required. Refresh the model library first.');
    return this.read(new URL(`/api/v1/model-versions/by-hash/${hash.toLowerCase()}`, ORIGIN), z.object({ id: z.number().int().positive(), modelId: z.number().int().positive() }), raw => z.object({ id: z.number().int().positive(), modelId: z.number().int().positive() }).parse(raw), signal);
  }
  async detail(modelId: number, signal?: AbortSignal): Promise<CivitaiReadResult<CivitaiModel>> {
    if (!id(modelId)) throw new Error('Choose a positive model ID.');
    return this.read(new URL(`/api/v1/models/${modelId}`, ORIGIN), modelSchema, raw => {
      const model = normalizeCivitaiModel(raw);
      if (!model || model.id !== modelId) throw new CivitaiError('Civitai returned a different or unsupported model identity.', 'response');
      return model;
    }, signal);
  }
  private async cacheFile(url: URL) {
    const base = await fsp.lstat(this.paths.cache);
    if (!base.isDirectory() || base.isSymbolicLink()) throw new CivitaiError('The private cache directory is unavailable.', 'cache');
    const folder = path.join(this.paths.cache, 'civitai'); await fsp.mkdir(folder, { recursive: true });
    const stat = await fsp.lstat(folder);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(await fsp.realpath(this.paths.cache), await fsp.realpath(folder))) throw new CivitaiError('The Civitai cache is outside the private studio.', 'cache');
    // Keys never contain the API key. Authenticated results are not written to
    // disk, so different accounts cannot accidentally share entitlement data.
    return path.join(folder, `${createHash('sha256').update(url.href).digest('hex')}.json`);
  }
  private async read<T>(url: URL, schema: z.ZodType<T>, normalize: (raw: unknown) => T, signal?: AbortSignal): Promise<CivitaiReadResult<T>> {
    if (signal?.aborted) throw new CivitaiError('Civitai request cancelled.', 'cancelled');
    const timeout = new AbortController(); const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    let cache: string | undefined;
    try { if (!this.#apiKey) cache = await this.cacheFile(url); } catch { /* A cache problem must not prevent a live read. */ }
    try {
      const request = () => this.requestFetch(url.href, { method: 'GET', headers: { Accept: 'application/json', ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}) }, signal: combined, redirect: 'error' });
      let response = await request();
      // Retry a transient server failure once, within the original timeout.
      // Longer server-requested waits are left to the user, not shortened.
      if ([500, 502, 503, 504].includes(response.status) && (!response.url || new URL(response.url).origin === ORIGIN)) {
        const retryAfter = response.headers.get('retry-after');
        const wait = retryAfter === null ? 750 : /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - this.now();
        if (Number.isFinite(wait) && wait <= 2000) {
          await response.body?.cancel();
          await delay(Math.max(750, wait), undefined, { signal: combined });
          combined.throwIfAborted();
          response = await request();
        }
      }
      if (response.url && new URL(response.url).origin !== ORIGIN) { await response.body?.cancel(); throw new CivitaiError('Civitai returned an unexpected redirect.', 'response'); }
      if (!response.ok) {
        await response.body?.cancel(); const status = response.status;
        const retry = response.headers.get('retry-after'); const numeric = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.ceil((Date.parse(retry) - this.now()) / 1000) : undefined;
        const wait = numeric !== undefined && Number.isFinite(numeric) ? Math.max(1, Math.min(3600, numeric)) : undefined;
        if (status === 401) throw new CivitaiError('Civitai requires a valid API key for this request. Add or update it in settings.', 'auth', status);
        if (status === 403) throw new CivitaiError('Civitai denied access. This may be an account, regional or resource restriction.', 'forbidden', status);
        if (status === 404) throw new CivitaiError('That Civitai model is unavailable or no longer public.', 'not-found', status);
        if (status === 429) throw new CivitaiError(`Civitai is rate limiting requests. ${wait ? `Retry after ${wait} seconds.` : 'Wait before trying again.'}`, 'rate-limit', status, wait);
        throw new CivitaiError(status >= 500 ? 'Civitai is temporarily unavailable. Try again later.' : `Civitai rejected the request (HTTP ${status}).`, status >= 500 ? 'offline' : 'response', status);
      }
      const type = response.headers.get('content-type') ?? '';
      if (!/application\/(?:[\w.-]+\+)?json\b/i.test(type) || !response.body) { await response.body?.cancel(); throw new CivitaiError('Civitai returned an unexpected response instead of JSON.', 'response'); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      const cancelBody = () => { void reader.cancel().catch(() => {}); };
      combined.addEventListener('abort', cancelBody, { once: true });
      try {
        while (true) {
          combined.throwIfAborted(); const item = await reader.read(); if (item.done) break;
          size += item.value.length; if (size > MAX_BODY) { await reader.cancel(); throw new CivitaiError('Civitai response exceeded the safe size limit.', 'response'); } chunks.push(item.value);
        }
      } finally { combined.removeEventListener('abort', cancelBody); reader.releaseLock(); }
      combined.throwIfAborted(); const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const data = schema.parse(normalize(JSON.parse(decoded))); const fetchedAt = new Date(this.now()).toISOString();
      if (cache) {
        const temporary = `${cache}.${randomUUID()}.tmp`;
        try { await fsp.writeFile(temporary, JSON.stringify({ schema: 1, url: url.href, fetchedAt, data }), { flag: 'wx', mode: 0o600 }); await fsp.rename(temporary, cache); }
        catch { /* Live data remains usable when disk caching fails. */ }
        finally { await fsp.rm(temporary, { force: true }).catch(() => {}); }
      }
      return { data, fetchedAt, fromCache: false, stale: false };
    } catch (cause) {
      const error = signal?.aborted ? new CivitaiError('Civitai request cancelled.', 'cancelled') : timeout.signal.aborted ? new CivitaiError('Civitai request timed out. Check your connection and retry.', 'timeout') : cause instanceof CivitaiError ? cause : new CivitaiError('Civitai could not be reached or returned invalid data. Check your connection and retry.', 'offline');
      if (cache && ['offline', 'timeout', 'rate-limit'].includes(error.code)) {
        try {
          const stat = await fsp.lstat(cache);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BODY) throw new Error('Invalid cache file');
          const saved = object(JSON.parse(await fsp.readFile(cache, 'utf8'))); const date = typeof saved.fetchedAt === 'string' ? Date.parse(saved.fetchedAt) : NaN;
          if (saved.schema !== 1 || saved.url !== url.href || !Number.isFinite(date) || date > this.now() || this.now() - date > MAX_CACHE_AGE) throw new Error('Expired cache');
          return { data: schema.parse(saved.data), fetchedAt: saved.fetchedAt as string, fromCache: true, stale: true, warning: error.message };
        } catch { /* Invalid or missing cache is not usable evidence. */ }
      }
      throw error;
    } finally { clearTimeout(timer); }
  }
}


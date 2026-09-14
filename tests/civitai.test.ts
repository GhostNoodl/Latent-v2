import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CivitaiClient, civitaiFamily, normalizeCivitaiModel } from '../src/main/civitai';
import { createPaths, inside } from '../src/main/paths';

const checksum = 'ABCDEF12'.repeat(8);
function rawModel() {
  return { id: 120096, name: 'Pixel Art XL', description: '<p>Soft <b>colors</b>.</p><script>bad()</script>', type: 'LORA', availability: 'Public', creator: { username: 'artist' }, allowNoCredit: false, allowDerivatives: true, allowCommercialUse: [], tags: ['style'], modelVersions: [
    { id: 135931, modelId: 120096, name: 'v1.1', baseModel: 'SDXL 1.0', availability: 'Public', trainedWords: ['pixel art'], files: [{ id: 99321, name: 'pixel-art-xl-v1.1.safetensors', type: 'Model', sizeKB: 123.5, hashes: { SHA256: checksum }, metadata: { format: 'SafeTensor', fp: 'fp16' }, downloadUrl: 'https://civitai.com/api/download/models/135931', primary: true }], images: [{ url: 'https://image.civitai.com/example/one.jpeg', nsfwLevel: 1, width: 1024, height: 1024 }] },
    { id: 130580, modelId: 120096, name: 'v1.0', baseModel: 'SDXL 1.0', availability: 'Public', files: [] },
  ] };
}
function json(value: unknown, status = 200, headers = {}) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } }); }
let sandbox: string; let cache: string; let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(async () => { sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'latent-civitai-test-')); cache = createPaths(path.join(sandbox, 'studio')).cache; fetchMock = vi.fn(); });
afterEach(async () => {
  vi.restoreAllMocks(); const resolved = path.resolve(sandbox);
  if (!inside(os.tmpdir(), resolved) || !path.basename(resolved).startsWith('latent-civitai-test-')) throw new Error('Unsafe cleanup path');
  await fsp.rm(resolved, { recursive: true, force: true });
});
const client = (extra: object = {}) => new CivitaiClient({ cache }, { fetch: fetchMock as typeof fetch, ...extra });

describe('Civitai metadata normalization', () => {
  it.each([0, 1, 2, 4, 8, 16, 32, undefined])('retains API image previews regardless of rating %s', rating => {
    const raw = rawModel();
    Object.assign(raw.modelVersions[0].images![0], { nsfwLevel: rating, nsfw: true });
    expect(normalizeCivitaiModel(raw)!.versions[0].previews).toHaveLength(1);
  });

  it('accepts safetensors with absent API format and retains safe previews on mature-tagged models', () => {
    const raw = rawModel();
    delete (raw.modelVersions[0].files[0].metadata as { format?: string }).format;
    const result = normalizeCivitaiModel({ ...raw, nsfw: true })!;
    expect(result.versions[0].files[0]).toMatchObject({ format: 'SafeTensor', safeTensor: true });
    expect(result.versions[0].previews).toHaveLength(1);
    raw.modelVersions[0].files[0].name = 'weights.ckpt';
    expect(normalizeCivitaiModel(raw)!.versions[0].files[0].safeTensor).toBe(false);
  });

  it('accepts the live API fileId selector only for the exact chosen file and version', () => {
    const raw = rawModel(); const file = raw.modelVersions[0].files[0];
    file.downloadUrl += '?fileId=99321';
    expect(normalizeCivitaiModel(raw)!.versions[0].files[0].downloadUrl).toBe(file.downloadUrl);
    file.downloadUrl = 'https://civitai.com/api/download/models/135931?fileId=999';
    expect(normalizeCivitaiModel(raw)!.versions[0].files[0].downloadUrl).toBeNull();
    file.downloadUrl = 'https://civitai.com/api/download/models/135931?fileId=99321&fileId=99321';
    expect(normalizeCivitaiModel(raw)!.versions[0].files[0].downloadUrl).toBeNull();
    file.downloadUrl = 'https://civitai.com/api/download/models/999?fileId=99321';
    expect(normalizeCivitaiModel(raw)!.versions[0].files[0].downloadUrl).toBeNull();
  });
  it('preserves model/version/file identities, exact declared family and hash', () => {
    const model = normalizeCivitaiModel(rawModel())!;
    expect(model.description).toBe('Soft colors.');
    expect(model.versions.map(version => [version.id, version.name])).toEqual([[135931, 'v1.1'], [130580, 'v1.0']]);
    expect(model.versions[0]).toMatchObject({ modelId: 120096, family: 'sdxl', baseModel: 'SDXL 1.0', trainedWords: ['pixel art'], publiclyListed: true });
    expect(model.versions[0].files[0]).toMatchObject({ id: 99321, sha256: checksum.toLowerCase(), sizeKB: 123.5, estimatedBytes: 126464, safeTensor: true });
    expect(model.permissions).toEqual({ allowNoCredit: false, allowDerivatives: true, allowDifferentLicense: null, allowCommercialUse: [] });
  });
  it.each(['Pony', 'NoobAI', 'SD 1.5', 'Other', 'My SDXL mixture', 'illustrious'])('does not guess compatibility for base %s', base => { expect(civitaiFamily(base)).toBe('unknown'); });
  it('recognizes only explicit supported base labels while retaining special variants', () => {
    expect(civitaiFamily('Illustrious')).toBe('illustrious'); expect(civitaiFamily('SDXL Turbo')).toBe('sdxl');
    const raw = rawModel(); raw.modelVersions[0].baseModel = 'SDXL Lightning';
    expect(normalizeCivitaiModel(raw)!.versions[0]).toMatchObject({ baseModel: 'SDXL Lightning', family: 'sdxl' });
  });
  it('ignores unsupported resource types and mismatched version parents', () => {
    expect(normalizeCivitaiModel({ ...rawModel(), type: 'LoCon' })).toBeNull();
    const raw = rawModel(); raw.modelVersions[0].modelId = 9;
    expect(normalizeCivitaiModel(raw)!.versions.map(version => version.id)).toEqual([130580]);
  });
  it('keeps permission representations distinct from inferred license grants', () => {
    expect(normalizeCivitaiModel({ ...rawModel(), allowCommercialUse: '{Image,RentCivit,NewFlag}' })!.permissions.allowCommercialUse).toEqual(['Image', 'RentCivit', 'NewFlag']);
    expect(normalizeCivitaiModel({ ...rawModel(), allowCommercialUse: undefined })!.permissions.allowCommercialUse).toBeNull();
  });
  it('drops unsafe preview/download URLs and never authorizes paid or archived resources', () => {
    const raw = rawModel(); const version = raw.modelVersions[0];
    version.images = [{ url: 'javascript:alert(1)', nsfwLevel: 1, width: 1, height: 1 }, { url: 'https://image.civitai.com/good.jpeg', nsfwLevel: 4, width: 1, height: 1 }];
    version.files[0].downloadUrl += '?token=never-cache-this';
    Object.assign(version, { availability: 'EarlyAccess', earlyAccessEndsAt: '2030-01-01T00:00:00Z' });
    const normalized = normalizeCivitaiModel(raw)!.versions[0];
    expect(normalized.previews.map(preview => preview.url)).toEqual(['https://image.civitai.com/good.jpeg']); expect(normalized.files[0].downloadUrl).toBeNull(); expect(normalized.publiclyListed).toBe(false);
    expect(normalizeCivitaiModel({ ...raw, mode: 'Archived' })!.versions[0].files).toEqual([]);
  });
  it.each(['../model.safetensors', 'CON.safetensors', 'model.safetensors '])('rejects unsafe downloadable filename %s', filename => {
    const raw = rawModel(); raw.modelVersions[0].files[0].name = filename;
    const result = normalizeCivitaiModel(raw)!.versions[0].files[0]; expect(result.downloadUrl).toBeNull(); expect(result.safeTensor).toBe(false);
  });
  it('does not label a missing hash, pickle or mismatched format as a verified safetensors file', () => {
    const raw = rawModel(); raw.modelVersions[0].files[0].metadata.format = 'PickleTensor'; raw.modelVersions[0].files[0].hashes.SHA256 = 'short';
    expect(normalizeCivitaiModel(raw)!.versions[0].files[0]).toMatchObject({ safeTensor: false, sha256: null });
  });
});

describe('bounded Civitai reads and credentials', () => {
  it('recovers from a transient search failure with one identical retry', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 503)).mockResolvedValueOnce(json({ items: [rawModel()] }));
    const result = await client({ apiKey: 'test-key' }).search({ query: 'pixel' });
    expect(result.data.items).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toEqual(fetchMock.mock.calls[0]);
  });
  it('stops after one retry when the server stays unavailable', async () => {
    fetchMock.mockImplementation(async () => json({}, 502));
    await expect(client({ apiKey: 'test-key' }).search()).rejects.toMatchObject({ code: 'offline', status: 502 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403, 404, 429])('does not retry HTTP %s', async status => {
    fetchMock.mockImplementation(async () => json({}, status));
    await expect(client({ apiKey: 'test-key' }).search()).rejects.toMatchObject({ status });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('honors a longer Retry-After without an early retry', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 503, { 'retry-after': '30' }));
    await expect(client({ apiKey: 'test-key' }).search()).rejects.toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('cancels during the retry wait and never sends a second request', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      setTimeout(() => controller.abort(), 25);
      return json({}, 503);
    });
    await expect(client({ apiKey: 'test-key' }).search({}, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('keeps the retry wait within the original timeout', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 503));
    await expect(client({ apiKey: 'test-key', timeoutMs: 25 }).search()).rejects.toMatchObject({ code: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('uses cursor pagination and ignores arbitrary next-page URLs', async () => {
    fetchMock.mockResolvedValue(json({ items: [rawModel()], metadata: { nextCursor: '2|opaque', nextPage: 'https://evil.test/private' } }));
    const result = await client().search({ query: 'pixel art', kind: 'lora', family: 'sdxl', limit: 2 });
    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.origin).toBe('https://civitai.com'); expect(url.searchParams.get('query')).toBe('pixel art'); expect(url.searchParams.has('page')).toBe(false);
    expect(url.searchParams.get('nsfw')).toBe('true'); expect(url.searchParams.get('baseModels')).toBe('SDXL 1.0');
    expect(result.data.nextCursor).toBe('2|opaque'); expect(result.data.items).toHaveLength(1); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });
  it('rejects pagination abuse before network activity and suppresses repeated cursors', async () => {
    await expect(client().search({ limit: 21 })).rejects.toThrow(); await expect(client().search({ cursor: 'x'.repeat(513) })).rejects.toThrow();
    await expect(client().search({ query: 'x', page: 1 } as never)).rejects.toThrow(); expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(json({ items: [], metadata: { nextCursor: 'same' } }));
    expect((await client().search({ cursor: 'same' })).data.nextCursor).toBeNull();
  });
  it('accepts a server-side key only in Authorization and never serializes or caches it', async () => {
    const key = 'test-secret-not-real'; fetchMock.mockResolvedValue(json(rawModel())); const authenticated = client({ apiKey: key });
    const result = await authenticated.detail(120096);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${key}`);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain(key); expect(JSON.stringify(authenticated)).not.toContain(key); expect(JSON.stringify(result)).not.toContain(key);
    expect(await fsp.readdir(cache)).not.toContain('civitai');
    expect(() => client({ apiKey: 'bad\nheader' })).toThrow('valid Civitai API key');
  });
  it.each([[401, 'auth'], [403, 'forbidden'], [404, 'not-found'], [429, 'rate-limit'], [500, 'offline']])('reports HTTP %s without echoing server secrets', async (status, code) => {
    fetchMock.mockResolvedValue(json({ error: 'sensitive-remote-details' }, status as number, { 'retry-after': '42' }));
    await expect(client().detail(120096)).rejects.toMatchObject({ code, status });
    try { await client().detail(120096); } catch (error) { expect(String(error)).not.toContain('sensitive-remote-details'); if (status === 429) expect(error).toMatchObject({ retryAfterSeconds: 42 }); }
  });
  it('rejects mismatched detail identities and unexpected HTML/redirect responses', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...rawModel(), id: 9 })).mockResolvedValueOnce(new Response('<html>Blocked</html>', { headers: { 'content-type': 'text/html' } }));
    await expect(client().detail(120096)).rejects.toMatchObject({ code: 'response' }); await expect(client().detail(120096)).rejects.toMatchObject({ code: 'response' });
    const redirected = json(rawModel()); Object.defineProperty(redirected, 'url', { value: 'https://evil.test/data' }); fetchMock.mockResolvedValueOnce(redirected);
    await expect(client().detail(120096)).rejects.toMatchObject({ code: 'response' });
  });
  it('bounds a slow body by timeout and a large body by bytes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }));
    await expect(client({ timeoutMs: 20 }).detail(120096)).rejects.toMatchObject({ code: 'timeout' });
    fetchMock.mockResolvedValueOnce(json('x'.repeat(4 * 1024 * 1024)));
    await expect(client().detail(120096)).rejects.toMatchObject({ code: 'response' });
  });
  it('cancels before a request or during an active response without falling back to cache', async () => {
    const stopped = new AbortController(); stopped.abort(); await expect(client().search({}, stopped.signal)).rejects.toMatchObject({ code: 'cancelled' }); expect(fetchMock).not.toHaveBeenCalled();
    const controller = new AbortController(); let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
    fetchMock.mockImplementation(async () => { started(); return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'application/json' } }); });
    const pending = client().detail(120096, controller.signal); const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled' }); await ready; controller.abort(); await assertion;
  });
});

describe('private last-successful cache', () => {
  it('returns marked stale cached metadata on offline reads with its original timestamp', async () => {
    fetchMock.mockResolvedValueOnce(json(rawModel())).mockRejectedValue(new Error('network secret'));
    const first = await client().detail(120096); const second = await client().detail(120096);
    expect(second).toMatchObject({ data: first.data, fetchedAt: first.fetchedAt, fromCache: true, stale: true }); expect(second.warning).toContain('connection');
    const files = await fsp.readdir(path.join(cache, 'civitai')); expect(files).toHaveLength(1);
    expect(await fsp.readFile(path.join(cache, 'civitai', files[0]), 'utf8')).not.toContain('<script>');
  });
  it('does not reuse cache for authentication failures, another query, or after expiry', async () => {
    fetchMock.mockResolvedValueOnce(json(rawModel())).mockResolvedValueOnce(json({}, 401)).mockRejectedValue(new Error('offline'));
    await client({ now: () => 1_000_000 }).detail(120096);
    await expect(client({ now: () => 1_000_001 }).detail(120096)).rejects.toMatchObject({ code: 'auth' });
    await expect(client({ now: () => 1_000_000 + 31 * 86400_000 }).detail(120096)).rejects.toMatchObject({ code: 'offline' });
    await expect(client().detail(999)).rejects.toMatchObject({ code: 'offline' });
  });
  it('rejects corrupted or unsafe cache content without returning it to the renderer', async () => {
    fetchMock.mockResolvedValueOnce(json(rawModel())).mockRejectedValue(new Error('offline')); await client().detail(120096);
    const folder = path.join(cache, 'civitai'); const [name] = await fsp.readdir(folder); const filename = path.join(folder, name);
    const saved = JSON.parse(await fsp.readFile(filename, 'utf8')); saved.data.versions[0].previews[0].url = 'javascript:alert(1)'; await fsp.writeFile(filename, JSON.stringify(saved));
    await expect(client().detail(120096)).rejects.toMatchObject({ code: 'offline' });
  });
});

it('keeps creator dependency lists and headings separate in plain-text notes', () => {
  const raw = rawModel(); raw.description = '<h3>Required assets</h3><ul><li>Use <b>SDXL</b> Base.</li><li>Install the recommended VAE.</li></ul><div>Read version notes.</div>';
  Object.assign(raw.modelVersions[0], { description: '<div>Steps: 28</div><div>CFG: 5</div><script>ignore()</script>' });
  const model = normalizeCivitaiModel(raw)!;
  expect(model.description).toBe('Required assets\nUse SDXL Base.\nInstall the recommended VAE.\nRead version notes.');
  expect(model.versions[0].description).toBe('Steps: 28\nCFG: 5');
});

it('supports explicitly restricting model listings to SFW without conflating that with preview rules', async () => {
  fetchMock.mockResolvedValue(json({ items: [rawModel()], metadata: {} }));
  await client().search({ includeMature: false });
  expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('nsfw')).toBe('false');
});

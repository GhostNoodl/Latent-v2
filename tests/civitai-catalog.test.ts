import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CivitaiCatalog, type CivitaiCredentialCrypto } from '../src/main/civitai-catalog';
import { ModelService } from '../src/main/models';
import { ModelTransferCancelledError } from '../src/main/model-transfers';
import { createPaths, inside } from '../src/main/paths';
import type { AppPaths } from '../src/shared/types';
import type { StudioStore } from '../src/main/store';

const header = Buffer.from(JSON.stringify({ __metadata__: { 'modelspec.architecture': 'stable-diffusion-xl-v1-base' }, tensor: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }));
const length = Buffer.alloc(8); length.writeBigUInt64LE(BigInt(header.length));
const payload = Buffer.concat([length, header, Buffer.alloc(4)]);
const sha256 = createHash('sha256').update(payload).digest('hex');
const selected = { modelId: 1, versionId: 11, fileId: 111 };
function rawModel() { return { id: 1, name: 'A style', type: 'LORA', availability: 'Public', allowNoCredit: false, allowCommercialUse: ['Image'], allowDerivatives: true, allowDifferentLicense: false, modelVersions: [{ id: 11, modelId: 1, name: 'Version one', availability: 'Public', status: 'Published', baseModel: 'SDXL 1.0', baseModelType: 'Standard', trainedWords: ['pixel art'], files: [{ id: 111, name: 'pixel.safetensors', type: 'Model', sizeKB: payload.length / 1024, metadata: { format: 'SafeTensor' }, hashes: { SHA256: sha256 }, downloadUrl: 'https://civitai.com/api/download/models/11' }] }] }; }
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
function weights() { const result = new Response(new Uint8Array(payload), { headers: { 'content-length': String(payload.length), etag: '"one"' } }); Object.defineProperty(result, 'url', { value: 'https://civitai.com/api/download/models/11' }); return result; }
let sandbox: string; let paths: AppPaths; let state: Map<string, unknown>; let metadata: Map<string, object>; let store: StudioStore; let models: ModelService; let fetchMock: ReturnType<typeof vi.fn>;
const encryptionKey = randomBytes(32);
const secureCrypto: CivitaiCredentialCrypto = {
  isEncryptionAvailable: () => true,
  encryptString(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), encrypted]); },
  decryptString(value) { const decipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8'); },
};
beforeEach(async () => {
  sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), 'latent-civitai-catalog-test-')); paths = createPaths(path.join(sandbox, 'studio'));
  state = new Map(); metadata = new Map();
  store = { getState: (key: string, fallback: unknown) => state.get(key) ?? fallback, setState: (key: string, value: unknown) => { state.set(key, structuredClone(value)); }, modelMetadata: (id: string) => metadata.get(id), saveModelMetadata: (id: string, value: object) => { metadata.set(id, structuredClone(value)); } } as unknown as StudioStore;
  models = new ModelService(paths, store, () => {}); fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  models.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); const resolved = path.resolve(sandbox);
  if (!inside(os.tmpdir(), resolved) || !path.basename(resolved).startsWith('latent-civitai-catalog-test-')) throw new Error('Unsafe test cleanup');
  await fsp.rm(resolved, { recursive: true, force: true });
});
const catalog = (crypto: CivitaiCredentialCrypto | undefined = secureCrypto) => new CivitaiCatalog(paths, store, models, () => {}, crypto);

describe('Civitai catalog credentials', () => {
  it('encrypts stored keys, returns only presence and uses the key solely in headers', async () => {
    const service = catalog(); service.setApiKey('synthetic-secret');
    const serialized = JSON.stringify([...state.values()]); expect(serialized).not.toContain('synthetic-secret');
    expect(service.settings()).toEqual({ hasApiKey: true }); expect(JSON.stringify(service)).not.toContain('synthetic-secret');
    fetchMock.mockResolvedValue(json(rawModel())); await service.detail(1);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic-secret');
    expect(await fsp.readdir(paths.cache)).not.toContain('civitai');
    service.setApiKey(null); expect(service.settings()).toEqual({ hasApiKey: false });
  });
  it('never falls back to plaintext when encryption is unavailable or fails', () => {
    expect(() => catalog({ ...secureCrypto, isEncryptionAvailable: () => false }).setApiKey('synthetic-secret')).toThrow('Secure credential storage');
    expect(() => catalog({ ...secureCrypto, getSelectedStorageBackend: () => 'basic_text' }).setApiKey('synthetic-secret')).toThrow('Secure credential storage');
    expect(() => catalog({ ...secureCrypto, encryptString: () => { throw new Error('sensitive failure'); } }).setApiKey('synthetic-secret')).toThrow('was not saved');
    expect(state.size).toBe(0);
  });
  it('rejects malformed keys and reports undecryptable stored credentials without exposing them', async () => {
    expect(() => catalog().setApiKey('bad\nheader')).toThrow('valid Civitai API key');
    catalog().setApiKey('synthetic-secret');
    await expect(catalog({ ...secureCrypto, decryptString: () => { throw new Error('synthetic-secret'); } }).detail(1)).rejects.toThrow('could not be unlocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('exact compatible Civitai acquisition', () => {
  it('retries a durable transfer using fresh exact detail and the currently protected key', async () => {
    const service = catalog(); service.setApiKey('first-synthetic-key');
    fetchMock.mockResolvedValueOnce(json(rawModel())).mockRejectedValueOnce(new Error('Download interrupted'));
    await expect(service.download(selected)).rejects.toThrow('interrupted'); const id = models.downloads[0].id;
    service.setApiKey('current-synthetic-key'); fetchMock.mockClear(); fetchMock.mockResolvedValueOnce(json(rawModel())).mockResolvedValueOnce(weights());
    await service.retryTransfer(id);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://civitai.com/api/v1/models/1', 'https://civitai.com/api/download/models/11']);
    expect(fetchMock.mock.calls.map(call => call[1].headers.Authorization)).toEqual(['Bearer current-synthetic-key', 'Bearer current-synthetic-key']);
    expect(models.downloads).toHaveLength(1); expect(models.downloads[0]).toMatchObject({ id, state: 'completed' }); expect(models.transferRecovery().transfers[0].attempt).toBe(2);
    const journal = await fsp.readFile(path.join(paths.cache, 'model-transfers', `${id}.json`), 'utf8'); expect(journal).not.toContain('synthetic-key'); expect(JSON.stringify([...metadata.values()])).not.toContain('synthetic-key');
  });
  it('cancels only the retry operation while its fresh metadata is still loading', async () => {
    const service = catalog(); fetchMock.mockResolvedValueOnce(json(rawModel())).mockRejectedValueOnce(new Error('Download interrupted'));
    await expect(service.download(selected)).rejects.toThrow(); const id = models.downloads[0].id;
    fetchMock.mockClear(); fetchMock.mockImplementation((_url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })));
    const controller = new AbortController(); const pending = service.retryTransfer(id, controller.signal); const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1)); controller.abort(); await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(models.transferRecovery().transfers[0].attempt).toBe(1); expect(models.assets).toEqual([]);
  });
  it('re-fetches detail then downloads and persists precise version/file provenance', async () => {
    fetchMock.mockResolvedValueOnce(json(rawModel())).mockResolvedValueOnce(weights());
    const installed = await catalog().download(selected);
    expect(installed).toMatchObject({ filename: 'civitai_1_11_111_pixel.safetensors', family: 'sdxl', sha256, triggers: ['pixel art'], civitai: { ...selected, versionName: 'Version one', baseModel: 'SDXL 1.0', permissions: { allowNoCredit: false, allowCommercialUse: ['Image'] } } });
    expect(await fsp.readFile(path.join(paths.models, 'loras', installed.filename))).toEqual(payload);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(['https://civitai.com/api/v1/models/1', 'https://civitai.com/api/download/models/11']);
    expect(fetchMock.mock.calls.every(call => !call[1].headers.Authorization)).toBe(true);
  });
  it('reuses an identical publisher file by hash without duplicating bytes or changing existing overrides', async () => {
    const existingPath = path.join(paths.models, 'loras', 'author-file.safetensors'); await fsp.writeFile(existingPath, payload); await models.refresh();
    const existing = models.assets[0]; store.saveModelMetadata(existing.id, { ...metadata.get(existing.id), sourceUrl: 'https://huggingface.co/author/model', triggers: ['my custom prefix'] });
    fetchMock.mockResolvedValue(json(rawModel())); const result = await catalog().download(selected);
    expect(result).toMatchObject({ id: existing.id, sourceUrl: 'https://huggingface.co/author/model', triggers: ['my custom prefix'], civitai: selected });
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(await fsp.readdir(path.join(paths.models, 'loras'))).toEqual(['author-file.safetensors']);
  });
  it('supports protected public downloads without persisting authentication metadata', async () => {
    const service = catalog(); service.setApiKey('synthetic-secret');
    fetchMock.mockResolvedValueOnce(json(rawModel())).mockResolvedValueOnce(weights()); await service.download(selected);
    expect(fetchMock.mock.calls.map(call => call[1].headers.Authorization)).toEqual(['Bearer synthetic-secret', 'Bearer synthetic-secret']);
    expect(JSON.stringify([...metadata.values()])).not.toContain('synthetic-secret'); expect(JSON.stringify(models.downloads)).not.toContain('synthetic-secret');
  });
  it.each(['SDXL Turbo', 'SDXL 1.0 LCM', 'SDXL Lightning', 'SDXL Hyper', 'Pony', 'NoobAI'])('blocks incompatible current workflow %s', async base => {
    const raw = rawModel(); raw.modelVersions[0].baseModel = base; fetchMock.mockResolvedValue(json(raw));
    await expect(catalog().download(selected)).rejects.toThrow(/workflow|unsupported/); expect(fetchMock).toHaveBeenCalledTimes(1); expect(models.assets).toEqual([]);
  });
  it('rejects checkpoint subtype uncertainty, early access and changed IDs before downloading', async () => {
    const service = catalog(); const checkpoint = rawModel(); checkpoint.type = 'Checkpoint'; checkpoint.modelVersions[0].baseModelType = 'Inpainting';
    fetchMock.mockResolvedValueOnce(json(checkpoint)); await expect(service.download(selected)).rejects.toThrow('Standard');
    const restricted = rawModel(); restricted.modelVersions[0].availability = 'EarlyAccess'; fetchMock.mockResolvedValueOnce(json(restricted));
    await expect(service.download(selected)).rejects.toThrow('does not buy');
    fetchMock.mockResolvedValueOnce(json(rawModel())); await expect(service.download({ ...selected, fileId: 999 })).rejects.toThrow('safetensors');
    fetchMock.mockResolvedValueOnce(json(rawModel())); await expect(service.download({ ...selected, versionId: 999 })).rejects.toThrow('exact Civitai version');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it('refuses stale cached acquisition metadata and arbitrary request fields', async () => {
    const service = catalog(); fetchMock.mockResolvedValueOnce(json(rawModel())).mockRejectedValue(new Error('offline')); await service.detail(1);
    await expect(service.download(selected)).rejects.toThrow('current Civitai response');
    await expect(service.download({ ...selected, url: 'https://evil.test/model' } as never)).rejects.toThrow(); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('cancels an active model body while preserving its resumable staging state', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const response = new Response(body, { headers: { 'content-length': String(payload.length), etag: '"one"' } }); Object.defineProperty(response, 'url', { value: 'https://civitai.com/api/download/models/11' });
    fetchMock.mockResolvedValueOnce(json(rawModel())).mockResolvedValueOnce(response);
    const service = catalog(); const pending = service.download(selected); const rejected = expect(pending).rejects.toThrow(ModelTransferCancelledError);
    await vi.waitFor(() => expect(models.downloads).toHaveLength(1));
    await vi.waitFor(() => expect(fs.existsSync(path.join(paths.models, 'loras', 'civitai_1_11_111_pixel.safetensors.part.json'))).toBe(true));
    controller.enqueue(new Uint8Array(payload.subarray(0, 24))); await vi.waitFor(() => expect(models.downloads[0].receivedBytes).toBe(24));
    service.cancel(); await rejected;
    expect(models.downloads[0].state).toBe('cancelled'); expect(models.assets).toEqual([]);
    expect(await fsp.readFile(path.join(paths.models, 'loras', 'civitai_1_11_111_pixel.safetensors.part'))).toEqual(payload.subarray(0, 24));
  });
});

describe('local metadata lookup', () => {
  it('matches the exact hash while preserving local family and trigger edits', async () => {
    await models.refresh(); const target=path.join(paths.models,'loras','local.safetensors'); await fsp.writeFile(target,payload); await models.refresh();
    const local=models.assets.find(item=>item.filename==='local.safetensors')!;
    await models.update(local.id,{family:'illustrious',triggers:['my trigger']});
    fetchMock.mockResolvedValueOnce(json({id:11,modelId:1})).mockResolvedValueOnce(json(rawModel()));
    await catalog().fetchLocalMetadata(local.id);
    const result=models.assets.find(item=>item.id===local.id)!;
    expect(result).toMatchObject({family:'illustrious',triggers:['my trigger'],civitai:{modelId:1,versionId:11,fileId:111,trainedWords:['pixel art']}});
    expect(fetchMock.mock.calls[0][0]).toContain('/model-versions/by-hash/'+sha256);
  });
});

describe('automatic local metadata', () => {
  it('honors opt-in, fetches once, and does not overwrite a mismatched file', async () => {
    let enabled=false;Object.assign(store,{settings:()=>({civitaiAutoMetadata:enabled})});
    await models.refresh();await fsp.writeFile(path.join(paths.models,'loras','auto.safetensors'),payload);await models.refresh();
    const local=models.assets.find(item=>item.filename==='auto.safetensors')!;const service=catalog();
    await service.autoMetadata();expect(fetchMock).not.toHaveBeenCalled();
    enabled=true;fetchMock.mockResolvedValueOnce(json({id:11,modelId:1})).mockResolvedValueOnce(json(rawModel()));
    await service.autoMetadata();await service.autoMetadata();expect(fetchMock).toHaveBeenCalledTimes(2);
    const before=structuredClone(metadata.get(local.id));const wrong=rawModel();wrong.modelVersions[0].files[0].hashes.SHA256='0'.repeat(64);
    fetchMock.mockResolvedValueOnce(json({id:11,modelId:1})).mockResolvedValueOnce(json(wrong));
    await expect(service.fetchLocalMetadata(local.id)).rejects.toThrow('matching file');expect(metadata.get(local.id)).toEqual(before);
  });
});

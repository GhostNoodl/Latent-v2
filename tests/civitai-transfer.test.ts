import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveCivitaiTransfer } from '../src/main/civitai-transfer';
import { prepareModelTransfer } from '../src/main/model-transfers';
import type { ModelDownloadRequest } from '../src/shared/types';
import type { ModelTransferRecord } from '../src/shared/model-transfer-types';
import type { CivitaiReadResult, CivitaiModel } from '../src/shared/civitai-types';

const request: ModelDownloadRequest = { url: 'https://civitai.com/api/download/models/11', filename: 'civitai_1_11_111_model.safetensors', kind: 'checkpoint', family: 'sdxl', sha256: 'a'.repeat(64), civitai: { modelId: 1, versionId: 11, fileId: 111, modelName: 'Model', versionName: 'One', baseModel: 'SDXL 1.0', sourceUrl: 'https://civitai.com/models/1?modelVersionId=11', permissions: { allowNoCredit: false, allowDerivatives: true, allowDifferentLicense: false, allowCommercialUse: ['Image'] } } };
const now = new Date().toISOString();
const saved: ModelTransferRecord = { version: 1, id: randomUUID(), ...prepareModelTransfer(request, true), createdAt: now, updatedAt: now, attempt: 1, state: 'failed', receivedBytes: 10, totalBytes: 100 };
function result(): CivitaiReadResult<CivitaiModel> {
  return { fromCache: false, stale: false, fetchedAt: now, data: { id: 1, name: 'Model', kind: 'checkpoint', description: '', creator: 'author', sourceUrl: 'https://civitai.com/models/1', tags: [], mode: null, availability: 'Public', permissions: request.civitai!.permissions, versions: [{ id: 11, modelId: 1, name: 'One', baseModel: 'SDXL 1.0', baseModelType: 'Standard', family: 'sdxl', trainedWords: ['fresh trigger'], sourceUrl: request.civitai!.sourceUrl, description: '', earlyAccessEndsAt: null, publiclyListed: true, availability: 'Public', status: 'Published', previews: [], files: [{ id: 111, name: 'renamed-model.safetensors', type: 'Model', format: 'SafeTensor', fp: 'fp16', sizeKB: 1, estimatedBytes: 1024, sha256: request.sha256!, downloadUrl: request.url, primary: true, safeTensor: true }] }] } };
}
describe('fresh Civitai transfer resolution', () => {
  it('re-fetches the exact saved selection, preserves destination, and returns fresh metadata without credentials', async () => {
    const detail = vi.fn().mockResolvedValue(result()); const next = await resolveCivitaiTransfer({ detail }, saved);
    expect(detail).toHaveBeenCalledWith(1, undefined); expect(next).toMatchObject({ filename: request.filename, sha256: request.sha256, family: request.family, triggers: ['fresh trigger'], civitai: { modelId: 1, versionId: 11, fileId: 111 } }); expect(JSON.stringify(next)).not.toContain('Authorization');
  });
  it.each(['stale', 'fromCache'] as const)('refuses %s detail for acquisition', async flag => { const value = result(); value[flag] = true; await expect(resolveCivitaiTransfer({ detail: vi.fn().mockResolvedValue(value) }, saved)).rejects.toThrow('current Civitai'); });
  it.each(['restricted', 'family', 'hash', 'file', 'workflow'] as const)('refuses a refreshed %s change', async change => {
    const value = result(); const version = value.data.versions[0];
    if (change === 'restricted') version.publiclyListed = false;
    if (change === 'family') { version.family = 'illustrious'; version.baseModel = 'Illustrious'; }
    if (change === 'hash') version.files[0].sha256 = 'b'.repeat(64);
    if (change === 'file') version.files[0].id = 112;
    if (change === 'workflow') version.baseModelType = 'Inpainting';
    await expect(resolveCivitaiTransfer({ detail: vi.fn().mockResolvedValue(value) }, saved)).rejects.toThrow();
  });
  it('does not fetch without a complete saved identity or after cancellation', async () => {
    const detail = vi.fn(); await expect(resolveCivitaiTransfer({ detail }, { ...saved, request: { ...saved.request, civitai: undefined } })).rejects.toThrow('identity');
    const controller = new AbortController(); controller.abort(); await expect(resolveCivitaiTransfer({ detail }, saved, controller.signal)).rejects.toThrow(); expect(detail).not.toHaveBeenCalled();
  });
});

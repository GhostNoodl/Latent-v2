import { z } from 'zod';
import type { AppPaths, CivitaiProvenance, ModelAsset } from '../shared/types';
import type { CivitaiModel, CivitaiSearchRequest, CivitaiVersion } from '../shared/civitai-types';
import { CivitaiClient } from './civitai';
import type { ModelService } from './models';
import type { StudioStore } from './store';
import { resolveCivitaiTransfer } from './civitai-transfer';

export interface CivitaiCredentialCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
const selectionSchema = z.object({ modelId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), versionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), fileId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const storedSchema = z.object({ version: z.literal(1), ciphertext: z.string().min(4).max(32_768).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).strict();
const KEY_STATE = 'civitai.encrypted-api-key.v1';

export function civitaiWorkflowIssue(model: CivitaiModel, version: CivitaiVersion): string | null {
  if (version.family === 'unknown') return 'This version has an unknown or unsupported base family.';
  if (!['SDXL 1.0', 'Illustrious'].includes(version.baseModel)) return `${version.baseModel} requires a different generation workflow. It is not enabled in Create yet.`;
  if (model.kind === 'checkpoint' && version.baseModelType !== 'Standard') return 'Only checkpoints explicitly marked Standard can be downloaded into the current Create workflow.';
  if (model.kind === 'lora' && version.baseModelType && version.baseModelType !== 'Standard') return 'This LoRA targets a different checkpoint workflow.';
  return null;
}

export class CivitaiCatalog {
  private metadataPending = new Map<string, Promise<void>>();
  private autoPending = false;
  private cancelEpoch = 0;
  private operations = new Set<AbortController>();
  constructor(private paths: AppPaths, private store: StudioStore, private models: ModelService, private changed: () => void, private credentialCrypto?: CivitaiCredentialCrypto) {}
  settings(): { hasApiKey: boolean } {
    return { hasApiKey: storedSchema.safeParse(this.store.getState(KEY_STATE, null)).success };
  }
  setApiKey(value: string | null): void {
    this.cancel();
    if (value === null) { this.store.setState(KEY_STATE, null); this.changed(); return; }
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('Enter a valid Civitai API key without spaces or line breaks.');
    const crypto = this.secureCrypto();
    let ciphertext: string;
    try { ciphertext = crypto.encryptString(value).toString('base64'); }
    catch { throw new Error('Windows secure credential storage could not protect this key. It was not saved.'); }
    const stored = storedSchema.parse({ version: 1, ciphertext });
    this.store.setState(KEY_STATE, stored); this.changed();
  }
  private secureCrypto(): CivitaiCredentialCrypto {
    const crypto = this.credentialCrypto;
    if (!crypto?.isEncryptionAvailable() || crypto.getSelectedStorageBackend?.() === 'basic_text') throw new Error('Secure credential storage is unavailable. Continue anonymously or retry when Windows credential protection is available.');
    return crypto;
  }
  private key(): string | undefined {
    const stored = this.store.getState(KEY_STATE, null); if (stored === null) return undefined;
    const parsed = storedSchema.safeParse(stored);
    if (!parsed.success) throw new Error('The saved Civitai key is invalid. Remove or replace it in Civitai settings.');
    try {
      const value = this.secureCrypto().decryptString(Buffer.from(parsed.data.ciphertext, 'base64'));
      if (!value || value.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid decrypted key');
      return value;
    } catch { throw new Error('The saved Civitai key could not be unlocked. Remove or replace it in Civitai settings.'); }
  }
  private async operation<T>(callback: (client: CivitaiClient, signal: AbortSignal, apiKey?: string) => Promise<T>, externalSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController(); this.operations.add(controller);
    const abort = () => controller.abort(); externalSignal?.addEventListener('abort', abort, { once: true });
    try { externalSignal?.throwIfAborted(); const apiKey = this.key(); return await callback(new CivitaiClient(this.paths, { apiKey }), controller.signal, apiKey); }
    finally { externalSignal?.removeEventListener('abort', abort); this.operations.delete(controller); this.changed(); }
  }
  async fetchLocalMetadata(modelId: string): Promise<void> {
    if (typeof modelId !== 'string' || modelId.length > 1000) throw new Error('Choose a local model.');
    const pending = this.metadataPending.get(modelId); if (pending) return pending;
    const work = this.operation(async (client, signal) => {
      const local = this.models.assets.find(item => item.id === modelId && item.status === 'ready');
      if (!local?.sha256) throw new Error('Refresh the library to identify this local file first.');
      const hash = local.sha256;
      const match = await client.versionByHash(hash, signal);
      if (match.stale) throw new Error('Reconnect to Civitai before updating metadata.');
      const response = await client.detail(match.data.modelId, signal);
      if (response.stale) throw new Error('Reconnect to Civitai before updating metadata.');
      const model = response.data, version = model.versions.find(item => item.id === match.data.id);
      const file = version?.files.find(item => item.sha256 === hash);
      if (!version || !file || model.kind !== local.kind) throw new Error('Civitai did not return a matching file. Existing metadata was preserved.');
      signal.throwIfAborted();
      const current = this.models.assets.find(item => item.id === modelId && item.status === 'ready' && item.sha256 === hash);
      const metadata = this.store.modelMetadata<Record<string, unknown>>(modelId);
      if (!current || !metadata || metadata.sha256 !== hash) throw new Error('The local model changed during lookup. Refresh and try again.');
      const civitai: CivitaiProvenance = { modelId:model.id,versionId:version.id,fileId:file.id,modelName:model.name,versionName:version.name,baseModel:version.baseModel,sourceUrl:version.sourceUrl,permissions:model.permissions,creator:model.creator,description:version.description || model.description,trainedWords:version.trainedWords,previewUrl:version.previews[0]?.url,fetchedAt:new Date().toISOString() };
      // Creator data is separate from the user's family and trigger edits.
      this.store.saveModelMetadata(modelId, {...metadata,civitai});
      await this.models.refresh(true);
    });
    this.metadataPending.set(modelId,work);try { await work; } finally { this.metadataPending.delete(modelId); }
  }
  async autoMetadata(): Promise<void> {
    if (this.autoPending || !this.store.settings().civitaiAutoMetadata) return;
    this.autoPending = true; const epoch = this.cancelEpoch;
    try {
      for (const asset of [...this.models.assets]) {
        if (epoch !== this.cancelEpoch || !this.store.settings().civitaiAutoMetadata) break;
        if (asset.status !== 'ready' || !asset.sha256) continue;
        const key = `civitai.metadata-attempt:${asset.sha256}`;
        if (asset.civitai?.fetchedAt || Date.now() - this.store.getState<number>(key,0) < 24*60*60*1000) continue;
        this.store.setState(key,Date.now());
        try { await this.fetchLocalMetadata(asset.id); } catch { /* Manual lookup exposes errors; automatic retries are bounded to once a day. */ }
        await new Promise(resolve => setTimeout(resolve,300));
      }
    } catch { /* Automatic metadata is optional and must not interrupt the studio. */ } finally { this.autoPending = false; }
  }
  search(request: CivitaiSearchRequest = {}) { return this.operation((client, signal) => client.search(request, signal)); }
  detail(modelId: number) { return this.operation((client, signal) => client.detail(modelId, signal)); }
  cancel(): void { this.cancelEpoch++; for (const controller of this.operations) controller.abort(); }
  retryTransfer(id: string, signal?: AbortSignal): Promise<void> {
    return this.operation((client, operationSignal, apiKey) => this.models.retryTransfer(id, async saved => ({
      request: await resolveCivitaiTransfer(client, saved, operationSignal),
      options: { signal: operationSignal, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined },
    }), operationSignal), signal);
  }
  async download(input: { modelId: number; versionId: number; fileId: number }): Promise<ModelAsset> {
    const selected = selectionSchema.parse(input);
    return this.operation(async (client, signal, apiKey) => {
      // Never acquire from old discovery data or a stale offline detail result.
      const response = await client.detail(selected.modelId, signal);
      if (response.stale || response.fromCache) throw new Error('A current Civitai response is required before downloading. Reconnect and retry.');
      const model = response.data; const version = model.versions.find(version => version.id === selected.versionId);
      if (!version) throw new Error('That exact Civitai version is no longer available. Refresh the model details.');
      const issue = civitaiWorkflowIssue(model, version); if (issue) throw new Error(issue);
      if (!version.publiclyListed || model.mode || (model.availability && model.availability !== 'Public')) throw new Error('This version is restricted or in early access. Latent does not buy or unlock model access.');
      const file = version.files.find(file => file.id === selected.fileId);
      if (!file || !file.safeTensor || !file.sha256 || !file.downloadUrl || !['Model', 'Pruned Model'].includes(file.type) || !file.estimatedBytes) throw new Error('Choose a public safetensors model file with a full SHA-256 and size.');
      const provenance: CivitaiProvenance = { ...selected, modelName: model.name, versionName: version.name, baseModel: version.baseModel, sourceUrl: version.sourceUrl, permissions: structuredClone(model.permissions) };
      signal.throwIfAborted(); await this.models.refresh(); signal.throwIfAborted();
      const existing = this.models.assets.find(asset => asset.kind === model.kind && asset.status === 'ready' && asset.sha256 === file.sha256);
      if (existing) {
        const metadata = this.store.modelMetadata<object>(existing.id);
        if (!metadata) throw new Error('The installed file metadata changed. Refresh the library and retry.');
        this.store.saveModelMetadata(existing.id, { ...metadata, civitai: provenance });
        await this.models.refresh(); return this.models.assets.find(asset => asset.id === existing.id)!;
      }
      const prefix = `civitai_${model.id}_${version.id}_${file.id}_`;
      const stem = file.name.replace(/\.safetensors$/i, '').replace(/[^\w .()-]+/g, '_').replace(/[. ]+$/g, '').slice(0, 180 - prefix.length - '.safetensors'.length) || 'model';
      const filename = `${prefix}${stem}.safetensors`;
      await this.models.download({ url: file.downloadUrl, filename, kind: model.kind, family: version.family as 'sdxl' | 'illustrious', sha256: file.sha256, triggers: version.trainedWords, sourceUrl: version.sourceUrl, civitai: provenance }, { signal, headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined });
      const installed = this.models.assets.find(asset => asset.kind === model.kind && asset.filename === filename && asset.sha256 === file.sha256);
      if (!installed) throw new Error('The downloaded file did not appear in the verified model library. Refresh and retry.');
      return installed;
    });
  }
}

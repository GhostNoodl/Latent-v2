import type { ModelDownloadRequest } from '../shared/types';
import type { ModelTransferRecord } from '../shared/model-transfer-types';
import type { CivitaiClient } from './civitai';
import { civitaiWorkflowIssue } from './civitai-catalog';
import { validateModelTransferRetry } from './model-transfers';

/** Called from CivitaiCatalog.operation so current credentials remain in main. */
export async function resolveCivitaiTransfer(client: Pick<CivitaiClient, 'detail'>, saved: Readonly<ModelTransferRecord>, signal?: AbortSignal): Promise<ModelDownloadRequest> {
  const selection = saved.request.civitai;
  if (saved.source.kind !== 'civitai' || !selection || !saved.request.sha256) throw new Error('This saved transfer has no complete Civitai version/file identity. Re-select its exact file in the catalog.');
  signal?.throwIfAborted(); const response = await client.detail(selection.modelId, signal); signal?.throwIfAborted();
  if (response.stale || response.fromCache) throw new Error('A current Civitai response is required before retrying. Reconnect and refresh this model.');
  const model = response.data; const version = model.versions.find(item => item.id === selection.versionId);
  if (model.id !== selection.modelId || !version) throw new Error('The saved Civitai model or version is no longer available.');
  const issue = civitaiWorkflowIssue(model, version); if (issue) throw new Error(issue);
  if (!version.publiclyListed || model.mode || model.availability && model.availability !== 'Public') throw new Error('This version is restricted or in early access. Latent does not buy or unlock model access.');
  const file = version.files.find(item => item.id === selection.fileId);
  if (!file || !file.safeTensor || !file.sha256 || !file.downloadUrl || !['Model', 'Pruned Model'].includes(file.type) || !file.estimatedBytes) throw new Error('The saved Civitai file is no longer a public safetensors model with a full checksum and size.');
  const next: ModelDownloadRequest = {
    ...saved.request, url: file.downloadUrl, kind: model.kind, family: version.family as 'sdxl' | 'illustrious', sha256: file.sha256, triggers: version.trainedWords, sourceUrl: version.sourceUrl,
    civitai: { modelId: model.id, versionId: version.id, fileId: file.id, modelName: model.name, versionName: version.name, baseModel: version.baseModel, sourceUrl: version.sourceUrl, permissions: structuredClone(model.permissions) },
  };
  return validateModelTransferRetry(saved, next);
}

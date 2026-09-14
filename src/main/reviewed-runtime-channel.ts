import { RUNTIME_RELEASE } from './runtime-config';
import { IPADAPTER_RELEASE } from '../shared/ipadapter-release';
import type { ReviewedRuntimeSet } from '../shared/runtime-update-types';
import { RUNTIME_ORIGIN_033_PACKAGES } from './runtime-origin-033-packages';
import { REVIEWED_RUNTIME_PACKAGES } from './runtime-update-packages';

/** Closed channel: new entries are reviewed application source changes, never remote executable manifests. */
const CURRENT_RUNTIME_SET: ReviewedRuntimeSet = {
  id: 'comfy-0-34-0-cu130-workflows-1', sequence: 1, label: 'ComfyUI 0.34.0 · Latent workflow set 1', releasedAt: '2026-09-05T00:00:00.000Z', channel: 'reviewed',
  backend: { version: RUNTIME_RELEASE.comfyVersion, commit: RUNTIME_RELEASE.comfyCommit, archiveSha256: RUNTIME_RELEASE.comfyArchiveSha256, archiveBytes: 12698942, archiveUrl: `https://codeload.github.com/Comfy-Org/ComfyUI/zip/${RUNTIME_RELEASE.comfyCommit}` },
  pythonVersion: RUNTIME_RELEASE.pythonVersion, packages: REVIEWED_RUNTIME_PACKAGES,
  optionalPackageSets: [[{ name: 'sageattention', version: '2.2.0+cu130torch2.10.0andhigher.post6' }, { name: 'triton-windows', version: '3.6.0.post26' }]],
  // Measured environments are below 4 GiB: three copies plus 1 GiB workspace.
  // This is a conservative admission budget, not an exact download-size claim.
  environmentPreparationBytes: 13 * 1024 ** 3,
  workflowContract: 'latent-image-workflows-1', workflowVersions: ['sdxl-txt2img@1', 'sdxl-img2img@1', 'sdxl-inpaint@1', 'sdxl-crop-inpaint@1', 'image-resize@1', 'image-realesrgan-anime-6b@1', 'sdxl-hires-latent@1', 'sdxl-hires-latent@2', 'sdxl-hires-image@1', 'sdxl-canny-controlnet@1', 'sdxl-prepared-controlnet@1', 'sdxl-regional-conditioning@1', 'sdxl-ipadapter-reference@1', 'sdxl-face-refinement@1', 'qwen-image-edit-2511-int8@1', 'qwen-image-edit-2511-int8@2'],
  mandatoryNodes: ['CheckpointLoaderSimple', 'CLIPTextEncode', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'LoadImage', 'ImageScale', 'VAEEncode', 'VAEEncodeForInpaint', 'ImageCompositeMasked', 'LoadImageMask', 'ControlNetLoader', 'Canny', 'ControlNetApplyAdvanced', 'SetUnionControlNetType', 'CLIPVisionLoader', 'UNETLoader', 'CLIPLoader', 'TextEncodeQwenImageEditPlus', 'FluxKontextMultiReferenceLatentMethod', 'CFGNorm', 'ModelSamplingAuraFlow', 'VAELoader', 'LoraLoader', 'LoraLoaderModelOnly', 'UpscaleModelLoader', 'ImageUpscaleWithModel', 'LatentUpscale', 'GetImageSize', 'LatentFromBatch', 'MaskToImage', 'ImageToMask', 'RepeatLatentBatch', 'RepeatImageBatch', 'ImageCrop', 'CropMask', 'SetLatentNoiseMask', 'JoinImageWithAlpha', 'SplitImageWithAlpha', 'ConditioningSetMask', 'ConditioningCombine'],
  optionalCustomNodes: [{ directory: 'latent_video_attention', repository: 'Latentv2/resources/latent-video-attention.py', revision: 'sha256:dee9d47101b2b4e42af636cda8ce2df2c091753ae82796c38fe336e7948241f8', license: 'Project source', files: [{ filename: '__init__.py', bytes: 936, sha256: 'dee9d47101b2b4e42af636cda8ce2df2c091753ae82796c38fe336e7948241f8' }] }, { directory: IPADAPTER_RELEASE.customNodeDirectory, repository: IPADAPTER_RELEASE.codeRepository, revision: IPADAPTER_RELEASE.codeRevision, license: IPADAPTER_RELEASE.codeLicense, files: IPADAPTER_RELEASE.codeFiles.map(({ filename, bytes, sha256 }) => ({ filename, bytes, sha256 })) }],
  compatibility: 'reviewed-pinned-environment', notes: 'The pinned target environment. Dependency changes are prepared separately before idle activation; a same-version refresh reuses its matching environment. Advanced configurations retain their separate verification status.',
};
/** Legacy recognition does not change the fresh-install or latest-update target. */
export const REVIEWED_RUNTIME_CHANNEL: readonly ReviewedRuntimeSet[] = [{
  ...CURRENT_RUNTIME_SET,
  id: 'candidate-comfy-0-33-0-origin', sequence: 0, label: 'ComfyUI 0.33.0 · legacy upgrade origin',
  releasedAt: '2026-09-07T00:00:00.000Z',
  backend: { version: '0.33.0', commit: '2f35f4a08176d993cded35dac3332be4f7287f41', archiveSha256: '778ac40b10a194dcfc0da3b7e7616aaa5b9149b82eb41703c4456471d2ab7367', archiveBytes: 12382656, archiveUrl: 'https://codeload.github.com/Comfy-Org/ComfyUI/zip/2f35f4a08176d993cded35dac3332be4f7287f41' },
  packages: RUNTIME_ORIGIN_033_PACKAGES,
  notes: 'Legacy tagged origin reviewed September 7: exact dependencies, core capabilities and an SDXL reference passed. App-controlled upgrade, rollback, busy automatic activation and interrupted-switch recovery now have scoped evidence; affected-workflow acceptance remains incomplete. Not a fresh-install default or complete advanced-workflow support claim on 0.33.',
}, CURRENT_RUNTIME_SET];
export function reviewedRuntimeSet(id: string): ReviewedRuntimeSet { const value = REVIEWED_RUNTIME_CHANNEL.find(item => item.id === id); if (!value) throw new Error('This runtime set is not part of the app’s reviewed channel.'); return structuredClone(value); }
export function latestReviewedRuntimeSet(): ReviewedRuntimeSet { return structuredClone([...REVIEWED_RUNTIME_CHANNEL].sort((a, b) => b.sequence - a.sequence)[0]); }
export function reviewedInstalledRuntime(marker: { comfyCommit?: string; sourceSha256?: string; updateSetId?: string }): ReviewedRuntimeSet | undefined {
  const value = REVIEWED_RUNTIME_CHANNEL.find(item => (!marker.updateSetId || marker.updateSetId === item.id) && item.backend.commit === marker.comfyCommit && item.backend.archiveSha256 === marker.sourceSha256); return value ? structuredClone(value) : undefined;
}

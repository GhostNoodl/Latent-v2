import path from 'node:path';
import type { AppPaths, AppSnapshot } from '../shared/types';
import type { FaceDetailerStatus } from '../shared/face-detailer-types';
import { ASSISTANT_RELEASE, assistantPaths } from './assistant-config';
import { QWEN_EDIT_ASSETS, qwenEditAssetPath } from './qwen-edit-assets';
import { IPADAPTER_RELEASE } from '../shared/ipadapter-release';
import { ipAdapterPaths } from './ipadapter';
import { CONTROLNET_RELEASE, controlNetPaths } from './controlnet';
import { SEGMENTATION_RELEASE, segmentationPaths } from './segmentation';
import { UPSCALER_RELEASE, upscalerPaths } from './upscaler';
import { FACE_DETAILER_RELEASE } from './face-detailer-release';
import { videoProfileAssets, VIDEO_AVAILABILITY } from '../shared/video-plan';
import { videoAssetPath } from './video-assets';

/** Main-owned definitions only. Renderer callers cannot provide filesystem paths. */
export interface StorageArtifactDefinition { id: string; filename: string; bytes: number; sha256: string; url: string; downloadPath: string; candidatePaths: string[]; }
export interface StoragePackageDefinition { id: string; name: string; state: string; message: string; progress?: number; destinations: string[]; dependencies: string[]; unknownRequirements: string[]; artifacts: StorageArtifactDefinition[]; }
export type StorageCatalogStatuses = Partial<Pick<AppSnapshot, 'backend' | 'assistant' | 'qwenEdit' | 'ipAdapter' | 'controlNet' | 'segmentation' | 'upscaler' | 'video'>> & { faceDetailer?: FaceDetailerStatus };
export function builtInStorageCatalog(paths: AppPaths, statuses: StorageCatalogStatuses = {}): StoragePackageDefinition[] {
  const artifact = (pin: { filename: string; bytes: number; sha256: string; url: string }, filename: string, alternatives: string[] = []): StorageArtifactDefinition => ({ ...pin, id: pin.sha256, downloadPath: filename, candidatePaths: [filename, ...alternatives] });
  const entry = (id: string, name: string, status: { state: string; message: string; installProgress?: number; progress?: number } | undefined, destinations: string[], dependencies: string[], artifacts: StorageArtifactDefinition[], unknownRequirements: string[]): StoragePackageDefinition => ({ id, name, state: status?.state ?? 'unknown', message: status?.message ?? 'Workflow readiness is unavailable.', progress: status?.installProgress ?? status?.progress, destinations, dependencies, artifacts, unknownRequirements });
  const assistant = assistantPaths(paths); const segmentation = segmentationPaths(paths); const control = controlNetPaths(paths); const upscale = upscalerPaths(paths); const ip = ipAdapterPaths(paths);
  const faceRuntime = path.join(paths.runtime, 'face-detailer'); const faceModels = path.join(faceRuntime, 'models');
  const qwenArtifacts = QWEN_EDIT_ASSETS.map(pin => artifact(pin, qwenEditAssetPath(paths, pin)));
  const videoPackages = (['base', 'turbo8', 'fused4'] as const).map(profile => {
    const pins = videoProfileAssets(profile);
    const assets = statuses.video?.assets;
    const present = profile === 'fused4' ? assets?.fusedPresent : profile === 'base' ? assets?.basePresent : assets?.turboPresent;
    const activeProfile = assets?.profile === profile;
    const operationState = assets && activeProfile && ['installing', 'verifying', 'cancelled', 'error'].includes(assets.state);
    const state = !assets ? 'unknown' : operationState ? assets.state : present ? 'files-present-unverified' : pins.some(pin => assets.installedRoles.includes(pin.role)) ? 'partial' : 'not-installed';
    const message = [assets?.message ?? statuses.video?.message ?? VIDEO_AVAILABILITY.message,
      ...assets?.warnings ?? [],
      assets && !assets.canAcquire ? assets.canVerify ? 'Local model verification is available; automatic acquisition is disabled.' : 'MiniMax H3 eligibility remains unresolved; setup and use are unavailable.' : '',
      'File presence is not runtime readiness. Runtime compatibility, hardware support and video generation remain unverified.',
    ].filter(Boolean).join(' ');
    return entry(`video-${profile}`, `MiniMax H3 video · ${profile === 'fused4' ? 'fused turbo 4-step candidate' : profile === 'base' ? 'base' : 'turbo 8-step candidate'}`,
      { state, message, ...(assets && activeProfile && ['installing', 'verifying'].includes(assets.state) && Number.isFinite(assets.progress) ? { progress: assets.progress } : {}) },
      [...new Set(pins.map(pin => path.dirname(videoAssetPath(paths, pin))))],
      ['Private image engine with native H3 and video output nodes', profile === 'fused4' ? 'Fused INT8 diffusion, automatic text-encoder device, video VAE and audio VAE' : 'INT8 diffusion, CPU text encoder, video VAE and audio VAE', ...(profile === 'turbo8' ? ['Dedicated video turbo adapter; separate from ordinary image LoRAs'] : [])],
      pins.map(pin => artifact({ filename: path.posix.basename(pin.filename), bytes: pin.bytes, sha256: pin.sha256, url: pin.sourceUrl }, videoAssetPath(paths, pin))),
      ['Base and turbo share four model assets; turbo adds one adapter. Fused uses its own diffusion weights and shares the encoder and VAEs. Shared payload is counted once per volume.',
        'Silent export still pins the audio VAE in the current video plan. License records, runtime dependencies, outputs and setup headroom are additional.']);
  });
  return [
    entry('backend', 'Private image engine', statuses.backend, [paths.runtime, path.join(paths.cache, 'runtime')], ['Private Python, Torch/CUDA and ComfyUI packages'], [], ['Python and package downloads are resolved by the runtime installer; complete download and extraction requirements are not known here.']),
    entry('assistant', 'Local prompt assistant', statuses.assistant, [assistant.modelDirectory, assistant.runtime, assistant.downloads], ['Private llama.cpp CPU binaries'], [
      artifact({ filename: ASSISTANT_RELEASE.modelFilename, bytes: ASSISTANT_RELEASE.modelBytes, sha256: ASSISTANT_RELEASE.modelSha256, url: `https://huggingface.co/${ASSISTANT_RELEASE.modelId}/resolve/${ASSISTANT_RELEASE.modelRevision}/${ASSISTANT_RELEASE.modelFilename}` }, assistant.model),
      artifact({ filename: ASSISTANT_RELEASE.archiveFilename, bytes: ASSISTANT_RELEASE.archiveBytes, sha256: ASSISTANT_RELEASE.archiveSha256, url: `https://github.com/ggml-org/llama.cpp/releases/download/${ASSISTANT_RELEASE.runtimeBuild}/${ASSISTANT_RELEASE.archiveFilename}` }, path.join(assistant.downloads, ASSISTANT_RELEASE.archiveFilename)),
    ], ['Extracted CPU binaries and installation headroom are additional to the known download payload.']),
    ...(['base', 'fast'] as const).map(profile => entry(`qwen-${profile}`, `Qwen Image Edit · ${profile === 'fast' ? 'four-step' : 'base'}`, statuses.qwenEdit && { ...statuses.qwenEdit, state: statuses.qwenEdit.state === 'installing' ? statuses.qwenEdit.state : (profile === 'base' ? statuses.qwenEdit.baseReady : statuses.qwenEdit.fastReady) ? 'ready' : 'not-installed' }, [path.join(paths.models, 'diffusion_models', 'qwen-edit-2511'), path.join(paths.models, 'text_encoders', 'qwen-edit-2511'), path.join(paths.models, 'vae', 'qwen-edit-2511'), ...(profile === 'fast' ? [path.join(paths.models, 'qwen-edit-loras', 'qwen-edit-2511')] : [])], ['Private image engine', 'INT8 diffusion model, text encoder and VAE', ...(profile === 'fast' ? ['Four-step Lightning adapter'] : [])], qwenArtifacts.filter((_a, index) => profile === 'fast' || QWEN_EDIT_ASSETS[index].role !== 'lightning'), ['Model cards, license files and installation headroom are additional. Base and four-step profiles share their first three assets.'])),
    ...videoPackages,
    entry('ipadapter', 'IP Adapter reference guidance', statuses.ipAdapter, [ip.weights, path.join(paths.models, 'ipadapter'), path.join(paths.models, 'clip_vision'), ip.liveCode], ['Private image engine', 'Reviewed IP Adapter custom code', 'ViT-H image encoder'], [
      ...IPADAPTER_RELEASE.models.map(pin => artifact(pin, path.join(ip.weights, pin.filename), [path.join(paths.models, pin.directory, pin.filename)])),
      ...IPADAPTER_RELEASE.codeFiles.map(pin => artifact(pin, path.join(ip.code, pin.filename), [path.join(ip.liveCode, pin.filename)])),
      ...IPADAPTER_RELEASE.supportFiles.map(pin => artifact(pin, path.join(ip.licenses, pin.filename))),
    ], ['Activation may retain both staged and active files; hard links can share disk allocation. Python dependencies are managed separately.']),
    entry('controlnet', 'ControlNet Canny', statuses.controlNet, [control.directory, control.runtime], ['Private image engine'], [artifact(CONTROLNET_RELEASE, control.model), artifact({ filename: 'MODEL-CARD.md', bytes: CONTROLNET_RELEASE.cardBytes, sha256: CONTROLNET_RELEASE.cardSha256, url: CONTROLNET_RELEASE.modelCardUrl }, path.join(control.runtime, 'MODEL-CARD.md')), artifact({ filename: 'LICENSE-Apache-2.0.txt', bytes: CONTROLNET_RELEASE.licenseBytes, sha256: CONTROLNET_RELEASE.licenseSha256, url: CONTROLNET_RELEASE.licenseUrl }, path.join(control.runtime, 'LICENSE-Apache-2.0.txt'))], ['Runtime dependency and working-file headroom are separate.']),
    entry('segmentation', 'SAM smart selection', statuses.segmentation, [segmentation.modelDirectory, segmentation.runtime, segmentation.cache], ['Private Python, Torch and NumPy (CPU)'], [artifact({ filename: SEGMENTATION_RELEASE.modelFilename, bytes: SEGMENTATION_RELEASE.modelBytes, sha256: SEGMENTATION_RELEASE.modelSha256, url: SEGMENTATION_RELEASE.modelUrl }, segmentation.model), artifact({ filename: SEGMENTATION_RELEASE.codeFilename, bytes: SEGMENTATION_RELEASE.codeBytes, sha256: SEGMENTATION_RELEASE.codeSha256, url: SEGMENTATION_RELEASE.codeUrl }, path.join(segmentation.cache, SEGMENTATION_RELEASE.codeFilename))], ['Extracted SAM source and optional embedding caches are additional.']),
    entry('upscaler', 'Real-ESRGAN anime upscaler', statuses.upscaler, [path.dirname(upscale.model), upscale.runtime], ['Private image engine and reviewed upscaler loader'], [artifact(UPSCALER_RELEASE, upscale.model), artifact({ filename: 'LICENSE-RealESRGAN.txt', bytes: UPSCALER_RELEASE.licenseBytes, sha256: UPSCALER_RELEASE.licenseSha256, url: UPSCALER_RELEASE.licenseUrl }, path.join(upscale.runtime, 'LICENSE-RealESRGAN.txt'))], ['Output images and runtime dependencies are additional.']),
    entry('face-detailer', 'Automatic face detection', statuses.faceDetailer, [faceModels, path.join(faceRuntime, 'vendor'), path.join(paths.cache, 'face-detailer')], ['Private Python and NumPy', 'Isolated CPU OpenCV vendor'], [artifact(FACE_DETAILER_RELEASE.wheel, path.join(paths.cache, 'face-detailer', FACE_DETAILER_RELEASE.wheel.filename)), artifact(FACE_DETAILER_RELEASE.anime, path.join(faceModels, FACE_DETAILER_RELEASE.anime.filename)), artifact(FACE_DETAILER_RELEASE.photographic, path.join(faceModels, FACE_DETAILER_RELEASE.photographic.filename))], ['Extracted OpenCV vendor, retained previous vendor versions and installation headroom are additional.']),
  ];
}

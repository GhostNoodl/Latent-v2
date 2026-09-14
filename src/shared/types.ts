import type { AssistantConversation, AssistantStatus, AssistantSuggestion, AssistantSuggestionRequest } from './assistant-types';
import type { SourceImageAsset, SourceImageInventory, SourceMaskAsset, SourceMaskSaveOptions } from './source-types';
import type { CivitaiDownloadRequest, CivitaiModel, CivitaiPermissions, CivitaiReadResult, CivitaiSearchPage, CivitaiSearchRequest, CivitaiSettings } from './civitai-types';
import type { SegmentationRequest, SegmentationStatus, SegmentationSuggestion } from './segmentation-types';
import type { AdvancedImagePlan, HiresFixSettings, UpscaleSettings, UpscalerStatus } from './advanced-image-types';
import type { DynamicPromptAuthoring, DynamicPromptRecipe, WildcardSnapshot } from './dynamic-prompt-recipe';
import type { ControlNetPlan, ControlNetSettings, ControlNetStatus, RetainedControlMap } from './controlnet-types';
import type { CollectionKind, CollectionSnapshot } from './collections-types';
import type { RuntimeIdentitySnapshot } from './runtime-identity';
import type { CropInpaintPlan, CropInpaintSettings } from './crop-inpaint-types';
import type { CreateModelFolderRequest, ModelLocationsSnapshot, MoveModelRequest } from './model-locations';
import type { QwenEditAssetsStatus, QwenEditJobRequest, QwenEditProfile, QwenEditRecord } from './qwen-edit-types';
import type { QwenConversationStore } from './qwen-conversation';
import type { RegionalPromptPlan, RegionalPromptSettings } from './regional-prompt-types';
import type { IPAdapterPlan, IPAdapterSettings, IPAdapterStatus } from './ipadapter-types';
import type { RuntimeUpdateSettings, RuntimeUpdateStatus } from './runtime-update-types';
import type { FaceDetectionReceipt, FaceDetectionRequest, FaceDetailerStatus, FaceRefinementRequest } from './face-detailer-types';
import type { FaceRefinementPlan, FaceRefinementOutput } from './face-detailer-workflow';
import type { DownloadStorageSnapshot, PackageStorageSnapshot, StorageOverviewSnapshot } from './storage-types';
import type { BackendActivitySnapshot, SubmittedJobQueueState } from './backend-activity-types';
import type { VideoAvailability, VideoDraft, VideoHistoryRecord, VideoPlan } from './video-types';
import type { VideoAssetBundle } from './video-assets';
import type { VideoConversation } from './video-conversation';
import type { ModelTransferRecovery, ModelTransferRetryRequest } from './model-transfer-types';
import type { HardwareProfilesStatus, HardwareRecommendationReport, HardwareProfileApplication, HardwareOomAdvice } from './hardware-profile-types';
export interface FaceDetailerRecipe { plan: FaceRefinementPlan; detection: FaceDetectionReceipt; source: SourceImageAsset; outputs: FaceRefinementOutput[]; }
export interface CivitaiProvenance { creator?: string; description?: string; trainedWords?: string[]; previewUrl?: string; fetchedAt?: string; modelId: number; versionId: number; fileId: number; modelName: string; versionName: string; baseModel: string; sourceUrl: string; permissions: CivitaiPermissions; }
export type ModelFamily = 'sdxl' | 'illustrious';
export type ModelKind = 'checkpoint' | 'lora';
export interface ModelProvenance { repository: string; revision: string; licenseName: string; version?: string; baseModel?: string; }
export interface ModelAsset {
  civitai?: CivitaiProvenance;
  id: string;
  name: string;
  filename: string;
  kind: ModelKind;
  family: ModelFamily | 'unknown';
  bytes: number;
  sha256?: string;
  triggers: string[];
  sourceUrl?: string;
  licenseUrl?: string;
  provenance?: ModelProvenance;
  status: 'ready' | 'missing';
}
export interface LoraSelection { modelId: string; weight: number; clipWeight: number; }
export interface GenerationDraft {
  faceDetailer?: { request: FaceRefinementRequest; frozen?: FaceRefinementPlan };
  ipAdapter?: { settings: IPAdapterSettings; frozen?: IPAdapterPlan };
  regionalPrompts?: { settings: RegionalPromptSettings; frozen?: RegionalPromptPlan };
  qwenEdit?: QwenEditJobRequest;
  variationOfRecordId?: string;
  controlNet?: ControlNetSettings;
  dynamicPrompts?: DynamicPromptAuthoring;
  hiresFix?: HiresFixSettings;
  upscale?: UpscaleSettings;
  imageInput?: { mode: 'img2img' | 'inpaint'; sourceId: string; sourceSha256: string; maskId?: string; maskSha256?: string; denoise: number; resize: 'stretch' | 'center-crop'; crop?: CropInpaintSettings; cropPlan?: CropInpaintPlan };
  family: ModelFamily;
  checkpointId: string;
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: string;
  batchSize: number;
  loras: LoraSelection[];
  autoTriggers: boolean;
  triggerResolutionVersion?: 'legacy@1' | 'punctuation@2';
  triggerWords?: Record<string, string[]>;
  assetHashes?: Record<string, string>;
}
export interface Preset { id: string; name: string; draft: GenerationDraft; }
export interface AppSettings {
  civitaiAutoMetadata?: boolean; civitaiDisplayMetadata?: boolean;
  showGenerationPreview: boolean;
  theme: 'system' | 'dark' | 'light';
  accent: 'iris' | 'sea-glass' | 'rose';
  rememberPositivePrompt: boolean;
  rememberNegativePrompt: boolean;
  desktopNotifications?: boolean;
  notifyGeneration: boolean;
  notifyDownload: boolean;
  notifyError: boolean;
  backendAutoStart: boolean;
  deviceMode: 'auto' | 'lowvram' | 'cpu';
}
export interface AppPaths {
  root: string;
  runtime: string;
  backend: string;
  python: string;
  models: string;
  outputs: string;
  inputs: string;
  temp: string;
  user: string;
  cache: string;
  logs: string;
  database: string;
}
export interface HardwareInfo {
  os: string;
  arch: string;
  ramBytes: number;
  gpuName?: string;
  vramMiB?: number;
  driver?: string;
}
export interface BackendStatus {
  state: 'not-installed' | 'installing' | 'stopped' | 'starting' | 'ready' | 'error';
  message: string;
  url?: string;
  version?: string;
  installProgress?: number;
  logTail: string[];
}
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface QueueJobBase {
  queueState?: SubmittedJobQueueState;
  id: string;
  createdAt: string;
  updatedAt: string;
  actualSeed: string;
  status: JobStatus;
  promptId?: string;
  progress: number;
  progressMax: number;
  currentNode?: string;
  phase?: string;
  error?: string;
  outputIds: string[];
  previewUrl?: string;
}
export interface GenerationJob extends QueueJobBase { kind?: 'image'; draft: GenerationDraft; }
export interface VideoJob extends QueueJobBase {
  kind: 'video'; video: VideoDraft; frames: number; durationSeconds: number;
  finalization?: 'pending' | 'failed';
}
export type StudioJob = GenerationJob | VideoJob;
export function isImageJob(job: StudioJob): job is GenerationJob { return job.kind !== 'video'; }
export function isVideoJob(job: StudioJob): job is VideoJob { return job.kind === 'video'; }
export interface GenerationRecord {
  faceDetailer?: FaceDetailerRecipe;
  facePass?: { index: number; faceId: string; seed: string; parentRecordId?: string; parentOutputNodeId?: string };
  ipAdapter?: IPAdapterPlan;
  ipAdapterSource?: SourceImageAsset;
  regionalPrompts?: RegionalPromptPlan;
  qwenEdit?: QwenEditRecord;
  cropInpaint?: CropInpaintPlan;
  runtimeIdentity?: RuntimeIdentitySnapshot;
  controlNet?: { plan: ControlNetPlan; map?: RetainedControlMap };
  dynamicPromptRecipe?: DynamicPromptRecipe;
  advancedImage?: AdvancedImagePlan;
  outputRole?: 'base' | 'face-pass' | 'final';
  outputNodeId?: string;
  outputBatchIndex?: number;
  baseRecordId?: string;
  imageInput?: { source: SourceImageAsset; mask?: SourceMaskAsset };
  id: string;
  jobId: string;
  createdAt: string;
  filename: string;
  imageUrl: string;
  draft: GenerationDraft;
  actualSeed: string;
  resolvedPrompt: string;
  width: number;
  height: number;
  checkpoint?: ModelAsset;
  loras: Array<ModelAsset & { weight: number; clipWeight: number }>;
  workflow: ComfyWorkflow;
  workflowVersion: string;
  backendVersion: string;
  appVersion: string;
  durationMs: number;
}
export interface DownloadStatus {
  id: string;
  name: string;
  /** Main-owned managed destination; absent on older or non-model transfers. */
  modelKind?: ModelKind;
  destinationDirectory?: string;
  state: 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled';
  receivedBytes: number;
  totalBytes: number;
  error?: string;
}
export interface ModelDownloadRequest { url: string; filename: string; kind: ModelKind; family: ModelFamily; sha256?: string; triggers?: string[]; sourceUrl?: string; licenseUrl?: string; provenance?: ModelProvenance; civitai?: CivitaiProvenance; }
export interface AppSnapshot {
  dismissedActivity?: { queue: string[]; notifications: string[] };
  notifications?: Array<{ id: string; title: string; body: string; at: string; preference: 'notifyGeneration' | 'notifyError' | 'notifyDownload' }>;
  video: VideoAvailability;
  backendActivity: BackendActivitySnapshot;
  hardwareProfiles: HardwareProfilesStatus;
  faceDetailer: FaceDetailerStatus;
  runtimeUpdates: RuntimeUpdateStatus;
  ipAdapter: IPAdapterStatus;
  qwenEdit: QwenEditAssetsStatus;
  modelLocations: ModelLocationsSnapshot;
  collections: CollectionSnapshot;
  controlNet: ControlNetStatus;
  wildcards: WildcardSnapshot;
  upscaler: UpscalerStatus;
  segmentation: SegmentationStatus;
  sourceImages: SourceImageInventory;
  assistant: AssistantStatus;
  backend: BackendStatus;
  models: ModelAsset[];
  history: GenerationRecord[];
  previewSelectedRecordId: string | null;
  jobs: StudioJob[];
  settings: AppSettings;
  draft: GenerationDraft;
  presets: Preset[];
  paths: AppPaths;
  hardware: HardwareInfo;
  downloads: DownloadStatus[];
}
export type ComfyInput = string | number | boolean | [string, number];
export type ComfyWorkflow = Record<string, { class_type: string; inputs: Record<string, ComfyInput>; _meta?: { title: string } }>;
export interface LatentAPI {
  getSetupPreflight(capability: import('./setup').SetupCapability): Promise<import('./setup').SetupPreflight>;
  runGuidedSetup(capability: import('./setup').SetupCapability): Promise<void>;
  getModelTransferRecovery(): Promise<ModelTransferRecovery>;
  retryModelTransfer(request: ModelTransferRetryRequest): Promise<void>;
  cancelModelTransfer(id: string): Promise<void>;
  getVideoConversation(): Promise<VideoConversation | null>;
  saveVideoConversation(value: VideoConversation): Promise<void>;
  planVideoDraft(draft: VideoDraft): Promise<VideoPlan>;
  getVideoPlaybackFixture(): Promise<VideoHistoryRecord>;
  getVideoHistory(): Promise<{ records: VideoHistoryRecord[]; warnings: string[] }>;
  restoreVideoParameters(id: string): Promise<VideoDraft>;
  setupVideoAssets(profile: VideoDraft['profile']): Promise<VideoAssetBundle>;
  verifyVideoAssets(profile: VideoDraft['profile']): Promise<VideoAssetBundle>;
  cancelVideoAssetSetup(): Promise<void>;
  revealVideo(id: string): Promise<void>;
  openVideoLicense(): Promise<void>;
  getStorageOverview(): Promise<StorageOverviewSnapshot>;
  getModelDownloadStorage(): Promise<DownloadStorageSnapshot>;
  getPackageStorage(packageId: string): Promise<PackageStorageSnapshot>;
  revealStorageDestination(id: string): Promise<void>;
  refreshHardwareProfiles(): Promise<HardwareProfilesStatus>;
  recommendHardwareProfiles(draft: GenerationDraft): Promise<HardwareRecommendationReport>;
  applyHardwareProfile(request: { reportId: string; profileId: string; draft: GenerationDraft }): Promise<HardwareProfileApplication>;
  applyHardwareBackendRecommendation(reportId: string): Promise<AppSnapshot>;
  getJobMemoryAdvice(jobId: string): Promise<HardwareOomAdvice>;
  setupFaceDetailer(repair?: boolean): Promise<void>;
  cancelFaceDetailerSetup(): Promise<void>;
  detectFaces(request: FaceDetectionRequest): Promise<FaceDetectionReceipt>;
  cancelFaceDetection(): Promise<void>;
  getFaceDetection(id: string): Promise<FaceDetectionReceipt>;
  getRuntimeUpdateStatus(): Promise<RuntimeUpdateStatus>;
  saveRuntimeUpdateSettings(settings: Partial<RuntimeUpdateSettings>): Promise<void>;
  checkRuntimeUpdates(): Promise<void>;
  prepareRuntimeEnvironmentRepair(): Promise<void>;
  stageRuntimeUpdate(kind: 'update' | 'refresh'): Promise<void>;
  activateRuntimeUpdate(): Promise<void>;
  rollbackRuntimeUpdate(): Promise<void>;
  recoverRuntimeUpdate(): Promise<void>;
  cancelRuntimeUpdate(): Promise<void>;
  getIPAdapterStatus(): Promise<IPAdapterStatus>;
  stageIPAdapter(repair?: boolean): Promise<void>;
  activateIPAdapter(): Promise<void>;
  cancelIPAdapterSetup(): Promise<void>;
  getQwenConversation(): Promise<QwenConversationStore | null>;
  saveQwenConversation(value: QwenConversationStore): Promise<void>;
  setupQwenEdit(profile: QwenEditProfile, repair?: boolean): Promise<void>;
  cancelQwenEditSetup(): Promise<void>;
  enqueueQwenEdit(request: QwenEditJobRequest): Promise<GenerationJob>;
  chooseExternalModelRoot(kind: ModelKind): Promise<ModelLocationsSnapshot | null>;
  unregisterExternalModelRoot(rootId: string): Promise<ModelLocationsSnapshot>;
  createModelFolder(request: CreateModelFolderRequest): Promise<ModelLocationsSnapshot>;
  moveModel(request: MoveModelRequest): Promise<ModelLocationsSnapshot>;
  recoverModelLocations(): Promise<ModelLocationsSnapshot>;
  createCollection(kind: CollectionKind, name: string): Promise<CollectionSnapshot>;
  renameCollection(id: string, name: string): Promise<CollectionSnapshot>;
  removeCollection(id: string): Promise<CollectionSnapshot>;
  addCollectionMembers(id: string, memberIds: string[]): Promise<CollectionSnapshot>;
  removeCollectionMembers(id: string, memberIds: string[]): Promise<CollectionSnapshot>;
  setupControlNet(repair?: boolean): Promise<void>;
  cancelControlNet(): Promise<void>;
  saveWildcards(entries: Record<string, string[]>): Promise<WildcardSnapshot>;
  setupUpscaler(repair?: boolean): Promise<void>;
  cancelUpscaler(): Promise<void>;
  fetchModelCivitaiMetadata(modelId: string): Promise<AppSnapshot>;
  civitaiSearch(request: CivitaiSearchRequest): Promise<CivitaiReadResult<CivitaiSearchPage>>;
  civitaiDetail(modelId: number): Promise<CivitaiReadResult<CivitaiModel>>;
  civitaiDownload(request: CivitaiDownloadRequest): Promise<ModelAsset>;
  cancelCivitai(): Promise<void>;
  getCivitaiSettings(): Promise<CivitaiSettings>;
  setCivitaiKey(value: string | null): Promise<void>;
  openCivitaiModel(modelId: number, versionId?: number): Promise<void>;
  setupSegmentation(repair?: boolean): Promise<void>;
  startSegmentation(): Promise<void>;
  stopSegmentation(): Promise<void>;
  suggestMask(request: SegmentationRequest): Promise<SegmentationSuggestion>;
  cancelSegmentation(): Promise<void>;
  importSourceImage(): Promise<SourceImageAsset | null>;
  useOutputAsSource(id: string): Promise<SourceImageAsset>;
  saveSourceMask(sourceId: string, pngBytes: Uint8Array, options?: SourceMaskSaveOptions): Promise<SourceMaskAsset>;
  setupAssistant(repair?: boolean): Promise<void>;
  startAssistant(): Promise<void>;
  stopAssistant(): Promise<void>;
  suggestPrompt(request: AssistantSuggestionRequest): Promise<AssistantSuggestion>;
  cancelAssistant(): Promise<void>;
  getAssistantConversation(target?: 'image' | 'video'): Promise<AssistantConversation | null>;
  saveAssistantConversation(conversation: AssistantConversation, target?: 'image' | 'video'): Promise<void>;
  copyText(text: string): Promise<void>;
  dismissActivity(scope: 'queue' | 'notifications', keys: string[] | null): Promise<AppSnapshot>;
  getSnapshot(): Promise<AppSnapshot>;
  changeStorageLocation(kind: 'models' | 'outputs'): Promise<void>;
  saveDraft(draft: GenerationDraft): Promise<void>;
  savePreviewSelection(recordId: string | null): Promise<void>;
  updateSettings(settings: Partial<AppSettings>): Promise<AppSnapshot>;
  setupBackend(): Promise<void>;
  startBackend(): Promise<void>;
  stopBackend(): Promise<void>;
  openComfyUI(): Promise<void>;
  refreshModels(): Promise<AppSnapshot>;
  importModels(kind: ModelKind): Promise<AppSnapshot>;
  updateModel(id: string, changes: { family?: ModelFamily | 'unknown'; triggers?: string[] }): Promise<AppSnapshot>;
  downloadModel(request: ModelDownloadRequest): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  queueGeneration(draft: GenerationDraft): Promise<GenerationJob>;
  cancelJob(id: string): Promise<void>;
  retryJob(id: string): Promise<StudioJob>;
  queueVideo(draft: VideoDraft): Promise<VideoJob>;
  retryVideoSave(id: string): Promise<void>;
  reorderJobs(ids: string[]): Promise<void>;
  savePreset(preset: Preset): Promise<AppSnapshot>;
  deletePreset(id: string): Promise<AppSnapshot>;
  revealOutput(id: string): Promise<void>;
  openOutput(id: string): Promise<void>;
  onSnapshot(listener: (snapshot: AppSnapshot) => void): () => void;
  onBeforeClose(listener: () => Promise<void>): () => void;
  onCloseCancelled(listener: () => void): () => void;
}
declare global { interface Window { latent: LatentAPI; } }

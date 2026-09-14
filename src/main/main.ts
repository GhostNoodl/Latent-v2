import { setupStorageBlockers, setupHardwareBlockers, type SetupCapability, type SetupPreflight } from '../shared/setup';
import { inspectHardware as inspectSetupHardware } from './hardware-profile-probe';
import { storageBoundary, copyStorageLocation } from './storage-locations';
import { reviewedRuntimeSet } from './reviewed-runtime-channel';
import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, Notification, protocol, safeStorage, session, shell } from 'electron';
import { copyStudioText } from './clipboard';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { containedPath, inside } from './paths';
import { createStartupPaths } from './portable-studio';
import { privateShellPath } from './shell-path';
import { StudioStore } from './store';
import { ModelService } from './models';
import { JobService } from './jobs';
import { ManagedBackend } from './managed-backend';
import { PromptAssistant } from './prompt-assistant';
import { SourceImageService } from './source-images';
import { SegmentationService } from './segmentation';
import { CivitaiCatalog } from './civitai-catalog';
import { UpscalerService } from './upscaler';
import { WildcardStore } from './wildcards';
import { ControlNetService } from './controlnet';
import { CollectionService } from './collections';
import { ModelLocationService } from './model-locations';
import { QwenEditAssetsService } from './qwen-edit-assets';
import { FaceDetailerService } from './face-detailer';
import { IPAdapterService } from './ipadapter';
import { activateIPAdapterWhenIdle } from './ipadapter-lifecycle';
import { RuntimeUpdateService } from './runtime-updates';
import { RuntimeUpdateCoordinator } from './runtime-update-coordinator';
import { StorageOverviewService } from './storage-overview';
import { builtInStorageCatalog } from './storage-catalog';
import { HardwareProfilesService } from './hardware-profiles';
import { BackendActivityService } from './backend-activity';
import { ModelTransferActions } from './model-transfer-actions';
import { modelTransferNeedsAttention } from './model-transfer-notifications';
import { DesktopNotifications, type NotificationPreference } from './desktop-notifications';
import { VideoConversationService } from './video-conversations';
import { VideoDraftService } from './video-drafts';
import { videoDraftSchema, VIDEO_AVAILABILITY } from '../shared/video-plan';
import { videoFileResponse, VideoMediaInspector, packagedVideoInspectorPath } from './video-media';
import { VideoHistoryService } from './video-history';
import { VideoAssetsService } from './video-assets';
import { VideoPreflightService } from './video-preflight';
import { localVideoAvailability } from './video-availability';
import { VideoQueueService } from './video-queue';
import { isVideoJob } from '../shared/types';
import { videoPlaybackFixtureFile, videoPlaybackFixtureRecord, VIDEO_PLAYBACK_FIXTURE_ID } from './video-playback-fixture';
import { runtimeUpdateSettingsSchema } from '../shared/runtime-update-types';
import { IPADAPTER_RELEASE } from '../shared/ipadapter-release';
import { qwenConversationSchema } from '../shared/qwen-conversation';
import { assistantConversationSchema } from '../shared/assistant-conversation';
import { MODEL_CATALOG } from '../shared/model-catalog';
import { draftSchema, settingsSchema } from '../shared/validation';
import type { AppSnapshot, GenerationDraft, HardwareInfo, LatentAPI } from '../shared/types';

protocol.registerSchemesAsPrivileged([{ scheme: 'latent-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
const paths = (() => {
  try { return createStartupPaths({ isPackaged: app.isPackaged, env: process.env, defaultRoot: path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Latentv2') }); }
  catch (error) { dialog.showErrorBox('Latent could not open its studio', error instanceof Error ? error.message : String(error)); process.exit(1); }
})();
app.setPath('userData', path.join(paths.root, 'desktop'));
app.setPath('sessionData', path.join(paths.root, 'desktop', 'session'));
app.setAppUserModelId('studio.latent.v2');
let window: BrowserWindow | undefined;
let store: StudioStore;
let models: ModelService;
let backend: ManagedBackend;
let jobs: JobService;
let assistant: PromptAssistant;
let sources: SourceImageService;
let segmentation: SegmentationService;
let civitai: CivitaiCatalog;
let upscaler: UpscalerService;
let wildcards: WildcardStore;
let controlNet: ControlNetService;
let collections: CollectionService;
let modelLocations: ModelLocationService;
let qwenEdit: QwenEditAssetsService;
let ipAdapter: IPAdapterService;
let faceDetailer: FaceDetailerService;
let runtimeUpdates: RuntimeUpdateService;
let runtimeCoordinator: RuntimeUpdateCoordinator;
let storageOverview: StorageOverviewService;
let hardwareProfiles: HardwareProfilesService;
let backendActivity: BackendActivityService;
let videoConversations: VideoConversationService;
let videoDrafts: VideoDraftService;
let videoHistory: VideoHistoryService;
let videoAssets: VideoAssetsService;
let videoInspector: VideoMediaInspector;
let modelTransferActions: ModelTransferActions;
const videoFixture = videoPlaybackFixtureFile({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, dirname: __dirname });
let runtimeUpdateTimer: NodeJS.Timeout | undefined;
let runtimeIdleTimer: NodeJS.Timeout | undefined;
let automaticRuntimeCheckPending = false;
let automaticRuntimeRetryAfter = 0;
let draft: GenerationDraft;
let closing = false;
let storageRestartPending = false;
let storageChanging = false;
let quitting = false;
let closed = false;
let pendingFlush: { nonce: string; resolve: () => void; reject: (error: Error) => void } | undefined;
const pendingOperations = new Set<Promise<unknown>>();
function track<T>(promise: Promise<T>): Promise<T> { pendingOperations.add(promise); promise.then(() => pendingOperations.delete(promise), () => pendingOperations.delete(promise)); return promise; }
let broadcastTimer: NodeJS.Timeout | undefined;
let hardware: HardwareInfo = { os: `${os.type()} ${os.release()}`, arch: os.arch(), ramBytes: os.totalmem() };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const notifications = new DesktopNotifications({
  settings: () => store.settings(), window: () => window, closing: () => closing || closed,
  supported: () => Notification.isSupported(),
  create: options => {
    const notice = new Notification(options);
    return { onClick: handler => { notice.on('click', handler); }, onFailure: handler => { notice.on('failed', (_event, error) => handler(error)); }, show: () => notice.show() };
  },
  failed: error => { void fs.appendFile(path.join(paths.logs, 'desktop.log'), `${new Date().toISOString()} Notification delivery: ${errorMessage(error)}\n`).catch(() => undefined); },
});
const indexFile = path.join(__dirname, '..', 'dist', 'index.html');
const devUrl = process.env.LATENT_DEV_URL;
if (devUrl && new URL(devUrl).origin !== 'http://127.0.0.1:5174') throw new Error('Unsupported development server URL.');
const trustedUrl = devUrl || pathToFileURL(indexFile).toString();
function trusted(value: string) { return value.split('#')[0] === trustedUrl; }
function videoStatus(): AppSnapshot['video'] {
  return localVideoAvailability(videoDrafts.status(), videoAssets.status(), backend.status().state, backend.getRuntimeIdentity());
}
function snapshot(): AppSnapshot {
  return { dismissedActivity: store.getState('activity.dismissed', { queue: [], notifications: [] }), notifications: store.getState('notifications', []), video: videoStatus(), backendActivity: backendActivity.status(), hardwareProfiles: hardwareProfiles.status(), faceDetailer: faceDetailer.status(), runtimeUpdates: runtimeUpdateSnapshot(), ipAdapter: ipAdapter.status(), qwenEdit: qwenEdit.status(), modelLocations: modelLocations.snapshot(), collections: collections.snapshot(), controlNet: controlNet.status(), upscaler: upscaler.status(), wildcards: wildcards.snapshot(), backend: backend.status(), assistant: assistant.status(), segmentation: segmentation.status(), sourceImages: sources.list(), models: models.assets, history: store.records(), previewSelectedRecordId: store.previewSelectionId(), jobs: jobs.jobs(), settings: store.settings(), draft, presets: store.presets(), paths, hardware, downloads: models.downloads };
}
function runtimeUpdateSnapshot() {
  const status = runtimeUpdates.status(); const problem = runtimeCoordinator.recoveryProblem();
  if (runtimeCoordinator.isActivationPending()) return { ...status, state: 'applying' as const, message: status.state === 'applying' ? status.message : 'Validating the activated runtime before enabling generation…' };
  if (!problem) return status;
  const repairable = runtimeCoordinator.canPrepareEnvironmentRepair();
  const showingOperation = ['staging', 'staged', 'applying'].includes(status.state);
  return { ...status, state: showingOperation ? status.state : 'error' as const, environmentRepairRequired: repairable, environmentRepairBytes: repairable && status.current ? reviewedRuntimeSet(status.current.setId).environmentPreparationBytes : undefined, recoveryRequired: status.recoveryRequired || !repairable, message: showingOperation ? status.message : `${repairable ? 'Environment repair needed' : 'Runtime recovery needs attention'}: ${status.state === 'error' ? status.message : problem}` };
}
async function automaticRuntimeCheck() {
  if (closing || closed || storageChanging || storageRestartPending || !runtimeCoordinator || runtimeCoordinator.blockedReason() || automaticRuntimeCheckPending || Date.now() < automaticRuntimeRetryAfter) return;
  automaticRuntimeCheckPending = true;
  try { await track(runtimeUpdates.automaticCheck()); }
  catch (error) { automaticRuntimeRetryAfter = Date.now() + 15 * 60_000; await fs.appendFile(path.join(paths.logs, 'desktop.log'), `${new Date().toISOString()} Automatic runtime check: ${errorMessage(error)}\n`); notify('notifyError', 'Runtime update needs attention', errorMessage(error)); }
  finally { automaticRuntimeCheckPending = false; }
}
function scheduleRuntimeIdleCheck() {
  if (!runtimeUpdateTimer || runtimeIdleTimer || closing || closed) return;
  runtimeIdleTimer = setTimeout(() => { runtimeIdleTimer = undefined; void automaticRuntimeCheck().catch(() => undefined); }, 1000);
}
function locationChangeBlockedReason(): string | undefined {
  if (!backend || !['stopped', 'not-installed'].includes(backend.status().state)) return 'Stop the image engine before changing model folders.';
  if (jobs?.jobs().some(job => ['queued', 'running'].includes(job.status))) return 'Finish or cancel queued and running jobs before changing model folders.';
  return undefined;
}
function assertModelLocationsReady() {
  const runtimeProblem = runtimeCoordinator?.blockedReason(); if (runtimeProblem) throw new Error(runtimeProblem);
  if (ipAdapter?.status().state === 'activating') throw new Error('Wait for reference-tool activation to finish before starting or queuing generation.');
  const state = modelLocations.snapshot();
  if (state.recoveryRequired || state.error) throw new Error(state.error || 'Recover the interrupted model move in Models before starting generation.');
}
function startEngine() { return models.library.withShared('starting the image engine', async () => { assertModelLocationsReady(); await backend.start(); }); }
function broadcast() {
  scheduleRuntimeIdleCheck();
  if (closed || closing || broadcastTimer) return;
  broadcastTimer = setTimeout(() => { broadcastTimer = undefined; if (window && !window.isDestroyed() && store && models && jobs && backend) window.webContents.send('latent:snapshot', snapshot()); }, 120);
}
function notify(preference: NotificationPreference, title: string, body: string) {
  if (store.settings()[preference]) {
    const recent = store.getState<NonNullable<AppSnapshot['notifications']>>('notifications', []);
    store.setState('notifications', [{ id: randomUUID(), title, body, at: new Date().toISOString(), preference }, ...recent].slice(0, 50));
    broadcast();
  }
  notifications.send(preference, title, body);
}
async function outputPath(id: string) {
  const record = store.records().find(item => item.id === id); if (!record) throw new Error('This image is not in your library.');
  const file = containedPath(paths.outputs, record.filename); const real = await fs.realpath(file);
  if (!inside(await fs.realpath(paths.outputs), real) || (await fs.lstat(file)).isSymbolicLink() || !file.endsWith('.png')) throw new Error('The image file is outside this studio.');
  return file;
}
async function inventoryHardware() {
  try {
    const result = await promisify(execFile)('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 8000, maxBuffer: 16384 });
    const [gpuName, vram, driver] = result.stdout.trim().split('\n')[0].split(',').map(s => s.trim());
    hardware = { ...hardware, gpuName, vramMiB: Number(vram), driver }; broadcast();
  } catch { /* The studio remains usable on machines without NVIDIA tooling. */ }
}
async function initialize() {
  store = new StudioStore(paths.database); draft = store.draft();
  models = new ModelService(paths, store, broadcast);
  assistant = new PromptAssistant(paths, store, broadcast);
  sources = new SourceImageService(paths, store);
  videoConversations = new VideoConversationService(store); videoDrafts = new VideoDraftService(store);
  videoInspector = new VideoMediaInspector({ get python() { return paths.python; }, workerPath: packagedVideoInspectorPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath, dirname: __dirname }) });
  videoHistory = new VideoHistoryService(paths, store, videoInspector);
  // User-supplied files only: no acquisition and no assertion of a publisher license grant.
  videoAssets = new VideoAssetsService(paths, () => ({ schema: 1, recordId: 'user-requested-video-setup-20260909', licenseUrl: VIDEO_AVAILABILITY.licenseUrl, resolvedAt: '2026-09-09T00:00:00.000Z', scope: 'acquisition-and-use' }), broadcast);
  faceDetailer = new FaceDetailerService(paths, store, broadcast, sources);
  segmentation = new SegmentationService(paths, store, broadcast, sources);
  civitai = new CivitaiCatalog(paths, store, models, broadcast, safeStorage);

  modelTransferActions = new ModelTransferActions({ models, civitai, assertReady: assertModelLocationsReady, changed: broadcast, completed: name => { notify('notifyDownload', 'Model download complete', name); }, failed: message => { notify('notifyError', 'Model download needs attention', message); } });
  upscaler = new UpscalerService(paths, store, broadcast);
  wildcards = new WildcardStore(store, broadcast);
  controlNet = new ControlNetService(paths, store, broadcast);
  qwenEdit = new QwenEditAssetsService(paths, store, broadcast);
  collections = new CollectionService(store, () => ({ modelIds: models.assets.map(model => model.id), recordIds: store.records().map(record => record.id) }), broadcast);
  backend = new ManagedBackend(paths, state => {
    notifications.backendChanged(state); broadcast();
  }, () => store.settings(), () => modelLocations.backendRoots());
  ipAdapter = new IPAdapterService(paths, broadcast, () => backend.status().state === 'stopped' && !jobs?.jobs().some(job => ['queued', 'running'].includes(job.status)));
  backendActivity = new BackendActivityService({ waitForStartup: () => backend.waitForStartup(), getBackend: () => ({ state: backend.status().state, url: backend.getUrl(), hasOwnedProcess: backend.hasOwnedProcess() }), getOwnedPrompts: () => jobs?.jobs().filter(job => job.promptId).map(job => ({ jobId: job.id, promptId: job.promptId! })) ?? [] }, broadcast);
  const videoPreflight = new VideoPreflightService(paths, videoAssets, sources, backend, { blockedReason: () => runtimeCoordinator?.blockedReason() ?? (!runtimeCoordinator ? 'Checking interrupted runtime maintenance.' : undefined) });
  const videoQueue = new VideoQueueService(paths, videoPreflight, videoHistory);
  jobs = new JobService(paths, store, models, backend, broadcast, job => { notifications.jobFinished(job); }, app.getVersion(), upscaler, controlNet, qwenEdit, ipAdapter, () => runtimeCoordinator?.blockedReason() ?? (!runtimeCoordinator ? 'Checking for interrupted runtime maintenance before generation.' : undefined), faceDetailer, backendActivity, videoQueue);
  runtimeCoordinator = new RuntimeUpdateCoordinator(models.library, backend, jobs, () => runtimeUpdates.status());
  runtimeUpdates = new RuntimeUpdateService(paths, store, broadcast, runtimeCoordinator.hooks);
  modelLocations = new ModelLocationService(paths, store, models, { assertChangesAllowed: () => { const reason = locationChangeBlockedReason(); if (reason) throw new Error(reason); }, changeBlockedReason: locationChangeBlockedReason }, broadcast);
  storageOverview = new StorageOverviewService(paths, {
    catalog: () => builtInStorageCatalog(paths, { video: videoStatus(), backend: backend.status(), assistant: assistant.status(), qwenEdit: qwenEdit.status(), ipAdapter: ipAdapter.status(), controlNet: controlNet.status(), segmentation: segmentation.status(), upscaler: upscaler.status(), faceDetailer: faceDetailer.status() }),
    transfers: () => models.downloads,
  });
  hardwareProfiles = new HardwareProfilesService(paths, store, broadcast, {
    getRuntimeIdentity: () => backend.getRuntimeIdentity(), getBackendUrl: () => backend.getUrl(), getSettings: () => store.settings(), getModels: () => models.assets,
    getSource: async sourceId => (await sources.resolve(sourceId)).source, getMask: async maskId => (await sources.resolveMask(maskId)).mask, isUpscalerReady: () => upscaler.status().state === 'ready',
  });
  const id = z.string().min(1).max(1000);
  let guidedSetupRunning = false;
  const preflightSetup = async (raw: SetupCapability): Promise<SetupPreflight> => {
    const capability = z.enum(['engine','images','edit','video']).parse(raw);
    const hardware = await inspectSetupHardware(paths, null);
    const storage = await storageOverview.packageStorage(capability === 'engine' ? 'backend' : capability === 'edit' ? 'qwen-base' : capability === 'video' ? 'video-fused4' : 'backend');
    const blockers = setupHardwareBlockers(hardware, capability);
    if (capability !== 'engine' && backend.status().state !== 'ready') blockers.push('Set up and start the generation engine first.');
    if (capability === 'video' && !videoAssets.status().canAcquire) blockers.push('Automatic video acquisition is unavailable. Review video setup in the Video tab.');
    if (capability === 'images') {
      const capacity = await storageOverview.downloadCapacity();
      const destination = capacity.destinations.find(d => d.id === capacity.modelDownloadDestinations?.checkpoint);
      storage.destinations = destination ? [destination] : []; storage.volumes = capacity.volumes.filter(v => v.id === destination?.volumeId);
      storage.package.minimumDownloadBytes = models.assets.some(m => m.kind === 'checkpoint' && m.status === 'ready' && ['sdxl','illustrious'].includes(m.family)) ? 0 : MODEL_CATALOG.find(m => m.id === 'onoma-illustrious-xl-1.1')!.bytes;
    }
    blockers.push(...setupStorageBlockers(storage, capability));
    return { capability,checkedAt:new Date().toISOString(),blockers,warnings:[capability === 'engine' ? 'Reserve at least 15 GiB for engine setup. Actual download size varies; this is a planning allowance.' : 'The download estimate excludes runtime packages; an additional 2 GiB allowance is checked in each destination.', 'Hardware eligibility is a starting check. Setup verifies installed components before use.'],gpu:hardware.gpus.length === 1 ? hardware.gpus[0].name : undefined,storage };
  };
  const methods: Omit<LatentAPI, 'onSnapshot' | 'onBeforeClose' | 'onCloseCancelled'> = {
    getSetupPreflight: preflightSetup,
    runGuidedSetup: async capability => {
      if (guidedSetupRunning) throw new Error('A setup operation is already running.');
      guidedSetupRunning = true;
      try {
      const check = await preflightSetup(capability);
      if (check.blockers.length) throw new Error(check.blockers.join(' '));
      if (capability === 'engine') { if (backend.status().state === 'stopped') await methods.startBackend(); else if (backend.status().state !== 'ready') await methods.setupBackend(); }
      else if (capability === 'images') { if (!models.assets.some(m => m.kind === 'checkpoint' && m.status === 'ready' && ['sdxl','illustrious'].includes(m.family))) { const {id: _id,name: _name,publisher: _publisher,description: _description,bytes: _bytes,...request} = MODEL_CATALOG.find(m => m.id === 'onoma-illustrious-xl-1.1')!; await methods.downloadModel(request); } }
      else if (capability === 'edit') await methods.setupQwenEdit('base');
      else await methods.setupVideoAssets('fused4');
      } finally { guidedSetupRunning = false; }
    },
    getModelTransferRecovery: async () => modelTransferActions.recovery(), retryModelTransfer: async request => modelTransferActions.retry(request), cancelModelTransfer: async transferId => modelTransferActions.cancel(transferId),
    getVideoConversation: async () => videoConversations.get(), saveVideoConversation: async value => videoConversations.save(value),
    planVideoDraft: async input => { const value = videoDraftSchema.parse(input); return videoDrafts.plan(value, value.seed === 'random' ? String(randomBytes(6).readUIntBE(0, 6)) : value.seed, async sourceId => (await sources.resolve(sourceId)).source); },
    getVideoPlaybackFixture: async () => videoPlaybackFixtureRecord(videoFixture),
    getVideoHistory: async () => videoHistory.snapshot(),
    setupVideoAssets: async profile => videoAssets.setup(z.enum(['base', 'turbo8', 'fused4']).parse(profile)),
    verifyVideoAssets: async profile => videoAssets.verifyLocal(z.enum(['base', 'turbo8', 'fused4']).parse(profile)),
    cancelVideoAssetSetup: async () => videoAssets.cancel(),
    restoreVideoParameters: async value => videoHistory.restore(id.parse(value)),
    revealVideo: async value => {
      const recordId = id.parse(value);
      if (recordId === VIDEO_PLAYBACK_FIXTURE_ID) { await videoPlaybackFixtureRecord(videoFixture); shell.showItemInFolder(videoFixture.filename); return; }
      const file = await videoHistory.file(recordId);
      await videoFileResponse(file, { method: 'HEAD', headers: new Headers(), signal: AbortSignal.timeout(15000) });
      shell.showItemInFolder(await privateShellPath(storageBoundary(paths, file.filename), file.filename));
    },
    openVideoLicense: async () => { await shell.openExternal(videoDrafts.status().licenseUrl); },
    getStorageOverview: async () => storageOverview.refresh(),
    getModelDownloadStorage: async () => storageOverview.downloadCapacity(),
    getPackageStorage: async packageId => storageOverview.packageStorage(z.string().regex(/^[a-z0-9-]{1,80}$/).parse(packageId)),
    revealStorageDestination: async destinationId => { const destination = await storageOverview.destination(z.string().regex(/^directory:[a-f0-9]{24}$/).parse(destinationId)); const error = await shell.openPath(await privateShellPath(storageBoundary(paths, destination), destination)); if (error) throw new Error(error); },
    refreshHardwareProfiles: async () => { await hardwareProfiles.refresh(); return hardwareProfiles.status(); },
    recommendHardwareProfiles: async value => hardwareProfiles.recommend(value),
    applyHardwareProfile: async request => hardwareProfiles.apply(request),
    applyHardwareBackendRecommendation: async reportId => { const priorMode = store.settings().deviceMode; const result = await hardwareProfiles.applyBackendRecommendation(z.uuid().parse(reportId)); if (store.settings().deviceMode !== priorMode) throw new Error('The backend preference changed while it was being checked. Recommend again.'); store.saveSettings(result.settings); hardwareProfiles.settingsChanged(); broadcast(); return snapshot(); },
    getJobMemoryAdvice: async jobId => { const job = jobs.jobs().find(value => value.id === id.parse(jobId)); if (!job || job.status !== 'failed') throw new Error('Choose an existing failed generation to inspect its recovery advice.'); if (isVideoJob(job)) throw new Error('Video recovery details are shown in its queue row. Image memory recommendations do not apply to video.'); return hardwareProfiles.oomAdvice(job.error ?? '', job.draft); },
    setupFaceDetailer: async repair => faceDetailer.setup(z.boolean().optional().parse(repair) ?? false), cancelFaceDetailerSetup: async () => faceDetailer.cancelSetup(), detectFaces: async request => faceDetailer.detect(request), cancelFaceDetection: async () => faceDetailer.cancelDetection(), getFaceDetection: async id => faceDetailer.getDetection(id),
    getRuntimeUpdateStatus: async () => runtimeUpdateSnapshot(),
    saveRuntimeUpdateSettings: async value => { await runtimeUpdates.saveSettings(runtimeUpdateSettingsSchema.partial().parse(value)); automaticRuntimeRetryAfter = 0; scheduleRuntimeIdleCheck(); },
    checkRuntimeUpdates: async () => { await runtimeUpdates.check(); automaticRuntimeRetryAfter = 0; },
    stageRuntimeUpdate: async kind => { await runtimeUpdates.stage(z.enum(['update', 'refresh']).parse(kind)); automaticRuntimeRetryAfter = 0; },
    prepareRuntimeEnvironmentRepair: async () => { if (!runtimeCoordinator.canPrepareEnvironmentRepair()) throw new Error('A verified environment mismatch without a pending transaction is required before preparing this repair.'); await runtimeUpdates.prepareEnvironmentRepair(); automaticRuntimeRetryAfter = 0; },
    activateRuntimeUpdate: async () => { try { await runtimeCoordinator.activateAndRecover(() => runtimeUpdates.activate(), () => runtimeUpdates.recover()); automaticRuntimeRetryAfter = 0; } finally { broadcast(); } },
    rollbackRuntimeUpdate: async () => { await runtimeUpdates.rollback(); automaticRuntimeRetryAfter = 0; },
    recoverRuntimeUpdate: async () => { try { await runtimeCoordinator.recover(() => runtimeUpdates.recover()); automaticRuntimeRetryAfter = 0; } finally { broadcast(); } },
    cancelRuntimeUpdate: async () => runtimeUpdates.cancel(),
    getIPAdapterStatus: async () => ipAdapter.status(),
    stageIPAdapter: async repair => {
      const requested = z.boolean().optional().parse(repair) ?? false;
      if (!requested) { await ipAdapter.stage(); return; }
      await models.library.withExclusive('repairing reference tools', async () => {
        assertModelLocationsReady();
        if (backend.status().state !== 'stopped' || jobs.jobs().some(job => ['queued', 'running'].includes(job.status))) throw new Error('Stop the image engine and finish or cancel its queue before repairing reference tools.');
        await ipAdapter.stage(true);
      });
    },
    activateIPAdapter: async () => { await activateIPAdapterWhenIdle(models.library, backend, jobs, ipAdapter, assertModelLocationsReady); broadcast(); },
    cancelIPAdapterSetup: async () => ipAdapter.cancel(),
    getQwenConversation: async () => { const saved = store.getState('qwen.conversation', null); return saved ? qwenConversationSchema.parse(saved) : null; },
    saveQwenConversation: async value => { store.setState('qwen.conversation', qwenConversationSchema.parse(value)); },
    setupQwenEdit: async (profile, repair) => { const selected = z.enum(['base', 'fast']).parse(profile); const requested = z.boolean().optional().parse(repair) ?? false; if (requested) await jobs.withRuntimeMaintenance(async () => { await backendActivity.assertIdle('repair Qwen assets'); if (backend.hasOwnedProcess()) throw new Error('Stop the image engine before repairing Qwen assets.'); await qwenEdit.setup(selected, true); }, { allowRetainedJobs: false }); else await qwenEdit.setup(selected); },
    cancelQwenEditSetup: async () => { qwenEdit.cancel(); },
    enqueueQwenEdit: async request => models.library.withShared('queuing an image edit', async () => { assertModelLocationsReady(); return jobs.enqueueQwenEdit(request); }),
    chooseExternalModelRoot: async input => {
      const kind = z.enum(['checkpoint', 'lora']).parse(input);
      const blocked = locationChangeBlockedReason(); if (blocked) throw new Error(blocked);
      const result = await dialog.showOpenDialog(window!, { title: `Use an existing ${kind === 'lora' ? 'LoRA' : 'checkpoint'} folder read-only`, properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths[0]) return null;
      await modelLocations.registerExternalRoot(kind, result.filePaths[0]); await models.refresh(); void civitai.autoMetadata(); broadcast();
      return modelLocations.snapshot();
    },
    unregisterExternalModelRoot: async rootId => { await modelLocations.unregisterExternalRoot(id.parse(rootId)); await models.refresh(); void civitai.autoMetadata(); broadcast(); return modelLocations.snapshot(); },
    createModelFolder: async request => { await modelLocations.createFolder(request); await models.refresh(); void civitai.autoMetadata(); broadcast(); return modelLocations.snapshot(); },
    moveModel: async request => { await modelLocations.moveModel(request); await models.refresh(); void civitai.autoMetadata(); broadcast(); return modelLocations.snapshot(); },
    recoverModelLocations: async () => { await modelLocations.recover(); await models.refresh(); void civitai.autoMetadata(); broadcast(); return modelLocations.snapshot(); },
    createCollection: async (kind, name) => collections.create(kind, name), renameCollection: async (collectionId, name) => collections.rename(collectionId, name), removeCollection: async collectionId => collections.remove(collectionId), addCollectionMembers: async (collectionId, memberIds) => collections.addMembers(collectionId, memberIds), removeCollectionMembers: async (collectionId, memberIds) => collections.removeMembers(collectionId, memberIds),
    setupControlNet: async repair => { const requested = z.boolean().optional().parse(repair) ?? false; if (requested) await jobs.withRuntimeMaintenance(async () => { await backendActivity.assertIdle('repair Canny ControlNet'); await controlNet.setup(true); }, { allowRetainedJobs: false }); else await controlNet.setup(); }, cancelControlNet: async () => controlNet.cancel(),
    saveWildcards: entries => wildcards.save(entries), setupUpscaler: async repair => { const requested = z.boolean().optional().parse(repair) ?? false; if (requested) await jobs.withRuntimeMaintenance(async () => { await backendActivity.assertIdle('repair the illustration upscaler'); await upscaler.setup(true); }, { allowRetainedJobs: false }); else await upscaler.setup(); }, cancelUpscaler: async () => upscaler.cancel(),
    fetchModelCivitaiMetadata: async modelId => { await civitai.fetchLocalMetadata(z.string().max(1000).parse(modelId)); return snapshot(); },
    civitaiSearch: async request => civitai.search(request), civitaiDetail: async modelId => civitai.detail(modelId),
    civitaiDownload: async request => {
      try { const asset = await civitai.download(request); notify('notifyDownload', 'Model ready', asset.name); void civitai.autoMetadata(); return asset; }
      catch (error) { if (modelTransferNeedsAttention(error)) notify('notifyError', 'Model download needs attention', errorMessage(error)); throw error; }
    },
    cancelCivitai: async () => civitai.cancel(), getCivitaiSettings: async () => civitai.settings(), setCivitaiKey: async value => { civitai.setApiKey(value); },
    openCivitaiModel: async (modelId, versionId) => { const url = new URL(`https://civitai.com/models/${z.number().int().positive().parse(modelId)}`); if (versionId !== undefined) url.searchParams.set('modelVersionId', String(z.number().int().positive().parse(versionId))); await shell.openExternal(url.href); },
    setupSegmentation: async repair => segmentation.setup(z.boolean().optional().parse(repair) ?? false), startSegmentation: async () => segmentation.start(), stopSegmentation: async () => segmentation.stop(), suggestMask: async request => segmentation.suggest(request), cancelSegmentation: async () => segmentation.cancel(),
    importSourceImage: async () => { const result = await dialog.showOpenDialog(window!, { title: 'Choose a source image', properties: ['openFile'], filters: [{ name: 'Still images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] }); if (result.canceled || !result.filePaths[0]) return null; const source = await sources.importFile(result.filePaths[0]); broadcast(); return source; },
    useOutputAsSource: async recordId => { const source = await sources.importFile(await outputPath(id.parse(recordId)), recordId); broadcast(); return source; },
    saveSourceMask: async (sourceId, bytes, options) => { const mask = await sources.saveMask(id.parse(sourceId), bytes, options); broadcast(); return mask; },
    setupAssistant: async repair => assistant.setup(z.boolean().optional().parse(repair) ?? false), startAssistant: async () => assistant.start(), stopAssistant: async () => assistant.stop(),
    suggestPrompt: async request => assistant.suggest(request), cancelAssistant: async () => assistant.cancel(),
    getAssistantConversation: async target => { const scope = z.enum(['image','video']).optional().parse(target); const saved = store.getState(scope === 'video' ? 'assistant.video.conversation' : 'assistant.conversation', null); return saved ? assistantConversationSchema.parse(saved) : null; },
    saveAssistantConversation: async (value, target) => { const scope = z.enum(['image','video']).optional().parse(target); store.setState(scope === 'video' ? 'assistant.video.conversation' : 'assistant.conversation', assistantConversationSchema.parse(value)); },
    copyText: value => copyStudioText(value, clipboard),
    dismissActivity: async (scope, keys) => { const kind = z.enum(['queue','notifications']).parse(scope); const values = z.array(z.string().max(500)).max(5000).nullable().parse(keys); const prior = store.getState<{queue:string[];notifications:string[]}>('activity.dismissed', {queue:[],notifications:[]}); store.setState('activity.dismissed', {...prior,[kind]:values === null ? [] : [...new Set([...prior[kind],...values])].slice(-10000)}); broadcast(); return snapshot(); },
    getSnapshot: async () => snapshot(),
    changeStorageLocation: async requestedKind => {
      const kind = z.enum(['models','outputs']).parse(requestedKind);
      if (!['stopped','not-installed'].includes(backend.status().state) || models.downloads.some(item => ['downloading','verifying'].includes(item.state))) throw new Error('Stop the engine and finish downloads before changing storage.');
      if (pendingOperations.size > 1) throw new Error('Wait for other studio operations to finish before changing storage.');
      storageChanging = true;
      try {
      const chosen = await dialog.showOpenDialog({ title: `Choose an empty folder for ${kind}`, properties: ['openDirectory','createDirectory'] });
      if (chosen.canceled || !chosen.filePaths[0]) return;
      await models.library.withExclusive('changing studio storage', async () => jobs.withRuntimeMaintenance(async () => { await backendActivity.assertIdle('change studio storage'); await copyStorageLocation(paths, kind, chosen.filePaths[0]); }, { allowRetainedJobs: false }));
      storageRestartPending = true; app.relaunch(); app.quit();
      } finally { storageChanging = false; }
    },
    saveDraft: async value => { draft = draftSchema.parse(value); store.saveDraft(draft); },
    savePreviewSelection: async recordId => { store.savePreviewSelection(recordId); },
    updateSettings: async patch => { const priorMode = store.settings().deviceMode; const settings = store.saveSettings(settingsSchema.partial().parse(patch)); if (settings.deviceMode !== priorMode) hardwareProfiles.settingsChanged(); videoConversations.applyPromptMemoryPolicy(); nativeTheme.themeSource = settings.theme; void civitai.autoMetadata(); broadcast(); return snapshot(); },
    setupBackend: async () => models.library.withShared('setting up the image engine', async () => { assertModelLocationsReady(); await backend.setup(); await backend.start(); }),
    startBackend: async () => startEngine(),
    stopBackend: async () => models.library.withShared('stopping the image engine', async () => jobs.withRuntimeMaintenance(async () => { await backendActivity.assertIdle('stop the image engine'); await backend.stop(); await backendActivity.refresh(); }, { allowRetainedJobs: true })),
    openComfyUI: async () => { assertModelLocationsReady(); const url = backend.getUrl(); if (!url) throw new Error('Start the image engine first.'); await shell.openExternal(url); },
    refreshModels: async () => { await models.refresh(); void civitai.autoMetadata(); return snapshot(); },
    importModels: async input => {
      const kind = z.enum(['checkpoint', 'lora']).parse(input);
      const choice = await dialog.showOpenDialog(window!, { title: `Copy ${kind === 'lora' ? 'LoRAs' : 'checkpoints'} into Latent`, properties: ['openFile', 'multiSelections'], filters: [{ name: 'SafeTensor models', extensions: ['safetensors'] }] });
      if (!choice.canceled) { await models.importFiles(choice.filePaths, kind); void civitai.autoMetadata(); } return snapshot();
    },
    updateModel: async (modelId, changes) => { await models.update(id.parse(modelId), changes); return snapshot(); },
    downloadModel: async request => {
      try { await models.download(request); notify('notifyDownload', 'Model download complete', request.filename); void civitai.autoMetadata(); }
      catch (error) { if (modelTransferNeedsAttention(error)) notify('notifyError', 'Model download needs attention', errorMessage(error)); throw error; }
    },
    cancelDownload: async downloadId => { models.cancelDownload(id.parse(downloadId)); },
    queueGeneration: async value => models.library.withShared('queueing an image', async () => { assertModelLocationsReady(); return jobs.enqueue(value); }),
    queueVideo: async value => models.library.withShared('queueing a video', async () => { const status = videoStatus(); if (!status.canGenerate) throw new Error(status.message); assertModelLocationsReady(); return jobs.enqueueVideo(value); }),
    retryVideoSave: async jobId => jobs.retryVideoSave(id.parse(jobId)),
    cancelJob: async jobId => jobs.cancel(id.parse(jobId)),
    retryJob: async jobId => models.library.withShared('retrying generation', async () => { const selected = id.parse(jobId); const job = jobs.jobs().find(value => value.id === selected); if (job && isVideoJob(job) && !videoStatus().canGenerate) throw new Error(videoStatus().message); assertModelLocationsReady(); return jobs.retry(selected); }),
    reorderJobs: async ids => jobs.reorder(z.array(id).max(10000).parse(ids)),
    savePreset: async preset => { const value = z.object({ id: z.string().max(100), name: z.string().trim().min(1).max(80), draft: draftSchema }).strict().parse(preset); store.savePreset({ ...value, id: value.id || randomUUID() }); broadcast(); return snapshot(); },
    deletePreset: async presetId => { store.deletePreset(id.parse(presetId)); broadcast(); return snapshot(); },
    revealOutput: async recordId => { shell.showItemInFolder(await privateShellPath(paths.outputs, await outputPath(id.parse(recordId)))); },
    openOutput: async recordId => { const error = await shell.openPath(await privateShellPath(paths.outputs, await outputPath(id.parse(recordId)))); if (error) throw new Error(error); },
  };
  for (const [method, handler] of Object.entries(methods)) ipcMain.handle(`latent:${method}`, (event, ...args: unknown[]) => {
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) throw new Error('This request did not come from the studio window.');
    if (closing) throw new Error('The studio is closing.');
    if ((storageChanging || storageRestartPending) && !/^(get|cancel|stop)/.test(method) && !['saveDraft','saveVideoConversation','saveQwenConversation','saveAssistantConversation','savePreviewSelection','copyText'].includes(method)) throw new Error(storageRestartPending ? 'Storage was copied. Restart the studio before changing models or generating again.' : 'Storage is being changed. Wait for copying and restart to finish.');
    return track(Promise.resolve().then(() => (handler as (...values: unknown[]) => unknown)(...args)));
  });
  ipcMain.handle('latent:flush-complete', (event, nonce, error) => {
    const pending = pendingFlush;
    if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url) || !pending || pending.nonce !== nonce) return;
    if (error) pending.reject(new Error(String(error).slice(0, 1000))); else pending.resolve();
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('latent-asset', async request => {
    try {
      const imageResponse = async (filename: string) => { const response = await net.fetch(pathToFileURL(filename).toString()); const headers = new Headers(response.headers); headers.set('Access-Control-Allow-Origin', '*'); headers.set('Cross-Origin-Resource-Policy', 'cross-origin'); headers.set('Content-Type', 'image/png'); return new Response(response.body, { status: response.status, headers }); };
      const url = new URL(request.url);
      if (url.search || url.hash || url.username || url.password || url.port) return new Response('Not found', { status: 404 });
      if (url.hostname === 'video' && /^\/[a-f0-9]{32}$/.test(url.pathname)) return await videoFileResponse(url.pathname === `/${VIDEO_PLAYBACK_FIXTURE_ID}` ? videoFixture : await videoHistory.file(url.pathname.slice(1)), request);
      if (request.method !== 'GET') return new Response('Not found', { status: 404 });
      const assetId = url.pathname.slice(1);
      if (url.hostname === 'output' && /^\/[a-f0-9]{32}$/.test(url.pathname)) return imageResponse(await outputPath(assetId));
      if (url.hostname === 'control-map' && /^[a-f0-9]{32}$/.test(assetId)) return imageResponse(await jobs.controlMapPath(assetId));
      if (url.hostname === 'source' && /^src_[a-f0-9-]{36}$/.test(assetId)) return imageResponse((await sources.resolve(assetId)).normalizedPath);
      if (url.hostname === 'mask' && /^mask_[a-f0-9-]{36}$/.test(assetId)) return imageResponse((await sources.resolveMask(assetId)).path);
      return new Response('Not found', { status: 404 });
    } catch { return new Response('Media unavailable', { status: 404 }); }
  });
  try { await modelLocations.initialize(); } catch (error) { await fs.appendFile(path.join(paths.logs, 'desktop.log'), `${new Date().toISOString()} Model folders need attention: ${errorMessage(error)}\n`); }
  // Recovery precedes JobService.start and every engine launch. Stored jobs stay intact.
  try { await runtimeCoordinator.recover(() => runtimeUpdates.recover()); } catch (error) { await fs.appendFile(path.join(paths.logs, 'desktop.log'), `${new Date().toISOString()} Runtime recovery needs attention: ${errorMessage(error)}\n`); }
  nativeTheme.themeSource = store.settings().theme;
  window = new BrowserWindow({ title: 'Latent v2', width: 1500, height: 980, minWidth: 1000, minHeight: 700, backgroundColor: '#f5f2ec', show: false, autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: true } });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(({ url }) => {
    const known = [...[...MODEL_CATALOG, ...models.assets].flatMap(model => [model.sourceUrl, model.licenseUrl]), IPADAPTER_RELEASE.modelCardUrl, IPADAPTER_RELEASE.encoderOriginUrl, IPADAPTER_RELEASE.codeSourceUrl].filter(Boolean);
    try { const link = new URL(url); if (link.protocol === 'https:' && !link.username && !link.password && known.includes(url)) void shell.openExternal(url).catch(error => { void fs.appendFile(path.join(paths.logs, 'desktop.log'), `${new Date().toISOString()} Could not open model information: ${errorMessage(error)}\n`); }); } catch { /* Unknown links remain blocked. */ }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) event.preventDefault(); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('ready-to-show', () => window?.show());
  window.on('close', event => { if (!closed) { event.preventDefault(); app.quit(); } });
  window.webContents.on('render-process-gone', (_event, details) => { void fs.appendFile(path.join(paths.logs, 'desktop.log'), `${new Date().toISOString()} Renderer ended: ${details.reason}\n`); });
  await window.loadURL(trustedUrl);
  window.show();
  void inventoryHardware(); if (!modelLocations.snapshot().recoveryRequired && !modelLocations.snapshot().error) await track(models.refresh()); if (closing || closed) return; jobs.start();
  runtimeCoordinator.finishStartup(); void civitai.autoMetadata(); runtimeUpdateTimer = setInterval(() => { void automaticRuntimeCheck().catch(() => undefined); }, 30_000); scheduleRuntimeIdleCheck();
  // Optional read-only screenshot evidence for local verification of the real
  // packaged renderer. This never changes the user's saved generation state.
  if (process.env.LATENT_CAPTURE_PATH && !app.isPackaged) setTimeout(async () => { if (window && !window.isDestroyed()) await fs.writeFile(process.env.LATENT_CAPTURE_PATH!, (await window.webContents.capturePage()).toPNG()); }, 2000);
  if (store.settings().backendAutoStart && backend.status().state === 'stopped' && (app.isPackaged || process.env.LATENT_NO_AUTOSTART !== '1')) void startEngine().catch(error => { void fs.appendFile(path.join(paths.logs, 'desktop.log'), `${new Date().toISOString()} ${errorMessage(error)}\n`); });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
  app.whenReady().then(initialize).catch(error => { dialog.showErrorBox('Latent could not open', errorMessage(error)); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (closed) return; event.preventDefault(); if (quitting) return; quitting = true;
    void (async () => {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { pendingFlush = undefined; reject(new Error('The studio did not finish saving its latest draft.')); }, 6000);
            pendingFlush = { nonce: randomUUID(), resolve: () => { clearTimeout(timer); pendingFlush = undefined; resolve(); }, reject: error => { clearTimeout(timer); pendingFlush = undefined; reject(error); } };
            window!.webContents.send('latent:flush-draft', pendingFlush.nonce);
          });
        } catch (error) {
          const choice = await dialog.showMessageBox(window, { type: 'warning', title: 'Your latest draft has not been saved', message: errorMessage(error), buttons: ['Keep studio open', 'Close without latest draft'], defaultId: 0, cancelId: 0 });
          if (choice.response === 0) { quitting = false; window.webContents.send('latent:close-cancelled'); return; }
        }
      }
      try { await backendActivity?.assertNoForeignWork('close the studio'); }
      catch (error) {
        try { if (window && !window.isDestroyed()) { window.webContents.send('latent:close-cancelled'); window.show(); window.focus(); await dialog.showMessageBox(window, { type: 'info', title: 'Shared image engine is still in use', message: errorMessage(error), buttons: ['Keep studio open'], defaultId: 0 }); } }
        finally { quitting = false; }
        return;
      }
      closing = true; backendActivity?.dispose(); if (broadcastTimer) clearTimeout(broadcastTimer); if (runtimeUpdateTimer) clearInterval(runtimeUpdateTimer); if (runtimeIdleTimer) clearTimeout(runtimeIdleTimer);
      models?.dispose();
      modelTransferActions?.dispose();
      civitai?.cancel();
      try { await runtimeUpdates?.dispose(); await jobs?.dispose(); await Promise.allSettled([backend?.dispose(), assistant?.dispose(), segmentation?.dispose(), upscaler?.dispose(), controlNet?.dispose(), qwenEdit?.dispose(), ipAdapter?.dispose(), faceDetailer?.dispose(), videoInspector?.dispose(), videoAssets?.dispose()]); await Promise.allSettled([...pendingOperations]); store?.close(); } finally { closed = true; app.quit(); }
    })();
  });
}

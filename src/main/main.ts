import { configureSetupActivity, setupActivitySnapshot } from './setup-activity';
import { ipcBlockedReason } from './ipc/gate';
import { videoHandlers } from './ipc/video';
import { storageHardwareHandlers } from './ipc/storage-hardware';
import { updatesHandlers } from './ipc/updates';
import { optionalToolsHandlers } from './ipc/optional-tools';
import { libraryHandlers } from './ipc/library';
import { assistantSourcesHandlers } from './ipc/assistant-sources';
import { createDesktopLog } from './desktop-log';
import { AppUpdateService } from './app-updates';
import { withPausedModelEngine } from './model-maintenance';
import {
  setupStorageBlockers,
  setupHardwareBlockers,
  type SetupCapability,
  type SetupPreflight,
} from '../shared/setup';
import { inspectHardware as inspectSetupHardware, nvidiaSmi } from './hardware-profile-probe';
import { copyStorageLocation } from './storage-locations';
import { reviewedRuntimeSet } from './reviewed-runtime-channel';
import {
  app,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  Notification,
  protocol,
  safeStorage,
  session,
  shell,
} from 'electron';
import { copyStudioText } from './clipboard';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { watch as watchFolder, type FSWatcher } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { containedPath, inside } from './paths';
import { MissingOutputs } from './missing-outputs';
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
import { SageAttentionService } from './sage-attention';
import { WildcardStore } from './wildcards';
import { ControlNetService } from './controlnet';
import { CollectionService } from './collections';
import { ModelLocationService } from './model-locations';
import { QwenEditAssetsService } from './qwen-edit-assets';
import { FaceDetailerService } from './face-detailer';
import { IPAdapterService } from './ipadapter';
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
import { VIDEO_AVAILABILITY } from '../shared/video-plan';
import { videoFileResponse, VideoMediaInspector, packagedVideoInspectorPath } from './video-media';
import { VideoHistoryService } from './video-history';
import { VideoAssetsService } from './video-assets';
import { VideoPreflightService } from './video-preflight';
import { localVideoAvailability } from './video-availability';
import { VideoQueueService } from './video-queue';
import { isVideoJob } from '../shared/types';
import { videoPlaybackFixtureFile, VIDEO_PLAYBACK_FIXTURE_ID } from './video-playback-fixture';
import { IPADAPTER_RELEASE } from '../shared/ipadapter-release';
import { MODEL_CATALOG } from '../shared/model-catalog';
import { draftSchema, parseSettingsPatch } from '../shared/validation';
import { TelegramBotService } from './telegram-bot';
import { PhoneRemoteService } from './phone-remote';
import { SIZE_PRESETS } from '../shared/defaults';
import type { AppSnapshot, GenerationDraft, HardwareInfo, LatentAPI } from '../shared/types';
import { SnapshotSender, type LightSnapshot } from './snapshot-sender';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'latent-asset',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  },
]);
const paths = (() => {
  try {
    return createStartupPaths({
      isPackaged: app.isPackaged,
      env: process.env,
      defaultRoot: path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Latentv2'),
    });
  } catch (error) {
    dialog.showErrorBox('Latent could not open its studio', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
})();
const desktopLog = createDesktopLog(paths.logs);
app.setPath('userData', path.join(paths.root, 'desktop'));
app.setPath('sessionData', path.join(paths.root, 'desktop', 'session'));
app.setAppUserModelId('studio.latent.v2');
let window: BrowserWindow | undefined;
let store: StudioStore;
let models: ModelService;
let backend: ManagedBackend;
let jobs: JobService;
let telegram: TelegramBotService;
let phone: PhoneRemoteService;
let assistant: PromptAssistant;
let sources: SourceImageService;
let segmentation: SegmentationService;
let civitai: CivitaiCatalog;
let upscaler: UpscalerService;
let sageAttention: SageAttentionService;
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
let missingOutputs: MissingOutputs;
let outputsWatcher: FSWatcher | undefined;
let outputsCheckTimer: NodeJS.Timeout | undefined;
const videoFixture = videoPlaybackFixtureFile({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  dirname: __dirname,
});
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
function track<T>(promise: Promise<T>): Promise<T> {
  pendingOperations.add(promise);
  promise.then(
    () => pendingOperations.delete(promise),
    () => pendingOperations.delete(promise),
  );
  return promise;
}
let broadcastTimer: NodeJS.Timeout | undefined;
let hardware: HardwareInfo = { os: `${os.type()} ${os.release()}`, arch: os.arch(), ramBytes: os.totalmem() };
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const notifications = new DesktopNotifications({
  settings: () => store.settings(),
  window: () => window,
  closing: () => closing || closed,
  supported: () => Notification.isSupported(),
  create: options => {
    const notice = new Notification(options);
    return {
      onClick: handler => {
        notice.on('click', handler);
      },
      onFailure: handler => {
        notice.on('failed', (_event, error) => handler(error));
      },
      show: () => notice.show(),
    };
  },
  failed: error => {
    void desktopLog(`Notification delivery: ${errorMessage(error)}`);
  },
});
const indexFile = path.join(__dirname, '..', 'dist', 'index.html');
const devUrl = process.env.LATENT_DEV_URL;
if (devUrl && new URL(devUrl).origin !== 'http://127.0.0.1:5174')
  throw new Error('Unsupported development server URL.');
const trustedUrl = devUrl || pathToFileURL(indexFile).toString();
function trusted(value: string) {
  return value.split('#')[0] === trustedUrl;
}
function videoStatus(): AppSnapshot['video'] {
  return localVideoAvailability(
    videoDrafts.status(),
    videoAssets.status(),
    backend.status().state,
    backend.getRuntimeIdentity(),
  );
}
function snapshot(): AppSnapshot {
  return snapshots.snapshot();
}
function lightSnapshot(): LightSnapshot {
  return {
    setupActivity: setupActivitySnapshot(),
    dismissedActivity: store.getState('activity.dismissed', { queue: [], notifications: [] }),
    notifications: store.getState('notifications', []),
    video: videoStatus(),
    backendActivity: backendActivity.status(),
    hardwareProfiles: hardwareProfiles.status(),
    faceDetailer: faceDetailer.status(),
    appUpdates: appUpdates?.status(),
    runtimeUpdates: runtimeUpdateSnapshot(),
    ipAdapter: ipAdapter.status(),
    qwenEdit: qwenEdit.status(),
    modelLocations: modelLocations.snapshot(),
    collections: collections.snapshot(),
    controlNet: controlNet.status(),
    upscaler: upscaler.status(),
    sageAttention: sageAttention.status(),
    wildcards: wildcards.snapshot(),
    backend: backend.status(),
    assistant: assistant.status(),
    segmentation: segmentation.status(),
    sourceImages: sources.list(),
    models: models.assets,
    previewSelectedRecordId: store.previewSelectionId(),
    telegram: telegram?.status(),
    phone: phone?.status(),
    settings: store.settings(),
    draft,
    paths,
    hardware,
    downloads: models.downloads,
  };
}
function runtimeUpdateSnapshot() {
  const status = runtimeUpdates.status();
  const problem = runtimeCoordinator.recoveryProblem();
  if (runtimeCoordinator.isActivationPending())
    return {
      ...status,
      state: 'applying' as const,
      message:
        status.state === 'applying' ? status.message : 'Validating the activated runtime before enabling generation…',
    };
  if (!problem) return status;
  const repairable = runtimeCoordinator.canPrepareEnvironmentRepair();
  const showingOperation = ['staging', 'staged', 'applying'].includes(status.state);
  return {
    ...status,
    state: showingOperation ? status.state : ('error' as const),
    environmentRepairRequired: repairable,
    environmentRepairBytes:
      repairable && status.current ? reviewedRuntimeSet(status.current.setId).environmentPreparationBytes : undefined,
    recoveryRequired: status.recoveryRequired || !repairable,
    message: showingOperation
      ? status.message
      : `${repairable ? 'Environment repair needed' : 'Runtime recovery needs attention'}: ${status.state === 'error' ? status.message : problem}`,
  };
}
async function automaticRuntimeCheck() {
  if (
    closing ||
    closed ||
    storageChanging ||
    storageRestartPending ||
    !runtimeCoordinator ||
    runtimeCoordinator.blockedReason() ||
    automaticRuntimeCheckPending ||
    Date.now() < automaticRuntimeRetryAfter
  )
    return;
  automaticRuntimeCheckPending = true;
  try {
    await track(runtimeUpdates.automaticCheck());
  } catch (error) {
    automaticRuntimeRetryAfter = Date.now() + 15 * 60_000;
    void desktopLog(`Automatic runtime check: ${errorMessage(error)}`);
    notify('notifyError', 'Runtime update needs attention', errorMessage(error));
  } finally {
    automaticRuntimeCheckPending = false;
  }
}
function scheduleRuntimeIdleCheck() {
  if (!runtimeUpdateTimer || runtimeIdleTimer || closing || closed) return;
  runtimeIdleTimer = setTimeout(() => {
    runtimeIdleTimer = undefined;
    void automaticRuntimeCheck().catch(() => undefined);
  }, 1000);
}
let appUpdates: AppUpdateService | undefined;
let appUpdateTimer: NodeJS.Timeout | undefined;
let appUpdateTickRunning = false,
  appInstallClosing = false;
let installerToLaunch: string | undefined;
function appUpdateBusyReason(): string | undefined {
  if (storageChanging || storageRestartPending || pendingOperations.size || modelChangeInProgress)
    return 'Waiting for studio operations to finish.';
  if (
    [
      assistant.status(),
      segmentation.status(),
      faceDetailer.status(),
      qwenEdit.status(),
      upscaler.status(),
      controlNet.status(),
      ipAdapter.status(),
      sageAttention.status(),
    ].some(value =>
      ['installing', 'starting', 'thinking', 'segmenting', 'detecting', 'activating'].includes(value.state),
    )
  )
    return 'Waiting for studio tools to finish.';
  if (modelChangeBlockedReason() || jobs.isProcessing()) return 'Waiting for the image engine and queue.';
  if (
    jobs
      .jobs()
      .some(job =>
        isVideoJob(job)
          ? job.finalization === 'pending'
          : job.status === 'completed' && job.draft.autoFace && !job.autoFaceFinished,
      )
  )
    return 'Waiting for saved media and face refinement.';
  const state = backendActivity.status();
  if (backend.status().state === 'ready' && (state.state !== 'ready' || state.totalRunning || state.totalPending))
    return 'Waiting for the shared image engine.';
  return undefined;
}
async function tickAppUpdates() {
  if (!appUpdates || appUpdateTickRunning || closing || closed || quitting) return;
  appUpdateTickRunning = true;
  try {
    await track(appUpdates.automatic());
    if (appUpdates.status().installRequested && !appUpdateBusyReason()) {
      await backendActivity.assertIdle('install an app update');
      if (appUpdateBusyReason()) return;
      appInstallClosing = true;
      app.quit();
    }
  } catch {
    /* The service reports network errors. Busy installation stays deferred. */
  } finally {
    appUpdateTickRunning = false;
  }
}
let modelChangeInProgress = false;
function modelChangeBlockedReason(): string | undefined {
  if (modelChangeInProgress) return 'Wait for the current model change to finish.';
  const runtimeProblem = runtimeCoordinator?.blockedReason();
  if (runtimeProblem) return runtimeProblem;
  if (!backend || !['ready', 'stopped', 'not-installed'].includes(backend.status().state))
    return 'Wait for the image engine to finish its current operation.';
  if (jobs?.jobs().some(job => ['queued', 'running'].includes(job.status)))
    return 'Finish or cancel queued and running jobs before changing models.';
  if (models?.downloads.some(item => ['downloading', 'verifying'].includes(item.state)))
    return 'Wait for model downloads to finish before changing files.';
  return undefined;
}
async function changeModelFiles<T>(operation: () => Promise<T>): Promise<T> {
  const blocked = modelChangeBlockedReason();
  if (blocked) throw new Error(blocked);
  modelChangeInProgress = true;
  broadcast();
  try {
    return await jobs.withRuntimeMaintenance(
      async () => {
        await backendActivity.assertIdle('change model files');
        return withPausedModelEngine(
          backend,
          operation,
          () => models.refresh(),
          () => startEngine(true),
          error =>
            notify(
              'notifyError',
              'Image engine needs attention',
              `Start the engine when ready. ${errorMessage(error)}`,
            ),
        );
      },
      { allowRetainedJobs: false },
    );
  } finally {
    modelChangeInProgress = false;
    broadcast();
  }
}
function locationChangeBlockedReason(): string | undefined {
  if (!backend || !['stopped', 'not-installed'].includes(backend.status().state))
    return 'Stop the image engine before changing model folders.';
  if (jobs?.jobs().some(job => ['queued', 'running'].includes(job.status)))
    return 'Finish or cancel queued and running jobs before changing model folders.';
  return undefined;
}
function assertModelLocationsReady(allowModelChange = false) {
  if (appInstallClosing) throw new Error('The studio is closing to install an update.');
  if (modelChangeInProgress && !allowModelChange) throw new Error('Wait for the model change to finish.');
  const runtimeProblem = runtimeCoordinator?.blockedReason();
  if (runtimeProblem) throw new Error(runtimeProblem);
  if (ipAdapter?.status().state === 'activating')
    throw new Error('Wait for reference-tool activation to finish before starting or queuing generation.');
  const state = modelLocations.snapshot();
  if (state.recoveryRequired || state.error)
    throw new Error(state.error || 'Recover the interrupted model move in Models before starting generation.');
}
function startEngine(allowModelChange = false) {
  return models.library.withShared('starting the image engine', async () => {
    assertModelLocationsReady(allowModelChange);
    await backend.start();
  });
}
/** Serialized form of each top-level snapshot field as the renderer last received it. */
const snapshots = new SnapshotSender({
  light: lightSnapshot,
  history: () => missingOutputs.visible(store.records()),
  historyRevision: () => `${store.recordsRevision}:${missingOutputs.revision}`,
  presets: () => store.presets(),
  presetsRevision: () => store.presetsRevision,
  jobs: {
    jobs: () => jobs.jobs(),
    jobOrder: () => jobs.jobOrder(),
    jobSnapshot: id => jobs.jobSnapshot(id),
    takeChangedJobIds: () => jobs.takeChangedJobIds(),
  },
});
function broadcast() {
  scheduleRuntimeIdleCheck();
  if (closed || closing || broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = undefined;
    if (window && !window.isDestroyed() && store && models && jobs && backend) {
      const patch = snapshots.patch();
      if (patch) window.webContents.send('latent:snapshot', patch);
    }
  }, 120);
}
function notify(preference: NotificationPreference, title: string, body: string) {
  if (store.settings()[preference]) {
    const recent = store.getState<NonNullable<AppSnapshot['notifications']>>('notifications', []);
    store.setState(
      'notifications',
      [{ id: randomUUID(), title, body, at: new Date().toISOString(), preference }, ...recent].slice(0, 50),
    );
    broadcast();
  }
  notifications.send(preference, title, body);
}
/** Files the outputs watcher named since the last check; undefined means look at everything. */
let changedOutputs: Set<string> | undefined;
function scheduleOutputsCheck(file?: string) {
  if (closing || closed) return;
  if (!file) changedOutputs = undefined;
  else if (changedOutputs || !outputsCheckTimer) (changedOutputs ??= new Set()).add(path.join(paths.outputs, file));
  if (outputsCheckTimer) return;
  outputsCheckTimer = setTimeout(() => {
    outputsCheckTimer = undefined;
    const files = changedOutputs;
    changedOutputs = undefined;
    void missingOutputs.refresh(files).catch(error => void desktopLog(`Image check failed: ${errorMessage(error)}`));
  }, 400);
}
function watchOutputs() {
  try {
    // Only the files the watcher names are re-checked, so each new image costs one check, not one per image.
    outputsWatcher = watchFolder(paths.outputs, { recursive: true }, (_event, file) =>
      scheduleOutputsCheck(file ? String(file) : undefined),
    );
    outputsWatcher.on('error', () => {
      outputsWatcher?.close();
      outputsWatcher = undefined;
    });
  } catch {
    // Window focus still re-checks when the folder cannot be watched.
  }
}
async function outputPath(id: string) {
  const record = store.record(id);
  if (!record) throw new Error('This image is not in your library.');
  const file = containedPath(paths.outputs, record.filename);
  const real = await fs.realpath(file);
  if (
    !inside(await fs.realpath(paths.outputs), real) ||
    (await fs.lstat(file)).isSymbolicLink() ||
    !file.endsWith('.png')
  )
    throw new Error('The image file is outside this studio.');
  return file;
}
async function inventoryHardware() {
  try {
    const result = await promisify(execFile)(
      nvidiaSmi(),
      ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 8000, maxBuffer: 16384 },
    );
    const [gpuName, vram, driver] = result.stdout
      .trim()
      .split('\n')[0]
      .split(',')
      .map(s => s.trim());
    hardware = { ...hardware, gpuName, vramMiB: Number(vram), driver };
    broadcast();
  } catch {
    /* The studio remains usable on machines without NVIDIA tooling. */
  }
}
const id = z.string().min(1).max(1000);
export type StudioMethods = Omit<LatentAPI, 'onSnapshot' | 'onBeforeClose' | 'onCloseCancelled'>;
/**
 * What the per-domain IPC handlers in ./ipc may use. Getters keep late binding: services are
 * created in initialize() and some values are reassigned while the app runs.
 */
function handlerContext() {
  return {
    get appUpdates() {
      return appUpdates;
    },
    assertModelLocationsReady,
    get assistant() {
      return assistant;
    },
    get automaticRuntimeRetryAfter() {
      return automaticRuntimeRetryAfter;
    },
    set automaticRuntimeRetryAfter(value: number) {
      automaticRuntimeRetryAfter = value;
    },
    get backend() {
      return backend;
    },
    get backendActivity() {
      return backendActivity;
    },
    broadcast,
    changeModelFiles,
    get civitai() {
      return civitai;
    },
    get collections() {
      return collections;
    },
    get controlNet() {
      return controlNet;
    },
    errorMessage,
    get faceDetailer() {
      return faceDetailer;
    },
    get hardwareProfiles() {
      return hardwareProfiles;
    },
    id,
    get ipAdapter() {
      return ipAdapter;
    },
    get jobs() {
      return jobs;
    },
    modelChangeBlockedReason,
    get modelLocations() {
      return modelLocations;
    },
    get models() {
      return models;
    },
    notify,
    outputPath,
    paths,
    get qwenEdit() {
      return qwenEdit;
    },
    get runtimeCoordinator() {
      return runtimeCoordinator;
    },
    runtimeUpdateSnapshot,
    get runtimeUpdates() {
      return runtimeUpdates;
    },
    scheduleRuntimeIdleCheck,
    get segmentation() {
      return segmentation;
    },
    snapshot,
    get sources() {
      return sources;
    },
    get storageOverview() {
      return storageOverview;
    },
    get store() {
      return store;
    },
    tickAppUpdates,
    get upscaler() {
      return upscaler;
    },
    get videoAssets() {
      return videoAssets;
    },
    get videoConversations() {
      return videoConversations;
    },
    get videoDrafts() {
      return videoDrafts;
    },
    videoFixture,
    get videoHistory() {
      return videoHistory;
    },
    get wildcards() {
      return wildcards;
    },
    get window() {
      return window;
    },
  };
}
export type HandlerContext = ReturnType<typeof handlerContext>;
async function initialize() {
  configureSetupActivity(paths.logs, broadcast);
  store = new StudioStore(paths.database);
  missingOutputs = new MissingOutputs(
    () => store.records(),
    record => containedPath(paths.outputs, record.filename),
    broadcast,
  );
  draft = store.draft();
  models = new ModelService(paths, store, broadcast);
  assistant = new PromptAssistant(paths, store, broadcast);
  sources = new SourceImageService(paths, store);
  videoConversations = new VideoConversationService(store);
  videoDrafts = new VideoDraftService(store);
  videoInspector = new VideoMediaInspector({
    get python() {
      return paths.python;
    },
    workerPath: packagedVideoInspectorPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      dirname: __dirname,
    }),
  });
  videoHistory = new VideoHistoryService(paths, store, videoInspector);
  // User-supplied files only: no acquisition and no assertion of a publisher license grant.
  videoAssets = new VideoAssetsService(
    paths,
    () => ({
      schema: 1,
      recordId: 'user-requested-video-setup-20260909',
      licenseUrl: VIDEO_AVAILABILITY.licenseUrl,
      resolvedAt: '2026-09-09T00:00:00.000Z',
      scope: 'acquisition-and-use',
    }),
    broadcast,
  );
  faceDetailer = new FaceDetailerService(paths, store, broadcast, sources);
  segmentation = new SegmentationService(paths, store, broadcast, sources);
  civitai = new CivitaiCatalog(paths, store, models, broadcast, safeStorage);

  modelTransferActions = new ModelTransferActions({
    models,
    civitai,
    assertReady: assertModelLocationsReady,
    changed: broadcast,
    completed: name => {
      notify('notifyDownload', 'Model download complete', name);
    },
    failed: message => {
      notify('notifyError', 'Model download needs attention', message);
    },
  });
  upscaler = new UpscalerService(paths, store, broadcast);
  sageAttention = new SageAttentionService(paths, broadcast);
  wildcards = new WildcardStore(store, broadcast);
  controlNet = new ControlNetService(paths, store, broadcast);
  qwenEdit = new QwenEditAssetsService(paths, store, broadcast);
  collections = new CollectionService(
    store,
    () => ({ modelIds: models.assets.map(model => model.id), recordIds: store.records().map(record => record.id) }),
    broadcast,
  );
  backend = new ManagedBackend(
    paths,
    state => {
      notifications.backendChanged(state);
      broadcast();
    },
    () => store.settings(),
    () => modelLocations.backendRoots(),
  );
  ipAdapter = new IPAdapterService(
    paths,
    broadcast,
    () => backend.status().state === 'stopped' && !jobs?.jobs().some(job => ['queued', 'running'].includes(job.status)),
  );
  backendActivity = new BackendActivityService(
    {
      waitForStartup: () => backend.waitForStartup(),
      getBackend: () => ({
        state: backend.status().state,
        url: backend.getUrl(),
        hasOwnedProcess: backend.hasOwnedProcess(),
      }),
      getOwnedPrompts: () =>
        jobs
          ?.jobs()
          .filter(job => job.promptId)
          .map(job => ({ jobId: job.id, promptId: job.promptId! })) ?? [],
    },
    broadcast,
  );
  const videoPreflight = new VideoPreflightService(paths, videoAssets, sources, backend, {
    blockedReason: () =>
      runtimeCoordinator?.blockedReason() ??
      (!runtimeCoordinator ? 'Checking interrupted runtime maintenance.' : undefined),
  });
  const videoQueue = new VideoQueueService(paths, videoPreflight, videoHistory);
  jobs = new JobService(
    paths,
    store,
    models,
    backend,
    broadcast,
    job => {
      notifications.jobFinished(job);
      telegram?.jobFinished(job);
    },
    app.getVersion(),
    upscaler,
    controlNet,
    qwenEdit,
    ipAdapter,
    () =>
      appInstallClosing
        ? 'The studio is closing to install an update.'
        : (runtimeCoordinator?.blockedReason() ??
          (!runtimeCoordinator ? 'Checking for interrupted runtime maintenance before generation.' : undefined)),
    faceDetailer,
    backendActivity,
    videoQueue,
  );
  telegram = new TelegramBotService({
    store,
    crypto: safeStorage,
    fetch: (input, init) => fetch(input, init),
    draft: () => draft,
    models: () => models.assets,
    presets: () => store.presets(),
    sizes: () => store.settings().sizePresets ?? SIZE_PRESETS,
    queue: value =>
      models.library.withShared('queueing an image from Telegram', async () => {
        assertModelLocationsReady();
        return jobs.enqueue(value);
      }),
    jobs: () => jobs.jobs(),
    cancel: jobId => jobs.cancel(jobId),
    backend: () => backend.status(),
    blockedReason: () =>
      ipcBlockedReason('queueGeneration', { closing, appInstallClosing, storageChanging, storageRestartPending }),
    readOutput: async record => fs.readFile(await outputPath(record.id)),
    changed: broadcast,
    log: text => void desktopLog(text),
  });
  phone = new PhoneRemoteService({
    store,
    draft: () => draft,
    models: () => models.assets,
    history: () => missingOutputs.visible(store.records()),
    jobs: () => jobs.jobs(),
    queue: value =>
      models.library.withShared('queueing an image from the phone page', async () => {
        assertModelLocationsReady();
        return jobs.enqueue(value);
      }),
    cancel: jobId => jobs.cancel(jobId),
    blockedReason: () =>
      ipcBlockedReason('queueGeneration', { closing, appInstallClosing, storageChanging, storageRestartPending }),
    readOutput: async record => fs.readFile(await outputPath(record.id)),
    changed: broadcast,
    log: text => void desktopLog(text),
  });
  runtimeCoordinator = new RuntimeUpdateCoordinator(models.library, backend, jobs, () => runtimeUpdates.status());
  runtimeUpdates = new RuntimeUpdateService(paths, store, broadcast, runtimeCoordinator.hooks);
  modelLocations = new ModelLocationService(
    paths,
    store,
    models,
    {
      assertChangesAllowed: () => {
        const reason = locationChangeBlockedReason();
        if (reason) throw new Error(reason);
      },
      changeBlockedReason: modelChangeBlockedReason,
    },
    broadcast,
  );
  storageOverview = new StorageOverviewService(paths, {
    catalog: () =>
      builtInStorageCatalog(paths, {
        video: videoStatus(),
        backend: backend.status(),
        assistant: assistant.status(),
        qwenEdit: qwenEdit.status(),
        ipAdapter: ipAdapter.status(),
        controlNet: controlNet.status(),
        segmentation: segmentation.status(),
        upscaler: upscaler.status(),
        faceDetailer: faceDetailer.status(),
      }),
    transfers: () => models.downloads,
  });
  hardwareProfiles = new HardwareProfilesService(paths, store, broadcast, {
    getRuntimeIdentity: () => backend.getRuntimeIdentity(),
    getBackendUrl: () => backend.getUrl(),
    getSettings: () => store.settings(),
    getModels: () => models.assets,
    getSource: async sourceId => (await sources.resolve(sourceId)).source,
    getMask: async maskId => (await sources.resolveMask(maskId)).mask,
    isUpscalerReady: () => upscaler.status().state === 'ready',
  });
  const installed =
    app.isPackaged &&
    process.platform === 'win32' &&
    process.arch === 'x64' &&
    !process.env.PORTABLE_EXECUTABLE_FILE &&
    (await fs.access(path.join(path.dirname(process.execPath), 'Uninstall Latent v2.exe')).then(
      () => true,
      () => false,
    ));
  appUpdates = new AppUpdateService(paths.root, store, app.getVersion(), Boolean(installed), broadcast);
  appUpdateTimer = setInterval(() => void tickAppUpdates(), 30000);
  let guidedSetupRunning = false;
  const preflightSetup = async (raw: SetupCapability): Promise<SetupPreflight> => {
    const capability = z.enum(['engine', 'images', 'edit', 'video']).parse(raw);
    const hardware = await inspectSetupHardware(paths, null);
    const storage = await storageOverview.packageStorage(
      capability === 'engine'
        ? 'backend'
        : capability === 'edit'
          ? 'qwen-lightning8'
          : capability === 'video'
            ? 'video-fused4'
            : 'backend',
    );
    const blockers = setupHardwareBlockers(hardware, capability);
    if (capability !== 'engine' && backend.status().state !== 'ready')
      blockers.push('Set up and start the generation engine first.');
    if (capability === 'video' && !videoAssets.status().canAcquire)
      blockers.push('Automatic video acquisition is unavailable. Review video setup in the Video tab.');
    if (capability === 'images') {
      const capacity = await storageOverview.downloadCapacity();
      const destination = capacity.destinations.find(d => d.id === capacity.modelDownloadDestinations?.checkpoint);
      storage.destinations = destination ? [destination] : [];
      storage.volumes = capacity.volumes.filter(v => v.id === destination?.volumeId);
      storage.package.minimumDownloadBytes = models.assets.some(
        m => m.kind === 'checkpoint' && m.status === 'ready' && ['sdxl', 'illustrious'].includes(m.family),
      )
        ? 0
        : MODEL_CATALOG.find(m => m.id === 'onoma-illustrious-xl-1.1')!.bytes;
    }
    blockers.push(...setupStorageBlockers(storage, capability));
    return {
      capability,
      checkedAt: new Date().toISOString(),
      blockers,
      warnings: [
        capability === 'engine'
          ? 'Reserve at least 15 GiB for engine setup. Actual download size varies; this is a planning allowance.'
          : 'The download estimate excludes runtime packages; an additional 2 GiB allowance is checked in each destination.',
        'Hardware eligibility is a starting check. Setup verifies installed components before use.',
      ],
      gpu: hardware.gpus.length === 1 ? hardware.gpus[0].name : undefined,
      storage,
    };
  };
  const methods: StudioMethods = {
    getSetupPreflight: preflightSetup,
    runGuidedSetup: async capability => {
      if (guidedSetupRunning) throw new Error('A setup operation is already running.');
      guidedSetupRunning = true;
      try {
        const check = await preflightSetup(capability);
        if (check.blockers.length) throw new Error(check.blockers.join(' '));
        if (capability === 'engine') {
          if (backend.status().state === 'stopped') await methods.startBackend();
          else if (backend.status().state !== 'ready') await methods.setupBackend();
        } else if (capability === 'images') {
          if (
            !models.assets.some(
              m => m.kind === 'checkpoint' && m.status === 'ready' && ['sdxl', 'illustrious'].includes(m.family),
            )
          ) {
            const {
              id: _id,
              name: _name,
              publisher: _publisher,
              description: _description,
              bytes: _bytes,
              ...request
            } = MODEL_CATALOG.find(m => m.id === 'onoma-illustrious-xl-1.1')!;
            await methods.downloadModel(request);
          }
        } else if (capability === 'edit') await methods.setupQwenEdit('lightning8');
        else await methods.setupVideoAssets('fused4');
      } finally {
        guidedSetupRunning = false;
      }
    },
    getModelTransferRecovery: async () => modelTransferActions.recovery(),
    retryModelTransfer: async request => modelTransferActions.retry(request),
    cancelModelTransfer: async transferId => modelTransferActions.cancel(transferId),
    copyText: value => copyStudioText(value, clipboard),
    dismissActivity: async (scope, keys) => {
      const kind = z.enum(['queue', 'notifications']).parse(scope);
      const values = z.array(z.string().max(500)).max(5000).nullable().parse(keys);
      const prior = store.getState<{ queue: string[]; notifications: string[] }>('activity.dismissed', {
        queue: [],
        notifications: [],
      });
      store.setState('activity.dismissed', {
        ...prior,
        [kind]: values === null ? [] : [...new Set([...prior[kind], ...values])].slice(-10000),
      });
      broadcast();
      return snapshot();
    },
    getSnapshot: async () => snapshots.remember(snapshot()),
    changeStorageLocation: async requestedKind => {
      const kind = z.enum(['models', 'outputs']).parse(requestedKind);
      if (
        !['stopped', 'not-installed'].includes(backend.status().state) ||
        models.downloads.some(item => ['downloading', 'verifying'].includes(item.state))
      )
        throw new Error('Stop the engine and finish downloads before changing storage.');
      if (pendingOperations.size > 1)
        throw new Error('Wait for other studio operations to finish before changing storage.');
      storageChanging = true;
      try {
        const chosen = await dialog.showOpenDialog({
          title: `Choose an empty folder for ${kind}`,
          properties: ['openDirectory', 'createDirectory'],
        });
        if (chosen.canceled || !chosen.filePaths[0]) return;
        await models.library.withExclusive('changing studio storage', async () =>
          jobs.withRuntimeMaintenance(
            async () => {
              await backendActivity.assertIdle('change studio storage');
              await copyStorageLocation(paths, kind, chosen.filePaths[0]);
            },
            { allowRetainedJobs: false },
          ),
        );
        storageRestartPending = true;
        app.relaunch();
        app.quit();
      } finally {
        storageChanging = false;
      }
    },
    saveDraft: async value => {
      draft = draftSchema.parse(value);
      store.saveDraft(draft);
    },
    savePreviewSelection: async recordId => {
      store.savePreviewSelection(recordId);
    },
    updateSettings: async patch => {
      const priorMode = store.settings().deviceMode;
      const settings = store.saveSettings(parseSettingsPatch(patch));
      if (settings.deviceMode !== priorMode) hardwareProfiles.settingsChanged();
      videoConversations.applyPromptMemoryPolicy();
      nativeTheme.themeSource = settings.theme;
      void civitai.autoMetadata();
      broadcast();
      return snapshot();
    },
    saveTelegramSettings: async value => telegram.saveSettings(value),
    setTelegramToken: async value => telegram.setToken(value),
    savePhoneSettings: async value => phone.saveSettings(value),
    newPhoneCode: async () => phone.newCode(),
    forgetPhones: async () => phone.forgetPhones(),
    setupBackend: async () =>
      models.library.withShared('setting up the image engine', async () => {
        assertModelLocationsReady();
        await backend.setup();
        await backend.start();
      }),
    startBackend: async () => startEngine(),
    stopBackend: async () =>
      models.library.withShared('stopping the image engine', async () =>
        jobs.withRuntimeMaintenance(
          async () => {
            await backendActivity.assertIdle('stop the image engine');
            await backend.stop();
            await backendActivity.refresh();
          },
          { allowRetainedJobs: true },
        ),
      ),
    checkSageAttention: async () => sageAttention.refresh(),
    installSageAttention: async () => {
      let restart = false;
      try {
        await models.library.withShared('installing SageAttention', async () => {
          assertModelLocationsReady();
          if (['not-installed', 'installing'].includes(backend.status().state))
            throw new Error('Set up the engine first.');
          await jobs.withRuntimeMaintenance(
            async () => {
              await backendActivity.assertIdle('install SageAttention');
              if (backend.status().state !== 'stopped') {
                restart = true;
                await backend.stop();
                await backendActivity.refresh();
              }
              await sageAttention.install();
            },
            { allowRetainedJobs: false },
          );
          store.saveSettings({ sageAttention: true });
        });
      } finally {
        broadcast();
        // Bring the engine back even when the install fails; it simply starts without the add-on.
        if (restart) await startEngine();
      }
    },
    openComfyUI: async () => {
      assertModelLocationsReady();
      const url = backend.getUrl();
      if (!url) throw new Error('Start the image engine first.');
      await shell.openExternal(url);
    },
    refreshModels: async () => {
      await models.refresh();
      void civitai.autoMetadata();
      return snapshot();
    },
    importModels: async input => {
      const kind = z.enum(['checkpoint', 'lora']).parse(input);
      const choice = await dialog.showOpenDialog(window!, {
        title: `Copy ${kind === 'lora' ? 'LoRAs' : 'checkpoints'} into Latent`,
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'SafeTensor models', extensions: ['safetensors'] }],
      });
      if (!choice.canceled) {
        await changeModelFiles(() => models.importFiles(choice.filePaths, kind));
        void civitai.autoMetadata();
      }
      return snapshot();
    },
    updateModel: async (modelId, changes) => {
      await models.update(id.parse(modelId), changes);
      return snapshot();
    },
    downloadModel: async request => {
      try {
        await models.download(request);
        notify('notifyDownload', 'Model download complete', request.filename);
        void civitai.autoMetadata();
      } catch (error) {
        if (modelTransferNeedsAttention(error))
          notify('notifyError', 'Model download needs attention', errorMessage(error));
        throw error;
      }
    },
    cancelDownload: async downloadId => {
      models.cancelDownload(id.parse(downloadId));
    },
    queueGeneration: async value =>
      models.library.withShared('queueing an image', async () => {
        assertModelLocationsReady();
        return jobs.enqueue(value);
      }),
    queueVideo: async value =>
      models.library.withShared('queueing a video', async () => {
        const status = videoStatus();
        if (!status.canGenerate) throw new Error(status.message);
        assertModelLocationsReady();
        return jobs.enqueueVideo(value);
      }),
    retryVideoSave: async jobId => jobs.retryVideoSave(id.parse(jobId)),
    cancelJob: async jobId => jobs.cancel(id.parse(jobId)),
    retryJob: async jobId =>
      models.library.withShared('retrying generation', async () => {
        const selected = id.parse(jobId);
        const job = jobs.jobs().find(value => value.id === selected);
        if (job && isVideoJob(job) && !videoStatus().canGenerate) throw new Error(videoStatus().message);
        assertModelLocationsReady();
        return jobs.retry(selected);
      }),
    reorderJobs: async ids => jobs.reorder(z.array(id).max(10000).parse(ids)),
    savePreset: async preset => {
      const value = z
        .object({ id: z.string().max(100), name: z.string().trim().min(1).max(80), draft: draftSchema })
        .strict()
        .parse(preset);
      store.savePreset({ ...value, id: value.id || randomUUID() });
      broadcast();
      return snapshot();
    },
    deletePreset: async presetId => {
      store.deletePreset(id.parse(presetId));
      broadcast();
      return snapshot();
    },
    copyOutput: async recordId => {
      const filename = await privateShellPath(paths.outputs, await outputPath(id.parse(recordId)));
      const image = nativeImage.createFromPath(filename);
      if (image.isEmpty()) throw new Error('The saved image could not be loaded.');
      await clipboard.write([
        new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) }),
      ]);
    },
    revealOutput: async recordId => {
      shell.showItemInFolder(await privateShellPath(paths.outputs, await outputPath(id.parse(recordId))));
    },
    trashOutputs: async recordIds => {
      const files = await Promise.all(
        z
          .array(id)
          .min(1)
          .max(500)
          .parse(recordIds)
          .map(async recordId => privateShellPath(paths.outputs, await outputPath(recordId))),
      );
      // The Recycle Bin is the undo: restoring a file brings its image back on the next check.
      for (const file of files) await shell.trashItem(file);
      await missingOutputs.refresh();
      broadcast();
    },
    openOutput: async recordId => {
      const error = await shell.openPath(await privateShellPath(paths.outputs, await outputPath(id.parse(recordId))));
      if (error) throw new Error(error);
    },
    ...videoHandlers(handlerContext()),
    ...storageHardwareHandlers(handlerContext()),
    ...updatesHandlers(handlerContext()),
    ...optionalToolsHandlers(handlerContext()),
    ...libraryHandlers(handlerContext()),
    ...assistantSourcesHandlers(handlerContext()),
  };
  for (const [method, handler] of Object.entries(methods))
    ipcMain.handle(`latent:${method}`, (event, ...args: unknown[]) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        !trusted(event.senderFrame.url)
      )
        throw new Error('This request did not come from the studio window.');
      const blocked = ipcBlockedReason(method, { closing, appInstallClosing, storageChanging, storageRestartPending });
      if (blocked) throw new Error(blocked);
      return track(Promise.resolve().then(() => (handler as (...values: unknown[]) => unknown)(...args)));
    });
  ipcMain.handle('latent:flush-complete', (event, nonce, error) => {
    const pending = pendingFlush;
    if (
      !window ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !trusted(event.senderFrame.url) ||
      !pending ||
      pending.nonce !== nonce
    )
      return;
    if (error) pending.reject(new Error(String(error).slice(0, 1000)));
    else pending.resolve();
  });
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle('latent-asset', async request => {
    try {
      const imageResponse = async (filename: string) => {
        const response = await net.fetch(pathToFileURL(filename).toString());
        const headers = new Headers(response.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
        headers.set('Content-Type', 'image/png');
        return new Response(response.body, { status: response.status, headers });
      };
      const url = new URL(request.url);
      if (url.search || url.hash || url.username || url.password || url.port)
        return new Response('Not found', { status: 404 });
      if (url.hostname === 'video' && /^\/[a-f0-9]{32}$/.test(url.pathname))
        return await videoFileResponse(
          url.pathname === `/${VIDEO_PLAYBACK_FIXTURE_ID}`
            ? videoFixture
            : await videoHistory.file(url.pathname.slice(1)),
          request,
        );
      if (request.method !== 'GET') return new Response('Not found', { status: 404 });
      const assetId = url.pathname.slice(1);
      if (url.hostname === 'output' && /^\/[a-f0-9]{32}$/.test(url.pathname))
        return imageResponse(await outputPath(assetId));
      if (url.hostname === 'control-map' && /^[a-f0-9]{32}$/.test(assetId))
        return imageResponse(await jobs.controlMapPath(assetId));
      if (url.hostname === 'source' && /^src_[a-f0-9-]{36}$/.test(assetId))
        return imageResponse((await sources.resolve(assetId)).normalizedPath);
      if (url.hostname === 'mask' && /^mask_[a-f0-9-]{36}$/.test(assetId))
        return imageResponse((await sources.resolveMask(assetId)).path);
      return new Response('Not found', { status: 404 });
    } catch {
      return new Response('Media unavailable', { status: 404 });
    }
  });
  try {
    await modelLocations.initialize();
  } catch (error) {
    void desktopLog(`Model folders need attention: ${errorMessage(error)}`);
  }
  // Recovery precedes JobService.start and every engine launch. Stored jobs stay intact.
  try {
    await runtimeCoordinator.recover(() => runtimeUpdates.recover());
  } catch (error) {
    void desktopLog(`Runtime recovery needs attention: ${errorMessage(error)}`);
  }
  nativeTheme.themeSource = store.settings().theme;
  const windowIcon = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'resources', 'latent-icon.ico')
    : path.join(__dirname, 'resources', 'latent-icon.ico');
  window = new BrowserWindow({
    title: 'Latent v2',
    icon: windowIcon,
    width: 1500,
    height: 980,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#f5f2ec',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  if (process.platform === 'win32')
    window.setAppDetails({ appId: 'studio.latent.v2', appIconPath: windowIcon, appIconIndex: 0 });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(({ url }) => {
    const known = [
      ...[...MODEL_CATALOG, ...models.assets].flatMap(model => [model.sourceUrl, model.licenseUrl]),
      IPADAPTER_RELEASE.modelCardUrl,
      IPADAPTER_RELEASE.encoderOriginUrl,
      IPADAPTER_RELEASE.codeSourceUrl,
    ].filter(Boolean);
    try {
      const link = new URL(url);
      if (link.protocol === 'https:' && !link.username && !link.password && known.includes(url))
        void shell.openExternal(url).catch(error => {
          void desktopLog(`Could not open model information: ${errorMessage(error)}`);
        });
    } catch {
      /* Unknown links remain blocked. */
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!trusted(url)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.on('ready-to-show', () => window?.show());
  // Images deleted outside the app leave the gallery and sidebar on the next check.
  window.on('focus', () => scheduleOutputsCheck());
  window.on('close', event => {
    if (!closed) {
      event.preventDefault();
      app.quit();
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    void desktopLog(`Renderer ended: ${details.reason}`);
  });
  await window.loadURL(trustedUrl);
  window.show();
  watchOutputs();
  scheduleOutputsCheck();
  void inventoryHardware();
  if (!modelLocations.snapshot().recoveryRequired && !modelLocations.snapshot().error) await track(models.refresh());
  if (closing || closed) return;
  jobs.start();
  telegram.start();
  phone.start();
  runtimeCoordinator.finishStartup();
  void civitai.autoMetadata();
  runtimeUpdateTimer = setInterval(() => {
    void automaticRuntimeCheck().catch(() => undefined);
  }, 30_000);
  scheduleRuntimeIdleCheck();
  // Optional read-only screenshot evidence for local verification of the real
  // packaged renderer. This never changes the user's saved generation state.
  if (process.env.LATENT_CAPTURE_PATH && !app.isPackaged)
    setTimeout(async () => {
      if (window && !window.isDestroyed())
        await fs.writeFile(process.env.LATENT_CAPTURE_PATH!, (await window.webContents.capturePage()).toPNG());
    }, 2000);
  void sageAttention.refresh();
  if (
    store.settings().backendAutoStart &&
    backend.status().state === 'stopped' &&
    (app.isPackaged || process.env.LATENT_NO_AUTOSTART !== '1')
  )
    void startEngine().catch(error => {
      void desktopLog(`${errorMessage(error)}`);
    });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(initialize)
    .catch(error => {
      dialog.showErrorBox('Latent could not open', errorMessage(error));
      app.quit();
    });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    if (closed) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingFlush = undefined;
              reject(new Error('The studio did not finish saving its latest draft.'));
            }, 6000);
            pendingFlush = {
              nonce: randomUUID(),
              resolve: () => {
                clearTimeout(timer);
                pendingFlush = undefined;
                resolve();
              },
              reject: error => {
                clearTimeout(timer);
                pendingFlush = undefined;
                reject(error);
              },
            };
            window!.webContents.send('latent:flush-draft', pendingFlush.nonce);
          });
        } catch (error) {
          if (appInstallClosing) {
            appUpdates?.cancelInstall('Save your open edits before installing. The update is still downloaded.');
            appInstallClosing = false;
            installerToLaunch = undefined;
            quitting = false;
            window.webContents.send('latent:close-cancelled');
            return;
          }
          const choice = await dialog.showMessageBox(window, {
            type: 'warning',
            title: 'Your latest draft has not been saved',
            message: errorMessage(error),
            buttons: ['Keep studio open', 'Close without latest draft'],
            defaultId: 0,
            cancelId: 0,
          });
          if (choice.response === 0) {
            quitting = false;
            window.webContents.send('latent:close-cancelled');
            return;
          }
        }
      }
      if (appInstallClosing) {
        try {
          if (appUpdateBusyReason())
            throw new Error('Studio work is still finishing. Request installation again when ready.');
          await backendActivity.assertIdle('install an app update');
          installerToLaunch = await appUpdates!.installer();
        } catch (error) {
          appUpdates?.cancelInstall(errorMessage(error));
          appInstallClosing = false;
          installerToLaunch = undefined;
          quitting = false;
          window?.webContents.send('latent:close-cancelled');
          return;
        }
      }
      try {
        await backendActivity?.assertNoForeignWork('close the studio');
      } catch (error) {
        try {
          if (window && !window.isDestroyed()) {
            window.webContents.send('latent:close-cancelled');
            window.show();
            window.focus();
            await dialog.showMessageBox(window, {
              type: 'info',
              title: 'Shared image engine is still in use',
              message: errorMessage(error),
              buttons: ['Keep studio open'],
              defaultId: 0,
            });
          }
        } finally {
          quitting = false;
          if (appInstallClosing) {
            appUpdates?.cancelInstall();
            appInstallClosing = false;
            installerToLaunch = undefined;
          }
        }
        return;
      }
      closing = true;
      if (appUpdateTimer) clearInterval(appUpdateTimer);
      backendActivity?.dispose();
      if (broadcastTimer) clearTimeout(broadcastTimer);
      if (runtimeUpdateTimer) clearInterval(runtimeUpdateTimer);
      if (runtimeIdleTimer) clearTimeout(runtimeIdleTimer);
      if (outputsCheckTimer) clearTimeout(outputsCheckTimer);
      outputsWatcher?.close();
      models?.dispose();
      modelTransferActions?.dispose();
      civitai?.cancel();
      let updateShutdownComplete = false;
      try {
        await appUpdates?.dispose();
        await runtimeUpdates?.dispose();
        await telegram?.dispose();
        await phone?.dispose();
        await jobs?.dispose();
        const stoppedServices = await Promise.allSettled([
          backend?.dispose(),
          assistant?.dispose(),
          segmentation?.dispose(),
          upscaler?.dispose(),
          controlNet?.dispose(),
          qwenEdit?.dispose(),
          ipAdapter?.dispose(),
          faceDetailer?.dispose(),
          videoInspector?.dispose(),
          videoAssets?.dispose(),
        ]);
        const finishedWrites = await Promise.allSettled([...pendingOperations]);
        store?.close();
        updateShutdownComplete = [...stoppedServices, ...finishedWrites].every(result => result.status === 'fulfilled');
      } finally {
        closed = true;
        if (appInstallClosing && installerToLaunch && updateShutdownComplete) {
          try {
            await new Promise<void>((resolve, reject) => {
              const child = spawn(installerToLaunch!, [], {
                detached: true,
                windowsHide: true,
                stdio: 'ignore',
                cwd: path.dirname(installerToLaunch!),
              });
              child.once('error', reject);
              child.once('spawn', () => {
                child.unref();
                resolve();
              });
            });
          } catch (error) {
            dialog.showErrorBox('Update installer could not start', errorMessage(error));
          }
        }
        app.quit();
      }
    })();
  });
}

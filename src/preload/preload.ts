import { contextBridge, ipcRenderer } from 'electron';
import type { AppSnapshot, LatentAPI } from '../shared/types';
const invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke(`latent:${method}`, ...args);
const closeListeners = new Set<() => Promise<void>>();
ipcRenderer.on('latent:flush-draft', async (_event: Electron.IpcRendererEvent, nonce: string) => {
  const results = await Promise.allSettled([...closeListeners].map(listener => Promise.resolve().then(listener)));
  const failed = results.find(result => result.status === 'rejected');
  await ipcRenderer.invoke('latent:flush-complete', nonce, failed?.status === 'rejected' ? (failed.reason instanceof Error ? failed.reason.message : String(failed.reason)) : undefined);
});
const api: LatentAPI = {
  getSetupPreflight: capability => invoke('getSetupPreflight', capability), runGuidedSetup: capability => invoke('runGuidedSetup', capability),
  queueVideo: draft => invoke('queueVideo', draft), retryVideoSave: id => invoke('retryVideoSave', id),
  getModelTransferRecovery: () => invoke('getModelTransferRecovery'), retryModelTransfer: request => invoke('retryModelTransfer', request), cancelModelTransfer: id => invoke('cancelModelTransfer', id),
  getVideoConversation: () => invoke('getVideoConversation'), saveVideoConversation: value => invoke('saveVideoConversation', value), planVideoDraft: draft => invoke('planVideoDraft', draft), getVideoPlaybackFixture: () => invoke('getVideoPlaybackFixture'), getVideoHistory: () => invoke('getVideoHistory'), restoreVideoParameters: id => invoke('restoreVideoParameters', id), revealVideo: id => invoke('revealVideo', id), openVideoLicense: () => invoke('openVideoLicense'),
  getStorageOverview: () => invoke('getStorageOverview'), getModelDownloadStorage: () => invoke('getModelDownloadStorage'), getPackageStorage: packageId => invoke('getPackageStorage', packageId), revealStorageDestination: id => invoke('revealStorageDestination', id),
  refreshHardwareProfiles: () => invoke('refreshHardwareProfiles'), recommendHardwareProfiles: draft => invoke('recommendHardwareProfiles', draft), applyHardwareProfile: request => invoke('applyHardwareProfile', request), applyHardwareBackendRecommendation: reportId => invoke('applyHardwareBackendRecommendation', reportId), getJobMemoryAdvice: jobId => invoke('getJobMemoryAdvice', jobId),
  setupFaceDetailer: repair => invoke('setupFaceDetailer', repair), cancelFaceDetailerSetup: () => invoke('cancelFaceDetailerSetup'), detectFaces: request => invoke('detectFaces', request), cancelFaceDetection: () => invoke('cancelFaceDetection'), getFaceDetection: id => invoke('getFaceDetection', id),
  getRuntimeUpdateStatus: () => invoke('getRuntimeUpdateStatus'), saveRuntimeUpdateSettings: settings => invoke('saveRuntimeUpdateSettings', settings), checkRuntimeUpdates: () => invoke('checkRuntimeUpdates'), prepareRuntimeEnvironmentRepair: () => invoke('prepareRuntimeEnvironmentRepair'), stageRuntimeUpdate: kind => invoke('stageRuntimeUpdate', kind), activateRuntimeUpdate: () => invoke('activateRuntimeUpdate'), rollbackRuntimeUpdate: () => invoke('rollbackRuntimeUpdate'), recoverRuntimeUpdate: () => invoke('recoverRuntimeUpdate'), cancelRuntimeUpdate: () => invoke('cancelRuntimeUpdate'),
  getIPAdapterStatus: () => invoke('getIPAdapterStatus'), stageIPAdapter: repair => invoke('stageIPAdapter', repair), activateIPAdapter: () => invoke('activateIPAdapter'), cancelIPAdapterSetup: () => invoke('cancelIPAdapterSetup'),
  getQwenConversation: () => invoke('getQwenConversation'), saveQwenConversation: value => invoke('saveQwenConversation', value),
  setupQwenEdit: (profile, repair) => invoke('setupQwenEdit', profile, repair), cancelQwenEditSetup: () => invoke('cancelQwenEditSetup'), enqueueQwenEdit: request => invoke('enqueueQwenEdit', request),
  setupVideoAssets: profile => invoke('setupVideoAssets', profile), verifyVideoAssets: profile => invoke('verifyVideoAssets', profile), cancelVideoAssetSetup: () => invoke('cancelVideoAssetSetup'),
  chooseExternalModelRoot: kind => invoke('chooseExternalModelRoot', kind), unregisterExternalModelRoot: id => invoke('unregisterExternalModelRoot', id),
  createModelFolder: request => invoke('createModelFolder', request), moveModel: request => invoke('moveModel', request), recoverModelLocations: () => invoke('recoverModelLocations'),
  createCollection: (kind, name) => invoke('createCollection', kind, name), renameCollection: (id, name) => invoke('renameCollection', id, name), removeCollection: id => invoke('removeCollection', id), addCollectionMembers: (id, ids) => invoke('addCollectionMembers', id, ids), removeCollectionMembers: (id, ids) => invoke('removeCollectionMembers', id, ids),
  setupControlNet: repair => invoke('setupControlNet', repair), cancelControlNet: () => invoke('cancelControlNet'),
  saveWildcards: entries => invoke('saveWildcards', entries), setupUpscaler: repair => invoke('setupUpscaler', repair), cancelUpscaler: () => invoke('cancelUpscaler'),
  fetchModelCivitaiMetadata: id => invoke('fetchModelCivitaiMetadata', id),
  civitaiSearch: request => invoke('civitaiSearch', request), civitaiDetail: id => invoke('civitaiDetail', id), civitaiDownload: request => invoke('civitaiDownload', request), cancelCivitai: () => invoke('cancelCivitai'), getCivitaiSettings: () => invoke('getCivitaiSettings'), setCivitaiKey: value => invoke('setCivitaiKey', value), openCivitaiModel: (id, version) => invoke('openCivitaiModel', id, version),
  setupSegmentation: repair => invoke('setupSegmentation', repair), startSegmentation: () => invoke('startSegmentation'), stopSegmentation: () => invoke('stopSegmentation'), suggestMask: request => invoke('suggestMask', request), cancelSegmentation: () => invoke('cancelSegmentation'),
  importSourceImage: () => invoke('importSourceImage'), useOutputAsSource: id => invoke('useOutputAsSource', id), saveSourceMask: (id, bytes, options) => invoke('saveSourceMask', id, bytes, options),
  setupAssistant: repair => invoke('setupAssistant', repair), startAssistant: () => invoke('startAssistant'), stopAssistant: () => invoke('stopAssistant'),
  suggestPrompt: request => invoke('suggestPrompt', request), cancelAssistant: () => invoke('cancelAssistant'),
  getAssistantConversation: target => invoke('getAssistantConversation', target), saveAssistantConversation: (value, target) => invoke('saveAssistantConversation', value, target),
  copyText: text => invoke('copyText', text),
  dismissActivity: (scope, keys) => invoke('dismissActivity', scope, keys), getSnapshot: () => invoke('getSnapshot'), changeStorageLocation: kind => invoke('changeStorageLocation', kind), saveDraft: draft => invoke('saveDraft', draft),
  savePreviewSelection: recordId => invoke('savePreviewSelection', recordId),
  updateSettings: settings => invoke('updateSettings', settings),
  setupBackend: () => invoke('setupBackend'), startBackend: () => invoke('startBackend'), stopBackend: () => invoke('stopBackend'), openComfyUI: () => invoke('openComfyUI'),
  refreshModels: () => invoke('refreshModels'), importModels: kind => invoke('importModels', kind),
  updateModel: (id, changes) => invoke('updateModel', id, changes),
  downloadModel: request => invoke('downloadModel', request), cancelDownload: id => invoke('cancelDownload', id),
  queueGeneration: draft => invoke('queueGeneration', draft), cancelJob: id => invoke('cancelJob', id), retryJob: id => invoke('retryJob', id), reorderJobs: ids => invoke('reorderJobs', ids),
  savePreset: preset => invoke('savePreset', preset), deletePreset: id => invoke('deletePreset', id), revealOutput: id => invoke('revealOutput', id), openOutput: id => invoke('openOutput', id),
  onSnapshot: listener => { const handler = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot) => listener(snapshot); ipcRenderer.on('latent:snapshot', handler); return () => ipcRenderer.removeListener('latent:snapshot', handler); },
  onBeforeClose: listener => { closeListeners.add(listener); return () => { closeListeners.delete(listener); }; },
  onCloseCancelled: listener => { ipcRenderer.on('latent:close-cancelled', listener); return () => { ipcRenderer.removeListener('latent:close-cancelled', listener); }; },
};
contextBridge.exposeInMainWorld('latent', api);

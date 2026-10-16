/** Writes that stay allowed while storage is moving, so open editors can still save. */
const STORAGE_SAFE_WRITES = new Set([
  'saveDraft',
  'saveVideoConversation',
  'saveQwenConversation',
  'saveAssistantConversation',
  'savePreviewSelection',
  'copyText',
]);

export interface IpcGateState {
  closing: boolean;
  appInstallClosing: boolean;
  storageChanging: boolean;
  storageRestartPending: boolean;
}

/** Why a studio method may not run right now, or undefined when it may. */
export function ipcBlockedReason(method: string, state: IpcGateState): string | undefined {
  if (state.closing) return 'The studio is closing.';
  if (state.appInstallClosing && !/^(get|save)/.test(method))
    return 'The studio is saving and closing to install an update.';
  if (
    (state.storageChanging || state.storageRestartPending) &&
    !/^(get|cancel|stop)/.test(method) &&
    !STORAGE_SAFE_WRITES.has(method)
  )
    return state.storageRestartPending
      ? 'Storage was copied. Restart the studio before changing models or generating again.'
      : 'Storage is being changed. Wait for copying and restart to finish.';
  return undefined;
}

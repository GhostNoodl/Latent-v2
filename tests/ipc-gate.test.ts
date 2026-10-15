import { expect, it } from 'vitest';
import { ipcBlockedReason } from '../src/main/ipc/gate';

const idle = { closing: false, appInstallClosing: false, storageChanging: false, storageRestartPending: false };

it('allows everything while idle and nothing while closing', () => {
  expect(ipcBlockedReason('queueGeneration', idle)).toBeUndefined();
  expect(ipcBlockedReason('getSnapshot', { ...idle, closing: true })).toMatch('closing');
});

it('keeps reads and saves available while closing to install an update', () => {
  const state = { ...idle, appInstallClosing: true };
  expect(ipcBlockedReason('getSnapshot', state)).toBeUndefined();
  expect(ipcBlockedReason('saveDraft', state)).toBeUndefined();
  expect(ipcBlockedReason('queueGeneration', state)).toMatch('install an update');
});

it('lets editors save but blocks changes while storage moves or awaits restart', () => {
  const moving = { ...idle, storageChanging: true };
  for (const method of ['getSnapshot', 'cancelJob', 'stopBackend', 'saveDraft', 'copyText', 'savePreviewSelection'])
    expect(ipcBlockedReason(method, moving), method).toBeUndefined();
  expect(ipcBlockedReason('downloadModel', moving)).toMatch('being changed');
  expect(ipcBlockedReason('downloadModel', { ...idle, storageRestartPending: true })).toMatch('Restart the studio');
});

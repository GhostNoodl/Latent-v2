// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { StudioSettings } from '../src/renderer/Settings';
import { openAssistantSettings } from '../src/renderer/assistant/open-settings';
import { DEFAULT_SETTINGS } from '../src/shared/defaults';
import { DEFAULT_ASSISTANT_SETTINGS } from '../src/shared/assistant-catalog';
import { DEFAULT_RUNTIME_UPDATE_SETTINGS } from '../src/shared/runtime-update-types';
import type { AppSnapshot } from '../src/shared/types';

let root: Root, host: HTMLDivElement, updateSettings: ReturnType<typeof vi.fn>;
const snapshot = () =>
  ({
    settings: { ...structuredClone(DEFAULT_SETTINGS) },
    backend: { state: 'ready', message: 'Ready', logTail: ['line one'] },
    hardware: { os: 'win32', arch: 'x64', ramBytes: 1, vramMiB: 16384 },
    hardwareProfiles: {
      state: 'ready',
      message: '',
      backend: { actual: 'auto', suggested: 'lowvram', explanation: '' },
    },
    runtimeUpdates: { state: 'idle', message: 'Up to date.', settings: DEFAULT_RUNTIME_UPDATE_SETTINGS, history: [] },
    ipAdapter: { state: 'not-installed', message: '' },
    sageAttention: { state: 'installed', message: 'Installed' },
    assistant: {
      settings: DEFAULT_ASSISTANT_SETTINGS,
      keys: {},
      ready: false,
      label: '',
      vision: false,
      local: { state: 'not-installed', message: '', installed: [], recommended: 'x', logTail: [] },
    },
    setupActivity: [],
    paths: { root: 'C:\\Latent' },
  }) as unknown as AppSnapshot;
const tab = (name: string) =>
  [...host.querySelectorAll<HTMLAnchorElement>('.settings-sections a')].find(a => a.textContent === name)!;
async function render() {
  await act(async () => {
    root.render(
      <StudioSettings
        snapshot={snapshot()}
        receive={() => {}}
        run={async (_key, task) => {
          await task();
          return true;
        }}
        busy={{}}
        hardwareActions={{ onRefresh() {}, onRecommend() {}, onApply() {}, onApplyBackend() {} }}
      />,
    );
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  updateSettings = vi.fn(async () => snapshot());
  Object.defineProperty(window, 'latent', {
    configurable: true,
    value: new Proxy({ updateSettings } as Record<string, unknown>, {
      get: (target, key: string) => target[key] ?? (async () => undefined),
    }),
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('has seven tabs and remembers the one you picked', async () => {
  await render();
  expect([...host.querySelectorAll('.settings-sections a')].map(a => a.textContent)).toEqual([
    'Engine',
    'Updates',
    'Preferences',
    'Assistant',
    'Remote',
    'Storage',
    'Logs and reset',
  ]);
  expect(host.textContent).toContain('Turbo math');
  await act(async () => tab('Preferences').click());
  expect(host.textContent).not.toContain('Turbo math');
  expect(localStorage.getItem('latent.settings-tab')).toBe('settings-preferences');
});

it('opens on the Assistant tab when another page asks for it', async () => {
  openAssistantSettings();
  await render();
  expect(tab('Assistant').getAttribute('aria-current')).toBe('page');
});

it('offers the suggested memory mode in the same row', async () => {
  await render();
  const use = [...host.querySelectorAll('button')].find(b => b.textContent === 'Use it')!;
  expect(host.textContent).toContain('Best for this PC: Low VRAM');
  await act(async () => use.click());
  expect(updateSettings).toHaveBeenCalledWith({ deviceMode: 'lowvram' });
});

it('opens extra options in a panel beside the row and closes it with Escape', async () => {
  await render();
  await act(async () => tab('Preferences').click());
  const row = [...host.querySelectorAll<HTMLButtonElement>('.panel-row-button')].find(b =>
    b.textContent?.includes('Notifications'),
  )!;
  await act(async () => row.click());
  expect(row.getAttribute('aria-expanded')).toBe('true');
  expect(host.querySelector('.setting-panel')?.textContent).toContain('Download finished');
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(host.querySelector('.setting-panel')).toBeNull();
});

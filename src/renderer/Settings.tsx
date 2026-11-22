import { PhoneRemote } from './PhoneRemote';
import { SetupActivityPanel } from './SetupActivityPanel';
import { AppUpdates } from './AppUpdates';
import { TelegramRemote } from './TelegramRemote';
import { AssistantSettings } from './assistant/AssistantSettings';
import { PackageSetupStorage } from './PackageSetupStorage';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowUpRight, Check, ChevronRight, Copy, Download, Play, RotateCcw, Square, Wrench } from 'lucide-react';
import type { AppSettings, AppSnapshot } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { ENHANCE_MAX_SIDE_LARGE, hasLargeVram, usesExtraVram } from '../shared/vram';
import { DEFAULT_IMAGE_VERSIONS } from '../shared/image-versions';
import { Busy, ConfirmDialog, Notice, Toggle, type RunAction } from './ui';
import { RuntimeUpdates } from './RuntimeUpdates';
import { StorageOverview } from './StorageOverview';
import {
  HardwareDetails,
  HardwareSummary,
  StartingPresets,
  type HardwareRecommendationsProps,
} from './HardwareRecommendations';

function scrollBackendLogs(event: KeyboardEvent<HTMLPreElement>) {
  if (
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return;
  const panel = event.currentTarget;
  const positions: Record<string, number> = {
    ArrowDown: panel.scrollTop + 40,
    ArrowUp: panel.scrollTop - 40,
    PageDown: panel.scrollTop + panel.clientHeight,
    PageUp: panel.scrollTop - panel.clientHeight,
    Home: 0,
    End: panel.scrollHeight - panel.clientHeight,
  };
  if (!Object.hasOwn(positions, event.key)) return;
  event.preventDefault();
  panel.scrollTop = Math.max(0, Math.min(panel.scrollHeight - panel.clientHeight, positions[event.key]));
}

const TABS = [
  { id: 'engine', name: 'Engine' },
  { id: 'updates', name: 'Updates' },
  { id: 'preferences', name: 'Preferences' },
  { id: 'assistant', name: 'Assistant' },
  { id: 'remote', name: 'Remote' },
  { id: 'storage', name: 'Storage' },
  { id: 'logs', name: 'Logs and reset' },
] as const;
type TabId = (typeof TABS)[number]['id'];
const tabKey = 'latent.settings-tab';
function savedTab(): TabId {
  try {
    // Saved as settings-<tab>, the same id other pages use to open a tab here (see openAssistantSettings).
    const saved = localStorage.getItem(tabKey);
    return TABS.find(tab => `settings-${tab.id}` === saved)?.id ?? 'engine';
  } catch {
    return 'engine';
  }
}

const DEVICE_MODE_NAMES: Record<AppSettings['deviceMode'], string> = {
  auto: 'Automatic',
  lowvram: 'Low VRAM',
  cpu: 'CPU only',
};

/** A settings row that opens its extra options in a panel right beside it, so nothing below jumps around.
 * One panel is open at a time per tab; Escape or a click elsewhere closes it. */
function PanelRow({
  id,
  open,
  onOpen,
  title,
  hint,
  status,
  children,
}: {
  id: string;
  open: string | undefined;
  onOpen(id: string | undefined): void;
  title: string;
  hint?: string;
  status?: string;
  children: ReactNode;
}) {
  const isOpen = open === id;
  const row = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!isOpen || !row.current || !panel.current) return;
    // Keep the panel on screen: nudge it up when the row sits low.
    const rowTop = row.current.getBoundingClientRect().top;
    const height = panel.current.offsetHeight;
    setShift(Math.min(0, window.innerHeight - 16 - rowTop - height));
  }, [isOpen]);
  useEffect(() => {
    if (!isOpen) return;
    const close = (event: Event) => {
      if (event instanceof globalThis.KeyboardEvent) {
        if (event.key === 'Escape') onOpen(undefined);
        return;
      }
      if (!row.current?.contains(event.target as Node)) onOpen(undefined);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', close);
    };
  }, [isOpen, onOpen]);
  return (
    <div className="setting-line panel-row" ref={row} data-open={isOpen || undefined}>
      <button
        type="button"
        className="panel-row-button"
        aria-expanded={isOpen}
        onClick={() => onOpen(isOpen ? undefined : id)}
      >
        <span>
          <strong>{title}</strong>
          {hint && <small>{hint}</small>}
        </span>
        {status && <em>{status}</em>}
        <ChevronRight size={16} />
      </button>
      {isOpen && (
        <div className="setting-panel" ref={panel} role="region" aria-label={title} style={{ marginTop: shift }}>
          <h3>{title}</h3>
          {children}
        </div>
      )}
    </div>
  );
}

function onOff(...values: boolean[]) {
  const on = values.filter(Boolean).length;
  return on === 0 ? 'Off' : on === values.length ? 'All on' : `${on} on`;
}

export function StudioSettings({
  snapshot,
  receive,
  run,
  busy,
  hardwareActions,
  onSetup,
}: {
  snapshot: AppSnapshot;
  onSetup?: () => void;
  receive: (snapshot: AppSnapshot) => void;
  run: RunAction;
  busy: Record<string, boolean>;
  hardwareActions: Omit<HardwareRecommendationsProps, 'status' | 'busy'>;
}) {
  const { settings, backend, paths } = snapshot;
  const sage = snapshot.sageAttention ?? { state: 'checking', message: 'Checking…' };
  const bigCard = hasLargeVram(snapshot.hardware);
  const vramGb = snapshot.hardware.vramMiB ? Math.round(snapshot.hardware.vramMiB / 1024) : undefined;
  useEffect(() => {
    void window.latent.checkSageAttention().catch(() => undefined);
  }, [backend.state]);
  const imageVersions = settings.imageVersions ?? DEFAULT_IMAGE_VERSIONS;
  const settingsBusy = busy.settings || busy.hardware;
  const [confirmReset, setConfirmReset] = useState(false);
  const [tab, setTab] = useState<TabId>(savedTab);
  const [panel, setPanel] = useState<string>();
  const content = useRef<HTMLDivElement>(null);
  const pickTab = (id: TabId) => {
    setTab(id);
    setPanel(undefined);
    content.current?.scrollTo?.({ top: 0 });
    try {
      localStorage.setItem(tabKey, `settings-${id}`);
    } catch {
      /* Private browser storage can be unavailable. */
    }
  };
  const runtimeWorking =
    ['applying', 'rolling-back', 'recovering'].includes(snapshot.runtimeUpdates.state) ||
    snapshot.ipAdapter.state === 'activating';
  const backendStartBlocked =
    runtimeWorking || snapshot.runtimeUpdates.recoveryRequired || snapshot.runtimeUpdates.environmentRepairRequired;
  const update = (change: Partial<AppSettings>) => {
    void run('settings', async () => receive(await window.latent.updateSettings(change)));
  };
  const reset = () => {
    void run(
      'settings',
      async () => receive(await window.latent.updateSettings(DEFAULT_SETTINGS)),
      'Settings are back to their defaults. Your images, recipes and presets are untouched.',
    );
  };
  const stateLabel = {
    'not-installed': 'Not installed',
    installing: 'Installing',
    stopped: 'Stopped',
    starting: 'Starting',
    ready: 'Ready',
    error: 'Needs attention',
  };
  const suggestedMode = snapshot.hardwareProfiles.backend?.suggested;
  const rows = { open: panel, onOpen: setPanel };
  return (
    <div className="page-content settings-content" ref={content} data-tab={tab}>
      <nav className="settings-sections" aria-label="Settings sections">
        {TABS.map(item => (
          <a
            key={item.id}
            href={`#settings-${item.id}`}
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={event => {
              event.preventDefault();
              pickTab(item.id);
            }}
          >
            {item.name}
          </a>
        ))}
      </nav>

      {tab === 'engine' && (
        <section className="settings-card backend-card" id="settings-engine">
          <div className="section-heading">
            <div>
              <h2>Engine</h2>
              <HardwareSummary
                status={snapshot.hardwareProfiles}
                busy={settingsBusy || runtimeWorking}
                onRefresh={hardwareActions.onRefresh}
              />
            </div>
            <span className="badge">
              <span className={`status-dot ${backend.state}`} />
              {stateLabel[backend.state]}
            </span>
          </div>
          {backend.state !== 'ready' && (
            <Notice error={backend.state === 'error'}>{backend.message || 'Waiting to hear from the engine…'}</Notice>
          )}
          {backend.state === 'installing' && <progress value={backend.installProgress} max={100} />}
          {['not-installed', 'error', 'installing'].includes(backend.state) && (
            <PackageSetupStorage packageId="backend" />
          )}
          <div className="button-row backend-actions">
            {['not-installed', 'error'].includes(backend.state) && (
              <button
                type="button"
                className="primary"
                disabled={busy.setup || backendStartBlocked}
                onClick={() => void run('setup', () => window.latent.setupBackend(), 'The engine is installed.')}
              >
                <Busy active={busy.setup} />
                {!busy.setup && <Download size={16} />}
                {backend.state === 'error' ? 'Repair the engine' : 'Install the engine'}
              </button>
            )}
            {['stopped', 'error'].includes(backend.state) && (
              <button
                type="button"
                className={backend.state === 'stopped' ? 'primary' : ''}
                disabled={busy.start || backendStartBlocked}
                onClick={() => void run('start', () => window.latent.startBackend())}
              >
                <Busy active={busy.start} />
                {!busy.start && <Play size={16} />}Start engine
              </button>
            )}
            {['ready', 'starting'].includes(backend.state) && (
              <button
                type="button"
                disabled={busy.stop || runtimeWorking}
                onClick={() => void run('stop', () => window.latent.stopBackend())}
              >
                <Busy active={busy.stop} />
                {!busy.stop && <Square size={15} />}Stop engine
              </button>
            )}
            <button
              type="button"
              disabled={backend.state !== 'ready' || busy.comfy || backendStartBlocked}
              onClick={() => void run('comfy', () => window.latent.openComfyUI())}
            >
              Open ComfyUI
              <ArrowUpRight size={15} />
            </button>
            {onSetup && (
              <button type="button" onClick={onSetup} title="Install the engine, image models, Qwen editing or video">
                <Wrench size={15} />
                Setup
              </button>
            )}
          </div>
          <div className="setting-line">
            <div>
              <h3>Start with Latent</h3>
              <p>Starts the engine when you open Latent.</p>
            </div>
            <fieldset disabled={settingsBusy}>
              <Toggle
                label="Start the engine with Latent"
                checked={settings.backendAutoStart}
                onChange={backendAutoStart => update({ backendAutoStart })}
              />
            </fieldset>
          </div>
          <h3 className="settings-group-title">
            Speed and memory <span>· applies when the engine restarts</span>
          </h3>
          <div className="setting-line">
            <div>
              <h3>Memory mode</h3>
              {suggestedMode && suggestedMode !== settings.deviceMode ? (
                <p>
                  Best for this PC: {DEVICE_MODE_NAMES[suggestedMode] ?? suggestedMode}.{' '}
                  <button
                    type="button"
                    className="text-button"
                    disabled={settingsBusy}
                    onClick={() => update({ deviceMode: suggestedMode })}
                  >
                    Use it
                  </button>
                </p>
              ) : (
                <p>Automatic picks what fits your card.</p>
              )}
            </div>
            <select
              aria-label="Memory mode"
              value={settings.deviceMode}
              disabled={settingsBusy}
              onChange={event => update({ deviceMode: event.target.value as AppSettings['deviceMode'] })}
            >
              <option value="auto">Automatic</option>
              <option value="lowvram">Low VRAM</option>
              <option value="cpu">CPU only</option>
            </select>
          </div>
          <div className="setting-line">
            <div>
              <h3>Turbo math</h3>
              <p>Faster on RTX cards. The same seed can look a tiny bit different.</p>
            </div>
            <fieldset disabled={settingsBusy || settings.deviceMode === 'cpu'}>
              <Toggle
                label="Turbo math"
                checked={settings.fastMath ?? false}
                onChange={fastMath => update({ fastMath })}
              />
            </fieldset>
          </div>
          <div className="setting-line">
            <div>
              <h3>SageAttention</h3>
              <p>
                {sage.state === 'installed' ? (
                  'Another speed boost on NVIDIA cards.'
                ) : (
                  <>Another speed boost on NVIDIA cards. Needs a small add-on (about 64 MB). {sage.message}</>
                )}
              </p>
              {['missing', 'error'].includes(sage.state) && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy.sage || runtimeWorking}
                  title="The engine restarts while the add-on installs."
                  onClick={() =>
                    void run('sage', () => window.latent.installSageAttention(), 'SageAttention is installed and on.')
                  }
                >
                  <Busy active={busy.sage} />
                  {!busy.sage && <Download size={16} />}Install SageAttention
                </button>
              )}
              {sage.state === 'installing' && <Busy active />}
            </div>
            <fieldset
              disabled={
                settingsBusy || settings.deviceMode === 'cpu' || (sage.state !== 'installed' && !settings.sageAttention)
              }
            >
              <Toggle
                label="SageAttention"
                checked={settings.sageAttention ?? false}
                onChange={sageAttention => update({ sageAttention })}
              />
            </fieldset>
          </div>
          <div className="setting-line">
            <div>
              <h3>Use extra graphics memory</h3>
              <p>
                {!bigCard
                  ? vramGb
                    ? `For cards with 20 GB or more. This one has ${vramGb} GB, so it stays off.`
                    : 'For cards with 20 GB or more.'
                  : settings.deviceMode !== 'auto'
                    ? 'Works with Automatic memory mode only.'
                    : `Enhance goes up to ${ENHANCE_MAX_SIDE_LARGE} pixels and Qwen reads prompts on the card.`}
              </p>
            </div>
            <fieldset disabled={settingsBusy || !bigCard || settings.deviceMode !== 'auto'}>
              <Toggle
                label="Use extra graphics memory"
                checked={usesExtraVram(settings, snapshot.hardware)}
                onChange={extraVram => update({ extraVram })}
              />
            </fieldset>
          </div>
          <PanelRow
            id="presets"
            {...rows}
            title="Starting settings for this PC"
            hint="Suggested size and steps for your prompt."
          >
            <StartingPresets
              status={snapshot.hardwareProfiles}
              busy={settingsBusy || runtimeWorking}
              {...hardwareActions}
            />
          </PanelRow>
        </section>
      )}

      {tab === 'updates' && (
        <section className="settings-pair" id="settings-updates">
          {snapshot.appUpdates && (
            <AppUpdates
              status={snapshot.appUpdates}
              busy={busy['app-update']}
              onSettings={value => void run('app-update', () => window.latent.saveAppUpdateSettings(value))}
              onCheck={() => void run('app-update', () => window.latent.checkAppUpdates())}
              onDownload={() => void run('app-update', () => window.latent.downloadAppUpdate())}
              onInstall={() => void run('app-update', () => window.latent.installAppUpdate())}
              onCancel={() => void run('app-update-cancel', () => window.latent.cancelAppUpdate())}
            />
          )}
          <RuntimeUpdates
            onRepair={() => void run('runtime-update', () => window.latent.prepareRuntimeEnvironmentRepair())}
            status={snapshot.runtimeUpdates}
            appUpdateVersion={snapshot.appUpdates?.release?.version}
            busy={
              busy['runtime-update'] || busy['runtime-update-settings'] || snapshot.ipAdapter.state === 'activating'
            }
            onSettings={value =>
              void run('runtime-update-settings', () => window.latent.saveRuntimeUpdateSettings(value))
            }
            onCheck={() =>
              void run('runtime-update', async () => {
                // New engines arrive inside app updates, so look for one of those too.
                if (snapshot.appUpdates?.supported) await window.latent.checkAppUpdates().catch(() => undefined);
                await window.latent.checkRuntimeUpdates();
              })
            }
            onStage={kind => void run('runtime-update', () => window.latent.stageRuntimeUpdate(kind))}
            onActivate={() => void run('runtime-update', () => window.latent.activateRuntimeUpdate())}
            onRollback={() => void run('runtime-update', () => window.latent.rollbackRuntimeUpdate())}
            onRecover={() => void run('runtime-update', () => window.latent.recoverRuntimeUpdate())}
            onCancel={() => void run('runtime-update-cancel', () => window.latent.cancelRuntimeUpdate())}
          />
        </section>
      )}

      {tab === 'preferences' && (
        <section className="settings-card" id="settings-preferences">
          <h2>Preferences</h2>
          <div className="setting-line">
            <label htmlFor="theme">Theme</label>
            <select
              id="theme"
              value={settings.theme}
              disabled={settingsBusy}
              onChange={event => update({ theme: event.target.value as AppSettings['theme'] })}
            >
              <option value="system">Use system</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </div>
          <div className="setting-line">
            <span>Accent color</span>
            <div className="accent-picker">
              {(['iris', 'sea-glass', 'rose', 'sky', 'amber', 'peach', 'mint', 'lilac'] as const).map(accent => (
                <button
                  type="button"
                  key={accent}
                  className={`accent-swatch ${accent}`}
                  aria-label={accent === 'sea-glass' ? 'Sea glass accent' : `${accent} accent`}
                  aria-pressed={settings.accent === accent}
                  disabled={settingsBusy}
                  onClick={() => update({ accent })}
                >
                  {settings.accent === accent && <Check size={16} />}
                </button>
              ))}
            </div>
          </div>
          <div className="setting-line">
            <label htmlFor="tune-side">Tune panel</label>
            <select
              id="tune-side"
              value={settings.tuneSide ?? 'right'}
              disabled={settingsBusy}
              onChange={event => update({ tuneSide: event.target.value as 'left' | 'right' })}
            >
              <option value="right">On the right</option>
              <option value="left">On the left</option>
            </select>
          </div>
          <div className="setting-line">
            <div>
              <h3>Live preview</h3>
              <p>Watch the image take shape while it makes.</p>
            </div>
            <fieldset disabled={settingsBusy}>
              <Toggle
                label="Live preview"
                checked={settings.showGenerationPreview}
                onChange={showGenerationPreview => update({ showGenerationPreview })}
              />
            </fieldset>
          </div>
          <PanelRow
            id="prompts"
            {...rows}
            title="Remember prompts"
            hint="Bring your last prompts back when Latent opens."
            status={onOff(settings.rememberPositivePrompt, settings.rememberNegativePrompt)}
          >
            <p>Saved images always keep their own prompts.</p>
            <fieldset disabled={settingsBusy} className="toggle-group">
              <Toggle
                label="Prompt"
                checked={settings.rememberPositivePrompt}
                onChange={rememberPositivePrompt => update({ rememberPositivePrompt })}
              />
              <Toggle
                label="Negative prompt"
                checked={settings.rememberNegativePrompt}
                onChange={rememberNegativePrompt => update({ rememberNegativePrompt })}
              />
            </fieldset>
          </PanelRow>
          <PanelRow
            id="versions"
            {...rows}
            title="Image versions"
            hint="Hires fix and face fix stack on one card in the gallery."
            status={imageVersions.group ? 'Grouped' : 'Off'}
          >
            <p>The newest version shows on top. Every version stays saved, open them from the card's ⋯ menu.</p>
            <fieldset disabled={settingsBusy} className="toggle-group">
              <Toggle
                label="Group versions together"
                checked={imageVersions.group}
                onChange={group => update({ imageVersions: { ...imageVersions, group } })}
              />
            </fieldset>
            {imageVersions.group && (
              <>
                <p>Also give these their own card:</p>
                <fieldset disabled={settingsBusy} className="toggle-group">
                  <Toggle
                    label="Original"
                    checked={imageVersions.showOriginal}
                    onChange={showOriginal => update({ imageVersions: { ...imageVersions, showOriginal } })}
                  />
                  <Toggle
                    label="Hires fix"
                    checked={imageVersions.showRefined}
                    onChange={showRefined => update({ imageVersions: { ...imageVersions, showRefined } })}
                  />
                  <Toggle
                    label="Face fix steps"
                    checked={imageVersions.showFaceSteps}
                    onChange={showFaceSteps => update({ imageVersions: { ...imageVersions, showFaceSteps } })}
                  />
                </fieldset>
              </>
            )}
          </PanelRow>
          <PanelRow
            id="civitai"
            {...rows}
            title="Civitai info"
            hint="Creator and preview pictures for your models."
            status={onOff(settings.civitaiAutoMetadata === true, settings.civitaiDisplayMetadata !== false)}
          >
            <p>Latent looks your files up by their fingerprint. The files never leave your PC.</p>
            <fieldset disabled={settingsBusy} className="toggle-group">
              <Toggle
                label="Look up new models automatically"
                checked={settings.civitaiAutoMetadata === true}
                onChange={civitaiAutoMetadata => update({ civitaiAutoMetadata })}
              />
              <Toggle
                label="Show Civitai info and previews"
                checked={settings.civitaiDisplayMetadata !== false}
                onChange={civitaiDisplayMetadata => update({ civitaiDisplayMetadata })}
              />
            </fieldset>
          </PanelRow>
          <PanelRow
            id="notifications"
            {...rows}
            title="Notifications"
            hint="A heads-up when something finishes in the background."
            status={onOff(settings.notifyGeneration, settings.notifyDownload, settings.notifyError)}
          >
            <fieldset disabled={settingsBusy} className="toggle-group">
              <Toggle
                label="Image finished"
                checked={settings.notifyGeneration}
                onChange={notifyGeneration => update({ notifyGeneration })}
              />
              <Toggle
                label="Download finished"
                checked={settings.notifyDownload}
                onChange={notifyDownload => update({ notifyDownload })}
              />
              <Toggle
                label="Something went wrong"
                checked={settings.notifyError}
                onChange={notifyError => update({ notifyError })}
              />
              <Toggle
                label="Also show them in Windows"
                checked={settings.desktopNotifications === true}
                onChange={desktopNotifications => update({ desktopNotifications })}
              />
            </fieldset>
          </PanelRow>
        </section>
      )}

      {tab === 'assistant' && <AssistantSettings status={snapshot.assistant} run={run} busy={busy} />}

      {tab === 'remote' && (
        <section className="settings-pair" id="settings-remote">
          {snapshot.telegram && <TelegramRemote status={snapshot.telegram} run={run} busy={Boolean(busy.telegram)} />}
          {snapshot.phone && <PhoneRemote status={snapshot.phone} run={run} busy={Boolean(busy.phone)} />}
        </section>
      )}

      {tab === 'storage' && (
        <section className="settings-card" id="settings-storage">
          <h2>Storage</h2>
          <p>
            To move models or images to another drive, pick an empty folder. Latent copies everything, checks the copy
            and restarts. The old files stay until you delete them. Stop the engine and let downloads finish first.
          </p>
          {(['models', 'outputs'] as const).map(kind => (
            <div className="setting-line" key={kind}>
              <div>
                <h3>{kind === 'models' ? 'Models' : 'Your images'}</h3>
                <p className="inline-path">{snapshot.paths[kind]}</p>
              </div>
              <button
                disabled={
                  !['stopped', 'not-installed'].includes(snapshot.backend.state) || Boolean(busy['storage-location'])
                }
                onClick={() => void run('storage-location', () => window.latent.changeStorageLocation(kind))}
              >
                Move…
              </button>
            </div>
          ))}
          <div className="setting-line storage-line">
            <StorageOverview
              refresh={() => window.latent.getStorageOverview()}
              reveal={id => window.latent.revealStorageDestination(id)}
              run={run}
            />
          </div>
        </section>
      )}

      {tab === 'logs' && (
        <section className="settings-card" id="settings-logs">
          <h2>Logs and reset</h2>
          <p>For when something goes wrong. Copy a log and send it along.</p>
          <PanelRow
            id="engine-log"
            {...rows}
            title="Engine log"
            hint={backend.version ? `ComfyUI ${backend.version}` : undefined}
          >
            <pre
              className="logs"
              tabIndex={0}
              role="region"
              aria-label="Engine log output"
              onKeyDown={scrollBackendLogs}
            >
              {backend.logTail.length ? backend.logTail.join('\n') : 'Nothing in the log yet.'}
            </pre>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                void run('copy-logs', () => window.latent.copyText(backend.logTail.join('\n')), 'Engine log copied.')
              }
            >
              <Copy size={14} />
              Copy log
            </button>
          </PanelRow>
          <PanelRow
            id="downloads"
            {...rows}
            title="Download history"
            hint="What Latent downloaded and installed."
            status={snapshot.setupActivity?.length ? String(snapshot.setupActivity.length) : undefined}
          >
            <SetupActivityPanel
              items={snapshot.setupActivity}
              onCopy={() =>
                void run(
                  'copy-setup-history',
                  () =>
                    window.latent.copyText(
                      JSON.stringify(
                        {
                          appVersion: snapshot.appUpdates?.currentVersion,
                          exportedAt: new Date().toISOString(),
                          activity: snapshot.setupActivity ?? [],
                        },
                        null,
                        2,
                      ),
                    ),
                  'Download history copied.',
                )
              }
            />
          </PanelRow>
          <PanelRow id="pc" {...rows} title="PC details" hint="Graphics card, driver and engine version.">
            <HardwareDetails status={snapshot.hardwareProfiles} />
          </PanelRow>
          <PanelRow id="paths" {...rows} title="Studio folders" hint="Where every part of Latent lives.">
            <button
              type="button"
              className="text-button"
              onClick={() =>
                void run(
                  'copy-paths',
                  () =>
                    window.latent.copyText(
                      Object.entries(paths)
                        .map(([name, path]) => `${name}: ${path}`)
                        .join('\n'),
                    ),
                  'Folders copied.',
                )
              }
            >
              <Copy size={14} />
              Copy folders
            </button>
            <dl className="path-list">
              {Object.entries(paths).map(([name, path]) => (
                <div key={name}>
                  <dt>{name === 'root' ? 'Studio home' : name}</dt>
                  <dd>{path}</dd>
                </div>
              ))}
            </dl>
          </PanelRow>
          <div className="setting-line">
            <div>
              <h3>Reset settings</h3>
              <p>Puts every setting back to how it was on install. Images, recipes, presets and models stay.</p>
            </div>
            <button type="button" disabled={settingsBusy} onClick={() => setConfirmReset(true)}>
              <Busy active={busy.settings} />
              {!busy.settings && <RotateCcw size={15} />}Reset settings
            </button>
          </div>
          {confirmReset && (
            <ConfirmDialog
              title="Reset all settings?"
              confirmLabel="Reset settings"
              onClose={() => setConfirmReset(false)}
              onConfirm={reset}
            >
              <p>
                Theme, notifications, engine startup and prompt memory go back to their defaults. Negative-prompt memory
                turns off, so the negative prompt it remembered is cleared. Your images, recipes, presets and models
                stay put.
              </p>
            </ConfirmDialog>
          )}
        </section>
      )}
    </div>
  );
}

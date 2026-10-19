import { SetupActivityPanel } from './SetupActivityPanel';
import { AppUpdates } from './AppUpdates';
import { TelegramRemote } from './TelegramRemote';
import { PackageSetupStorage } from './PackageSetupStorage';
import { useEffect, useState, type KeyboardEvent } from 'react';
import { ArrowUpRight, Check, Copy, Download, Play, RotateCcw, Square, Terminal } from 'lucide-react';
import type { AppSettings, AppSnapshot } from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/defaults';
import { DEFAULT_IMAGE_VERSIONS } from '../shared/image-versions';
import { Busy, ConfirmDialog, Notice, Toggle, type RunAction } from './ui';
import { RuntimeUpdates } from './RuntimeUpdates';
import { StorageOverview } from './StorageOverview';
import { HardwareRecommendations, type HardwareRecommendationsProps } from './HardwareRecommendations';

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
  useEffect(() => {
    void window.latent.checkSageAttention().catch(() => undefined);
  }, [backend.state]);
  const imageVersions = settings.imageVersions ?? DEFAULT_IMAGE_VERSIONS;
  const settingsBusy = busy.settings || busy.hardware;
  const [confirmReset, setConfirmReset] = useState(false);
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
  return (
    <div className="page-content settings-content">
      {onSetup && (
        <section className="settings-card">
          <h2>Studio setup</h2>
          <p>Check your PC and install the engine, image models, Qwen editing or video.</p>
          <button type="button" className="primary" onClick={onSetup}>
            Open setup
          </button>
        </section>
      )}
      <section className="settings-card backend-card">
        <div className="section-heading">
          <div>
            <h2>Image engine</h2>
            <p>The engine that makes your images. Latent gives it its own private copy of ComfyUI.</p>
          </div>
          <span className="badge">
            <span className={`status-dot ${backend.state}`} />
            {stateLabel[backend.state]}
          </span>
        </div>
        <Notice error={backend.state === 'error'}>{backend.message || 'Waiting to hear from the engine…'}</Notice>
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
        </div>
        <div className="setting-line">
          <div>
            <h3>Start with the studio</h3>
            <p>Start the engine automatically when Latent opens.</p>
          </div>
          <fieldset disabled={settingsBusy}>
            <Toggle
              label="Automatic startup"
              checked={settings.backendAutoStart}
              onChange={backendAutoStart => update({ backendAutoStart })}
            />
          </fieldset>
        </div>
        <div className="setting-line">
          <div>
            <h3>Memory and device</h3>
            <p>Takes effect the next time the engine starts.</p>
          </div>
          <select
            aria-label="Memory and device mode"
            value={settings.deviceMode}
            disabled={settingsBusy}
            onChange={event => update({ deviceMode: event.target.value as AppSettings['deviceMode'] })}
          >
            <option value="auto">Automatic (GPU preferred)</option>
            <option value="lowvram">Low VRAM</option>
            <option value="cpu">CPU only</option>
          </select>
        </div>
        <div className="setting-line">
          <div>
            <h3>Turbo math</h3>
            <p>
              Faster sampling on NVIDIA RTX cards using lower-precision math. Images can differ very slightly from the
              same seed. Takes effect the next time the engine starts.
            </p>
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
              Speeds up image, Qwen and video models on NVIDIA cards. It needs a small add-on (about 64 MB). Takes
              effect the next time the engine starts.
            </p>
            <p className="muted">
              {sage.state === 'installed' ? (
                <>
                  <Check size={14} /> Installed
                </>
              ) : (
                sage.message
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
        <details className="log-details">
          <summary>
            <Terminal size={15} />
            Engine log {backend.version ? `· ComfyUI ${backend.version}` : ''}
          </summary>
          <pre className="logs" tabIndex={0} role="region" aria-label="Engine log output" onKeyDown={scrollBackendLogs}>
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
            Copy logs
          </button>
        </details>
      </section>
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
            'Download and setup history copied.',
          )
        }
      />
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
      {snapshot.telegram && <TelegramRemote status={snapshot.telegram} run={run} busy={Boolean(busy.telegram)} />}
      <RuntimeUpdates
        onRepair={() => void run('runtime-update', () => window.latent.prepareRuntimeEnvironmentRepair())}
        status={snapshot.runtimeUpdates}
        busy={busy['runtime-update'] || busy['runtime-update-settings'] || snapshot.ipAdapter.state === 'activating'}
        onSettings={value => void run('runtime-update-settings', () => window.latent.saveRuntimeUpdateSettings(value))}
        onCheck={() => void run('runtime-update', () => window.latent.checkRuntimeUpdates())}
        onStage={kind => void run('runtime-update', () => window.latent.stageRuntimeUpdate(kind))}
        onActivate={() => void run('runtime-update', () => window.latent.activateRuntimeUpdate())}
        onRollback={() => void run('runtime-update', () => window.latent.rollbackRuntimeUpdate())}
        onRecover={() => void run('runtime-update', () => window.latent.recoverRuntimeUpdate())}
        onCancel={() => void run('runtime-update-cancel', () => window.latent.cancelRuntimeUpdate())}
      />
      <section className="settings-card">
        <h2>Appearance</h2>
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
      </section>
      <section className="settings-card">
        <h2>Where files are stored</h2>
        <p>
          Want models or images on another drive? Pick a new folder and Latent copies everything there, checks the copy,
          and restarts. Your original files stay where they are until you delete them.
        </p>
        <p>Stop the engine and let downloads finish first. The new folder must be empty and big enough.</p>
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
              Choose folder, copy & restart
            </button>
          </div>
        ))}
      </section>
      <section className="settings-card">
        <h2>Previews, drafts, and notifications</h2>
        <div className="setting-line">
          <div>
            <h3>Civitai metadata</h3>
            <p>
              Look up your model files on Civitai to show their creator and preview images. Your files never leave your
              PC.
            </p>
          </div>
          <fieldset disabled={settingsBusy} className="toggle-group">
            <Toggle
              label="Automatically fetch Civitai metadata"
              checked={settings.civitaiAutoMetadata === true}
              onChange={civitaiAutoMetadata => update({ civitaiAutoMetadata })}
            />
            <Toggle
              label="Display Civitai metadata and previews"
              checked={settings.civitaiDisplayMetadata !== false}
              onChange={civitaiDisplayMetadata => update({ civitaiDisplayMetadata })}
            />
          </fieldset>
        </div>
        <div className="setting-line">
          <div>
            <h3>Generation preview</h3>
            <p>
              Watch the image take shape while it generates. This only changes what you see while waiting; the final
              image is the same either way.
            </p>
          </div>
          <fieldset disabled={settingsBusy}>
            <Toggle
              label="Show live generation previews"
              checked={settings.showGenerationPreview}
              onChange={showGenerationPreview => update({ showGenerationPreview })}
            />
          </fieldset>
        </div>
        <div className="setting-line">
          <div>
            <h3>Image versions</h3>
            <p>
              Show an image and its hires fix and face fix as one card in the gallery, with the newest version on top.
              Every version stays saved and you can still view or compare them from the card's ⋯ menu.
            </p>
          </div>
          <fieldset disabled={settingsBusy}>
            <Toggle
              label="Group versions together"
              checked={imageVersions.group}
              onChange={group => update({ imageVersions: { ...imageVersions, group } })}
            />
          </fieldset>
        </div>
        {imageVersions.group && (
          <div className="setting-line">
            <div>
              <h3>Also keep as separate cards</h3>
              <p>Pick the earlier versions that should still get their own card next to the grouped one.</p>
            </div>
            <fieldset disabled={settingsBusy} className="setting-toggles">
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
          </div>
        )}
        <div className="setting-line">
          <div>
            <h3>Remember prompts</h3>
            <p>Bring these prompts back next time you open Latent. Saved images always keep their own prompts.</p>
          </div>
          <fieldset disabled={settingsBusy} className="toggle-group">
            <Toggle
              label="Positive prompt"
              checked={settings.rememberPositivePrompt}
              onChange={rememberPositivePrompt => update({ rememberPositivePrompt })}
            />
            <Toggle
              label="Negative prompt"
              checked={settings.rememberNegativePrompt}
              onChange={rememberNegativePrompt => update({ rememberNegativePrompt })}
            />
          </fieldset>
        </div>
        <div className="setting-line">
          <div>
            <h3>Notification preferences</h3>
            <p>Get a heads-up when something finishes while Latent is in the background.</p>
          </div>
          <fieldset disabled={settingsBusy} className="toggle-group">
            <Toggle
              label="Also send desktop notifications"
              checked={settings.desktopNotifications === true}
              onChange={desktopNotifications => update({ desktopNotifications })}
            />
            <Toggle
              label="Generation finished"
              checked={settings.notifyGeneration}
              onChange={notifyGeneration => update({ notifyGeneration })}
            />
            <Toggle
              label="Download finished"
              checked={settings.notifyDownload}
              onChange={notifyDownload => update({ notifyDownload })}
            />
            <Toggle
              label="Errors need attention"
              checked={settings.notifyError}
              onChange={notifyError => update({ notifyError })}
            />
          </fieldset>
        </div>
      </section>
      <HardwareRecommendations
        status={snapshot.hardwareProfiles}
        busy={settingsBusy || runtimeWorking}
        {...hardwareActions}
      />
      <section className="settings-card">
        <StorageOverview
          refresh={() => window.latent.getStorageOverview()}
          reveal={id => window.latent.revealStorageDestination(id)}
          run={run}
        />
        <details className="log-details">
          <summary>All studio paths</summary>
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
                'Studio paths copied.',
              )
            }
          >
            <Copy size={14} />
            Copy paths
          </button>
          <dl className="path-list">
            {Object.entries(paths).map(([name, path]) => (
              <div key={name}>
                <dt>{name === 'root' ? 'Studio home' : name}</dt>
                <dd>{path}</dd>
              </div>
            ))}
          </dl>
        </details>
      </section>
      <section className="settings-card">
        <h2>Reset settings</h2>
        <div className="setting-line">
          <div>
            <h3>Start fresh</h3>
            <p>
              Puts every option on this page back the way it was when you installed Latent. Your images, recipes,
              presets and models aren't touched.
            </p>
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
              turns off, so the negative prompt it remembered is cleared. Your images, recipes, presets and models stay
              put.
            </p>
          </ConfirmDialog>
        )}
      </section>
    </div>
  );
}

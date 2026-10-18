import { Download, RefreshCw, RotateCcw, ShieldCheck } from 'lucide-react';
import type { RuntimeUpdateSettings, RuntimeUpdateStatus } from '../shared/runtime-update-types';
import { Notice, Toggle } from './ui';
export interface RuntimeUpdatesProps {
  status: RuntimeUpdateStatus;
  busy?: boolean;
  onSettings(settings: Partial<RuntimeUpdateSettings>): void;
  onRepair(): void;
  onCheck(): void;
  onStage(kind: 'update' | 'refresh'): void;
  onActivate(): void;
  onRollback(): void;
  onRecover(): void;
  onCancel(): void;
}
export function RuntimeUpdates({
  status,
  busy = false,
  onSettings,
  onRepair,
  onCheck,
  onStage,
  onActivate,
  onRollback,
  onRecover,
  onCancel,
}: RuntimeUpdatesProps) {
  const working = busy || ['checking', 'staging', 'applying', 'rolling-back', 'recovering'].includes(status.state);
  const update = (patch: Partial<RuntimeUpdateSettings>) => onSettings(patch);
  return (
    <section className="settings-card">
      <div className="section-heading">
        <div>
          <h2>
            <ShieldCheck size={18} />
            Engine updates
          </h2>
          <p>
            ComfyUI, its add-ons and Latent's built-in workflows are tested together and update together, so they always
            fit.
          </p>
        </div>
      </div>
      <Notice error={status.state === 'error'}>{status.message}</Notice>
      {working && status.progress !== undefined && <progress value={status.progress} max={100} />}
      {status.automaticRetryPaused && (
        <p>
          Automatic updates are paused because the last one failed or was cancelled. Choose Check now to turn them back
          on, or try again by hand.
        </p>
      )}
      <dl className="metadata">
        <dt>Installed</dt>
        <dd>{status.current?.label ?? 'Not recorded yet'}</dd>
        <dt>Available</dt>
        <dd>{status.available?.label ?? "You're up to date"}</dd>
        <dt>Previous</dt>
        <dd>{status.previous?.label ?? 'Kept after your first update, so you can go back'}</dd>
        <dt>Last checked</dt>
        <dd>{status.lastCheckedAt ? new Date(status.lastCheckedAt).toLocaleString() : 'Not checked yet'}</dd>
        {status.staged && (
          <>
            <dt>Ready to apply</dt>
            <dd>
              {status.staged.label} · {status.staged.kind === 'refresh' ? 'fresh copy of this version' : 'update'}
            </dd>
          </>
        )}
      </dl>
      {status.available?.environmentPreparationBytes && (
        <p>
          Needs about {(status.available.environmentPreparationBytes / 1024 ** 3).toFixed(1)} GB of free space while it
          installs.
        </p>
      )}
      <div className="setting-line">
        <div>
          <h3>Automatic checks</h3>
          <p>New engine versions arrive with Latent app updates.</p>
        </div>
        <fieldset disabled={working}>
          <Toggle
            label="Check for engine updates automatically"
            checked={status.settings.autoCheck}
            onChange={autoCheck => update({ autoCheck })}
          />
        </fieldset>
      </div>
      <div className="setting-line">
        <label htmlFor="runtime-update-interval">How often to check while Latent is open</label>
        <select
          id="runtime-update-interval"
          value={status.settings.intervalHours}
          disabled={working}
          onChange={event => update({ intervalHours: Number(event.target.value) })}
        >
          {![1, 6, 12, 24, 72, 168].includes(status.settings.intervalHours) && (
            <option value={status.settings.intervalHours}>Every {status.settings.intervalHours} hours</option>
          )}
          {[1, 6, 12, 24, 72, 168].map(hours => (
            <option key={hours} value={hours}>
              {hours === 1 ? 'Every hour' : `Every ${hours} hours`}
            </option>
          ))}
        </select>
      </div>
      <div className="setting-line">
        <div>
          <h3>Install updates when idle</h3>
          <p>Waits until nothing is generating, and keeps the old version so you can go back.</p>
        </div>
        <fieldset disabled={working && !['checking', 'staging'].includes(status.state)}>
          <Toggle
            label="Install engine updates automatically"
            checked={status.settings.autoApply}
            onChange={autoApply => update({ autoApply })}
          />
        </fieldset>
      </div>
      {status.environmentRepairRequired && (
        <Notice>
          Some of the engine's packages don't match what they should be. Prepare a repair and Latent fixes it in a
          separate copy, so nothing breaks if it fails.
          {status.environmentRepairBytes
            ? ` It needs about ${(status.environmentRepairBytes / 1024 ** 3).toFixed(1)} GB of free space while it works.`
            : ''}
        </Notice>
      )}
      {status.environmentRepairRequired && !status.staged?.environmentRepair && (
        <button type="button" disabled={working || status.recoveryRequired} onClick={onRepair}>
          <Download size={15} />
          Prepare a repair
        </button>
      )}
      <div className="button-row">
        <button
          type="button"
          disabled={working || status.recoveryRequired || status.environmentRepairRequired}
          onClick={onCheck}
        >
          <RefreshCw size={15} />
          Check now
        </button>
        {status.available && (
          <button type="button" disabled={working || status.recoveryRequired} onClick={() => onStage('update')}>
            <Download size={15} />
            Download update
          </button>
        )}
        {status.staged && (
          <button type="button" className="primary" disabled={working || status.recoveryRequired} onClick={onActivate}>
            {status.staged.environmentRepair ? 'Apply repair' : 'Install update'}
          </button>
        )}
        {status.previous && (
          <button type="button" disabled={working || status.recoveryRequired} onClick={onRollback}>
            <RotateCcw size={15} />
            Go back to previous version
          </button>
        )}
        {status.recoveryRequired && (
          <button type="button" className="primary" disabled={working} onClick={onRecover}>
            Finish interrupted update
          </button>
        )}
        {['checking', 'staging'].includes(status.state) && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <details>
        <summary>Reinstall and update history</summary>
        <p>
          Something acting up? Reinstall downloads a clean copy of the version you have now. It doesn't upgrade
          anything, and your models, images and settings stay put.
        </p>
        <button
          type="button"
          disabled={working || status.recoveryRequired || status.environmentRepairRequired || !status.current}
          onClick={() => onStage('refresh')}
        >
          Reinstall this version
        </button>
        {status.history.length ? (
          <ol>
            {[...status.history]
              .reverse()
              .slice(0, 25)
              .map(event => (
                <li key={event.id}>
                  <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time> · {event.action} ·{' '}
                  {event.outcome}
                  <p>{event.message}</p>
                </li>
              ))}
          </ol>
        ) : (
          <p>No updates yet.</p>
        )}
      </details>
    </section>
  );
}

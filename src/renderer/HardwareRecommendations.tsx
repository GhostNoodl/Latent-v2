import { Cpu, RefreshCw, Sparkles } from 'lucide-react';
import type { HardwareOomAdvice, HardwareProfilesStatus } from '../shared/hardware-profile-types';
import { Notice } from './ui';
import './hardware-recommendations.css';
export interface HardwareRecommendationsProps {
  status: HardwareProfilesStatus;
  busy?: boolean;
  draftChanged?: boolean;
  oomAdvice?: HardwareOomAdvice;
  error?: string;
  draftInvalid?: boolean;
  onRefresh(): void;
  onRecommend(): void;
  onApply(profileId: string, reportId: string): void;
  onApplyBackend(reportId: string): void;
}
const formatBytes = (value: number) =>
  value === 0 ? 'No extra model files' : `${(value / 1e9).toFixed(2)} GB model storage`;
/** One line about this PC for the top of the Engine tab, with a refresh button. */
export function HardwareSummary({
  status,
  busy = false,
  onRefresh,
}: {
  status: HardwareProfilesStatus;
  busy?: boolean;
  onRefresh(): void;
}) {
  const working = busy || status.state === 'refreshing';
  const inventory = status.inventory;
  const gpu = inventory?.gpus[0];
  return (
    <p className="hardware-line">
      <Cpu size={14} />
      <span>
        {inventory
          ? [
              gpu ? `${gpu.name} · ${(gpu.vramMiB / 1024).toFixed(0)} GB` : 'No NVIDIA card found',
              `${(inventory.ramBytes / 1073741824).toFixed(0)} GB RAM`,
            ].join(' · ')
          : "Your PC hasn't been checked yet"}
      </span>
      <button
        type="button"
        className="icon-button"
        disabled={working}
        onClick={onRefresh}
        title="Check this PC again, for example after changing your graphics card"
        aria-label="Check this PC again"
      >
        <RefreshCw size={14} className={working ? 'spin' : ''} />
      </button>
    </p>
  );
}

/** The full list of what Latent found, for the Logs tab. */
export function HardwareDetails({ status }: { status: HardwareProfilesStatus }) {
  const inventory = status.inventory;
  if (!inventory) return <p className="muted">Not checked yet. Use the refresh button on the Engine tab.</p>;
  return (
    <>
      <p className="muted small">Checked {new Date(inventory.observedAt).toLocaleString()}.</p>
      {inventory.messages.map(message => (
        <p className="muted small" key={message}>
          {message}
        </p>
      ))}
      <dl className="metadata">
        <dt>Detection</dt>
        <dd>{inventory.detection}</dd>
        <dt>Device the engine uses</dt>
        <dd>{inventory.activeDevice?.name ?? 'Start the engine to see this'}</dd>
        <dt>NVIDIA cards</dt>
        <dd>
          {inventory.gpus.length
            ? inventory.gpus
                .map(gpu => `${gpu.name} · ${(gpu.vramMiB / 1024).toFixed(1)} GB · driver ${gpu.driver}`)
                .join('; ')
            : 'None found'}
        </dd>
        <dt>System</dt>
        <dd>
          {inventory.os} · {inventory.arch} · {(inventory.ramBytes / 1073741824).toFixed(1)} GB RAM
        </dd>
        <dt>Engine</dt>
        <dd>
          {inventory.runtimeIdentity
            ? `${inventory.runtimeIdentity.data.comfy.observedVersion ?? 'Unknown Comfy version'} · ${inventory.runtimeIdentity.sha256.slice(0, 12)}`
            : 'Start the engine to see its version'}
        </dd>
      </dl>
    </>
  );
}

/** Suggested starting settings for the prompt in Create, tested on this PC where possible. */
export function StartingPresets({
  status,
  busy = false,
  draftChanged = false,
  oomAdvice,
  error,
  draftInvalid = false,
  onRecommend,
  onApply,
}: HardwareRecommendationsProps) {
  const working = busy || status.state === 'refreshing';
  const report = status.report;
  return (
    <div className="hardware-recommendations">
      {status.state === 'error' && <Notice error>{status.message}</Notice>}
      {error && <Notice error>{error}</Notice>}
      <button type="button" disabled={working || draftInvalid} className="primary" onClick={onRecommend}>
        <Sparkles size={15} />
        Suggest settings for my prompt
      </button>
      {draftInvalid && <Notice>Some settings in Create aren't finished yet. Fix them first to get suggestions.</Notice>}
      {draftChanged && report && (
        <Notice>Your settings in Create changed since these suggestions. Ask again to get fresh ones.</Notice>
      )}
      {report && (
        <>
          <p>{report.explanation}</p>
          <div className="hardware-profile-grid">
            {report.recommendations.map(item => (
              <article className="hardware-profile-card" key={item.profile.id}>
                <h3>{item.profile.title}</h3>
                <p>
                  {item.state === 'observed'
                    ? 'Tested on your PC'
                    : item.state === 'partial-benchmark'
                      ? 'Partly tested on your PC'
                      : item.state === 'stale'
                        ? 'Tested before your last engine change'
                        : 'Not tested on your PC yet'}
                </p>
                <p>{item.profile.description}</p>
                <p>
                  {item.profile.settings.width} × {item.profile.settings.height} ·{' '}
                  {item.profile.settings.steps
                    ? `${item.profile.settings.steps} steps · CFG ${item.profile.settings.cfg}`
                    : 'No diffusion sampling'}{' '}
                  · one image
                </p>
                <p>{formatBytes(item.profile.storageBytes)}</p>
                {item.profile.evidence && (
                  <>
                    <p>
                      {item.profile.evidence.durationMs !== undefined
                        ? `Took ${(item.profile.evidence.durationMs / 1000).toFixed(1)} s`
                        : 'Time not measured'}
                      {item.profile.evidence.memory
                        ? ` · used about ${(item.profile.evidence.memory.observedMiB / 1024).toFixed(1)} GB of graphics memory`
                        : ''}
                    </p>
                    <p>{item.profile.evidence.quality}</p>
                  </>
                )}
                <ul>
                  {item.profile.tradeoffs.map(value => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>
                {item.reasons.length > 0 && <Notice>{item.reasons.join(' ')}</Notice>}
                <button
                  type="button"
                  disabled={working || draftChanged || !item.applicable || !item.changedFields.length}
                  onClick={() => onApply(item.profile.id, report.id)}
                >
                  {item.applicable && !item.changedFields.length ? 'Already using these' : 'Use these settings'}
                </button>
                {item.applicable && item.changedFields.length > 0 && (
                  <p>Changes {item.changedFields.join(', ')}. You can Undo afterwards.</p>
                )}
                {item.profile.evidence && (
                  <details>
                    <summary>Test details</summary>
                    <p>
                      {item.profile.evidence.receipt} · {item.profile.evidence.workflowVersion} · image{' '}
                      {item.profile.evidence.recordId}
                    </p>
                    <p>
                      {item.profile.evidence.durationScope}. Cache: {item.profile.evidence.cache}.
                    </p>
                    <ul>
                      {item.profile.evidence.limitations.map(value => (
                        <li key={value}>{value}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </article>
            ))}
          </div>
        </>
      )}
      {oomAdvice?.recognized && (
        <Notice error>
          <strong>{oomAdvice.title}</strong>
          <ol>
            {oomAdvice.steps.map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          <p>Nothing was changed, and Latent won't retry on its own.</p>
        </Notice>
      )}
    </div>
  );
}

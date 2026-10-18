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
export function HardwareRecommendations({
  status,
  busy = false,
  draftChanged = false,
  oomAdvice,
  error,
  draftInvalid = false,
  onRefresh,
  onRecommend,
  onApply,
  onApplyBackend,
}: HardwareRecommendationsProps) {
  const working = busy || status.state === 'refreshing';
  const inventory = status.inventory;
  const report = status.report;
  return (
    <section className="settings-card hardware-recommendations">
      <div className="section-heading">
        <div>
          <h2>
            <Cpu size={18} />
            Your hardware & starting presets
          </h2>
          <p>See what your PC can handle and get suggested settings for it.</p>
        </div>
        <button type="button" disabled={working} onClick={onRefresh}>
          <RefreshCw size={15} className={working ? 'spin' : ''} />
          Refresh hardware
        </button>
      </div>
      <Notice error={status.state === 'error'}>{status.message}</Notice>
      {error && <Notice error>{error}</Notice>}
      {inventory && (
        <p className="muted small">
          Checked {new Date(inventory.observedAt).toLocaleString()}. Refresh after changing your graphics card or
          engine.
        </p>
      )}
      {inventory?.messages.map(message => (
        <p className="muted small" key={message}>
          {message}
        </p>
      ))}
      {inventory && (
        <div className="hardware-summary">
          <div>
            <Cpu size={26} />
            <strong>{inventory.gpus[0]?.name ?? 'Graphics card unavailable'}</strong>
            <span>
              {inventory.gpus[0]
                ? `${(inventory.gpus[0].vramMiB / 1024).toFixed(0)} GB graphics memory`
                : 'Refresh to detect your GPU'}
            </span>
          </div>
          <div>
            <strong>{(inventory.ramBytes / 1073741824).toFixed(0)} GB</strong>
            <span>System memory</span>
          </div>
          <div>
            <strong>{inventory.activeDevice?.name ?? 'Engine stopped'}</strong>
            <span>Generation device</span>
          </div>
        </div>
      )}
      {inventory && (
        <details>
          <summary>Technical device details</summary>
          <dl className="metadata">
            <dt>Detection</dt>
            <dd>{inventory.detection}</dd>
            <dt>Device the engine uses</dt>
            <dd>{inventory.activeDevice?.name ?? 'Start the engine to see this'}</dd>
            <dt>Detected NVIDIA devices</dt>
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
        </details>
      )}
      {status.backend && (
        <div className="setting-line">
          <div>
            <h3>Memory and device mode</h3>
            <p>
              Using: {status.backend.actual}. Suggested: {status.backend.suggested ?? 'refresh hardware first'}.
            </p>
            <p>{status.backend.explanation}</p>
          </div>
          {report && status.backend.suggested && status.backend.actual !== status.backend.suggested && (
            <button type="button" disabled={working || draftChanged} onClick={() => onApplyBackend(report.id)}>
              Use the suggested mode
            </button>
          )}
        </div>
      )}
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
    </section>
  );
}

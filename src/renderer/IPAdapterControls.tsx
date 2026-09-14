import { PackageSetupStorage } from './PackageSetupStorage';
import { useEffect, useRef, useState } from 'react';
import { Download, ImagePlus, Paintbrush, Power, X } from 'lucide-react';
import type { SourceImageAsset } from '../shared/source-types';
import type { ModelFamily } from '../shared/types';
import type { IPAdapterSettings, IPAdapterStatus } from '../shared/ipadapter-types';
import { ipAdapterReferenceRectangle } from '../shared/ipadapter-workflow';
import { IPADAPTER_RELEASE } from '../shared/ipadapter-release';
import { Busy, Field, Notice, Toggle } from './ui';
import './ipadapter.css';

export interface IPAdapterControlsProps {
  /** Composer ownership changes invalidate a pending import, even when reference settings stay absent. */
  draftRevision?: unknown;
  family: ModelFamily; value?: IPAdapterSettings; frozen?: boolean; sources: SourceImageAsset[]; status: IPAdapterStatus; engineStopped: boolean; disabledReason?: string;
  onChange(value: IPAdapterSettings | undefined): void;
  onImportSource(): Promise<SourceImageAsset | null>;
  onStage(): Promise<unknown>; onActivate(): Promise<unknown>; onCancelSetup(): Promise<unknown> | void;
}
export function ipAdapterSettingsForSource(source: SourceImageAsset, family: ModelFamily, existing?: IPAdapterSettings): IPAdapterSettings {
  return { ...(existing ?? { mode: 'balanced', weight: family === 'illustrious' ? 0.30 : 0.65, startPercent: 0, endPercent: 1, framing: 'center-crop' }), sourceId: source.id, sourceSha256: source.normalized.sha256 };
}
export function IPAdapterControls({ draftRevision, family, value, frozen, sources, status, engineStopped, disabledReason, onChange, onImportSource, onStage, onActivate, onCancelSetup }: IPAdapterControlsProps) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const latest = useRef({ value, family }); latest.current = { value, family };
  const ownership = useRef({ draftRevision, value, family, frozen, revision: 0 });
  if (ownership.current.draftRevision !== draftRevision || ownership.current.value !== value || ownership.current.family !== family || ownership.current.frozen !== frozen) ownership.current = { draftRevision, value, family, frozen, revision: ownership.current.revision + 1 };
  const mounted = useRef(true), importRequest = useRef(0), working = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; importRequest.current++; }; }, []);
  const source = sources.find(source => source.id === value?.sourceId); const settingUp = status.state === 'staging' || status.state === 'activating';
  const canActivate = status.state === 'staged' || status.state === 'error' && Boolean(status.bundle);
  const setupMessage = status.state === 'ready'
    ? engineStopped ? 'Reviewed reference files are activated. Start the image engine to use them.' : 'Reviewed reference files are activated. Reference compatibility is checked before generation.'
    : status.state === 'staged' && engineStopped ? 'Reviewed reference files are staged. Activate them, then start the image engine.' : status.message;
  let framingError = ''; let rectangle: ReturnType<typeof ipAdapterReferenceRectangle> | undefined;
  if (source && value) { try { rectangle = ipAdapterReferenceRectangle(source.normalized.width, source.normalized.height, value.framing); } catch (error) { framingError = error instanceof Error ? error.message : String(error); } }
  function choose(source: SourceImageAsset) { importRequest.current++; onChange(ipAdapterSettingsForSource(source, latest.current.family, latest.current.value)); setError(''); }
  function change(patch: Partial<IPAdapterSettings>) { importRequest.current++; if (latest.current.value) onChange({ ...latest.current.value, ...patch }); }
  async function run(task: () => Promise<unknown>) { if (working.current) return; working.current = true; setBusy(true); setError(''); try { await task(); } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : String(error)); } finally { working.current = false; if (mounted.current) setBusy(false); } }
  async function importSource() {
    const request = ++importRequest.current, revision = ownership.current.revision;
    const source = await onImportSource();
    if (source && mounted.current && request === importRequest.current && revision === ownership.current.revision) choose(source);
  }
  async function cancelSetup() { try { await onCancelSetup(); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } }
  return <details className="advanced ipadapter-controls"><summary><Paintbrush size={15} />Image reference · IP Adapter{value && ' · Enabled'}</summary><div className="advanced-grid">
    <p className="muted small">Borrow visual cues from one reference while creating a new image from your prompt. Balanced, style and composition modes guide the model differently; similarity and layout are not guaranteed.</p>
    <div className="button-row"><button type="button" disabled={busy} onClick={() => void run(importSource)}><ImagePlus size={14} />Import reference</button></div>
    <Field label="Saved image reference"><select value={value?.sourceId ?? ''} disabled={busy} onChange={event => { const source = sources.find(source => source.id === event.target.value); if (source) choose(source); }}><option value="">Choose a saved source…</option>{value && !source && <option value={value.sourceId}>Missing reference</option>}{sources.map(source => <option key={source.id} value={source.id}>{source.name}</option>)}</select></Field>
    {disabledReason && <Notice>{disabledReason}</Notice>}
    {frozen && <Notice>This image reference uses its saved framing and dependency versions. Editing the reference controls creates a new recipe.</Notice>}
    {value && <><Toggle checked label="Use this image reference" onChange={() => { importRequest.current++; onChange(undefined); }} />
      {source && <div className="ipadapter-reference"><div className={`ipadapter-reference-image ${value.framing}`}><img src={`latent-asset://source/${source.id}`} alt={`IP Adapter reference: ${source.name}`} /></div><div><strong>{source.name}</strong><p className="muted small">Original: {source.normalized.width} × {source.normalized.height}</p>{rectangle && <p className="muted small">{value.framing === 'center-crop' ? `Square crop: ${rectangle.x}, ${rectangle.y} · ${rectangle.width} × ${rectangle.height}` : 'Entire image stretched to a square'}<br />Vision encoder input: 224 × 224</p>}</div></div>}
      {(!source || source.normalized.sha256 !== value.sourceSha256) && <Notice error>The reference is missing or changed. Restore its original source or choose a deliberate replacement.</Notice>}{framingError && <Notice error>{framingError}</Notice>}
      <div className="two-columns"><Field label="Reference influence"><select value={value.mode} onChange={event => change({ mode: event.target.value as IPAdapterSettings['mode'] })}><option value="balanced">Balanced reference</option><option value="style">Style guidance</option><option value="composition">Composition guidance</option></select></Field><Field label="Reference framing"><select value={value.framing} onChange={event => change({ framing: event.target.value as IPAdapterSettings['framing'] })}><option value="center-crop">Center square crop</option><option value="stretch">Entire image · stretch to square</option></select></Field></div>
      <Field label={`Reference strength · ${value.weight}`} hint="Strength depends on the checkpoint and reference. Reduce it if colors or contrast become harsh. Zero leaves the baseline model unchanged."><input type="range" min={0} max={1.5} step={0.05} value={value.weight} onChange={event => change({ weight: Number(event.target.value) })} /></Field>
      <div className="two-columns"><Field label="Start fraction"><input type="number" min={0} max={1} step={0.05} value={value.startPercent} onChange={event => change({ startPercent: Number(event.target.value) })} /></Field><Field label="End fraction"><input type="number" min={0} max={1} step={0.05} value={value.endPercent} onChange={event => change({ endPercent: Number(event.target.value) })} /></Field></div>
      {value.startPercent >= value.endPercent && <Notice error>Reference influence must start before it ends.</Notice>}
      <p className="muted small">One SDXL/Illustrious text-to-image pass, batch 1. The reference is retained unchanged. Other advanced workflows require separate compatibility tests.</p>
    </>}
    {status.state !== 'ready' && <PackageSetupStorage packageId="ipadapter" />}<Notice>{setupMessage}</Notice>{error && <Notice error>{error}</Notice>}
    {settingUp ? <div className="ipadapter-setup"><Busy active /><progress max={100} value={status.progress ?? 0} /><button type="button" onClick={() => void cancelSetup()}><X size={13} />Cancel setup</button></div> : canActivate ? <div className="button-row"><button type="button" disabled={busy || !engineStopped} onClick={() => void run(onActivate)}><Power size={14} />{status.state === 'error' ? 'Retry reference-tool activation' : 'Activate reviewed reference tools'}</button>{!engineStopped && <span className="muted small">Stop the image engine and finish or cancel its queue first. Activation requires a fresh engine start.</span>}</div> : status.state !== 'ready' && <button type="button" disabled={busy || status.state === 'error' && !engineStopped} onClick={() => void run(onStage)}><Download size={14} />{status.state === 'error' ? 'Repair reference tools' : 'Download reference tools · 3.38 GB'}</button>}
    {status.state === 'error' && <><p className="muted small">Repair preserves changed reviewed files and stages replacements. Stop the image engine and finish or cancel its queue first; activate the repaired files afterward.</p>{canActivate && <button type="button" disabled={busy || !engineStopped} onClick={() => void run(onStage)}>Repair reference tools</button>}</>}
    <details className="ipadapter-provenance"><summary>Reviewed dependencies</summary><p className="muted small">IP Adapter Plus SDXL with the matching ViT-H vision encoder. File checks are separate from visual and GPU compatibility tests.</p><a href={IPADAPTER_RELEASE.modelCardUrl} target="_blank" rel="noreferrer">Adapter model card · Apache-2.0</a><a href={IPADAPTER_RELEASE.encoderOriginUrl} target="_blank" rel="noreferrer">Original vision encoder · MIT</a><a href={IPADAPTER_RELEASE.codeSourceUrl} target="_blank" rel="noreferrer">Pinned IPAdapter Plus code · GPL-3.0</a></details>
  </div></details>;
}


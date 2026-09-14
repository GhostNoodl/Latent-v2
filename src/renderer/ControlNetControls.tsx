import { PackageSetupStorage } from './PackageSetupStorage';
import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Plus, ScanLine } from 'lucide-react';
import type { AppSnapshot, GenerationDraft, GenerationRecord } from '../shared/types';
import type { ControlNetSettings } from '../shared/controlnet-types';
import type { SourceImageAsset } from '../shared/source-types';
import { Field, Notice, Toggle, type RunAction } from './ui';

export function ControlNetControls({ snapshot, draft, selected, onChange, run }: { snapshot: AppSnapshot; draft: GenerationDraft; selected?: GenerationRecord; onChange: (change: Partial<GenerationDraft>) => void; run: RunAction }) {
  const [pending, setPending] = useState(false);
  const latest = useRef(draft); latest.current = draft;
  const ownership = useRef({ draft, revision: 0 });
  if (ownership.current.draft !== draft) ownership.current = { draft, revision: ownership.current.revision + 1 };
  const mounted = useRef(true), importRequest = useRef(0), importing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; importRequest.current++; }; }, []);
  const settings = draft.controlNet;
  const source = snapshot.sourceImages.sources.find(item => item.id === settings?.sourceId);
  const status = snapshot.controlNet;
  function defaults(source: SourceImageAsset): ControlNetSettings { return { kind: 'canny', sourceId: source.id, sourceSha256: source.normalized.sha256, resize: 'center-crop', strength: 0.65, startPercent: 0, endPercent: 1, lowThreshold: 0.1, highThreshold: 0.2 }; }
  function choose(source: SourceImageAsset) { importRequest.current++; onChange({ controlNet: { ...(latest.current.controlNet ?? defaults(source)), sourceId: source.id, sourceSha256: source.normalized.sha256 } }); }
  function change(patch: Partial<ControlNetSettings>) { importRequest.current++; if (latest.current.controlNet) onChange({ controlNet: { ...latest.current.controlNet, ...patch } }); }
  async function importSource(preview: boolean) {
    if (importing.current || preview && !selected) return;
    importing.current = true;
    const request = ++importRequest.current, revision = ownership.current.revision;
    setPending(true);
    try { await run('control-source', async () => { const source = preview ? await window.latent.useOutputAsSource(selected!.id) : await window.latent.importSourceImage(); if (source && mounted.current && request === importRequest.current && revision === ownership.current.revision) choose(source); }); }
    finally { importing.current = false; if (mounted.current) setPending(false); }
  }
  return <details className="advanced"><summary><ScanLine size={15} />Composition guidance · ControlNet{settings && ' · Enabled'}</summary><div className="advanced-grid">
    <p className="muted small">Extract Canny edges from a photo, or supply a prepared depth, line-art or pose map. Uses the installed SDXL Union model.</p>
    <div className="button-row"><button type="button" disabled={pending} onClick={() => void importSource(false)}><Plus size={14} />Import reference</button><button type="button" disabled={pending || !selected} onClick={() => void importSource(true)}><ImagePlus size={14} />Use preview</button></div>
    <Field label="Control reference"><select value={settings?.sourceId ?? ''} disabled={pending} onChange={event => { const item = snapshot.sourceImages.sources.find(item => item.id === event.target.value); if (item) choose(item); }}><option value="">Choose a saved source…</option>{settings && !source && <option value={settings.sourceId}>Missing reference</option>}{snapshot.sourceImages.sources.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
    {status.state !== 'ready' && <PackageSetupStorage packageId="controlnet" />}
    {settings && <><Field label="Control mode"><select value={settings.kind} onChange={event => change({ kind: event.target.value as ControlNetSettings['kind'] })}><option value="canny">Canny edges · automatic</option><option value="depth">Depth · prepared map</option><option value="lineart">Line art / edges · prepared map</option><option value="pose">Pose · prepared OpenPose map</option></select></Field>{settings.kind !== 'canny' && <Notice>Import a prepared {settings.kind} control map, not an ordinary photograph. This mode uses your map directly; it does not estimate depth or detect a pose.</Notice>}<Toggle checked onChange={() => { importRequest.current++; onChange({ controlNet: undefined }); }} label="Use edge control" />
      {source && <div className="source-input-preview"><img src={`latent-asset://source/${source.id}`} alt={`Control reference: ${source.name}`} /><div><strong>{source.name}</strong><span>{source.normalized.width} × {source.normalized.height}</span></div></div>}
      {(!source || source.normalized.sha256 !== settings.sourceSha256) && <Notice error>Choose the original reference or a deliberate replacement.</Notice>}
      <Field label={`Control strength · ${settings.strength}`} hint="Zero retains a control map without applying guidance."><input type="range" min={0} max={2} step={0.05} value={settings.strength} onChange={event => change({ strength: Number(event.target.value) })} /></Field>
      <div className="two-columns"><Field label="Start fraction"><input type="number" min={0} max={1} step={0.05} value={settings.startPercent} onChange={event => change({ startPercent: Number(event.target.value) })} /></Field><Field label="End fraction"><input type="number" min={0} max={1} step={0.05} value={settings.endPercent} onChange={event => change({ endPercent: Number(event.target.value) })} /></Field></div>
      {settings.kind === 'canny' && <div className="two-columns"><Field label="Low edge threshold"><input type="number" min={0.01} max={0.99} step={0.01} value={settings.lowThreshold} onChange={event => change({ lowThreshold: Number(event.target.value) })} /></Field><Field label="High edge threshold"><input type="number" min={0.01} max={0.99} step={0.01} value={settings.highThreshold} onChange={event => change({ highThreshold: Number(event.target.value) })} /></Field></div>}
      <Field label="Fit control reference"><select value={settings.resize} onChange={event => change({ resize: event.target.value as ControlNetSettings['resize'] })}><option value="center-crop">Center crop</option><option value="stretch">Stretch to fit</option></select></Field>
      <p className="muted small">The exact {draft.width} × {draft.height} control map is retained with the result. One sampling pass only; turn off hires fix, inpainting and standalone enlargement.</p>
      <Notice>{status.message}</Notice>{status.state !== 'ready' && <div className="button-row">{status.state === 'installing' ? <><progress value={status.installProgress ?? 0} max={100} /><button type="button" onClick={() => void run('cancel-control', () => window.latent.cancelControlNet())}>Cancel setup</button></> : <button type="button" onClick={() => void run('setup-control', () => window.latent.setupControlNet(status.state === 'error'))}>{status.state === 'error' ? 'Repair Canny ControlNet' : 'Set up Canny ControlNet · 2.51 GB'}</button>}</div>}
    </>}
  </div></details>;
}



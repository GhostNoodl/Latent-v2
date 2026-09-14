import { PackageSetupStorage } from './PackageSetupStorage';
import { useId, useRef, useState } from 'react';
import { Download, ImagePlus, LoaderCircle, ScanFace, Square, WandSparkles } from 'lucide-react';
import type { SourceImageAsset } from '../shared/source-types';
import { actionErrorMessage } from '../shared/action-error';
import { FACE_PROFILE_LABELS, faceRefinementRequestSchema, type FaceDetectionReceipt, type FaceDetectionRequest, type FaceDetailerStatus, type FaceRefinementRequest } from '../shared/face-detailer-types';
import { Field, Notice, type RunAction } from './ui';
import './face-detailer.css';

export interface FaceDetailerActions {
  setup: () => Promise<void>; cancelSetup: () => Promise<void>;
  detect: (request: FaceDetectionRequest) => Promise<FaceDetectionReceipt>; cancelDetection: () => Promise<void>;
  refine: (request: FaceRefinementRequest) => Promise<unknown>;
}
export interface FaceDetailerControlsProps {
  source?: SourceImageAsset; status: FaceDetailerStatus; run: RunAction; actions: FaceDetailerActions;
  onImport?: () => Promise<void>; onUsePreview?: () => Promise<void>; disabled?: boolean;
  initialDetection?: FaceDetectionReceipt;
  initialRefinement?: FaceRefinementRequest; frozen?: boolean; refinementDisabledReason?: string;
}
export function FaceDetailerControls({ source, status, run, actions, onImport, onUsePreview, disabled, initialDetection, initialRefinement, frozen, refinementDisabledReason }: FaceDetailerControlsProps) {
  const [receipt, setReceipt] = useState(initialDetection);
  const [selected, setSelected] = useState<string[]>(initialRefinement?.faceIds ?? initialDetection?.faces.map(face => face.id) ?? []);
  const [profile, setProfile] = useState<FaceDetectionRequest['profile']>(initialDetection?.request.profile ?? 'anime');
  const [maxFaces, setMaxFaces] = useState(initialDetection?.request.maxFaces ?? 4); const [confidence, setConfidence] = useState(initialDetection?.request.confidence ?? 0.7);
  const [expansion, setExpansion] = useState(initialDetection?.request.expansion ?? 0.15); const [feather, setFeather] = useState(initialDetection?.request.feather ?? 8);
  const [denoise, setDenoise] = useState(initialRefinement?.denoise ?? 0.35); const [padding, setPadding] = useState(initialRefinement?.contextPadding ?? 64); const [seed, setSeed] = useState(initialRefinement?.seed ?? 'random');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [imageFailed, setImageFailed] = useState(false);
  const identity = source ? `${source.id}:${source.normalized.sha256}` : undefined;
  const [previewIdentity, setPreviewIdentity] = useState(identity);
  const pending = useRef(false); const currentSource = useRef(source); currentSource.current = source;
  const svgId = useId().replaceAll(':', '_');
  if (previewIdentity !== identity) { setPreviewIdentity(identity); setImageFailed(false); }
  const processing = busy || status.state === 'detecting' || status.state === 'installing' || Boolean(disabled);
  const sourceAllowed = Boolean(source && source.normalized.width * source.normalized.height <= 4194304 && Math.max(source.normalized.width, source.normalized.height) <= 8192);
  const matching = Boolean(source && receipt && receipt.source.id === source.id && receipt.source.sha256 === source.normalized.sha256);
  const refinement = faceRefinementRequestSchema.safeParse({ detectionId: receipt?.id, faceIds: selected, denoise, contextPadding: padding, seed });
  async function perform(key: string, work: () => Promise<unknown>) {
    if (pending.current || disabled) return; pending.current = true; setBusy(true); setError('');
    try { await run(key, async () => { try { await work(); } catch (reason) { setError(actionErrorMessage(reason)); throw reason; } }); }
    finally { pending.current = false; setBusy(false); }
  }
  function invalidate() { setReceipt(undefined); setSelected([]); setError(''); }
  function toggle(id: string) { setSelected(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]); }
  async function detect() {
    const frozenSource = currentSource.current; if (!frozenSource || !sourceAllowed) return;
    const request: FaceDetectionRequest = { sourceId: frozenSource.id, sourceSha256: frozenSource.normalized.sha256, profile, maxFaces, confidence, expansion, feather };
    await perform('face-detect', async () => { const detected = await actions.detect(request); setReceipt(detected); setSelected(detected.faces.map(face => face.id)); });
  }
  const ready = status.state === 'ready' || status.state === 'error';
  return <section className="face-detailer" aria-label="Automatic face refinement">
    <div className="section-heading"><h3><ScanFace size={17} />Automatic face refinement</h3><span className="tag">Experimental · CPU detection</span></div>
    <p className="face-help">Find faces, review the selected regions, then refine each one at 512 × 512. Your chosen diffusion model and prompts supply the edit. The original canvas is retained.</p>
    {frozen && <Notice>The saved recipe keeps its exact detections, selected faces, order and seeds. Editing selection, strength, context or seed deliberately creates a new plan.</Notice>}
    {(onImport || onUsePreview) && <div className="face-actions">{onImport && <button type="button" disabled={processing} onClick={() => { void perform('face-import', onImport); }}><ImagePlus size={15} />Import source</button>}{onUsePreview && <button type="button" disabled={processing} onClick={() => { void perform('face-preview-source', onUsePreview); }}>Use preview as source</button>}</div>}
    {!source && <Notice>Select or import a source image before detecting faces.</Notice>}
    {source && <p className="face-source"><strong>{source.name}</strong><span>{source.normalized.width} × {source.normalized.height}</span></p>}
    {source && !sourceAllowed && <Notice error>The initial automatic face profile supports source canvases up to 4 megapixels and 8192 pixels per side. Use a smaller source.</Notice>}
    {['not-installed','error','installing'].includes(status.state) && <PackageSetupStorage packageId="face-detailer" />}<div className="face-runtime" aria-live="polite"><span>{status.message}</span>{status.state === 'installing' && <progress value={status.installProgress ?? 0} max={100} aria-label="Face detector installation progress" />}</div>
    <div className="face-actions">{status.state === 'not-installed' || status.state === 'error' ? <button type="button" className="soft-button" disabled={processing} onClick={() => { void perform('face-setup', actions.setup); }}><Download size={15} />{status.state === 'error' ? 'Verify / set up CPU detector' : 'Install CPU detector · 41 MB'}</button> : null}{status.state === 'installing' && <button type="button" onClick={() => { void run('face-cancel-setup', actions.cancelSetup); }}><Square size={14} />Cancel setup</button>}{status.state === 'detecting' && <button type="button" onClick={() => { void run('face-cancel-detection', actions.cancelDetection); }}><Square size={14} />Cancel detection</button>}</div>
    <fieldset disabled={processing} className="face-detection-fields"><legend>Detection and mask</legend>
      <Field label="Face style"><select value={profile} onChange={event => { setProfile(event.target.value as typeof profile); invalidate(); }}>{Object.entries(FACE_PROFILE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <div className="face-fields-pair"><Field label="Maximum faces"><select value={maxFaces} onChange={event => { setMaxFaces(Number(event.target.value)); invalidate(); }}>{[1, 2, 3, 4].map(count => <option key={count}>{count}</option>)}</select></Field><Field label={`Expand region · ${Math.round(expansion * 100)}%`}><input type="range" min={0} max={0.5} step={0.05} value={expansion} onChange={event => { setExpansion(Number(event.target.value)); invalidate(); }} /></Field></div>
      <Field label={`Inward feather · ${feather} source pixels`} hint="Softens the inside of the ellipse; pixels outside it stay untouched."><input type="range" min={0} max={32} step={1} value={feather} onChange={event => { setFeather(Number(event.target.value)); invalidate(); }} /></Field>
      {profile === 'photographic' && <Field label={`YuNet minimum score · ${confidence.toFixed(2)}`} hint="A detector score is not a guarantee that the region contains a face."><input type="range" min={0.1} max={0.99} step={0.01} value={confidence} onChange={event => { setConfidence(Number(event.target.value)); invalidate(); }} /></Field>}
      <p className="face-help">{profile === 'anime' ? 'The anime cascade does not provide a calibrated confidence score.' : 'YuNet is intended for photographic human faces.'} Both profiles can miss faces or select unrelated regions, especially on unusual or non-human characters.</p>
      <button type="button" className="soft-button" disabled={!ready || !sourceAllowed || imageFailed} onClick={() => { void detect(); }}>{busy && status.state === 'detecting' ? <LoaderCircle size={15} className="spin" /> : <ScanFace size={15} />}Detect faces</button>
    </fieldset>
    {receipt && !matching && <Notice error>These detections belong to a different source. Select their original source or detect the current image again.</Notice>}
    {receipt && matching && <div className="face-review">
      <div className="section-heading"><h4>Review detected regions</h4><span>{receipt.faces.length} found · {Math.round(receipt.durationMs)} ms</span></div>
      {receipt.faces.length === 0 ? <Notice>No faces were detected. Your original stays unchanged. Try the other profile or another source; no refinement will be queued.</Notice> : <>
        <svg className="face-overlay" viewBox={`0 0 ${receipt.source.width} ${receipt.source.height}`} aria-label="Source with detected face regions" role="group">
          <image href={`latent-asset://source/${encodeURIComponent(receipt.source.id)}`} width={receipt.source.width} height={receipt.source.height} onError={() => setImageFailed(true)} />
          <defs>{receipt.faces.map(face => <mask id={`${svgId}_${face.id}`} key={face.id} maskUnits="userSpaceOnUse" x={0} y={0} width={receipt.source.width} height={receipt.source.height}><image href={`latent-asset://mask/${encodeURIComponent(face.mask.id)}`} width={receipt.source.width} height={receipt.source.height} onError={() => setImageFailed(true)} /></mask>)}</defs>
          {receipt.faces.map((face, index) => <g key={face.id}>{selected.includes(face.id) && <rect x={0} y={0} width={receipt.source.width} height={receipt.source.height} fill="var(--accent)" opacity={0.45} mask={`url(#${svgId}_${face.id})`} />}<rect {...face.box} className={`face-box ${selected.includes(face.id) ? 'selected' : ''}`} tabIndex={processing ? -1 : 0} role="checkbox" aria-checked={selected.includes(face.id)} aria-label={`Refine face ${index + 1}`} onClick={() => { if (!processing) toggle(face.id); }} onKeyDown={event => { if (!processing && [' ', 'Enter'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); toggle(face.id); } }} /></g>)}
        </svg>
        {imageFailed && <Notice error>A source or mask preview could not load. Review the source before queuing refinement.</Notice>}
        <div className="face-choices">{receipt.faces.map((face, index) => <label className="checkbox-label" key={face.id}><input type="checkbox" disabled={processing} checked={selected.includes(face.id)} onChange={() => toggle(face.id)} /><span>Face {index + 1} · {face.box.width} × {face.box.height}{face.score === undefined ? '' : ` · score ${face.score.toFixed(2)}`}</span></label>)}</div>
        {receipt.omittedCount > 0 && <p className="face-help">{receipt.omittedCount} additional candidate{receipt.omittedCount === 1 ? '' : 's'} exceeded the selected limit. Larger regions and higher YuNet scores are considered first.</p>}
        <fieldset disabled={processing}><legend>Refinement</legend><Field label={`Change strength · ${Math.round(denoise * 100)}%`} hint="Lower values keep more of the existing face."><input type="range" min={0} max={1} step={0.01} value={denoise} onChange={event => setDenoise(Number(event.target.value))} /></Field><div className="face-fields-pair"><Field label="Context padding"><input type="number" min={0} max={512} step={8} value={padding} onChange={event => setPadding(Number(event.target.value))} /></Field><Field label="Seed"><input value={seed} maxLength={32} spellCheck={false} onChange={event => setSeed(event.target.value)} placeholder="random" /></Field></div></fieldset>
        {!refinement.success && selected.length > 0 && <p className="inline-error">{refinement.error.issues[0]?.message}</p>}
        <p className="face-help">Up to four sequential edits, batch size 1. Selected regions may change expression or identity. Review your current model and prompts before queuing.</p>
        <button type="button" className="primary" disabled={processing || !refinement.success || imageFailed || !sourceAllowed || Boolean(refinementDisabledReason)} onClick={() => { if (refinement.success && matching) void perform('face-refine', () => actions.refine(refinement.data)); }}><WandSparkles size={16} />Refine {selected.length || 'selected'} {selected.length === 1 ? 'face' : 'faces'}</button>
      </>}
    </div>}
    {refinementDisabledReason && <Notice error>{refinementDisabledReason}</Notice>}
    {error && <Notice error>{error}</Notice>}
  </section>;
}


import { useEffect, useRef, useState } from 'react';
import { FileImage, ImagePlus, LoaderCircle, Paintbrush, Plus, X } from 'lucide-react';
import type { AppSnapshot, GenerationDraft, GenerationRecord } from '../shared/types';
import type { SourceImageAsset, SourceMaskAsset } from '../shared/source-types';
import { Field, type RunAction } from './ui';
import { MaskEditor } from './MaskEditor';
import './source-input.css';
import { DEFAULT_CROP_INPAINT_SETTINGS } from '../shared/crop-inpaint-types';

interface SourceInputProps {
  snapshot: AppSnapshot;
  draft: GenerationDraft;
  onChange: (change: Partial<GenerationDraft>) => void;
  selected?: GenerationRecord;
  run: RunAction;
}

export function SourceInput({ snapshot, draft, onChange, selected, run }: SourceInputProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [imageFailed, setImageFailed] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [editor, setEditor] = useState<{ source: SourceImageAsset; mask?: SourceMaskAsset }>();
  const current = useRef(draft); current.current = draft;
  const ownership = useRef({ draft, revision: 0 });
  if (ownership.current.draft !== draft) ownership.current = { draft, revision: ownership.current.revision + 1 };
  const mounted = useRef(true), importRequest = useRef(0), importing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; importRequest.current++; }; }, []);
  const sources = snapshot.sourceImages.sources;
  const input = draft.imageInput;
  const source = sources.find(item => item.id === input?.sourceId);
  const sourceChanged = Boolean(source && input && source.normalized.sha256 !== input.sourceSha256);
  const masks = source ? snapshot.sourceImages.masks.filter(mask => mask.sourceId === source.id && mask.sourceSha256 === source.normalized.sha256).sort((a, b) => b.revision - a.revision) : [];
  const mask = masks.find(item => item.id === input?.maskId && item.sha256 === input?.maskSha256);
  const ready = Boolean(source && !sourceChanged && !imageFailed);
  useEffect(() => { setImageFailed(false); }, [input?.sourceId, input?.sourceSha256]);

  function chooseSource(next: SourceImageAsset) {
    importRequest.current++;
    const previous = current.current.imageInput;
    onChange({ imageInput: { mode: previous?.mode ?? 'img2img', sourceId: next.id, sourceSha256: next.normalized.sha256, denoise: previous?.denoise ?? 0.65, resize: previous?.resize ?? 'center-crop' } });
    setError(''); setImageFailed(false);
  }
  async function importSource(useSelected = false) {
    if (importing.current || (useSelected && !selected)) return;
    importing.current = true;
    const request = ++importRequest.current, revision = ownership.current.revision;
    const ownsDraft = () => mounted.current && importRequest.current === request && ownership.current.revision === revision;
    setBusy(true); setError('');
    try {
      await run('source-import', async () => {
        try {
          const result = useSelected ? await window.latent.useOutputAsSource(selected!.id) : await window.latent.importSourceImage();
          // Keep the imported file in saved sources, but never attach it over a later edit or restore.
          if (result && ownsDraft()) chooseSource(result);
        } catch (reason) { if (ownsDraft()) setError(reason instanceof Error ? reason.message : String(reason)); throw reason; }
      });
    } finally { importing.current = false; if (mounted.current) setBusy(false); }
  }
  function changeInput(patch: Partial<NonNullable<GenerationDraft['imageInput']>>) {
    importRequest.current++;
    if (current.current.imageInput) onChange({ imageInput: { ...current.current.imageInput, cropPlan: undefined, ...patch, ...(patch.mode === 'img2img' ? { crop: undefined } : {}) } });
  }
  function savedMask(saved: SourceMaskAsset) {
    const latest = current.current.imageInput;
    if (!latest || latest.sourceId !== saved.sourceId || latest.sourceSha256 !== saved.sourceSha256) throw new Error('The mask was saved for its original source, but Create now uses another source. Select that source to use this mask.');
    onChange({ imageInput: { ...latest, cropPlan: undefined, mode: 'inpaint', maskId: saved.id, maskSha256: saved.sha256 } });
  }

  return <section className="source-input" aria-label="Source image">
    <div className="source-input-heading"><h3><FileImage size={15} />Source image</h3>{input && <button type="button" className="icon-button" aria-label="Return to text to image" title="Return to text to image" disabled={busy} onClick={() => onChange({ imageInput: undefined, upscale: undefined })}><X size={14} /></button>}</div>
    <div className="source-import-actions"><button type="button" className="soft-button" disabled={busy} onClick={() => { void importSource(); }}>{busy ? <LoaderCircle size={14} className="spin" /> : <Plus size={14} />}Import image</button><button type="button" disabled={busy || !selected} title={selected ? `Use ${selected.filename}` : 'Select a saved image in history first'} onClick={() => { void importSource(true); }}><ImagePlus size={14} />Use preview</button></div>
    {sources.length > 0 && <div><label>Saved sources</label><div className="source-thumbnail-list">{sources.map(item => <button type="button" key={item.id} disabled={busy} aria-pressed={input?.sourceId === item.id} onClick={() => chooseSource(item)} title={`${item.name} · ${item.normalized.width} × ${item.normalized.height}`}><img loading="lazy" src={`latent-asset://source/${item.id}`} alt={item.name} /><span>{item.name}</span><small>{item.normalized.width} × {item.normalized.height}</small></button>)}</div></div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!input && <p className="source-input-help">PNG, JPEG, or WebP. Importing adds a private copy and keeps your original.</p>}
    {input && <>
      {!source || sourceChanged ? <p className="inline-error" role="alert">{sourceChanged ? 'This source differs from the saved recipe. Choose a source deliberately to replace it.' : 'The source for this recipe is missing. Choose or import its source before generating.'}</p> : <div className="source-input-preview"><img key={`${source.id}:${source.normalized.sha256}:${previewAttempt}`} src={`latent-asset://source/${encodeURIComponent(source.id)}`} alt={`Source: ${source.name}`} onLoad={() => setImageFailed(false)} onError={() => setImageFailed(true)} /><div><strong>{source.name}</strong><span>{source.normalized.width} × {source.normalized.height}</span></div></div>}
      {imageFailed && <><p className="inline-error" role="alert">The source preview could not be loaded. Retry after restoring its original file, or import a new source if the file has changed.</p><button type="button" className="soft-button" onClick={() => setPreviewAttempt(value => value + 1)}>Retry source preview</button></>}
      {draft.upscale ? <p className="source-input-help">This source will {draft.upscale.resize === 'center-crop' ? 'be center-cropped' : 'stretch'} to {draft.upscale.width} × {draft.upscale.height}. Choose the enlargement method and size below.</p> : <>
      <div className="source-mode" aria-label="Image workflow"><button type="button" aria-pressed={input.mode === 'img2img'} onClick={() => changeInput({ mode: 'img2img' })}>Image to image</button><button type="button" aria-pressed={input.mode === 'inpaint'} onClick={() => changeInput({ mode: 'inpaint' })}>Inpaint</button></div>
      <Field label={`Change strength · ${Math.round(input.denoise * 100)}%`} hint={input.mode === 'inpaint' && (!input.crop || input.crop.mode === 'replace') ? 'Replacement clears the selected content first. Higher strength allows a fresh replacement; low nonzero strength can leave a flat patch. Zero keeps the source unchanged.' : 'Lower values keep more of the source. Higher values allow larger changes.'}><input type="range" min={0} max={1} step={0.01} value={input.denoise} onChange={event => changeInput({ denoise: Number(event.target.value) })} /></Field>
      {!input.crop && <><Field label="Fit source to output"><select value={input.resize} onChange={event => changeInput({ resize: event.target.value as 'stretch' | 'center-crop' })}><option value="center-crop">Center crop</option><option value="stretch">Stretch to fit</option></select></Field><p className="source-input-help">Source{input.mode === 'inpaint' ? ' and mask' : ''} will {input.resize === 'center-crop' ? 'be center-cropped' : 'stretch'} to {draft.width} × {draft.height}. Imported dimensions do not change the output size.</p></>}
      {input.mode === 'inpaint' && <div className="source-mask-controls">
        <label className="checkbox-label"><input type="checkbox" checked={Boolean(input.crop)} onChange={event => changeInput({ crop: event.target.checked ? { ...DEFAULT_CROP_INPAINT_SETTINGS } : undefined })} />Focus on the masked area</label>
        {input.crop ? <><Field label="Inpaint approach"><select value={input.crop.mode} onChange={event => changeInput({ crop: { ...input.crop!, mode: event.target.value as 'refine' | 'replace' } })}><option value="refine">Refine existing content</option><option value="replace">Replace selected content</option></select></Field><Field label="Context padding (source pixels)" hint="Include surrounding details to help the edit blend in."><input type="number" min={0} max={2048} step={8} value={input.crop.contextPadding} onChange={event => changeInput({ crop: { ...input.crop!, contextPadding: Number(event.target.value) } })} /></Field><p className="source-input-help">The selected area and context are worked at {draft.width} × {draft.height}, then blended into the original {source?.normalized.width ?? '?'} × {source?.normalized.height ?? '?'} canvas. Black-mask pixels and original transparency are preserved. Source canvases up to 4 megapixels.</p>{input.crop.mode === 'replace' && <p className="source-input-help">Replacement clears the selected content before sampling. Use high strength for a fresh replacement.</p>}</> : <p className="source-input-help">Full-frame replacement clears the selected area before sampling. Small edits may benefit from Focus on the masked area.</p>}
        {masks.length > 0 && <Field label="Saved mask"><select value={mask?.id ?? ''} onChange={event => { const next = masks.find(item => item.id === event.target.value); if (next) changeInput({ maskId: next.id, maskSha256: next.sha256 }); }}><option value="">Choose a mask revision…</option>{masks.map(item => <option key={item.id} value={item.id}>Revision {item.revision} · {new Date(item.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</option>)}</select></Field>}
        <div className="source-mask-actions"><button type="button" className="soft-button" disabled={!ready} onClick={() => { if (source) setEditor({ source, mask }); }}><Paintbrush size={14} />{mask ? 'Edit mask' : 'Paint mask'}</button>{mask && <button type="button" disabled={!ready} onClick={() => { if (source) setEditor({ source }); }}>New mask</button>}</div>
        {mask ? <p className="source-input-help">Mask revision {mask.revision} selected. Edits save as a new revision.</p> : <p className="inline-error">{input.maskId ? 'The saved mask is unavailable or changed. Select a matching revision or paint a new mask.' : 'Paint and save a nonempty mask before generating.'}</p>}
        {draft.batchSize !== 1 && <div className="source-batch-warning"><p>Inpainting currently generates one image at a time.</p><button type="button" onClick={() => onChange({ batchSize: 1 })}>Set batch to 1</button></div>}
      </div>}
      </>}
    </>}
    {editor && <MaskEditor source={editor.source} mask={editor.mask} segmentationStatus={snapshot.segmentation} onSaved={savedMask} onClose={() => setEditor(undefined)} run={run} />}
  </section>;
}

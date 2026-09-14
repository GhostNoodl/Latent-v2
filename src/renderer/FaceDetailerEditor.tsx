import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSnapshot, GenerationDraft, GenerationRecord } from '../shared/types';
import type { FaceDetectionReceipt } from '../shared/face-detailer-types';
import { prepareFaceDraft, restoreFaceDraft } from '../shared/face-detailer-recipe';
import { actionErrorMessage } from '../shared/action-error';
import { validateAssets } from '../shared/workflow';
import { FaceDetailerControls } from './FaceDetailerControls';
import { Field, Modal, Notice, type RunAction } from './ui';

type FaceEditorProps = { snapshot: AppSnapshot; draft: GenerationDraft; record?: GenerationRecord; preview?: GenerationRecord; previewRevision?: number; run: RunAction; onClose: () => void; onQueued: () => void };

export function FaceDetailerEditor(props: FaceEditorProps) {
  const [restored] = useState(() => {
    try { return { recipe: props.record?.faceDetailer ? restoreFaceDraft(props.record) : structuredClone(props.draft) }; }
    catch (error) { return { error: actionErrorMessage(error) }; }
  });
  if (!restored.recipe) return <Modal title="Reuse face refinement" onClose={props.onClose}><Notice error>Could not restore these parameters: {restored.error} Recover the original generation metadata before reusing this setup. Your Create draft is unchanged.</Notice></Modal>;
  return <ReadyFaceDetailerEditor {...props} recipe={restored.recipe} />;
}

function ReadyFaceDetailerEditor({ snapshot, recipe, record, preview, previewRevision, run, onClose, onQueued }: FaceEditorProps & { recipe: GenerationDraft }) {
  const [sourceId, setSourceId] = useState(record?.faceDetailer?.source.id ?? snapshot.sourceImages.sources[0]?.id);
  const [detection, setDetection] = useState<FaceDetectionReceipt>();
  const [loading, setLoading] = useState(Boolean(record?.faceDetailer)); const [error, setError] = useState(''); const [queued, setQueued] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0); const [closeError, setCloseError] = useState('');
  const [closing, setClosing] = useState(false);
  const mounted = useRef(true), closingRef = useRef(false), epoch = useRef(0), sourceRevision = useRef(0);
  const sourceIdRef = useRef(sourceId); const live = useRef({ snapshot, preview, previewRevision }); live.current = { snapshot, preview, previewRevision };
  const pending = useRef(new Map<string, Promise<boolean>>()); const closeWork = useRef<Promise<void> | undefined>(undefined);
  const pendingRefinement = useRef<Promise<unknown> | undefined>(undefined);
  const source = snapshot.sourceImages.sources.find(item => item.id === sourceId);
  const selectSource = (id: string) => { if (closingRef.current) return; sourceIdRef.current = id; sourceRevision.current++; setSourceId(id); setQueued(false); };
  const localRun: RunAction = useCallback(async (key, task, success) => {
    if (closingRef.current || pending.current.has(key)) return false;
    let accepted: Promise<unknown> | undefined;
    const work = run(key, () => {
      accepted = task();
      // Parent run reports task failures as false. Keep the accepted refinement
      // promise so closing can distinguish queue failure from declined task entry.
      if (key === 'face-refine') pendingRefinement.current = accepted;
      return accepted;
    }, success); pending.current.set(key, work);
    try { return await work; } finally { pending.current.delete(key); if (key === 'face-refine' && pendingRefinement.current === accepted) pendingRefinement.current = undefined; }
  }, [run]);
  const prepareClose = useCallback(() => {
    if (closeWork.current) return closeWork.current;
    closingRef.current = true; setClosing(true); setCloseError(''); epoch.current++;
    const work = (async () => {
      try {
        if (pending.current.has('face-detect') || live.current.snapshot.faceDetailer.state === 'detecting') await window.latent.cancelFaceDetection();
        // Detection is intentionally cancelled above; its stale-result rejection
        // remains handled by run. A submitted refinement must instead report failure.
        await Promise.all([
          ...[...pending.current].filter(([key]) => ['face-detect', 'face-import', 'face-preview-source', 'face-refine'].includes(key)).map(([, task]) => task),
          ...(pendingRefinement.current ? [pendingRefinement.current] : []),
        ]);
      } catch (reason) { closingRef.current = false; if (mounted.current) { setClosing(false); setCloseError(actionErrorMessage(reason)); } throw reason; }
    })();
    closeWork.current = work;
    void work.finally(() => { if (closeWork.current === work) closeWork.current = undefined; }).catch(() => {});
    return work;
  }, []);
  useEffect(() => {
    mounted.current = true;
    const before = window.latent.onBeforeClose?.(prepareClose);
    const cancelled = window.latent.onCloseCancelled?.(() => { closingRef.current = false; setClosing(false); });
    return () => { mounted.current = false; epoch.current++; before?.(); cancelled?.(); if (pending.current.has('face-detect')) void window.latent.cancelFaceDetection().catch(() => {}); };
  }, [prepareClose]);
  const close = async () => { try { await prepareClose(); if (mounted.current && closingRef.current) onClose(); } catch { /* The retained editor displays the failure. */ } };
  async function importSource(usePreview = false) {
    const requestedRevision = sourceRevision.current, requestedEpoch = epoch.current;
    const requestedSource = live.current.snapshot.sourceImages.sources.find(item => item.id === sourceIdRef.current);
    const previewId = live.current.preview?.id;
    const imported = usePreview && previewId ? await window.latent.useOutputAsSource(previewId) : await window.latent.importSourceImage();
    if (!imported) return;
    if (!mounted.current || closingRef.current || requestedEpoch !== epoch.current) return;
    const currentSource = live.current.snapshot.sourceImages.sources.find(item => item.id === sourceIdRef.current);
    if (requestedRevision !== sourceRevision.current || requestedSource?.id !== currentSource?.id || requestedSource?.normalized.sha256 !== currentSource?.normalized.sha256) throw new Error('The imported source was saved, but your face source changed. Select it deliberately to use it.');
    selectSource(imported.id);
  }
  useEffect(() => {
    let active = true;
    if (record?.faceDetailer) { setLoading(true); setError(''); }
    if (record?.faceDetailer) void window.latent.getFaceDetection(record.faceDetailer.plan.detectionId).then(value => {
      if (JSON.stringify(value) !== JSON.stringify(record.faceDetailer!.detection)) throw new Error('The saved detection receipt differs from this image. Restore its original receipt before reusing it.');
      if (active) setDetection(value);
    }).catch(reason => { if (active) setError(actionErrorMessage(reason)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [record, loadAttempt]);
  let reason = '';
  if (recipe.imageInput || recipe.controlNet || recipe.hiresFix || recipe.upscale || recipe.ipAdapter || recipe.qwenEdit || recipe.regionalPrompts?.settings.enabled) reason = 'Return to Create and turn off other image workflows before face refinement.';
  try { validateAssets(recipe, snapshot.models); } catch (failure) { reason ||= failure instanceof Error ? failure.message : String(failure); }
  if (snapshot.backend.state !== 'ready') reason ||= 'Start the image engine in Settings before refining. CPU detection is available while the engine is stopped.';
  const checkpoint = snapshot.models.find(model => model.id === recipe.checkpointId);
  const variations = recipe.dynamicPrompts?.enabled;
  const frozenPrompts = variations ? recipe.dynamicPrompts?.frozen : undefined;
  return <Modal title={record?.faceDetailer ? 'Reuse face refinement' : 'Refine faces'} onClose={() => { void close(); }}>
    <p className="muted small">{checkpoint?.name ?? recipe.checkpointId} · {recipe.family} · {recipe.steps} steps · CFG {recipe.cfg} · {recipe.loras.length} LoRAs. Refinement uses 512 × 512 working crops and saves every completed pass at the original canvas size.</p>
    <details><summary>{variations ? 'Prompt variations for every face' : 'Prompts used for every face'}</summary>
      {variations && <p className="muted small">{frozenPrompts ? `Saved choices stay frozen at prompt seed ${frozenPrompts.resolutionSeed}, even when you change the face image seed. Every face uses the same expansion.` : 'Choices resolve once when queued, using the first face image seed. Every face uses the same expansion.'}</p>}
      {frozenPrompts && <div aria-label="Saved prompt expansion"><p>Expanded positive: {frozenPrompts.positive.resolved || 'None'}</p><p className="muted small">Expanded negative: {frozenPrompts.negative.resolved || 'None'}</p></div>}
      <p>{variations && 'Authored positive: '}{recipe.prompt || 'No positive prompt'}</p><p className="muted small">{variations ? 'Authored negative' : 'Negative'}: {recipe.negativePrompt || 'None'}</p>
      <p className="muted small">The model, LoRAs and prompts are captured when this window opens. Close it to edit the Create recipe.</p>
    </details>
    <Field label="Source image"><select value={sourceId ?? ''} disabled={closing || loading || snapshot.faceDetailer.state === 'detecting'} onChange={event => selectSource(event.target.value)}><option value="">Choose a saved source</option>{sourceId && !source && <option value={sourceId}>Missing source · {sourceId}</option>}{snapshot.sourceImages.sources.map(item => <option key={item.id} value={item.id}>{item.name} · {item.normalized.width} × {item.normalized.height}</option>)}</select></Field>
    {loading ? <Notice>Verifying the saved source, detections and masks…</Notice> : !error && <FaceDetailerControls key={record?.id ?? 'new'} source={source} status={snapshot.faceDetailer} run={localRun} disabled={closing} initialDetection={detection} initialRefinement={recipe.faceDetailer?.request} frozen={Boolean(recipe.faceDetailer?.frozen)} refinementDisabledReason={reason} onImport={() => importSource()} onUsePreview={preview ? () => importSource(true) : undefined} actions={{ setup: () => window.latent.setupFaceDetailer(snapshot.faceDetailer.state === 'error'), cancelSetup: () => window.latent.cancelFaceDetailerSetup(), detect: async input => {
      const requestedEpoch = epoch.current, requestedRevision = sourceRevision.current;
      const result = await window.latent.detectFaces(input);
      const current = live.current.snapshot.sourceImages.sources.find(item => item.id === sourceIdRef.current);
      if (!mounted.current || closingRef.current || requestedEpoch !== epoch.current || requestedRevision !== sourceRevision.current || current?.id !== input.sourceId || current.normalized.sha256 !== input.sourceSha256) throw new Error('Face detection was interrupted or its source changed. Detect the current source again.');
      if (result.source.id !== input.sourceId || result.source.sha256 !== input.sourceSha256) throw new Error('Face detection returned a different source. Detect the current source again.');
      return result;
    }, cancelDetection: () => { epoch.current++; return window.latent.cancelFaceDetection(); }, refine: async request => {
      const requestedEpoch = epoch.current, requestedRevision = sourceRevision.current, requestedPreview = live.current.preview?.id, requestedPreviewRevision = live.current.previewRevision;
      await window.latent.queueGeneration(prepareFaceDraft(recipe, request));
      if (!mounted.current || closingRef.current || requestedEpoch !== epoch.current || requestedRevision !== sourceRevision.current) return;
      setQueued(true); if (requestedPreview === live.current.preview?.id && requestedPreviewRevision === live.current.previewRevision) onQueued();
    } }} />}
    {closing && <Notice>Finishing pending face-editor work before closing…</Notice>}
    {error && <Notice error>{error}<button type="button" disabled={closing} onClick={() => setLoadAttempt(value => value + 1)}>Retry saved detection</button></Notice>}
    {closeError && <Notice error>{closeError}</Notice>}
    {queued && <Notice>Face refinement is queued. Each completed face pass will appear in image history with its saved seed and masks.</Notice>}
  </Modal>;
}

import { PackageSetupStorage } from './PackageSetupStorage';
import { actionErrorMessage } from '../shared/action-error';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Check, CircleStop, Download, Eraser, Eye, FlipHorizontal2, Hand, LoaderCircle, Minus, Paintbrush, Play, Plus, RectangleHorizontal, Save, Scan, Sparkles, Square, Trash2, Undo2 } from 'lucide-react';
import { SOURCE_IMAGE_LIMITS, type SourceImageAsset, type SourceMaskAsset, type SourceMaskEdit } from '../shared/source-types';
import type { SegmentationRequest, SegmentationStatus, SegmentationSuggestion } from '../shared/segmentation-types';
import { maskTransformEdit, type MaskTransformKind, type MaskTransformResponse, type MaskTransformSettings } from './mask-transform';
import { Modal, Notice, type RunAction } from './ui';
import './source-input.css';

interface MaskEditorProps {
  source: SourceImageAsset;
  mask?: SourceMaskAsset;
  segmentationStatus: SegmentationStatus;
  onSaved: (mask: SourceMaskAsset) => void;
  onClose: () => void;
  run: RunAction;
}
type Tool = 'paint' | 'erase' | 'rectangle' | 'pan' | 'include' | 'exclude' | 'smart-box';
interface Point { x: number; y: number; }
interface UndoFrame { pixels: Uint8Array; version: number; edits: SourceMaskEdit[]; }
const UNDO_BYTES = 64 * 1024 * 1024;
const MAX_UNDO = 8;
const TINT = [194, 162, 244] as const;
const SMART_MAX_PIXELS = 4 * 1024 * 1024;
const SMART_MAX_POINTS = 64;

export function MaskEditor({ source, mask, segmentationStatus, onSaved, onClose, run }: MaskEditorProps) {
  const width = source.normalized.width; const height = source.normalized.height;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [appClosing, setAppClosing] = useState(false);
  const appClosingRef = useRef(false), closeEpoch = useRef(0);
  const [dirty, setDirty] = useState(false);
  const [closeWarning, setCloseWarning] = useState(false);
  const keepEditingButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (closeWarning) { keepEditingButton.current?.focus(); keepEditingButton.current?.closest('.mask-close-warning')?.scrollIntoView({ block: 'nearest' }); } }, [closeWarning]);
  const [tool, setTool] = useState<Tool>('paint');
  const [brush, setBrush] = useState(Math.min(1024, Math.max(width, height), Math.max(1, Math.round(Math.min(width, height) / 24))));
  const [opacity, setOpacity] = useState(0.5);
  const [maskOnly, setMaskOnly] = useState(false);
  const [undoCount, setUndoCount] = useState(0);
  const [zoom, setZoom] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 800, height: 460 });
  const [rectangle, setRectangle] = useState<{ start: Point; end: Point }>();
  const [cursor, setCursor] = useState<Point>();
  const [sourceUrl, setSourceUrl] = useState('');
  const [smartOpen, setSmartOpen] = useState(false);
  const [smartPoints, setSmartPoints] = useState<SegmentationRequest['points']>([]);
  const [smartBox, setSmartBox] = useState<SegmentationRequest['box']>();
  const [suggestion, setSuggestion] = useState<SegmentationSuggestion>();
  const [proposalShown, setProposalShown] = useState(false);
  const [smartPending, setSmartPending] = useState<Record<string, boolean>>({});
  const [smartError, setSmartError] = useState('');
  const [smartNotice, setSmartNotice] = useState('');
  const [editCount, setEditCount] = useState(0);
  const [transformOpen, setTransformOpen] = useState(false);
  const [transformKind, setTransformKind] = useState<MaskTransformKind>('grow');
  const [transformRadius, setTransformRadius] = useState(8);
  const [transformBusy, setTransformBusy] = useState(false);
  const [transformShown, setTransformShown] = useState(false);
  const [transformReady, setTransformReady] = useState(false);
  const [transformError, setTransformError] = useState('');
  const [transformEmpty, setTransformEmpty] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const maskCanvas = useRef<HTMLCanvasElement | null>(null);
  const undo = useRef<UndoFrame[]>([]);
  const version = useRef(0); const nextVersion = useRef(0); const savedVersion = useRef(0);
  const stroke = useRef<{ pointerId: number; start: Point; last: Point; tool: Tool; pan?: { x: number; y: number; left: number; top: number } } | undefined>(undefined);
  const loaded = useRef(false); const savingRef = useRef(false); const dirtyRef = useRef(false);
  const viewMaskOnly = useRef(maskOnly); viewMaskOnly.current = maskOnly;
  const closed = useRef(false);
  const mounted = useRef(true);
  const suggestionPixels = useRef<Uint8Array | undefined>(undefined);
  const showProposal = useRef(proposalShown); showProposal.current = proposalShown;
  const requestEpoch = useRef(0);
  const smartRequest = useRef<Promise<void> | null>(null);
  const smartActions = useRef(new Set<string>());
  const proposalController = useRef<AbortController | null>(null);
  const smartStatus = useRef(segmentationStatus); smartStatus.current = segmentationStatus;
  const edits = useRef<SourceMaskEdit[]>([]);
  const transformBase = useRef<UndoFrame | undefined>(undefined);
  const transformPixels = useRef<Uint8Array | undefined>(undefined);
  const transformSettings = useRef<MaskTransformSettings | undefined>(undefined);
  const transformWorker = useRef<Worker | undefined>(undefined);
  const transformEpoch = useRef(0);
  const showTransform = useRef(transformShown); showTransform.current = transformShown;
  const maxUndo = Math.max(1, Math.min(MAX_UNDO, Math.floor(UNDO_BYTES / (width * height))));
  const fitScale = Math.max(0.001, Math.min(1, (viewportSize.width - 32) / width, (viewportSize.height - 32) / height));
  const scale = zoom || fitScale;
  const blocked = appClosing || loading || saving || closeWarning || smartPending.close || !loaded.current;
  const cannotMutate = () => appClosingRef.current || closed.current || !mounted.current;
  const smartSizeAllowed = width * height <= SMART_MAX_PIXELS;
  const segmenting = Boolean(smartPending.suggest || segmentationStatus.state === 'segmenting');
  const manualBlocked = blocked || proposalShown || segmenting || transformOpen;
  const editBlocked = manualBlocked || editCount >= 256;
  const runtimeChanging = Boolean(smartPending.setup || smartPending.start || smartPending.stop || ['installing', 'starting'].includes(segmentationStatus.state));
  const guidesBlocked = blocked || !smartSizeAllowed || segmenting || transformOpen;
  const guidanceChanged = Boolean(suggestion && JSON.stringify({ points: smartPoints, box: smartBox }) !== JSON.stringify({ points: suggestion.request.points, box: suggestion.request.box }));

  const updateDirty = useCallback(() => { const value = version.current !== savedVersion.current; dirtyRef.current = value; setDirty(value); }, []);
  const repaint = useCallback(() => {
    const working = maskCanvas.current; const overlay = canvas.current;
    if (!working || !overlay) return;
    const context = working.getContext('2d', { willReadFrequently: true })!;
    const preview = showTransform.current ? transformPixels.current : showProposal.current ? suggestionPixels.current : undefined;
    const image = preview ? context.createImageData(width, height) : context.getImageData(0, 0, width, height);
    for (let at = 0; at < image.data.length; at += 4) {
      const value = preview ? preview[at / 4] : image.data[at]; image.data[at] = viewMaskOnly.current ? 255 : TINT[0]; image.data[at + 1] = viewMaskOnly.current ? 255 : TINT[1]; image.data[at + 2] = viewMaskOnly.current ? 255 : TINT[2]; image.data[at + 3] = value;
    }
    overlay.getContext('2d')!.putImageData(image, 0, 0);
  }, [width, height]);

  useEffect(() => {
    let abandoned = false; const urls: string[] = []; const controller = new AbortController();
    loaded.current = false;
    const loadImage = async (url: string) => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('The source or mask could not be loaded. Its file may have changed or been removed.');
      const objectUrl = URL.createObjectURL(await response.blob()); urls.push(objectUrl);
      const image = new Image(); image.src = objectUrl; await image.decode();
      if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('The loaded pixels do not match the saved source dimensions.');
      return { image, objectUrl };
    };
    void (async () => {
      try {
        if (width < 1 || height < 1 || width > SOURCE_IMAGE_LIMITS.maxDimension || height > SOURCE_IMAGE_LIMITS.maxDimension || width * height > SOURCE_IMAGE_LIMITS.maxPixels) throw new Error('This source exceeds the experimental input-image limits.');
        if (mask && (mask.sourceId !== source.id || mask.sourceSha256 !== source.normalized.sha256 || mask.width !== width || mask.height !== height)) throw new Error('This mask belongs to a different source identity.');
        const image = await loadImage(`latent-asset://source/${encodeURIComponent(source.id)}`);
        const previous = mask ? await loadImage(`latent-asset://mask/${encodeURIComponent(mask.id)}`) : undefined;
        if (abandoned) return;
        const working = document.createElement('canvas'); working.width = width; working.height = height;
        const context = working.getContext('2d', { willReadFrequently: true }); if (!context) throw new Error('A canvas could not be created for this image.');
        context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
        if (previous) context.drawImage(previous.image, 0, 0);
        maskCanvas.current = working; setSourceUrl(image.objectUrl);
        if (!canvas.current) throw new Error('The mask canvas is unavailable.');
        canvas.current.width = width; canvas.current.height = height;
        loaded.current = true; repaint(); setLoading(false);
      } catch (reason) { if (!abandoned) { setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)); } }
    })();
    return () => { abandoned = true; controller.abort(); for (const url of urls) URL.revokeObjectURL(url); if (maskCanvas.current) { maskCanvas.current.width = 1; maskCanvas.current.height = 1; } maskCanvas.current = null; undo.current = []; loaded.current = false; };
  }, [source.id, source.normalized.sha256, mask?.id, width, height, repaint]);
  useLayoutEffect(() => {
    const target = viewport.current; if (!target) return;
    // Fit the first frame too: ResizeObserver delivery can be delayed in a
    // background window. Match its content-box measurements rather than using
    // the provisional viewport size until an observer callback arrives.
    const style = getComputedStyle(target);
    const contentWidth = target.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const contentHeight = target.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
    if (contentWidth > 0 && contentHeight > 0) setViewportSize({ width: contentWidth, height: contentHeight });
    const observer = new ResizeObserver(entries => { const rect = entries[0]?.contentRect; if (rect) setViewportSize({ width: rect.width, height: rect.height }); });
    observer.observe(target); return () => observer.disconnect();
  }, []);
  useEffect(() => { if (loaded.current) repaint(); }, [maskOnly, proposalShown, suggestion?.id, transformShown, transformReady, repaint]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestEpoch.current++; proposalController.current?.abort(); suggestionPixels.current = undefined; transformEpoch.current++; transformWorker.current?.terminate(); transformWorker.current = undefined; transformBase.current = undefined; transformPixels.current = undefined; if (smartRequest.current) void window.latent.cancelSegmentation().catch(() => {}); };
  }, []);
  useEffect(() => {
    const unsubscribeClose = window.latent?.onBeforeClose?.(async () => {
      if (dirtyRef.current || savingRef.current || transformBase.current || stroke.current) { setCloseWarning(true); throw new Error('The mask editor has unsaved changes or a transform preview. Save or discard its mask before closing the studio.'); }
      const epoch = ++closeEpoch.current;
      appClosingRef.current = true; setAppClosing(true);
      try {
        if (smartRequest.current) { requestEpoch.current++; proposalController.current?.abort(); await window.latent.cancelSegmentation(); await smartRequest.current; }
      } catch (reason) { if (epoch === closeEpoch.current) { appClosingRef.current = false; setAppClosing(false); } throw reason; }
    });
    const unsubscribeCancelled = window.latent?.onCloseCancelled?.(() => { closeEpoch.current++; appClosingRef.current = false; setAppClosing(false); });
    return () => { unsubscribeClose?.(); unsubscribeCancelled?.(); };
  }, []);

  async function smartAction(key: string, task: () => Promise<void>) {
    if (cannotMutate() || smartActions.current.has(key)) return false;
    smartActions.current.add(key); setSmartPending(previous => ({ ...previous, [key]: true })); setSmartError('');
    try { return await run(`segmentation-${key}`, async () => { try { await task(); } catch (reason) { if (mounted.current) setSmartError(actionErrorMessage(reason)); throw reason; } }); }
    finally { smartActions.current.delete(key); if (mounted.current) setSmartPending(previous => ({ ...previous, [key]: false })); }
  }
  function addPoint(at: Point, label: 0 | 1) {
    if (cannotMutate() || guidesBlocked) return;
    if (smartPoints.length >= SMART_MAX_POINTS) { setSmartError('A selection can use up to 64 points. Remove a point before adding another.'); return; }
    setSmartPoints(previous => previous.length >= SMART_MAX_POINTS ? previous : [...previous, { x: Math.max(0, Math.min(width - 1, at.x)), y: Math.max(0, Math.min(height - 1, at.y)), label }]); setSmartNotice('');
  }
  async function readProposalPixels(proposal: SegmentationSuggestion, signal: AbortSignal) {
    if (proposal.request.sourceId !== source.id || proposal.sourceSha256 !== source.normalized.sha256 || proposal.mask.sourceId !== source.id || proposal.mask.sourceSha256 !== source.normalized.sha256 || proposal.mask.width !== width || proposal.mask.height !== height) throw new Error('The suggested mask belongs to a different source.');
    const response = await fetch(`latent-asset://mask/${encodeURIComponent(proposal.mask.id)}`, { signal });
    if (!response.ok) throw new Error('The suggested mask file could not be loaded.');
    const blob = await response.blob(); signal.throwIfAborted(); const url = URL.createObjectURL(blob);
    const scratch = document.createElement('canvas');
    try {
      const image = new Image(); image.src = url; await image.decode(); signal.throwIfAborted();
      if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('The suggested mask dimensions differ from this source.');
      scratch.width = width; scratch.height = height; const context = scratch.getContext('2d', { willReadFrequently: true }); if (!context) throw new Error('The suggested mask preview could not be created.');
      context.drawImage(image, 0, 0); const rgba = context.getImageData(0, 0, width, height).data; const pixels = new Uint8Array(width * height);
      for (let at = 0; at < pixels.length; at++) { const index = at * 4; if (rgba[index] !== rgba[index + 1] || rgba[index] !== rgba[index + 2] || rgba[index + 3] !== 255) throw new Error('The suggested mask is not opaque grayscale.'); pixels[at] = rgba[index]; }
      return pixels;
    } finally { URL.revokeObjectURL(url); scratch.width = 1; scratch.height = 1; }
  }
  function suggest() {
    if (cannotMutate() || guidesBlocked || runtimeChanging || smartRequest.current || smartStatus.current.state !== 'ready' || (!smartPoints.length && !smartBox)) return;
    const request: SegmentationRequest = { sourceId: source.id, points: structuredClone(smartPoints), box: smartBox ? { ...smartBox } : undefined };
    const epoch = ++requestEpoch.current; const controller = new AbortController(); proposalController.current = controller; setSmartNotice('');
    const task = smartAction('suggest', async () => {
      try {
        const result = await window.latent.suggestMask(request);
        if (!mounted.current || epoch !== requestEpoch.current) return;
        const pixels = await readProposalPixels(result, controller.signal);
        if (!mounted.current || epoch !== requestEpoch.current) return;
        suggestionPixels.current = pixels; setSuggestion(result); showProposal.current = true; setProposalShown(true); setTool('include');
      } catch (reason) { if (epoch === requestEpoch.current) throw reason; }
    }).then(() => {});
    smartRequest.current = task; void task.finally(() => { if (smartRequest.current === task) smartRequest.current = null; });
  }
  async function cancelSuggestion() {
    requestEpoch.current++; proposalController.current?.abort();
    await smartAction('cancel', async () => { await window.latent.cancelSegmentation(); await smartRequest.current; setSmartNotice('Suggestion cancelled. Your painted mask is unchanged.'); });
  }
  function useSuggestion() {
    const pixels = suggestionPixels.current;
    if (cannotMutate() || blocked || segmenting || transformBase.current || edits.current.length >= 256 || !suggestion || !pixels) return;
    if (!pixels.some(value => value > 0)) { setSmartError('This suggestion is empty. Add an include point or adjust the box and suggest again.'); return; }
    snapshot(); showProposal.current = false; setProposalShown(false);
    restore({ pixels, version: ++nextVersion.current, edits: [...edits.current, { kind: 'sam', proposalMaskId: suggestion.mask.id }] }); setTool('paint'); setSmartNotice('Suggested pixels are now your working mask. Paint to refine, or Undo to restore the previous mask.');
  }

  function captureFrame(): UndoFrame {
    const data = maskCanvas.current!.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
    const pixels = new Uint8Array(width * height); for (let at = 0; at < pixels.length; at++) pixels[at] = data[at * 4];
    return { pixels, version: version.current, edits: [...edits.current] };
  }
  function pushUndo(frame: UndoFrame) { while (undo.current.length >= maxUndo) undo.current.shift(); undo.current.push(frame); setUndoCount(undo.current.length); }
  function snapshot() { pushUndo(captureFrame()); }
  function changed(edit: SourceMaskEdit) { edits.current = [...edits.current, edit]; setEditCount(edits.current.length); version.current = ++nextVersion.current; updateDirty(); setError(''); }
  function restore(frame: UndoFrame) {
    const context = maskCanvas.current!.getContext('2d', { willReadFrequently: true })!; const image = context.createImageData(width, height);
    for (let at = 0; at < frame.pixels.length; at++) { const index = at * 4; image.data[index] = frame.pixels[at]; image.data[index + 1] = frame.pixels[at]; image.data[index + 2] = frame.pixels[at]; image.data[index + 3] = 255; }
    context.putImageData(image, 0, 0); version.current = frame.version; edits.current = [...frame.edits]; setEditCount(edits.current.length); updateDirty(); repaint();
  }
  function undoEdit() { if (cannotMutate() || manualBlocked || stroke.current) return; const frame = undo.current.pop(); if (!frame) return; restore(frame); setUndoCount(undo.current.length); setSmartNotice('The previous working mask is restored.'); }
  function wholeMask(operation: 'clear' | 'fill' | 'invert') {
    if (cannotMutate() || editBlocked || stroke.current) return;
    snapshot(); const context = maskCanvas.current!.getContext('2d', { willReadFrequently: true })!;
    if (operation === 'invert') { const image = context.getImageData(0, 0, width, height); for (let at = 0; at < image.data.length; at += 4) { const value = 255 - image.data[at]; image.data[at] = value; image.data[at + 1] = value; image.data[at + 2] = value; image.data[at + 3] = 255; } context.putImageData(image, 0, 0); }
    else { context.fillStyle = operation === 'clear' ? '#000' : '#fff'; context.fillRect(0, 0, width, height); }
    changed({ kind: operation }); repaint();
  }
  function openTransform() {
    if (cannotMutate() || editBlocked || stroke.current) return;
    transformBase.current = captureFrame(); setTransformOpen(true); setTransformError(''); setTool('pan');
  }
  function clearTransformPreview() {
    transformEpoch.current++; transformWorker.current?.terminate(); transformWorker.current = undefined;
    transformPixels.current = undefined; transformSettings.current = undefined; showTransform.current = false;
    setTransformBusy(false); setTransformReady(false); setTransformShown(false); setTransformError('');
  }
  function cancelTransform() { clearTransformPreview(); transformBase.current = undefined; setTransformOpen(false); }
  function previewTransform() {
    const base = transformBase.current;
    if (cannotMutate() || !base || transformWorker.current || blocked || !transformRadius) return;
    clearTransformPreview();
    const settings: MaskTransformSettings = { kind: transformKind, radius: transformRadius };
    const epoch = ++transformEpoch.current;
    setTransformBusy(true);
    try {
      const worker = new Worker(new URL('./mask-transform.worker.ts', import.meta.url), { type: 'module' }); transformWorker.current = worker;
      const fail = (message: string) => { if (!mounted.current || epoch !== transformEpoch.current) return; worker.terminate(); transformWorker.current = undefined; setTransformBusy(false); setTransformError(message); };
      worker.onerror = event => { event.preventDefault(); fail(event.message || 'The mask preview worker could not start. Your working mask is unchanged.'); };
      worker.onmessageerror = () => fail('The mask preview worker returned an unreadable result.');
      worker.onmessage = ({ data }: MessageEvent<MaskTransformResponse>) => {
        if (!mounted.current || epoch !== transformEpoch.current || data.id !== epoch) return;
        if ('error' in data) { fail(data.error); return; }
        if (!(data.pixels instanceof Uint8Array) || data.pixels.length !== width * height) { fail('The mask preview returned unexpected dimensions.'); return; }
        worker.terminate(); transformWorker.current = undefined; transformPixels.current = data.pixels; transformSettings.current = settings;
        setTransformEmpty(!data.pixels.some(value => value > 0)); showTransform.current = true; setTransformShown(true); setTransformReady(true); setTransformBusy(false);
      };
      const pixels = base.pixels.slice(); worker.postMessage({ id: epoch, pixels, width, height, settings }, [pixels.buffer]);
    } catch (reason) { transformWorker.current?.terminate(); transformWorker.current = undefined; setTransformBusy(false); setTransformError(reason instanceof Error ? reason.message : String(reason)); }
  }
  function applyTransform() {
    const base = transformBase.current; const pixels = transformPixels.current; const settings = transformSettings.current;
    if (cannotMutate() || !base || !pixels || !settings || transformWorker.current || blocked || base.edits.length >= 256) return;
    if (base.version !== version.current) { setTransformError('The working mask changed after this preview began. Cancel the preview and try again.'); return; }
    pushUndo(base); showTransform.current = false; setTransformShown(false);
    restore({ pixels, version: ++nextVersion.current, edits: [...base.edits, maskTransformEdit(settings)] });
    clearTransformPreview(); transformBase.current = undefined; setTransformOpen(false); setTool('paint');
  }
  function point(event: ReactPointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect(); return { x: Math.max(0, Math.min(width, (event.clientX - rect.left) * width / rect.width)), y: Math.max(0, Math.min(height, (event.clientY - rect.top) * height / rect.height)) };
  }
  function brushLine(from: Point, to: Point, erase: boolean) {
    const context = maskCanvas.current!.getContext('2d', { willReadFrequently: true })!; const overlay = canvas.current!.getContext('2d')!;
    for (const [target, isOverlay] of [[context, false], [overlay, true]] as const) {
      target.save(); target.lineWidth = brush; target.lineCap = 'round'; target.lineJoin = 'round'; target.globalCompositeOperation = isOverlay && erase ? 'destination-out' : 'source-over';
      target.strokeStyle = isOverlay ? viewMaskOnly.current ? '#fff' : `rgb(${TINT.join(',')})` : erase ? '#000' : '#fff'; target.fillStyle = target.strokeStyle;
      target.beginPath(); target.moveTo(from.x, from.y); target.lineTo(to.x, to.y); target.stroke();
      if (from.x === to.x && from.y === to.y) { target.beginPath(); target.arc(to.x, to.y, brush / 2, 0, Math.PI * 2); target.fill(); }
      target.restore();
    }
  }
  function pointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (cannotMutate() || blocked || stroke.current || event.button !== 0) return;
    if ((tool === 'include' || tool === 'exclude' || tool === 'smart-box') && guidesBlocked) return;
    if ((tool === 'paint' || tool === 'erase' || tool === 'rectangle') && editBlocked) return;
    if (tool === 'include' || tool === 'exclude') { event.preventDefault(); event.currentTarget.focus(); const at = point(event); setCursor(at); addPoint(at, tool === 'include' ? 1 : 0); return; }
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    const at = point(event); setCursor(at);
    stroke.current = { pointerId: event.pointerId, start: at, last: at, tool, pan: tool === 'pan' && viewport.current ? { x: event.clientX, y: event.clientY, left: viewport.current.scrollLeft, top: viewport.current.scrollTop } : undefined };
    if (tool === 'rectangle' || tool === 'smart-box') setRectangle({ start: at, end: at });
    else if (tool !== 'pan') { snapshot(); brushLine(at, at, tool === 'erase'); changed({ kind: tool === 'erase' ? 'erase' : 'paint' }); }
  }
  function pointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const at = point(event); setCursor(at); const currentStroke = stroke.current;
    if (cannotMutate() || !currentStroke || currentStroke.pointerId !== event.pointerId || blocked) return;
    if ((currentStroke.tool === 'paint' || currentStroke.tool === 'erase' || currentStroke.tool === 'rectangle') && manualBlocked) return;
    if (currentStroke.tool === 'pan') { if (viewport.current && currentStroke.pan) { viewport.current.scrollLeft = currentStroke.pan.left - (event.clientX - currentStroke.pan.x); viewport.current.scrollTop = currentStroke.pan.top - (event.clientY - currentStroke.pan.y); } return; }
    if (currentStroke.tool === 'rectangle' || currentStroke.tool === 'smart-box') setRectangle({ start: currentStroke.start, end: at });
    else brushLine(currentStroke.last, at, currentStroke.tool === 'erase');
    currentStroke.last = at;
  }
  function pointerEnd(event: ReactPointerEvent<HTMLCanvasElement>, cancel = false) {
    const currentStroke = stroke.current; if (!currentStroke || currentStroke.pointerId !== event.pointerId) return;
    if ((currentStroke.tool === 'rectangle' || currentStroke.tool === 'smart-box') && !cancel) {
      const end = point(event); const left = Math.min(end.x, currentStroke.start.x); const top = Math.min(end.y, currentStroke.start.y); const rectWidth = Math.abs(end.x - currentStroke.start.x); const rectHeight = Math.abs(end.y - currentStroke.start.y);
      if (rectWidth >= 1 && rectHeight >= 1) {
        if (currentStroke.tool === 'smart-box') { setSmartBox({ x: left, y: top, width: rectWidth, height: rectHeight }); setSmartNotice(''); }
        else { snapshot(); const context = maskCanvas.current!.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(left, top, rectWidth, rectHeight); changed({ kind: 'rectangle' }); repaint(); }
      }
    } else if (cancel && (currentStroke.tool === 'paint' || currentStroke.tool === 'erase')) { const previous = undo.current.pop(); if (previous) restore(previous); setUndoCount(undo.current.length); }
    stroke.current = undefined; setRectangle(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function revealKeyboardCursor(at: Point) {
    setCursor(at);
    const view = viewport.current, surface = canvas.current;
    if (!view || !surface) return;
    view.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const bounds = view.getBoundingClientRect(), image = surface.getBoundingClientRect();
    const x = image.left + at.x / width * image.width - bounds.left - view.clientLeft;
    const y = image.top + at.y / height * image.height - bounds.top - view.clientTop;
    const marginX = Math.min(16, view.clientWidth / 2), marginY = Math.min(16, view.clientHeight / 2);
    if (x < marginX) view.scrollLeft += x - marginX;
    else if (x > view.clientWidth - marginX) view.scrollLeft += x - view.clientWidth + marginX;
    if (y < marginY) view.scrollTop += y - marginY;
    else if (y > view.clientHeight - marginY) view.scrollTop += y - view.clientHeight + marginY;
  }
  function keyboard(event: ReactKeyboardEvent<HTMLCanvasElement>) {
    if (cannotMutate() || blocked) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undoEdit(); return; }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault(); const step = event.shiftKey ? 25 : 1; const previous = cursor ?? { x: width / 2, y: height / 2 };
      revealKeyboardCursor({ x: Math.max(0, Math.min(width - 1, previous.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0))), y: Math.max(0, Math.min(height - 1, previous.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0))) }); return;
    }
    if (event.code === 'Space' && (tool === 'include' || tool === 'exclude')) { event.preventDefault(); const at = cursor ?? { x: Math.floor(width / 2), y: Math.floor(height / 2) }; revealKeyboardCursor(at); addPoint(at, tool === 'include' ? 1 : 0); return; }
    if (event.code === 'Space' && (tool === 'paint' || tool === 'erase') && !editBlocked) { event.preventDefault(); const at = cursor ?? { x: width / 2, y: height / 2 }; revealKeyboardCursor(at); snapshot(); brushLine(at, at, tool === 'erase'); changed({ kind: tool === 'erase' ? 'erase' : 'paint' }); }
  }
  function requestClose() {
    if (cannotMutate() || savingRef.current || smartActions.current.has('close')) return;
    const finish = () => { if (cannotMutate()) return; if (dirtyRef.current || transformBase.current) setCloseWarning(true); else { closed.current = true; onClose(); } };
    if (smartRequest.current) { requestEpoch.current++; proposalController.current?.abort(); void smartAction('close', async () => { await window.latent.cancelSegmentation(); await smartRequest.current; finish(); }); }
    else finish();
  }
  async function discardAndClose() {
    if (cannotMutate() || savingRef.current) return;
    await smartAction('close', async () => {
      if (smartRequest.current) { requestEpoch.current++; proposalController.current?.abort(); await window.latent.cancelSegmentation(); await smartRequest.current; }
      if (cannotMutate()) return;
      cancelTransform();
      closed.current = true; dirtyRef.current = false; onClose();
    });
  }
  async function save() {
    if (cannotMutate() || savingRef.current || stroke.current || !loaded.current || showProposal.current || smartRequest.current || transformBase.current) return;
    savingRef.current = true; setSaving(true); setError('');
    try {
      await run('mask-save', async () => {
        try {
          const working = maskCanvas.current!; const data = working.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
          let nonempty = false; for (let at = 0; at < data.length; at += 4) if (data[at] > 0) { nonempty = true; break; }
          if (!nonempty) throw new Error('The mask is empty. Paint an area or choose Fill before saving for inpainting.');
          const blob = await new Promise<Blob>((resolve, reject) => working.toBlob(result => result ? resolve(result) : reject(new Error('The mask PNG could not be encoded.')), 'image/png'));
          if (blob.size > SOURCE_IMAGE_LIMITS.maxInputBytes) throw new Error('The encoded mask exceeds the 64 MiB input limit. Use a smaller source image.');
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (cannotMutate()) return;
          const saved = await window.latent.saveSourceMask(source.id, bytes, { baseMaskId: mask?.id ?? null, edits: [...edits.current] });
          if (cannotMutate()) return;
          savedVersion.current = version.current; updateDirty(); onSaved(saved); closed.current = true; onClose();
        } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); throw reason; }
      });
    } finally { savingRef.current = false; if (mounted.current && !closed.current) setSaving(false); }
  }

  return <div className="mask-editor" onKeyDownCapture={event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !(event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) {
      event.preventDefault(); event.stopPropagation(); undoEdit();
    }
  }}><Modal title="Paint the part you want to change" onClose={requestClose}>
    <div className="mask-editor-intro"><p><strong>{source.name}</strong><span>{width} × {height} · {mask ? `continuing revision ${mask.revision}` : 'new mask'}</span></p><span className="mask-legend"><i />{transformShown ? 'Previewing a mask transform' : proposalShown ? 'Previewing a suggested mask' : 'Highlighted areas will be edited'}</span></div>
    {error && <Notice error>{error}</Notice>}
    {closeWarning && <div className="mask-close-warning" role="alert"><div><strong>Keep your mask edits?</strong><p>{transformOpen ? 'Apply or cancel the transform preview before saving your working mask.' : proposalShown ? 'Use or dismiss the suggestion before saving your working mask.' : 'Save a new revision, or discard the edits made in this window.'}</p></div><div className="button-row"><button ref={keepEditingButton} type="button" disabled={appClosing || saving || smartPending.close} onClick={() => setCloseWarning(false)}>Keep editing</button><button type="button" disabled={appClosing || saving || smartPending.close} onClick={() => { void discardAndClose(); }}>Discard edits</button><button type="button" className="primary" disabled={appClosing || saving || proposalShown || segmenting || transformOpen || smartPending.close} onClick={() => { void save(); }}><Save size={14} />Save & close</button></div></div>}
    <section className="mask-smart" aria-label="Optional smart selection">
      <button type="button" className="mask-smart-toggle" disabled={transformOpen} aria-expanded={smartOpen} onClick={() => { if (smartOpen) { showProposal.current = false; setProposalShown(false); if (['include', 'exclude', 'smart-box'].includes(tool)) setTool('pan'); } setSmartOpen(!smartOpen); }}><Sparkles size={15} /><strong>Smart selection</strong><span>Optional · SAM ViT-B · CPU</span><span>{smartOpen ? 'Hide' : 'Open'}</span></button>
      {smartOpen && <div className="mask-smart-content">
        {['not-installed', 'error', 'installing'].includes(segmentationStatus.state) && <PackageSetupStorage packageId="segmentation" />}
        <div className="mask-smart-runtime"><div><p>{segmentationStatus.message}</p><small>Experimental assistance. The model download is about 375 MB.</small>{segmentationStatus.state === 'installing' && <progress value={Math.max(0, Math.min(100, segmentationStatus.installProgress ?? 0))} max={100} aria-label="SAM installation progress" />}</div><div className="button-row">
          {['not-installed', 'error'].includes(segmentationStatus.state) && <button type="button" disabled={runtimeChanging || segmenting || blocked} onClick={() => { void smartAction('setup', () => window.latent.setupSegmentation(segmentationStatus.state === 'error')); }}><Download size={13} />{segmentationStatus.state === 'error' ? 'Verify / repair SAM' : 'Install SAM'}</button>}
          {['not-installed', 'stopped', 'error'].includes(segmentationStatus.state) && <button type="button" title={!segmentationStatus.installationAvailable ? 'Finish or repair SAM installation before starting.' : undefined} disabled={!segmentationStatus.installationAvailable || segmentationStatus.state === 'not-installed' || runtimeChanging || segmenting || blocked} onClick={() => { void smartAction('start', () => window.latent.startSegmentation()); }}><Play size={13} />Start SAM</button>}
          {['ready', 'segmenting', 'starting', 'installing'].includes(segmentationStatus.state) && <button type="button" disabled={appClosing || smartPending.stop || smartPending.close || saving} onClick={() => { requestEpoch.current++; proposalController.current?.abort(); void smartAction('stop', async () => { await window.latent.stopSegmentation(); await smartRequest.current; }); }}><CircleStop size={13} />{segmentationStatus.state === 'installing' ? 'Cancel setup' : 'Stop SAM'}</button>}
        </div></div>
        {!smartSizeAllowed && <p className="mask-smart-warning">Smart selection currently accepts sources up to 4 megapixels. This source is {(width * height / 1_000_000).toFixed(1)} megapixels; its manual painting tools remain available.</p>}
        <div className="mask-smart-guidance"><div className="mask-tool-group"><button type="button" aria-pressed={tool === 'include'} disabled={guidesBlocked || smartPoints.length >= SMART_MAX_POINTS} onClick={() => setTool('include')}><Plus size={13} />Include point</button><button type="button" aria-pressed={tool === 'exclude'} disabled={guidesBlocked || smartPoints.length >= SMART_MAX_POINTS} onClick={() => setTool('exclude')}><Minus size={13} />Exclude point</button><button type="button" aria-pressed={tool === 'smart-box'} disabled={guidesBlocked} onClick={() => setTool('smart-box')}><RectangleHorizontal size={13} />Guide box</button></div><div className="button-row"><button type="button" disabled={guidesBlocked || !smartPoints.length} onClick={() => setSmartPoints(previous => previous.slice(0, -1))}>Remove last point</button><button type="button" disabled={guidesBlocked || (!smartPoints.length && !smartBox)} onClick={() => { setSmartPoints([]); setSmartBox(undefined); }}>Clear guides</button></div></div>
        <div className="mask-smart-request"><p>{smartPoints.length} / 64 points{smartBox ? ' · guide box set' : ''}. Click inside what to include; exclude clicks guide the boundary. Points and the box do not paint the mask.</p>{segmenting ? <button type="button" disabled={appClosing || smartPending.cancel || smartPending.close} onClick={() => { void cancelSuggestion(); }}><CircleStop size={14} />Cancel suggestion</button> : <button type="button" className="soft-button" disabled={guidesBlocked || runtimeChanging || segmentationStatus.state !== 'ready' || (!smartPoints.length && !smartBox)} onClick={suggest}><Sparkles size={14} />Suggest mask</button>}</div>
        {smartError && <p className="mask-smart-error" role="alert">{smartError}</p>}
        {smartNotice && <p className="mask-smart-note" role="status">{smartNotice}</p>}
        {segmenting && <p className="mask-smart-note" role="status"><LoaderCircle className="spin" size={13} />Finding a mask on CPU…</p>}
        {suggestion && <div className="mask-suggestion-review">
          <div className="mask-suggestion-heading"><strong>Review the proposed boundary</strong><div className="mask-tool-group"><button type="button" disabled={transformOpen} aria-pressed={!proposalShown} onClick={() => { showProposal.current = false; setProposalShown(false); }}>Working mask</button><button type="button" disabled={transformOpen} aria-pressed={proposalShown} onClick={() => { showProposal.current = true; setProposalShown(true); if (['paint', 'erase', 'rectangle'].includes(tool)) setTool('pan'); }}>Suggested mask</button></div></div>
          <p>Inspect edges and neighboring objects before using this selection. Model self-score: {suggestion.predictedQuality.toFixed(3)}.</p>
          {!suggestion.pointPromptsSatisfied && <p className="mask-smart-warning">Some include/exclude points were not matched. Adjust the guides and suggest again, or refine the result manually after using it.</p>}
          {suggestion.selectedPixels === 0 && <p className="mask-smart-warning">The suggestion is empty. Add an include point or adjust the box and suggest again.</p>}
          {guidanceChanged && <p className="mask-smart-warning">The guides have changed. This preview still shows the earlier request; suggest again to include your latest points.</p>}
          <div className="mask-suggestion-apply"><small>{suggestion.selectedPixels.toLocaleString()} pixels selected · {(suggestion.durationMs / 1000).toFixed(1)}s · {suggestion.embeddingCacheHit ? 'reused source embedding' : 'new source embedding'}</small><button type="button" className="primary" disabled={blocked || segmenting || transformOpen || editCount >= 256 || suggestion.selectedPixels === 0} onClick={useSuggestion}><Check size={14} />{guidanceChanged ? 'Use this earlier suggestion' : 'Use suggested mask'}</button></div>
          <details className="mask-smart-details"><summary>Selection details</summary><p>Source: {suggestion.request.sourceId}<br />Model: {suggestion.model} · CPU<br />Model hash: {suggestion.modelSha256}<br />Code revision: {suggestion.codeRevision}<br />Embedding: {suggestion.embeddingMs.toFixed(0)} ms · inference: {suggestion.inferenceMs.toFixed(0)} ms<br />Stored proposal: mask revision {suggestion.mask.revision}</p></details>
        </div>}
      </div>}
    </section>
    <div className="mask-tools" aria-label="Mask tools"><div className="mask-tool-group">{[{ id: 'paint' as const, icon: Paintbrush, label: 'Paint' }, { id: 'erase' as const, icon: Eraser, label: 'Erase' }, { id: 'rectangle' as const, icon: RectangleHorizontal, label: 'Rectangle' }, { id: 'pan' as const, icon: Hand, label: 'Pan' }].map(item => <button type="button" key={item.id} aria-pressed={tool === item.id} disabled={item.id === 'pan' ? blocked : editBlocked} onClick={() => setTool(item.id)}><item.icon size={15} />{item.label}</button>)}</div><label className="mask-brush-size"><span>Brush · {brush}px</span><input type="range" min={1} max={Math.min(1024, Math.max(width, height))} step={1} value={brush} disabled={editBlocked || (tool !== 'paint' && tool !== 'erase')} onChange={event => setBrush(Number(event.target.value))} /></label><div className="mask-tool-group"><button type="button" disabled={manualBlocked || !undoCount} onClick={undoEdit} title={`Undo · ${undoCount} available`}><Undo2 size={15} />Undo</button><button type="button" disabled={editBlocked} onClick={() => wholeMask('invert')}><FlipHorizontal2 size={15} />Invert</button><button type="button" disabled={editBlocked} onClick={() => wholeMask('clear')}><Trash2 size={15} />Clear</button><button type="button" disabled={editBlocked} onClick={() => wholeMask('fill')}><Square size={15} />Fill</button></div></div>
    {editCount >= 256 && <Notice>This revision has reached its 256-edit limit. Save and reopen the mask to continue, or Undo an edit. Its recorded edit history will be retained.</Notice>}
    <section className="mask-transform" aria-label="Grow, shrink, and feather mask">
      {!transformOpen ? <button type="button" disabled={editBlocked} onClick={openTransform}><Scan size={14} />Grow / shrink / feather</button> : <>
        <div className="mask-transform-heading"><strong>Refine the working mask boundary</strong><span>Preview first · Undo after applying</span></div>
        <div className="mask-transform-settings"><label><span>Operation</span><select value={transformKind} disabled={transformBusy || blocked} onChange={event => { clearTransformPreview(); setTransformKind(event.target.value as MaskTransformKind); }}><option value="grow">Grow selected area</option><option value="shrink">Shrink selected area</option><option value="feather">Feather boundary</option></select></label><label><span>Radius · {transformRadius} source px</span><input type="range" min={0} max={64} step={1} value={transformRadius} disabled={transformBusy || blocked} onChange={event => { clearTransformPreview(); setTransformRadius(Number(event.target.value)); }} /></label><input className="mask-transform-number" aria-label="Transform radius in source pixels" type="number" min={0} max={64} step={1} value={transformRadius} disabled={transformBusy || blocked} onChange={event => { clearTransformPreview(); setTransformRadius(Math.max(0, Math.min(64, Math.round(Number(event.target.value) || 0)))); }} /></div>
        <p>{transformKind === 'feather' ? `Gaussian approximation, σ ${(transformRadius / 3).toFixed(2)} px. Canvas edges extend their nearest pixel. Tiny radii use an exact truncated Gaussian.` : `${transformKind === 'grow' ? 'Expands' : 'Contracts'} grayscale selection with a square ${transformRadius * 2 + 1} × ${transformRadius * 2 + 1} neighborhood. Pixels beyond the canvas are treated as black.`} Each preview starts from the mask you opened this panel with.</p>
        {transformError && <p className="mask-smart-error" role="alert">{transformError}</p>}
        {transformBusy && <p className="mask-smart-note" role="status"><LoaderCircle className="spin" size={13} />Computing full-resolution pixels in a background worker…</p>}
        {transformReady && transformEmpty && <p className="mask-smart-warning">This preview is empty. Inpainting needs a nonempty mask; reduce the radius or paint an area after applying.</p>}
        <div className="mask-transform-actions"><div className="mask-tool-group">{transformReady && <><button type="button" aria-pressed={!transformShown} onClick={() => { showTransform.current = false; setTransformShown(false); }}>Working mask</button><button type="button" aria-pressed={transformShown} onClick={() => { showTransform.current = true; setTransformShown(true); }}>Transform preview</button></>}</div><div className="button-row"><button type="button" onClick={cancelTransform} disabled={saving}>{transformBusy ? 'Cancel computation' : 'Cancel preview'}</button><button type="button" disabled={transformBusy || blocked || !transformRadius} onClick={previewTransform}><Eye size={14} />Preview</button><button type="button" className="primary" disabled={!transformReady || transformBusy || blocked} onClick={applyTransform}><Check size={14} />Apply to working mask</button></div></div>
      </>}
    </section>
    {transformShown && <p className="mask-proposal-banner" role="status">Showing a transform preview. Working pixels and their Undo history stay unchanged until Apply.</p>}
    {proposalShown && <p className="mask-proposal-banner" role="status">Showing the suggested mask. Choose Use suggested mask to replace your working pixels, or switch back to Working mask.</p>}
    <div className="mask-view-controls"><div className="button-row"><button type="button" className="icon-button" aria-label="Zoom out" onClick={() => setZoom(Math.max(0.025, scale / 1.25))}><Minus size={14} /></button><span>{zoom ? `${Math.round(scale * 100)}%` : `Fit · ${Math.round(scale * 100)}%`}</span><button type="button" className="icon-button" aria-label="Zoom in" onClick={() => setZoom(Math.min(4, scale * 1.25))}><Plus size={14} /></button><button type="button" onClick={() => setZoom(0)}><Scan size={13} />Fit</button><button type="button" onClick={() => setZoom(1)}>100%</button></div><label><input type="checkbox" checked={maskOnly} onChange={event => setMaskOnly(event.target.checked)} /><Eye size={14} />Mask only</label><label className="mask-opacity"><span>Overlay</span><input type="range" min={0.1} max={0.9} step={0.05} value={opacity} disabled={maskOnly} onChange={event => setOpacity(Number(event.target.value))} /></label></div>
    <div className="mask-viewport" ref={viewport} aria-busy={loading || saving}>
      {loading && <div className="mask-loading" role="status"><LoaderCircle className="spin" size={22} />Loading source pixels…</div>}
      <div className={`mask-surface tool-${tool}`} style={{ width: width * scale, height: height * scale, visibility: loading ? 'hidden' : 'visible' }}>
        {sourceUrl && <img src={sourceUrl} alt="Source image beneath editable mask" draggable={false} style={{ visibility: maskOnly ? 'hidden' : 'visible' }} />}
        <canvas ref={canvas} aria-label="Editable mask. Arrow keys move the cursor; Space uses the selected brush or include/exclude point tool; Control Z undoes painting." tabIndex={0} style={{ opacity: maskOnly ? 1 : opacity }} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={event => pointerEnd(event)} onPointerCancel={event => pointerEnd(event, true)} onLostPointerCapture={event => pointerEnd(event, true)} onPointerLeave={() => { if (!stroke.current) setCursor(undefined); }} onKeyDown={keyboard} />
        {cursor && (tool === 'paint' || tool === 'erase') && !blocked && <span className={`mask-brush-cursor ${tool === 'erase' ? 'is-eraser' : ''}`} style={{ width: brush * scale, height: brush * scale, left: cursor.x * scale, top: cursor.y * scale }} />}
        {rectangle && <span className={`mask-rectangle-preview ${tool === 'smart-box' ? 'is-guide' : ''}`} style={{ left: Math.min(rectangle.start.x, rectangle.end.x) * scale, top: Math.min(rectangle.start.y, rectangle.end.y) * scale, width: Math.abs(rectangle.start.x - rectangle.end.x) * scale, height: Math.abs(rectangle.start.y - rectangle.end.y) * scale }} />}
        {smartOpen && smartBox && <span className="mask-smart-box" style={{ left: smartBox.x * scale, top: smartBox.y * scale, width: smartBox.width * scale, height: smartBox.height * scale }} />}
        {smartOpen && smartPoints.map((guide, index) => <button type="button" key={index} className={`mask-smart-point ${guide.label ? 'is-include' : 'is-exclude'}`} disabled={guidesBlocked || !['include', 'exclude', 'smart-box'].includes(tool)} style={{ left: guide.x * scale, top: guide.y * scale }} aria-label={`Remove ${guide.label ? 'include' : 'exclude'} point ${index + 1} at ${Math.round(guide.x)}, ${Math.round(guide.y)}`} title={`Remove ${guide.label ? 'include' : 'exclude'} point ${index + 1}`} onClick={() => setSmartPoints(previous => previous.filter((_, item) => item !== index))}>{guide.label ? '+' : '−'}</button>)}
        {smartOpen && cursor && (tool === 'include' || tool === 'exclude') && !guidesBlocked && <span className={`mask-point-cursor ${tool === 'exclude' ? 'is-exclude' : ''}`} style={{ left: cursor.x * scale, top: cursor.y * scale }}>{tool === 'include' ? '+' : '−'}</span>}
      </div>
    </div>
    <div className="mask-editor-footnote"><span>White edits · black preserves</span><span>Up to {maxUndo} Undo steps for this source</span></div>
    <footer className="mask-editor-footer"><p>{loading ? 'Loading source and mask…' : !loaded.current ? 'Source or mask unavailable' : transformOpen ? 'Transform preview · working pixels are kept' : proposalShown ? 'Reviewing a proposal · working pixels are kept' : dirty ? 'Unsaved mask edits' : mask ? `Saved revision ${mask.revision} loaded` : 'Paint an area to begin'}<small>Mask pixels stay aligned with this source image. Saving creates a new revision.</small></p><div className="button-row"><button type="button" disabled={appClosing || saving || smartPending.close} onClick={requestClose}>{smartPending.close ? 'Cancelling…' : 'Cancel'}</button><button type="button" className="primary" disabled={appClosing || loading || saving || !loaded.current || closeWarning || proposalShown || segmenting || transformOpen || smartPending.close} onClick={() => { void save(); }}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{saving ? 'Saving mask…' : 'Save mask'}</button></div></footer>
  </Modal></div>;
}

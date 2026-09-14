import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { ArrowLeftRight, Maximize, Minus, Plus } from 'lucide-react';
import { Modal, Notice } from './ui';
import './compare-image.css';

export interface CompareImageAsset {
  url: string;
  label: string;
  width: number;
  height: number;
}
export type CompareAlignment = 'stretch' | 'center-crop' | 'same-canvas' | 'raw';
export interface CompareImageProps {
  before: CompareImageAsset;
  after: CompareImageAsset;
  alignment: CompareAlignment;
  /** Saved source-fitting canvas, when inference precedes a final output resize. */
  sourceFittingSize?: Size;
  onClose: () => void;
}
type Size = { width: number; height: number };
type LoadedImage = Size & { url: string };
type ImageSide = 'before' | 'after';
type Point = { x: number; y: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const validSize = ({ width, height }: Size) => Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0;

// ComfyUI v0.34.0 comfy/utils.py common_upscale uses Python round(), including
// ties to even, and removes the SAME integer margin from both sides. CSS cover
// would instead produce a fractional crop and can shift odd-size source images.
// https://github.com/Comfy-Org/ComfyUI/blob/v0.34.0/comfy/utils.py#L1011-L1028
export function comparisonCrop(source: Size, result: Size, alignment: CompareAlignment, sourceFittingSize = result) {
  const roundEven = (value: number) => {
    const floor = Math.floor(value);
    return value - floor === 0.5 ? floor + floor % 2 : Math.round(value);
  };
  let x = 0;
  let y = 0;
  if (alignment === 'center-crop') {
    const oldAspect = source.width / source.height;
    const newAspect = sourceFittingSize.width / sourceFittingSize.height;
    if (oldAspect > newAspect) x = roundEven((source.width - source.width * (newAspect / oldAspect)) / 2);
    else if (oldAspect < newAspect) y = roundEven((source.height - source.height * (oldAspect / newAspect)) / 2);
  }
  return { x, y, width: source.width - x * 2, height: source.height - y * 2 };
}

export function CompareImage({ before, after, alignment, sourceFittingSize, onClose }: CompareImageProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const beforeRef = useRef<HTMLImageElement>(null); const afterRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ pointerId: number; point: Point; pan: Point } | null>(null);
  const dividerDrag = useRef<{ node: HTMLButtonElement; pointerId: number } | null>(null);
  const [viewport, setViewport] = useState<Size>({ width: 600, height: 380 });
  const [beforeLoaded, setBeforeLoaded] = useState<LoadedImage>();
  const [afterLoaded, setAfterLoaded] = useState<LoadedImage>();
  const [errors, setErrors] = useState<Partial<Record<ImageSide, boolean>>>({});
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retryButton = useRef<HTMLButtonElement>(null);
  const restoreRetryFocus = useRef(false);
  const previousUrls = useRef({ before: before.url, after: after.url });
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [divider, setDivider] = useState(50);
  const [panning, setPanning] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const helpId = useId();
  const dividerId = useId();
  const source = beforeLoaded?.url === before.url ? beforeLoaded : validSize(before) ? before : { width: 1, height: 1 };
  const result = afterLoaded?.url === after.url ? afterLoaded : validSize(after) ? after : { width: 1, height: 1 };
  const dimensionMismatch = !validSize(before) || !validSize(after) || source.width !== before.width || source.height !== before.height || result.width !== after.width || result.height !== after.height;
  const sameCanvasMismatch = alignment === 'same-canvas' && (source.width !== result.width || source.height !== result.height);
  const invalidFittingSize = sourceFittingSize !== undefined && !validSize(sourceFittingSize);
  const crop = comparisonCrop(source, result, alignment, invalidFittingSize ? result : sourceFittingSize);
  const cannotAlign = dimensionMismatch || sameCanvasMismatch || invalidFittingSize || crop.width <= 0 || crop.height <= 0;
  const raw = showRaw || alignment === 'raw' || cannotAlign;
  const world = raw ? { width: source.width + result.width + 32, height: Math.max(source.height, result.height) } : result;
  const fit = Math.max(0.001, Math.min((viewport.width - 32) / world.width, (viewport.height - 32) / world.height, 1));
  const scale = zoom === 'fit' ? fit : zoom;
  const display = { width: world.width * scale, height: world.height * scale };
  const limitX = Math.max(0, (display.width - viewport.width) / 2 + 24);
  const limitY = Math.max(0, (display.height - viewport.height) / 2 + 24);
  const visiblePan = { x: clamp(pan.x, -limitX, limitX), y: clamp(pan.y, -limitY, limitY) };
  const origin = { x: (viewport.width - display.width) / 2 + visiblePan.x, y: (viewport.height - display.height) / 2 + visiblePan.y };
  const sourceStyle: CSSProperties = raw ? { width: source.width * scale, height: source.height * scale, left: 0, top: (world.height - source.height) * scale / 2 } : { width: `${100 * source.width / crop.width}%`, height: `${100 * source.height / crop.height}%`, left: `${-100 * crop.x / crop.width}%`, top: `${-100 * crop.y / crop.height}%` };
  const resultStyle: CSSProperties = raw ? { width: result.width * scale, height: result.height * scale, left: (source.width + 32) * scale, top: (world.height - result.height) * scale / 2 } : { width: '100%', height: '100%', left: 0, top: 0 };
  const guideLeft = clamp(origin.x + display.width * divider / 100, 0, viewport.width);
  const guideOutside = origin.x + display.width * divider / 100 < 0 || origin.x + display.width * divider / 100 > viewport.width;
  const loading = [beforeLoaded?.url !== before.url && !errors.before ? 'source' : '', afterLoaded?.url !== after.url && !errors.after ? 'result' : ''].filter(Boolean);

  function releaseCaptures() {
    const panId = drag.current?.pointerId; drag.current = null;
    if (panId !== undefined && viewportRef.current?.hasPointerCapture(panId)) viewportRef.current.releasePointerCapture(panId);
    const dividerCapture = dividerDrag.current; dividerDrag.current = null;
    if (dividerCapture?.node.hasPointerCapture(dividerCapture.pointerId)) dividerCapture.node.releasePointerCapture(dividerCapture.pointerId);
  }
  function stopDragging() { releaseCaptures(); setPanning(false); }

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => setViewport({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(node);
    return () => { observer.disconnect(); releaseCaptures(); };
  }, []);
  useEffect(() => {
    setZoom('fit'); setPan({ x: 0, y: 0 }); setDivider(50); setShowRaw(false); stopDragging();
    restoreRetryFocus.current = false;
    const old = previousUrls.current;
    setErrors(value => ({ before: old.before === before.url && value.before, after: old.after === after.url && value.after }));
    previousUrls.current = { before: before.url, after: after.url };
  }, [before.url, after.url, before.width, before.height, after.width, after.height, alignment, sourceFittingSize?.width, sourceFittingSize?.height]);
  useEffect(() => { stopDragging(); }, [world.width, world.height, raw]);
  useEffect(() => {
    if (!restoreRetryFocus.current) return;
    if (errors.before || errors.after) {
      restoreRetryFocus.current = false;
      if (document.activeElement === document.body) retryButton.current?.focus();
    } else if (beforeLoaded?.url === before.url && afterLoaded?.url === after.url) {
      restoreRetryFocus.current = false;
    }
  }, [errors, beforeLoaded, afterLoaded, before.url, after.url]);

  function fitImages() { stopDragging(); setZoom('fit'); setPan({ x: 0, y: 0 }); }
  function changeZoom(next: number) {
    stopDragging();
    const value = clamp(next, Math.min(fit, 0.05), 8);
    setPan({ x: visiblePan.x * value / scale, y: visiblePan.y * value / scale });
    setZoom(value);
  }
  function beginPan(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary) return;
    stopDragging();
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, point: { x: event.clientX, y: event.clientY }, pan: visiblePan };
    setPanning(true);
  }
  function movePan(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    setPan({ x: clamp(drag.current.pan.x + event.clientX - drag.current.point.x, -limitX, limitX), y: clamp(drag.current.pan.y + event.clientY - drag.current.point.y, -limitY, limitY) });
  }
  function endPan(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function placeDivider(clientX: number) {
    const bounds = viewportRef.current?.getBoundingClientRect();
    if (bounds) setDivider(clamp((clientX - bounds.left - viewportRef.current!.clientLeft - origin.x) / display.width * 100, 0, 100));
  }
  function endDivider(event: PointerEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (dividerDrag.current?.pointerId !== event.pointerId) return;
    dividerDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function dividerKey(event: KeyboardEvent<HTMLButtonElement>) {
    let next: number;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 100;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = divider - (event.shiftKey ? 10 : 1);
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = divider + (event.shiftKey ? 10 : 1);
    else return;
    event.preventDefault(); event.stopPropagation(); setDivider(clamp(next, 0, 100));
  }
  function viewportKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const step = event.shiftKey ? 120 : 32;
    if (event.key === '+' || event.key === '=') changeZoom(scale * 1.25);
    else if (event.key === '-') changeZoom(scale / 1.25);
    else if (event.key === '0') fitImages();
    else if (event.key === '1') { stopDragging(); setZoom(1); setPan({ x: 0, y: 0 }); }
    else if (event.key.startsWith('Arrow')) setPan({ x: clamp(visiblePan.x + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0), -limitX, limitX), y: clamp(visiblePan.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0), -limitY, limitY) });
    else return;
    event.preventDefault();
  }
  const currentImage = (image: HTMLImageElement, side: ImageSide) => image === (side === 'before' ? beforeRef.current : afterRef.current);
  const failed = (image: HTMLImageElement, side: ImageSide) => { if (currentImage(image, side)) setErrors(value => ({ ...value, [side]: true })); };
  const loaded = (image: HTMLImageElement, side: ImageSide) => {
    if (!currentImage(image, side)) return;
    const value = { width: image.naturalWidth, height: image.naturalHeight, url: side === 'before' ? before.url : after.url };
    if (!validSize(value)) { failed(image, side); return; }
    if (side === 'before') setBeforeLoaded(value); else setAfterLoaded(value);
    setErrors(previous => ({ ...previous, [side]: false }));
  };
  function retryImages() { restoreRetryFocus.current = document.activeElement === retryButton.current; stopDragging(); setBeforeLoaded(undefined); setAfterLoaded(undefined); setErrors({}); setLoadAttempt(value => value + 1); }
  const alignmentText = raw ? 'Raw view · each image keeps its original aspect ratio and pixel scale.' : alignment === 'center-crop' ? `Source aligned with the saved center crop (${crop.width} × ${crop.height}, ${crop.x}px from each horizontal edge, ${crop.y}px from each vertical edge).` : alignment === 'stretch' ? 'Before image stretched to the result dimensions for comparison.' : 'Both images share the same canvas dimensions.';

  return <Modal title="Compare source and result" onClose={onClose}><div className="compare-image">
    <div className="compare-metadata"><div><span>Before</span><strong>{before.label}</strong><small>{source.width} × {source.height} px</small></div><div><span>After</span><strong>{after.label}</strong><small>{result.width} × {result.height} px</small></div></div>
    {loading.length > 0 && <p className="compare-help" role="status">Loading {loading.join(' and ')} image{loading.length > 1 ? 's' : ''}…</p>}
    {(errors.before || errors.after) && <Notice error>{errors.before ? 'The source image could not be loaded. ' : ''}{errors.after ? 'The result image could not be loaded. ' : ''}Check that this studio’s image files are still available. <button ref={retryButton} type="button" onClick={retryImages}>Retry images</button></Notice>}
    {cannotAlign && <Notice>Saved dimensions do not support a reliable overlay. Showing the actual images side by side without alignment.</Notice>}
    <div className="compare-toolbar"><div className="button-row"><button type="button" onClick={() => changeZoom(scale / 1.25)} aria-label="Zoom out"><Minus size={16} /></button><output aria-label="Comparison zoom">{Math.round(scale * 100)}%</output><button type="button" onClick={() => changeZoom(scale * 1.25)} disabled={scale >= 8} aria-label="Zoom in"><Plus size={16} /></button><button type="button" onClick={fitImages}><Maximize size={15} />Fit</button><button type="button" onClick={() => { stopDragging(); setZoom(1); setPan({ x: 0, y: 0 }); }}>100%</button></div>{alignment !== 'raw' && !cannotAlign && <button type="button" aria-pressed={showRaw} onClick={() => { setShowRaw(value => !value); fitImages(); }}>{showRaw ? 'Aligned divider' : 'Raw side by side'}</button>}</div>
    <div ref={viewportRef} className={`compare-viewport${panning ? ' is-panning' : ''}`} tabIndex={0} role="group" aria-label="Image comparison canvas" aria-describedby={helpId} onPointerDown={beginPan} onPointerMove={movePan} onPointerUp={endPan} onPointerCancel={endPan} onLostPointerCapture={endPan} onKeyDown={viewportKey}>
      <div className="compare-world" style={{ width: display.width, height: display.height, left: origin.x, top: origin.y }}>
        <img key={`${after.url}:${loadAttempt}`} ref={afterRef} className="compare-result" style={resultStyle} src={after.url} alt={`${after.label}, after`} draggable={false} onLoad={event => loaded(event.currentTarget, 'after')} onError={event => failed(event.currentTarget, 'after')} />
        <div className="compare-source" style={{ clipPath: raw ? undefined : `inset(0 ${100 - divider}% 0 0)` }}><img key={`${before.url}:${loadAttempt}`} ref={beforeRef} style={sourceStyle} src={before.url} alt={`${before.label}, before`} draggable={false} onLoad={event => loaded(event.currentTarget, 'before')} onError={event => failed(event.currentTarget, 'before')} /></div>
      </div>
      <div className="compare-corner-labels" aria-hidden="true"><span>Before</span><span>After</span></div>
      {!raw && <div className={`compare-divider${guideOutside ? ' is-outside' : ''}`} style={{ left: guideLeft, top: Math.max(0, origin.y), height: Math.min(viewport.height, origin.y + display.height) - Math.max(0, origin.y) }}><button type="button" className="compare-divider-handle" role="slider" aria-label="Before and after divider" title={guideOutside ? 'Divider is outside the panned view. Drag this handle to reposition it.' : 'Drag to compare before and after'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(divider)} aria-valuetext={`${Math.round(divider)}% before, ${100 - Math.round(divider)}% after`} onKeyDown={dividerKey} onPointerDown={event => { if (event.button !== 0 || !event.isPrimary) return; event.preventDefault(); event.stopPropagation(); stopDragging(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); dividerDrag.current = { node: event.currentTarget, pointerId: event.pointerId }; placeDivider(event.clientX); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { event.stopPropagation(); placeDivider(event.clientX); } }} onPointerUp={endDivider} onPointerCancel={endDivider} onLostPointerCapture={endDivider}><ArrowLeftRight size={18} /></button></div>}
    </div>
    {!raw && <div className="compare-slider"><label htmlFor={dividerId}>Before {Math.round(divider)}%</label><input id={dividerId} type="range" min={0} max={100} step={1} value={divider} aria-label="Amount of before image shown" onChange={event => setDivider(Number(event.target.value))} /><button type="button" onClick={() => setDivider(50)}>Center divider</button></div>}
    <p className="compare-alignment">{alignmentText}{!raw && alignment !== 'same-canvas' && ' Display scaling does not change either saved image.'}</p>
    <p id={helpId} className="compare-help">Drag the canvas to pan both images. Focus it and use arrow keys to pan, + / − to zoom, 0 to fit, or 1 for 100%. {raw ? '' : 'Drag the divider or use its arrow keys (Shift for larger steps).'} Viewing preserves your draft.</p>
    <div className="compare-footer"><button type="button" onClick={onClose}>Done</button></div>
  </div></Modal>;
}


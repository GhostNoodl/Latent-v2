import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { ArrowDown, ArrowUp, LayoutPanelLeft, Move, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import { activeRegionalPromptRegions, createDefaultRegionalPromptSettings, REGIONAL_PROMPT_LIMITS, regionalPromptSettingsSchema, type RegionalPromptRegion, type RegionalPromptSettings } from '../shared/regional-prompt-types';
import { moveRegionalRegion, rectangleFromPoints, resizeRegionalRegion, setRegionalBound, type RegionCorner, type RegionPoint } from '../shared/regional-prompt-editor';
import { regionalMaskGeometry } from '../shared/regional-prompt-workflow';
import { Field, Modal, Notice } from './ui';
import './regional-prompts.css';

export interface RegionalPromptsProps { value?: RegionalPromptSettings; width: number; height: number; disabledReason?: string; onChange(value: RegionalPromptSettings | undefined): void; }
const COLORS = ['#ac94ec', '#64ceb4', '#e3ad70', '#df8fb3'];
interface Gesture { kind: 'draw' | 'move' | RegionCorner; id: string; start: RegionPoint; original: RegionalPromptSettings; pointer: number; }
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function RegionalPrompts({ value, width, height, disabledReason, onChange }: RegionalPromptsProps) {
  const enabled = value?.enabled ?? false; const [open, setOpen] = useState(false);
  const [editor, setEditor] = useState<RegionalPromptSettings>(createDefaultRegionalPromptSettings); const editorRef = useRef(editor);
  const [selectedId, setSelectedId] = useState('region_left'); const [undo, setUndo] = useState<RegionalPromptSettings[]>([]);
  const [drawing, setDrawing] = useState(false); const [error, setError] = useState('');
  const svg = useRef<SVGSVGElement>(null); const gesture = useRef<Gesture | null>(null);
  const openRef = useRef(false), closing = useRef(false), baseline = useRef('');
  useEffect(() => {
    const before = window.latent?.onBeforeClose?.(async () => {
      if (openRef.current && JSON.stringify(editorRef.current) !== baseline.current) {
        const message = 'The regional editor has unapplied changes. Apply the layout or Cancel its edits before closing the studio.';
        setError(message); throw new Error(message);
      }
      cancelGesture(true); closing.current = true;
    });
    const cancelled = window.latent?.onCloseCancelled?.(() => { closing.current = false; });
    return () => { before?.(); cancelled?.(); cancelGesture(false); };
  }, []);
  const selected = editor.regions.find(region => region.id === selectedId);
  const regionCount = value?.regions.length ?? 0; const active = value ? activeRegionalPromptRegions(value).length : 0;
  function replace(next: RegionalPromptSettings) { if (closing.current) return; editorRef.current = next; setEditor(next); setError(''); }
  function remember(previous: RegionalPromptSettings) { setUndo(history => [...history.slice(-49), structuredClone(previous)]); }
  function change(next: RegionalPromptSettings) { if (!closing.current && JSON.stringify(next) !== JSON.stringify(editorRef.current)) { remember(editorRef.current); replace(next); } }
  function patch(id: string, update: Partial<RegionalPromptRegion> | ((region: RegionalPromptRegion) => RegionalPromptRegion)) {
    change({ ...editorRef.current, regions: editorRef.current.regions.map(region => region.id === id ? typeof update === 'function' ? update(region) : { ...region, ...update } : region) });
  }
  function cancelGesture(restore: boolean) {
    const action = gesture.current; if (!action) return false;
    gesture.current = null;
    if (svg.current?.hasPointerCapture(action.pointer)) svg.current.releasePointerCapture(action.pointer);
    if (restore) { replace(action.original); setDrawing(false); }
    return true;
  }
  function dismiss() { if (closing.current) return; cancelGesture(false); openRef.current = false; setOpen(false); }
  function openEditor() { if (closing.current) return; const copy = structuredClone(value ?? createDefaultRegionalPromptSettings()); cancelGesture(false); baseline.current = JSON.stringify(copy); replace(copy); setSelectedId(copy.regions[0]?.id ?? ''); setUndo([]); setDrawing(false); openRef.current = true; setOpen(true); }
  function undoLast() { if (closing.current || cancelGesture(true)) return; const previous = undo.at(-1); if (!previous) return; replace(previous); setUndo(history => history.slice(0, -1)); if (!previous.regions.some(region => region.id === selectedId)) setSelectedId(previous.regions[0]?.id ?? ''); }
  function newRegion(): RegionalPromptRegion { return { id: `region_${crypto.randomUUID()}`, name: `Region ${editorRef.current.regions.length + 1}`, x: 0.25, y: 0.25, width: 0.5, height: 0.5, positivePrompt: '', negativePrompt: '', strength: 1, feather: 0 }; }
  function add() { if (editorRef.current.regions.length >= REGIONAL_PROMPT_LIMITS.maxRegions) return; const region = newRegion(); change({ ...editorRef.current, regions: [...editorRef.current.regions, region] }); setSelectedId(region.id); setDrawing(false); }
  function remove(id: string) { const regions = editorRef.current.regions.filter(region => region.id !== id); change({ ...editorRef.current, regions }); if (selectedId === id) setSelectedId(regions[0]?.id ?? ''); }
  function reorder(id: string, delta: number) { const regions = [...editorRef.current.regions]; const index = regions.findIndex(region => region.id === id); const target = index + delta; if (target < 0 || target >= regions.length) return; [regions[index], regions[target]] = [regions[target], regions[index]]; change({ ...editorRef.current, regions }); }
  function point(event: PointerEvent): RegionPoint { const transformed = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse()); return { x: Math.max(0, Math.min(1, transformed.x / width)), y: Math.max(0, Math.min(1, transformed.y / height)) }; }
  function start(event: PointerEvent, kind: Gesture['kind'], id?: string) {
    if (closing.current || event.button !== 0 || gesture.current || !svg.current) return; event.preventDefault(); event.stopPropagation();
    if (kind === 'draw' && editorRef.current.regions.length >= REGIONAL_PROMPT_LIMITS.maxRegions) return;
    const original = structuredClone(editorRef.current); const origin = point(event); const region = kind === 'draw' ? newRegion() : original.regions.find(region => region.id === id)!;
    if (!region) return; gesture.current = { kind, id: region.id, start: origin, original, pointer: event.pointerId }; setSelectedId(region.id); svg.current.setPointerCapture(event.pointerId);
    if (kind === 'draw') replace({ ...original, regions: [...original.regions, { ...region, ...rectangleFromPoints(origin, origin) }] });
  }
  function move(event: PointerEvent) {
    const action = gesture.current; if (!action || action.pointer !== event.pointerId) return; const target = point(event);
    const original = action.original.regions.find(region => region.id === action.id);
    const updated = action.kind === 'draw' ? { ...editorRef.current.regions.find(region => region.id === action.id)!, ...rectangleFromPoints(action.start, target) } : action.kind === 'move' ? moveRegionalRegion(original!, { x: target.x - action.start.x, y: target.y - action.start.y }) : resizeRegionalRegion(original!, action.kind, target);
    replace({ ...editorRef.current, regions: editorRef.current.regions.map(region => region.id === action.id ? updated : region) });
  }
  function finish(event: PointerEvent, cancel = false) {
    const action = gesture.current; if (!action || action.pointer !== event.pointerId) return;
    gesture.current = null; if (svg.current?.hasPointerCapture(event.pointerId)) svg.current.releasePointerCapture(event.pointerId);
    if (cancel) replace(action.original); else if (JSON.stringify(action.original) !== JSON.stringify(editorRef.current)) remember(action.original);
    setDrawing(false);
  }
  function apply() {
    if (closing.current) return;
    try { const checked = regionalPromptSettingsSchema.parse(editorRef.current); onChange(checked); dismiss(); }
    catch (issue) { setError(errorText(issue)); }
  }
  const canvasValid = [width,height].every(size => Number.isInteger(size) && size >= 256 && size <= 2048 && size % 64 === 0) && width * height <= 4 * 1024 * 1024;
  const selectedGeometry = canvasValid && selected ? regionalMaskGeometry({ ...selected, name: selected.name.trim() || 'Untitled region' }, { width, height }) : undefined;

  return <section className="regional-prompts" aria-label="Regional prompting">
    <div className="regional-heading"><label className="toggle"><input type="checkbox" checked={enabled} disabled={Boolean(disabledReason) && !enabled} onChange={event => { if (!closing.current) onChange({ ...(value ?? createDefaultRegionalPromptSettings()), enabled: event.target.checked }); }} /><span>Regional prompts</span></label><button type="button" className="text-button" disabled={!canvasValid} onClick={openEditor}><LayoutPanelLeft size={14} />Edit regions{regionCount > 0 && <span className="badge">{regionCount}</span>}</button></div>
    <p className="muted small">Keep the global prompt for the whole scene. Add separate literal prompts to selected areas; guidance can overlap and does not guarantee perfectly isolated subjects.</p>
    {!canvasValid && <p className="muted small">Finish the image size before editing regions: 256–2048, in multiples of 64.</p>}{disabledReason && <Notice>{disabledReason}</Notice>}
    {enabled && <p className={`small ${active ? 'muted' : 'regional-needs-text'}`}>{active ? `${active} active ${active === 1 ? 'region' : 'regions'} · ${width} × ${height} canvas` : 'Enter a positive or negative prompt in at least one region with strength above zero before generating.'}</p>}
    {open && canvasValid && <Modal title="Regional prompts" onClose={dismiss}><div className="regional-editor" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) { event.preventDefault(); undoLast(); } }}>
      <p className="muted small">Draw up to four regions, or add one and enter its bounds. Move a region by dragging; resize with its corner handles. The global positive and negative prompts remain separate.</p>
      <div className="regional-toolbar"><button type="button" className={drawing ? 'active' : ''} aria-pressed={drawing} disabled={editor.regions.length >= 4} onClick={() => setDrawing(!drawing)}><Pencil size={14} />{drawing ? 'Draw on canvas…' : 'Draw region'}</button><button type="button" disabled={editor.regions.length >= 4} onClick={add}><Plus size={14} />Add centered region</button><button type="button" disabled={!undo.length} onClick={undoLast}><Undo2 size={14} />Undo</button><span className="muted small">{width} × {height} · {editor.regions.length}/4 regions</span></div>
      <div className="regional-layout"><div className="regional-canvas-column"><svg ref={svg} className={`regional-canvas ${drawing ? 'drawing' : ''}`} viewBox={`0 0 ${width} ${height}`} style={{ aspectRatio: `${width} / ${height}` }} aria-label="Regional prompt canvas" onPointerDown={event => { if (drawing) start(event, 'draw'); }} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}>
        <defs><pattern id="regional-grid" width={width / 10} height={height / 10} patternUnits="userSpaceOnUse"><path d={`M ${width / 10} 0 L 0 0 0 ${height / 10}`} fill="none" stroke="currentColor" strokeWidth="1" /></pattern></defs><rect width={width} height={height} className="regional-grid" fill="url(#regional-grid)" />
        {editor.regions.map((region, index) => { const selected = region.id === selectedId; const geometry = regionalMaskGeometry({ ...region, name: region.name.trim() || 'Untitled region' }, { width, height }); const box = geometry.pixelBounds; const feather = geometry.featherPixels; const handle = Math.max(width, height) / 65;
          return <g key={region.id} className={`regional-shape ${selected ? 'selected' : ''}`} style={{ '--region-color': COLORS[index] } as CSSProperties}>
            <rect x={box.x} y={box.y} width={box.width} height={box.height} tabIndex={0} role="button" aria-label={`${region.name || 'Untitled region'}, ${Math.round(region.x * 100)} percent from left, ${Math.round(region.y * 100)} percent from top. Arrow keys move; bounds fields resize.`} onPointerDown={event => { if (drawing) start(event, 'draw'); else start(event, 'move', region.id); }} onFocus={() => setSelectedId(region.id)} onKeyDown={event => { const step = event.shiftKey ? 0.05 : 0.01; const delta = ({ ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } } as Record<string, RegionPoint>)[event.key]; if (delta) { event.preventDefault(); patch(region.id, current => moveRegionalRegion(current, delta)); } if (event.key === 'Delete') { event.preventDefault(); remove(region.id); } }} />
            {feather > 0 && <rect className="regional-feather" x={box.x + feather} y={box.y + feather} width={Math.max(0, box.width - feather * 2)} height={Math.max(0, box.height - feather * 2)} />}
            <text x={box.x + 8} y={box.y + Math.max(height / 30, 18)} fontSize={Math.max(height / 40, 14)}>{index + 1}. {region.name || 'Untitled'}</text>
            {selected && (['nw', 'ne', 'sw', 'se'] as const).map(corner => <rect key={corner} className={`regional-handle ${corner}`} x={(corner.includes('w') ? box.x : box.x + box.width) - handle / 2} y={(corner.includes('n') ? box.y : box.y + box.height) - handle / 2} width={handle} height={handle} onPointerDown={event => start(event, corner, region.id)} />)}
          </g>;
        })}
      </svg><p className="muted small"><Move size={12} />Bounds include feathering. Dashed inset marks the full-strength interior. Overlap mixes guidance; list order is retained in the recipe.</p>
      <ol className="regional-list">{editor.regions.map((region, index) => <li key={region.id} className={region.id === selectedId ? 'selected' : ''}><button type="button" onClick={() => setSelectedId(region.id)}><span className="regional-swatch" style={{ background: COLORS[index] }} />{index + 1}. {region.name || 'Untitled region'}</button><button type="button" className="icon-button" disabled={index === 0} aria-label={`Move ${region.name} earlier`} onClick={() => reorder(region.id, -1)}><ArrowUp size={14} /></button><button type="button" className="icon-button" disabled={index === editor.regions.length - 1} aria-label={`Move ${region.name} later`} onClick={() => reorder(region.id, 1)}><ArrowDown size={14} /></button><button type="button" className="icon-button" aria-label={`Delete ${region.name}`} onClick={() => remove(region.id)}><Trash2 size={14} /></button></li>)}</ol></div>
      <div className="regional-fields">{selected ? <>
        <Field label="Region name"><input value={selected.name} maxLength={80} onChange={event => patch(selected.id, { name: event.target.value })} /></Field>
        <Field label="Regional positive prompt" hint="Literal text. Wildcards and {choices} are not expanded inside region prompts."><textarea rows={4} value={selected.positivePrompt} maxLength={4000} onChange={event => patch(selected.id, { positivePrompt: event.target.value })} placeholder="What belongs in this area?" /></Field>
        <Field label="Regional negative prompt"><textarea rows={3} value={selected.negativePrompt} maxLength={4000} onChange={event => patch(selected.id, { negativePrompt: event.target.value })} placeholder="What should this area avoid?" /></Field>
        <div className="regional-two"><Field label="Strength" hint="0 skips this region; global guidance still applies."><input type="number" min={0} max={2} step={0.05} value={selected.strength} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) patch(selected.id, { strength: Math.max(0, Math.min(2, value)) }); }} /></Field><Field label="Feather · canvas pixels" hint={`Effective: ${selectedGeometry!.featherPixels}px; clamped to half the shorter side.`}><input type="number" min={0} max={256} step={1} value={selected.feather} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) patch(selected.id, { feather: Math.max(0, Math.min(256, Math.round(value))) }); }} /></Field></div>
        <div className="regional-bounds">{(['x', 'y', 'width', 'height'] as const).map(key => <Field key={key} label={`${{ x: 'Left', y: 'Top', width: 'Width', height: 'Height' }[key]} · %`}><input type="number" min={key === 'x' || key === 'y' ? 0 : 1} max={100} step={0.1} value={Math.round(selected[key] * 100000) / 1000} onChange={event => patch(selected.id, current => setRegionalBound(current, key, Number(event.target.value) / 100))} /></Field>)}</div>
        <p className="muted small">Pixel bounds: {selectedGeometry!.pixelBounds.x}, {selectedGeometry!.pixelBounds.y} · {selectedGeometry!.pixelBounds.width} × {selectedGeometry!.pixelBounds.height}. Edges round outward to whole pixels.</p>
      </> : <Notice>Add or draw a region to describe part of the scene.</Notice>}</div></div>
      {error && <Notice error>{error}</Notice>}<div className="regional-footer"><p className="muted small">Regional prompting guides conditioning; it does not guarantee perfect subject separation. Initial use supports one SDXL/Illustrious text-to-image pass.</p><div className="button-row"><button type="button" className="primary" onClick={apply}>Apply layout</button><button type="button" onClick={dismiss}>Cancel</button></div></div>
    </div></Modal>}
  </section>;
}

import { useEffect, useRef, type ReactNode } from 'react';

export function CanvasViewport({ children, zoom, onZoom, width, hasImage }: { children: ReactNode; zoom: number; onZoom(value: number): void; width: number; hasImage: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const current = useRef({ zoom, onZoom, width, hasImage }); current.current = { zoom, onZoom, width, hasImage };
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | undefined>(undefined);
  useEffect(() => {
    const node = ref.current!;
    const wheel = (event: WheelEvent) => {
      const state = current.current; const image = node.querySelector('img');
      if (!state.hasImage || !image || event.deltaY === 0) return;
      event.preventDefault();
      const previous = state.zoom || image.getBoundingClientRect().width / state.width;
      const next = Math.max(0.1, Math.min(4, previous * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
      const rect = node.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      const left = (node.scrollLeft + x) * next / previous - x, top = (node.scrollTop + y) * next / previous - y;
      state.onZoom(next);
      requestAnimationFrame(() => { if (ref.current === node) { node.scrollLeft = left; node.scrollTop = top; } });
    };
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  }, []);
  return <div ref={ref} className={`canvas-wrap ${hasImage ? 'has-image' : ''} ${zoom ? 'canvas-zoomed' : ''}`} tabIndex={hasImage ? 0 : undefined} role="group" aria-label="Image preview: scroll to zoom, drag to pan, double-click to fit" onDoubleClick={() => onZoom(0)} onPointerDown={event => {
    if (!hasImage || !zoom || event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: event.currentTarget.scrollLeft, top: event.currentTarget.scrollTop };
  }} onPointerMove={event => { const start = drag.current; if (!start || start.id !== event.pointerId) return; event.currentTarget.scrollLeft = start.left - event.clientX + start.x; event.currentTarget.scrollTop = start.top - event.clientY + start.y; }} onPointerUp={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }} onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key.toLowerCase() === 'f') { event.preventDefault(); onZoom(0); } }}>{children}</div>;
}

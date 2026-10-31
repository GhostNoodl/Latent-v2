import { useLayoutEffect, useState, type RefObject } from 'react';

/** A dashed outline on the stage showing the shape and pixel size the next image will have. */
export function SizePeek({
  stage,
  width,
  height,
}: {
  stage: RefObject<HTMLElement | null>;
  width: number;
  height: number;
}) {
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number }>();
  useLayoutEffect(() => {
    const host = stage.current;
    const area = host?.querySelector<HTMLElement>('.canvas-wrap');
    if (!host || !area) return;
    const measure = () => {
      const outer = host.getBoundingClientRect(),
        inner = area.getBoundingClientRect();
      const room = { width: inner.width * 0.96, height: inner.height * 0.96 };
      // Match the shown picture's scale so sizes compare truthfully, but always fit the stage.
      const image = area.querySelector<HTMLImageElement>('img');
      const shown = image?.naturalWidth ? image.getBoundingClientRect().width / image.naturalWidth : undefined;
      const fit = Math.min(room.width / width, room.height / height);
      const scale = shown ? Math.min(shown, fit) : fit;
      const w = width * scale,
        h = height * scale;
      setBox({
        left: inner.left - outer.left + (inner.width - w) / 2,
        top: inner.top - outer.top + (inner.height - h) / 2,
        width: w,
        height: h,
      });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [stage, width, height]);
  if (!box) return null;
  return (
    <div className="size-peek" style={box} aria-hidden="true">
      <span>
        {width} × {height}
      </span>
    </div>
  );
}

import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';

export type PaintTool = 'brush' | 'erase' | 'pick';
export interface EditPaintHandle {
  clear: () => void;
  /** Opaque grayscale PNG at the picture's size: white = change, black = keep. Undefined when nothing is painted. */
  exportMask: () => Promise<Uint8Array | undefined>;
  /** Adds the white part of a saved mask picture to the paint. */
  addMask: (url: string) => Promise<void>;
  /** Swaps painted and unpainted parts. */
  invert: () => void;
}
interface Props {
  width: number;
  height: number;
  tool: PaintTool;
  /** Brush size in screen pixels. */
  brush: number;
  onPaintedChange: (painted: boolean) => void;
  onPick: (x: number, y: number) => void;
}

const accentOf = (element: Element) => getComputedStyle(element).getPropertyValue('--accent').trim() || '#c9a7ff';

/** A see-through paint layer over the picture. It keeps its strokes at the picture's own size. */
export const EditPaint = forwardRef<EditPaintHandle, Props>(function EditPaint(
  { width, height, tool, brush, onPaintedChange, onPick },
  ref,
) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number }>(undefined);
  const painted = useRef(false);
  const [cursor, setCursor] = useState<{ x: number; y: number }>();

  const setPainted = useCallback(
    (value: boolean) => {
      if (painted.current === value) return;
      painted.current = value;
      onPaintedChange(value);
    },
    [onPaintedChange],
  );
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) * width) / rect.width,
      y: ((event.clientY - rect.top) * height) / rect.height,
      scale: width / rect.width,
    };
  };
  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }, scale: number) => {
    const context = canvas.current?.getContext('2d');
    if (!context) return;
    context.save();
    context.globalCompositeOperation = tool === 'erase' ? 'destination-out' : 'source-over';
    context.strokeStyle = accentOf(canvas.current!);
    context.fillStyle = context.strokeStyle;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.lineWidth = Math.max(1, brush * scale);
    context.beginPath();
    context.moveTo(from.x, from.y);
    context.lineTo(to.x + 0.01, to.y);
    context.stroke();
    context.restore();
    if (tool === 'brush') setPainted(true);
  };

  useImperativeHandle(
    ref,
    () => ({
      clear() {
        canvas.current?.getContext('2d')?.clearRect(0, 0, width, height);
        setPainted(false);
      },
      async exportMask() {
        const paint = canvas.current;
        if (!paint) return undefined;
        const pixels = paint.getContext('2d')!.getImageData(0, 0, width, height).data;
        let any = false;
        for (let index = 3; index < pixels.length; index += 4)
          if (pixels[index] > 0) {
            any = true;
            break;
          }
        if (!any) {
          setPainted(false);
          return undefined;
        }
        const white = document.createElement('canvas');
        white.width = width;
        white.height = height;
        const whiteContext = white.getContext('2d')!;
        whiteContext.drawImage(paint, 0, 0);
        whiteContext.globalCompositeOperation = 'source-in';
        whiteContext.fillStyle = '#fff';
        whiteContext.fillRect(0, 0, width, height);
        const mask = document.createElement('canvas');
        mask.width = width;
        mask.height = height;
        const maskContext = mask.getContext('2d')!;
        maskContext.fillStyle = '#000';
        maskContext.fillRect(0, 0, width, height);
        maskContext.drawImage(white, 0, 0);
        // Edges come out gray; keep them gray but exactly neutral and opaque.
        const data = maskContext.getImageData(0, 0, width, height);
        for (let index = 0; index < data.data.length; index += 4) {
          const value = data.data[index];
          data.data[index + 1] = value;
          data.data[index + 2] = value;
          data.data[index + 3] = 255;
        }
        maskContext.putImageData(data, 0, 0);
        const blob = await new Promise<Blob | null>(resolve => mask.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('The painted area could not be saved.');
        return new Uint8Array(await blob.arrayBuffer());
      },
      invert() {
        const paint = canvas.current;
        const context = paint?.getContext('2d');
        if (!paint || !context) return;
        const flipped = document.createElement('canvas');
        flipped.width = width;
        flipped.height = height;
        const flippedContext = flipped.getContext('2d')!;
        flippedContext.fillStyle = accentOf(paint);
        flippedContext.fillRect(0, 0, width, height);
        flippedContext.globalCompositeOperation = 'destination-out';
        flippedContext.drawImage(paint, 0, 0);
        context.clearRect(0, 0, width, height);
        context.drawImage(flipped, 0, 0);
        const pixels = context.getImageData(0, 0, width, height).data;
        let any = false;
        for (let index = 3; index < pixels.length; index += 4)
          if (pixels[index] > 0) {
            any = true;
            break;
          }
        painted.current = !any;
        setPainted(any);
      },
      async addMask(url: string) {
        const image = new Image();
        image.src = url;
        await image.decode();
        const temp = document.createElement('canvas');
        temp.width = width;
        temp.height = height;
        const context = temp.getContext('2d')!;
        context.drawImage(image, 0, 0, width, height);
        const data = context.getImageData(0, 0, width, height);
        const accent = accentOf(canvas.current!);
        const probe = document.createElement('canvas').getContext('2d')!;
        probe.fillStyle = accent;
        probe.fillRect(0, 0, 1, 1);
        const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
        for (let index = 0; index < data.data.length; index += 4) {
          const on = data.data[index] > 127;
          data.data[index] = r;
          data.data[index + 1] = g;
          data.data[index + 2] = b;
          data.data[index + 3] = on ? 255 : 0;
        }
        context.putImageData(data, 0, 0);
        canvas.current?.getContext('2d')?.drawImage(temp, 0, 0);
        setPainted(true);
      },
    }),
    [width, height, setPainted],
  );

  return (
    <>
      <canvas
        ref={canvas}
        className={`ed-paint ed-paint-${tool}`}
        width={width}
        height={height}
        aria-label="Paint the part to change"
        onPointerDown={event => {
          if (event.button !== 0) return;
          const at = point(event);
          if (tool === 'pick') {
            onPick(Math.round(at.x), Math.round(at.y));
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          last.current = at;
          stroke(at, at, at.scale);
        }}
        onPointerMove={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          setCursor({ x: event.clientX - rect.left, y: event.clientY - rect.top });
          if (!last.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const at = point(event);
          stroke(last.current, at, at.scale);
          last.current = at;
        }}
        onPointerUp={() => {
          last.current = undefined;
        }}
        onPointerLeave={() => setCursor(undefined)}
      />
      {cursor && tool !== 'pick' && (
        <span
          className="ed-brush"
          style={{ left: cursor.x, top: cursor.y, width: brush, height: brush }}
          aria-hidden="true"
        />
      )}
    </>
  );
});

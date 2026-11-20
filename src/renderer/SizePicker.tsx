import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { SIZE_PRESETS } from '../shared/defaults';
import { IMAGE_MODELS, imageModelSizes, type ImageModelId } from '../shared/image-models';

type Size = { name: string; width: number; height: number };

const MIN = 256;
const MAX = 2048;
/** Create's draft takes sides in steps of 64. */
const snap = (value: number) => Math.min(MAX, Math.max(MIN, Math.round(value / 64) * 64));
const megapixels = (width: number, height: number) => ((width * height) / (1024 * 1024)).toFixed(1);

function Shape({ width, height }: { width: number; height: number }) {
  const long = 16;
  const ratio = width / height;
  return (
    <span
      className="size-shape"
      aria-hidden="true"
      style={{
        width: ratio >= 1 ? long : Math.max(6, Math.round(long * ratio)),
        height: ratio <= 1 ? long : Math.max(6, Math.round(long / ratio)),
      }}
    />
  );
}

/** The size chip's panel: model-aware sizes, your presets, and a custom width and height. */
export function SizePicker({
  width,
  height,
  presets = SIZE_PRESETS,
  imageModel,
  onChoose,
  onPreview,
  onClose,
}: {
  width: number;
  height: number;
  presets?: Size[];
  imageModel?: ImageModelId;
  onChoose(size: { width: number; height: number }): void;
  onPreview(size: { width: number; height: number } | undefined): void;
  onClose(): void;
}) {
  /** What you typed in the custom boxes; empty means they show the current size. */
  const [typed, setTyped] = useState<{ width?: string; height?: string }>({});
  const customWidth = typed.width ?? String(width);
  const customHeight = typed.height ?? String(height);
  const setCustomWidth = (value: string) => setTyped(previous => ({ ...previous, width: value }));
  const setCustomHeight = (value: string) => setTyped(previous => ({ ...previous, height: value }));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"], button')?.focus();
    return () => onPreview(undefined);
  }, [onPreview]);
  const best = imageModel ? imageModelSizes(imageModel) : undefined;
  const applyCustom = () => {
    const w = snap(Number(customWidth) || width);
    const h = snap(Number(customHeight) || height);
    setTyped({});
    onChoose({ width: w, height: h });
  };
  const sizeButton = (size: Size) => (
    <button
      type="button"
      key={`${size.name}-${size.width}-${size.height}`}
      aria-pressed={size.width === width && size.height === height}
      title={`${size.width} × ${size.height}`}
      onClick={() => {
        setTyped({});
        onChoose(size);
      }}
      onPointerEnter={() => onPreview(size)}
      onPointerLeave={() => onPreview(undefined)}
      onFocus={() => onPreview(size)}
      onBlur={() => onPreview(undefined)}
    >
      <Shape width={size.width} height={size.height} />
      <span>{size.name}</span>
      <small>
        {size.width}×{size.height}
      </small>
    </button>
  );
  return (
    <div
      ref={ref}
      className="size-popover"
      role="group"
      aria-label="Image size"
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="size-popover-heading">
        <strong>Size</strong>
        <span>
          {width} × {height} · {megapixels(width, height)} MP
        </span>
      </div>
      {best && imageModel && (
        <>
          <p className="size-popover-label">Best for {IMAGE_MODELS[imageModel].name}</p>
          <div className="size-popover-grid">{best.map(sizeButton)}</div>
        </>
      )}
      <p className="size-popover-label">{best ? 'Your sizes' : 'Sizes'}</p>
      <div className="size-popover-grid">{presets.map(sizeButton)}</div>
      <p className="size-popover-label">Custom</p>
      <div className="size-popover-custom">
        <input
          type="text"
          aria-label="Width"
          inputMode="numeric"
          value={customWidth}
          onChange={event => setCustomWidth(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              applyCustom();
            }
          }}
        />
        <button
          type="button"
          className="icon-button"
          aria-label="Swap width and height"
          title="Swap width and height"
          onClick={() => {
            setTyped({});
            onChoose({ width: height, height: width });
          }}
        >
          <ArrowLeftRight size={14} />
        </button>
        <input
          type="text"
          aria-label="Height"
          inputMode="numeric"
          value={customHeight}
          onChange={event => setCustomHeight(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              applyCustom();
            }
          }}
        />
        <button type="button" className="primary" onClick={applyCustom}>
          Use
        </button>
      </div>
      <small className="size-popover-note">
        Sides snap to steps of 64, from {MIN} to {MAX}.
      </small>
    </div>
  );
}

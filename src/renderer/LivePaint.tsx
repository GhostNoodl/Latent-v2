import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Brush, Eraser, ImageIcon, Pause, Play, Shuffle, Star, Trash2, Undo2, X } from 'lucide-react';
import type { AppSnapshot, GenerationDraft, GenerationRecord } from '../shared/types';

/** Live results run short so each change comes back in a few seconds. */
export const LIVE_MAX_STEPS = 10;
const UNDO_LIMIT = 30;
const COLORS = ['#1b1b1f', '#f4f1ea', '#d64545', '#e8913a', '#f2d24b', '#4caf6a', '#3b82c4', '#8a5cc7', '#7a5236'];

/** Longest canvas side for the sketch: big enough to guide, small enough to send fast. */
export function sketchSize(width: number, height: number, longest = 1024) {
  const scale = Math.min(1, longest / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** The recipe for one live result: the current settings, run from the sketch with fewer steps. */
export function liveDraft(
  draft: GenerationDraft,
  sketch: { id: string; sha256: string },
  options: { prompt: string; strength: number; seed: string },
): GenerationDraft {
  return {
    ...draft,
    prompt: options.prompt,
    seed: options.seed,
    batchSize: 1,
    steps: Math.min(draft.steps, LIVE_MAX_STEPS),
    imageInput: {
      mode: 'img2img',
      sourceId: sketch.id,
      sourceSha256: sketch.sha256,
      denoise: Math.max(0.05, Math.min(1, options.strength)),
      resize: 'center-crop',
    },
    hiresFix: undefined,
    upscale: undefined,
    regionalPrompts: undefined,
    sweep: undefined,
    enhance: undefined,
    autoFace: undefined,
    autoFaceParentRecordId: undefined,
    faceDetailer: undefined,
    variationOfRecordId: undefined,
    qwenEdit: undefined,
    dynamicPrompts: undefined,
  };
}

/** What to clean up on close: results nobody kept, and sketches only those results used. */
export function liveLeftovers(
  results: { recordId: string; sketchId: string }[],
  sketchIds: string[],
  kept: Set<string>,
) {
  const keptSketches = new Set(results.filter(item => kept.has(item.recordId)).map(item => item.sketchId));
  return {
    records: results.filter(item => !kept.has(item.recordId)).map(item => item.recordId),
    sketches: sketchIds.filter(id => !keptSketches.has(id)),
  };
}

const randomSeed = () => String(crypto.getRandomValues(new Uint32Array(1))[0]);

interface LiveJob {
  jobId: string;
  sketchId: string;
}

/** Krita-style live painting: sketch on the left, the engine redraws it on the right after each stroke. */
export function LivePaint({
  snapshot,
  draft,
  startImage,
  onClose,
}: {
  snapshot: AppSnapshot;
  draft: GenerationDraft;
  /** The image on screen in Create, offered as a starting point. */
  startImage?: GenerationRecord;
  onClose(message?: string): void;
}) {
  const size = sketchSize(draft.width, draft.height);
  const canvas = useRef<HTMLCanvasElement>(null);
  const undoStack = useRef<ImageData[]>([]);
  const [undoCount, setUndoCount] = useState(0);
  const [tool, setTool] = useState<'brush' | 'eraser'>('brush');
  const [color, setColor] = useState(COLORS[0]);
  const [brush, setBrush] = useState(18);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [strength, setStrength] = useState(0.65);
  const [seed, setSeed] = useState(randomSeed);
  const [auto, setAuto] = useState(true);
  const [error, setError] = useState('');
  const [jobs, setJobs] = useState<LiveJob[]>([]);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [closing, setClosing] = useState(false);
  const sketches = useRef<string[]>([]);
  const busy = useRef(false);
  const lastJob = useRef<string | undefined>(undefined);
  const again = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const stroke = useRef<{ pointer: number; x: number; y: number } | null>(null);
  const settings = useRef({ prompt, strength, seed, draft });
  settings.current = { prompt, strength, seed, draft };

  const context = () => canvas.current?.getContext('2d') ?? null;
  const fillPaper = () => {
    const ctx = context();
    if (!ctx) return;
    ctx.fillStyle = '#f4f1ea';
    ctx.fillRect(0, 0, size.width, size.height);
  };
  useEffect(() => {
    fillPaper();
    // A new canvas size starts a fresh sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.width, size.height]);

  async function send() {
    if (busy.current) {
      again.current = true;
      return;
    }
    const node = canvas.current;
    if (!node) return;
    busy.current = true;
    setError('');
    try {
      const blob = await new Promise<Blob | null>(resolve => node.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('Could not read the sketch.');
      const sketch = await window.latent.importLiveSketch(new Uint8Array(await blob.arrayBuffer()));
      sketches.current.push(sketch.id);
      const current = settings.current;
      const job = await window.latent.queueGeneration(
        liveDraft(current.draft, { id: sketch.id, sha256: sketch.normalized.sha256 }, current),
      );
      // Only the newest change matters: stop the one still waiting or running.
      if (lastJob.current) void window.latent.cancelJob(lastJob.current).catch(() => {});
      lastJob.current = job.id;
      setJobs(list => [...list, { jobId: job.id, sketchId: sketch.id }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        void send();
      }
    }
  }
  const schedule = (delay = 350) => {
    window.clearTimeout(timer.current);
    if (auto) timer.current = window.setTimeout(() => void send(), delay);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const remember = () => {
    const ctx = context();
    if (!ctx) return;
    undoStack.current = [
      ...undoStack.current.slice(-(UNDO_LIMIT - 1)),
      ctx.getImageData(0, 0, size.width, size.height),
    ];
    setUndoCount(undoStack.current.length);
  };
  const undo = () => {
    const ctx = context();
    const last = undoStack.current.pop();
    if (!ctx || !last) return;
    ctx.putImageData(last, 0, 0);
    setUndoCount(undoStack.current.length);
    schedule();
  };
  const at = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * size.width,
      y: ((event.clientY - rect.top) / rect.height) * size.height,
    };
  };
  const line = (from: { x: number; y: number }, to: { x: number; y: number }, pressure: number) => {
    const ctx = context();
    if (!ctx) return;
    ctx.strokeStyle = tool === 'eraser' ? '#f4f1ea' : color;
    ctx.lineWidth = brush * (size.width / 512) * (pressure > 0 && pressure !== 0.5 ? 0.4 + pressure : 1);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };
  const startImageOnCanvas = () => {
    if (!startImage) return;
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      const ctx = context();
      if (!ctx) return;
      remember();
      const scale = Math.max(size.width / image.naturalWidth, size.height / image.naturalHeight);
      const w = image.naturalWidth * scale,
        h = image.naturalHeight * scale;
      ctx.drawImage(image, (size.width - w) / 2, (size.height - h) / 2, w, h);
      schedule(50);
    };
    image.onerror = () => setError('That image could not be loaded.');
    image.src = startImage.imageUrl;
  };

  const records = new Map(snapshot.history.map(record => [record.id, record]));
  const jobById = new Map(snapshot.jobs.map(job => [job.id, job]));
  const results = jobs.flatMap(item => {
    const recordId = jobById.get(item.jobId)?.outputIds[0];
    return recordId ? [{ recordId, sketchId: item.sketchId }] : [];
  });
  const latest = [...results].reverse().find(item => records.has(item.recordId));
  const latestRecord = latest ? records.get(latest.recordId) : undefined;
  const newest = jobs.at(-1) ? jobById.get(jobs.at(-1)!.jobId) : undefined;
  const working = newest && (newest.status === 'queued' || newest.status === 'running');
  const status = error
    ? 'Something went wrong'
    : working
      ? newest.status === 'running'
        ? `Drawing… ${newest.progressMax ? Math.round((newest.progress / newest.progressMax) * 100) : 0}%`
        : 'Waiting for the engine…'
      : newest?.status === 'failed'
        ? 'That one failed'
        : latestRecord
          ? 'Up to date'
          : 'Paint something';
  const shown = working && newest.previewUrl && snapshot.settings.showGenerationPreview ? newest.previewUrl : undefined;

  const close = async () => {
    if (closing) return;
    setClosing(true);
    window.clearTimeout(timer.current);
    const active = jobs.filter(item => {
      const job = jobById.get(item.jobId);
      return job && (job.status === 'queued' || job.status === 'running');
    });
    for (const item of active) await window.latent.cancelJob(item.jobId).catch(() => {});
    const leftovers = liveLeftovers(results, sketches.current, kept);
    try {
      if (leftovers.records.length) await window.latent.trashOutputs(leftovers.records);
      await window.latent.discardLiveSketches(leftovers.sketches);
    } catch {
      // Cleanup is best effort; the results stay in the Library.
    }
    onClose(kept.size ? `${kept.size} kept in the Library.` : undefined);
  };

  return (
    <div className="live-paint" role="dialog" aria-modal="true" aria-label="Live paint">
      <header className="live-top">
        <strong>Live paint</strong>
        <span className={`live-status ${working ? 'working' : ''}`}>{status}</span>
        <span className="muted live-hint">Results you don’t keep go to the Recycle Bin when you close.</span>
        <button
          type="button"
          disabled={!latestRecord || kept.has(latestRecord.id)}
          onClick={() => latestRecord && setKept(value => new Set(value).add(latestRecord.id))}
        >
          <Star size={14} /> {latestRecord && kept.has(latestRecord.id) ? 'Kept' : 'Keep'}
        </button>
        <button type="button" className="primary" disabled={closing} onClick={() => void close()}>
          Done
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Close live paint"
          disabled={closing}
          onClick={() => void close()}
        >
          <X size={16} />
        </button>
      </header>
      <div className="live-tools" role="toolbar" aria-label="Brush">
        <button type="button" aria-pressed={tool === 'brush'} onClick={() => setTool('brush')}>
          <Brush size={14} /> Brush
        </button>
        <button type="button" aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}>
          <Eraser size={14} /> Eraser
        </button>
        <span className="live-colors">
          {COLORS.map(value => (
            <button
              type="button"
              key={value}
              aria-label={`Color ${value}`}
              aria-pressed={tool === 'brush' && color === value}
              style={{ background: value }}
              onClick={() => {
                setColor(value);
                setTool('brush');
              }}
            />
          ))}
          <input
            type="color"
            aria-label="Pick a color"
            value={color}
            onChange={event => {
              setColor(event.target.value);
              setTool('brush');
            }}
          />
        </span>
        <label className="live-size">
          Size
          <input type="range" min={2} max={80} value={brush} onChange={event => setBrush(Number(event.target.value))} />
        </label>
        <button type="button" disabled={!undoCount} onClick={undo}>
          <Undo2 size={14} /> Undo
        </button>
        <button
          type="button"
          onClick={() => {
            remember();
            fillPaper();
            schedule();
          }}
        >
          <Trash2 size={14} /> Clear
        </button>
        {startImage && (
          <button type="button" onClick={startImageOnCanvas} title="Paint over the image on screen in Create">
            <ImageIcon size={14} /> Start from image
          </button>
        )}
      </div>
      <div className="live-panes">
        <div className="live-pane">
          <canvas
            ref={canvas}
            width={size.width}
            height={size.height}
            style={{ aspectRatio: `${size.width} / ${size.height}` }}
            className={tool === 'eraser' ? 'erasing' : ''}
            onPointerDown={event => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              remember();
              const point = at(event);
              stroke.current = { pointer: event.pointerId, ...point };
              line(point, point, event.pressure);
              window.clearTimeout(timer.current);
            }}
            onPointerMove={event => {
              if (stroke.current?.pointer !== event.pointerId) return;
              const point = at(event);
              line(stroke.current, point, event.pressure);
              stroke.current = { ...stroke.current, ...point };
            }}
            onPointerUp={event => {
              if (stroke.current?.pointer !== event.pointerId) return;
              stroke.current = null;
              schedule();
            }}
            onPointerCancel={() => {
              stroke.current = null;
            }}
          />
        </div>
        <div className="live-pane live-result">
          {shown || latestRecord ? (
            <img src={shown ?? latestRecord!.imageUrl} alt="Live result" />
          ) : (
            <p className="muted">Each stroke is redrawn here by the engine in a few seconds.</p>
          )}
          {working && <span className="live-spinner" aria-hidden="true" />}
        </div>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <footer className="live-bottom">
        <textarea
          rows={2}
          value={prompt}
          aria-label="Prompt"
          placeholder="Describe the picture"
          onChange={event => {
            setPrompt(event.target.value);
            schedule(700);
          }}
        />
        <label className="live-strength" title="How much the engine may change your sketch">
          <span>
            Change <b>{Math.round(strength * 100)}%</b>
          </span>
          <input
            type="range"
            min={0.2}
            max={0.95}
            step={0.05}
            value={strength}
            onChange={event => {
              setStrength(Number(event.target.value));
              schedule(500);
            }}
          />
        </label>
        <button
          type="button"
          title="Try a different seed"
          onClick={() => {
            setSeed(randomSeed());
            schedule(50);
          }}
        >
          <Shuffle size={14} /> New seed
        </button>
        <button type="button" aria-pressed={auto} onClick={() => setAuto(value => !value)}>
          {auto ? <Pause size={14} /> : <Play size={14} />} {auto ? 'Live' : 'Paused'}
        </button>
        {!auto && (
          <button type="button" className="primary" onClick={() => void send()}>
            Draw now
          </button>
        )}
      </footer>
    </div>
  );
}

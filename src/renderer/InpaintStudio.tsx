import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  Dices,
  Eraser,
  FlipHorizontal2,
  ImagePlus,
  LoaderCircle,
  MousePointerClick,
  Paintbrush,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { droppedImage, imageDropProps, sourceFromDrop, startRecordDrag, type DroppedImage } from './image-drag';
import { isImageJob, type AppSnapshot, type GenerationDraft, type GenerationRecord } from '../shared/types';
import type { SourceImageAsset } from '../shared/source-types';
import { DEFAULT_DRAFT, SAMPLERS, SCHEDULERS } from '../shared/defaults';
import {
  DEFAULT_INPAINT_STUDIO,
  INPAINT_LIMITS,
  inpaintStudioSettingsSchema,
  inpaintWorkingSize,
  looksLikeInpaintModel,
  type InpaintStudioSettings,
} from '../shared/inpaint-studio';
import { draftSchema } from '../shared/validation';
import { actionErrorMessage as errorMessage } from '../shared/action-error';
import { CompareImage } from './CompareImage';
import { EditPaint, type EditPaintHandle, type PaintTool } from './EditPaint';
import { Popover } from './EditPopover';
import { Notice } from './ui';
import { ModelArtwork, ModelPicker, modelDisplayName } from './ModelPicker';
import './edit-page.css';
import './inpaint-studio.css';

export interface InpaintStudioProps {
  snapshot: AppSnapshot;
  onSnapshot?: (snapshot: AppSnapshot) => void;
  /** Create's current setup: the starting checkpoint, LoRAs and prompt. */
  createDraft: GenerationDraft;
  /** A picture to start from (dropped on Edit, or sent from Create or the Library). */
  dropped?: DroppedImage;
  onDroppedUsed?: () => void;
}

/** What the studio remembers between visits. */
interface StudioState {
  sourceId?: string;
  prompt: string;
  negativePrompt: string;
  checkpointId: string;
  loras: GenerationDraft['loras'];
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: string;
  denoise: number;
  tries: number;
  settings: InpaintStudioSettings;
}
const STORE_KEY = 'latent.inpaint-studio';
const sourceUrl = (id: string) => `latent-asset://source/${encodeURIComponent(id)}`;
const maskUrl = (id: string) => `latent-asset://mask/${encodeURIComponent(id)}`;

function fromCreate(draft: GenerationDraft): StudioState {
  return {
    prompt: draft.prompt,
    negativePrompt: draft.negativePrompt,
    checkpointId: draft.imageModel ? '' : draft.checkpointId,
    loras: draft.imageModel ? [] : structuredClone(draft.loras),
    steps: draft.imageModel ? DEFAULT_DRAFT.steps : draft.steps,
    cfg: draft.imageModel ? DEFAULT_DRAFT.cfg : draft.cfg,
    sampler: draft.imageModel ? DEFAULT_DRAFT.sampler : draft.sampler,
    scheduler: draft.imageModel ? DEFAULT_DRAFT.scheduler : draft.scheduler,
    seed: 'random',
    denoise: 0.75,
    tries: 2,
    settings: { ...DEFAULT_INPAINT_STUDIO },
  };
}
function loadState(createDraft: GenerationDraft): StudioState {
  const base = fromCreate(createDraft);
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<StudioState>;
    const settings = inpaintStudioSettingsSchema.safeParse({ ...DEFAULT_INPAINT_STUDIO, ...saved.settings });
    return {
      ...base,
      ...saved,
      checkpointId: saved.checkpointId || base.checkpointId,
      settings: settings.success ? settings.data : base.settings,
    };
  } catch {
    return base;
  }
}

/** One click sets up a common job. */
const QUICK: Array<{ label: string; patch: Partial<StudioState>; settings?: Partial<InpaintStudioSettings> }> = [
  {
    label: 'Remove object',
    patch: { denoise: 1, prompt: 'empty background, nothing there' },
    settings: { fill: 'blur', grow: 12, blur: 16, soft: false },
  },
  { label: 'Fix face', patch: { denoise: 0.45 }, settings: { area: 'painted', padding: 64, fill: 'keep', soft: true } },
  {
    label: 'Fix hands',
    patch: { denoise: 0.55 },
    settings: { area: 'painted', padding: 96, fill: 'keep', soft: true },
  },
  { label: 'Add detail', patch: { denoise: 0.3 }, settings: { area: 'painted', fill: 'keep', soft: true } },
  { label: 'Replace it', patch: { denoise: 1 }, settings: { fill: 'blank', grow: 8, blur: 8, soft: false } },
];
const FILL: Array<{ value: InpaintStudioSettings['fill']; label: string; detail: string }> = [
  { value: 'keep', label: 'Keep what is there', detail: 'Best for fixes' },
  { value: 'blur', label: 'Blur it first', detail: 'Removing things' },
  { value: 'blank', label: 'Start blank', detail: 'Something new' },
];
const fillLabel = (value: InpaintStudioSettings['fill']) =>
  value === 'keep' ? 'Keep' : value === 'blur' ? 'Blur first' : 'Blank';

export function InpaintStudio({ snapshot, onSnapshot, createDraft, dropped, onDroppedUsed }: InpaintStudioProps) {
  const [state, setState] = useState<StudioState>(() => loadState(createDraft));
  const [source, setSource] = useState<SourceImageAsset>();
  const [picked, setPicked] = useState<string>();
  const [view, setView] = useState<'after' | 'before'>('after');
  const [compare, setCompare] = useState<GenerationRecord>();
  const [menu, setMenu] = useState<string>();
  const [tool, setTool] = useState<PaintTool>('brush');
  const [brush, setBrush] = useState(46);
  const [painted, setPainted] = useState(false);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState('');
  const [dropOver, setDropOver] = useState(false);
  const [fit, setFit] = useState({ width: 0, height: 0 });
  /** Zoom and pan of the picture: scale, then offset in screen pixels from the centre. */
  const [zoom, setZoom] = useState({ scale: 1, x: 0, y: 0 });
  const [picker, setPicker] = useState<'checkpoint' | 'lora'>();
  const [assistNote, setAssistNote] = useState('');
  const pan = useRef<{ id: number; x: number; y: number; from: { x: number; y: number } }>(undefined);
  const spaceHeld = useRef(false);
  const [lastBatch, setLastBatch] = useState<string[]>([]);
  const paint = useRef<EditPaintHandle>(null);
  const canvasArea = useRef<HTMLDivElement>(null);
  const live = useRef(snapshot);
  live.current = snapshot;
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const settings = state.settings;

  const edit = (patch: Partial<StudioState>) => setState(value => ({ ...value, ...patch }));
  const tune = (patch: Partial<InpaintStudioSettings>) =>
    setState(value => ({ ...value, settings: { ...value.settings, ...patch } }));
  useEffect(() => {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, sourceId: source?.id }));
    } catch {
      /* Remembering is a convenience only. */
    }
  }, [state, source?.id]);

  // Reopen the last picture when it is still saved.
  useEffect(() => {
    if (source || dropped) return;
    const found = snapshot.sourceImages.sources.find(item => item.id === state.sourceId);
    if (found) setSource(found);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.sourceImages.sources]);

  async function action(key: string, task: () => Promise<void>) {
    if (pending[key]) return;
    setPending(value => ({ ...value, [key]: true }));
    setError('');
    try {
      await task();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(value => ({ ...value, [key]: false }));
    }
  }
  function pickSource(next: SourceImageAsset) {
    setSource(next);
    setZoom({ scale: 1, x: 0, y: 0 });
    setPicked(undefined);
    setView('after');
    paint.current?.clear();
  }
  const startFrom = (load: () => Promise<SourceImageAsset | null | undefined>) =>
    action('source', async () => {
      const next = await load();
      if (!next) return;
      pickSource(next);
      onSnapshot?.(await window.latent.getSnapshot());
    });
  useEffect(() => {
    if (!dropped) return;
    onDroppedUsed?.();
    void startFrom(() => sourceFromDrop(dropped));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dropped]);

  const checkpoints = snapshot.models.filter(model => model.kind === 'checkpoint' && model.status === 'ready');
  const loraAssets = snapshot.models.filter(model => model.kind === 'lora' && model.status === 'ready');
  const checkpoint = checkpoints.find(model => model.id === state.checkpointId);
  const activeLoras = state.loras.filter(lora => !lora.off);
  // Inpaint checkpoints are found by name, and can be set by hand in the Model panel.
  useEffect(() => {
    if (checkpoint) tune({ inpaintModel: looksLikeInpaintModel(`${checkpoint.name} ${checkpoint.filename}`) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkpoint?.id]);

  // Results made from this picture, newest first.
  const results = useMemo(
    () =>
      source
        ? snapshot.history.filter(
            record => record.draft.imageInput?.studio && record.imageInput?.source.id === source.id,
          )
        : [],
    [snapshot.history, source],
  );
  const working = snapshot.jobs
    .filter(isImageJob)
    .filter(
      job =>
        job.draft.imageInput?.studio &&
        job.draft.imageInput.sourceId === source?.id &&
        ['queued', 'running'].includes(job.status),
    );
  const failed = snapshot.jobs
    .filter(isImageJob)
    .filter(
      job => job.status === 'failed' && lastBatch.includes(job.id) && job.draft.imageInput?.sourceId === source?.id,
    );
  const shown = results.find(record => record.id === picked);
  // When a new result lands from the last run, show it.
  const newest = results[0]?.id;
  const seen = useRef<string | undefined>(newest);
  useEffect(() => {
    if (newest && newest !== seen.current && lastBatch.length) {
      const record = results[0];
      if (record && lastBatch.includes(record.jobId)) setPicked(record.id);
    }
    seen.current = newest;
  }, [newest, results, lastBatch]);

  const baseSize = source ? { width: source.normalized.width, height: source.normalized.height } : undefined;
  useLayoutEffect(() => {
    const area = canvasArea.current;
    if (!area || !baseSize) return;
    const measure = () => {
      const pad = 28;
      const width = Math.max(0, area.clientWidth - pad);
      const height = Math.max(0, area.clientHeight - pad);
      const scale = Math.min(width / baseSize.width, height / baseSize.height);
      setFit({ width: Math.floor(baseSize.width * scale), height: Math.floor(baseSize.height * scale) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [baseSize?.width, baseSize?.height]);

  const segmentationReady = ['ready', 'stopped', 'starting', 'segmenting'].includes(snapshot.segmentation?.state ?? '');
  const engineReady = snapshot.backend.state === 'ready';
  const busy = pending.source || pending.queue;
  const showingResult = Boolean(shown) && view === 'after';
  const tooBig = baseSize && Math.max(baseSize.width, baseSize.height) > INPAINT_LIMITS.maxSourceSide;
  const workSize = baseSize
    ? settings.area === 'whole'
      ? inpaintWorkingSize(baseSize.width, baseSize.height, settings.detail)
      : undefined
    : undefined;

  async function pickArea(x: number, y: number) {
    if (!source) return;
    await action('pick', async () => {
      const result = await window.latent.suggestMask({ sourceId: source.id, points: [{ x, y, label: 1 }] });
      await paint.current?.addMask(maskUrl(result.mask.id));
    });
  }
  async function keepGoing(record: GenerationRecord) {
    await startFrom(() => window.latent.useOutputAsSource(record.id));
  }
  async function inpaint() {
    if (!source || !checkpoint || !engineReady || busy) return;
    await action('queue', async () => {
      const png = await paint.current?.exportMask();
      if (!png) throw new Error('Paint over the part you want to change first.');
      const mask = await window.latent.saveSourceMask(source.id, png);
      const count = Math.max(1, Math.min(4, state.tries));
      const ids: string[] = [];
      for (let index = 0; index < count; index++) {
        const seed =
          state.seed !== 'random' && /^\d+$/.test(state.seed) ? String(BigInt(state.seed) + BigInt(index)) : 'random';
        const draft: GenerationDraft = {
          ...studioDraft(seed)!,
          imageInput: {
            mode: 'inpaint',
            sourceId: source.id,
            sourceSha256: source.normalized.sha256,
            maskId: mask.id,
            maskSha256: mask.sha256,
            denoise: state.denoise,
            resize: 'stretch',
            studio: { ...settings },
          },
        };
        const job = await window.latent.queueGeneration(draftSchema.parse(draft) as GenerationDraft);
        ids.push(job.id);
      }
      setLastBatch(ids);
      setView('after');
      onSnapshot?.(await window.latent.getSnapshot());
    });
  }

  const showCivitai = snapshot.settings.civitaiDisplayMetadata !== false;
  const nameOf = (model: (typeof snapshot.models)[number]) => modelDisplayName(model, showCivitai);
  const modelLabel = checkpoint
    ? `${nameOf(checkpoint)}${activeLoras.length ? ` + ${activeLoras.length} LoRA${activeLoras.length === 1 ? '' : 's'}` : ''}`
    : 'Pick one';
  // Why Inpaint can't run yet, shown on the button's tooltip so the dock never changes size.
  const blockedReason = !source
    ? 'Pick a picture first.'
    : !checkpoint
      ? 'Pick an SDXL model first.'
      : !painted
        ? 'Paint the part to change first.'
        : undefined;

  // Zoom with the mouse wheel around the pointer; pan with the middle or right button, or Space + drag.
  const zoomTo = (scale: number, around?: { x: number; y: number }) =>
    setZoom(value => {
      const next = Math.min(8, Math.max(1, scale));
      if (next === 1) return { scale: 1, x: 0, y: 0 };
      const point = around ?? { x: 0, y: 0 };
      return {
        scale: next,
        x: point.x - ((point.x - value.x) * next) / value.scale,
        y: point.y - ((point.y - value.y) * next) / value.scale,
      };
    });
  const fromCentre = (event: { clientX: number; clientY: number }) => {
    const rect = canvasArea.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 };
  };
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
    const down = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !typing(event.target)) {
        spaceHeld.current = true;
        event.preventDefault();
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === 'Space') spaceHeld.current = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  /** The setup the engine and the assistant both get. */
  function studioDraft(seed = 'random'): GenerationDraft | undefined {
    if (!checkpoint) return undefined;
    return {
      ...structuredClone(DEFAULT_DRAFT),
      family: checkpoint.family === 'illustrious' ? 'illustrious' : 'sdxl',
      checkpointId: checkpoint.id,
      loras: structuredClone(state.loras),
      prompt: state.prompt,
      negativePrompt: state.negativePrompt,
      steps: state.steps,
      cfg: state.cfg,
      sampler: state.sampler,
      scheduler: state.scheduler,
      seed,
      batchSize: 1,
      // The engine picks the real working size from the painted area.
      width: 1024,
      height: 1024,
      autoTriggers: createDraft.autoTriggers,
      triggerResolutionVersion: createDraft.triggerResolutionVersion ?? 'visible@3',
      ...(createDraft.triggerWords ? { triggerWords: structuredClone(createDraft.triggerWords) } : {}),
    };
  }
  const assistant = snapshot.assistant;
  async function askAssistant(kind: 'improve' | 'describe') {
    if (!source || !checkpoint) return;
    await action('assist', async () => {
      setAssistNote('');
      const draft = studioDraft();
      if (!draft) return;
      if (kind === 'improve' && !state.prompt.trim()) throw new Error('Type roughly what you want first.');
      const png = assistant?.vision ? await paint.current?.exportMask() : undefined;
      if (kind === 'describe' && !png) throw new Error('Paint the part to change first.');
      const mask = png ? await window.latent.saveSourceMask(source.id, png) : undefined;
      const reply = await window.latent.assistantSuggest({
        target: 'inpaint',
        action: kind,
        draft,
        checkpointName: nameOf(checkpoint),
        loraNames: activeLoras.flatMap(lora => {
          const asset = loraAssets.find(model => model.id === lora.modelId);
          return asset ? [nameOf(asset)] : [];
        }),
        inpaint: { strength: state.denoise, fill: settings.fill, area: settings.area },
        ...(mask ? { image: { kind: 'source' as const, id: source.id, maskId: mask.id } } : {}),
      });
      const option = reply.options[0];
      if (option?.prompt.trim())
        edit({ prompt: option.prompt.slice(0, 16000), negativePrompt: option.negativePrompt.slice(0, 16000) });
      setAssistNote(reply.message);
    });
  }

  const toolbar = (
    <div className="ed-toolbar">
      {shown ? (
        <>
          <button type="button" className="ed-btn" onClick={() => setPicked(undefined)}>
            <Paintbrush size={15} />
            Back to painting
          </button>
          <button type="button" className="ed-btn" disabled={busy} onClick={() => shown && void keepGoing(shown)}>
            <Pencil size={15} />
            Keep going from this
          </button>
        </>
      ) : (
        source && (
          <span className="ed-tools">
            {(
              [
                ['brush', 'Brush', Pencil],
                ['erase', 'Eraser', Eraser],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                type="button"
                key={value}
                className={tool === value ? 'on' : ''}
                title={label}
                aria-label={label}
                aria-pressed={tool === value}
                onClick={() => setTool(value)}
              >
                <Icon size={15} />
              </button>
            ))}
            <button
              type="button"
              className={tool === 'pick' ? 'on' : ''}
              title={
                segmentationReady
                  ? 'Auto pick: click a thing to paint it'
                  : 'Auto pick needs Smart select. Set it up in Create first.'
              }
              aria-label="Auto pick"
              aria-pressed={tool === 'pick'}
              disabled={!segmentationReady}
              onClick={() => setTool('pick')}
            >
              {pending.pick ? <LoaderCircle className="spin" size={15} /> : <MousePointerClick size={15} />}
            </button>
            <label className="ed-size">
              Brush
              <input
                type="range"
                min={8}
                max={180}
                value={brush}
                onChange={event => setBrush(Number(event.target.value))}
                aria-label="Brush size"
              />
              <span>{brush}</span>
            </label>
            <button
              type="button"
              title="Swap painted and unpainted"
              aria-label="Invert the paint"
              onClick={() => paint.current?.invert()}
            >
              <FlipHorizontal2 size={15} />
            </button>
            <button
              type="button"
              title="Clear the paint"
              aria-label="Clear the paint"
              onClick={() => paint.current?.clear()}
            >
              <Trash2 size={15} />
            </button>
          </span>
        )
      )}
      {source && !shown && (
        <span className="ed-hint">
          {painted ? (
            <>
              Only the <b>painted part</b> gets redrawn with your model.
            </>
          ) : (
            'Paint over the part you want to change.'
          )}
        </span>
      )}
      <span className="ed-spacer" />
      {shown && (
        <span className="ed-seg" role="group" aria-label="Compare">
          <button type="button" aria-pressed={view === 'after'} onClick={() => setView('after')}>
            After
          </button>
          <button type="button" aria-pressed={view === 'before'} onClick={() => setView('before')}>
            Before
          </button>
          <button type="button" onClick={() => setCompare(shown)}>
            <ArrowLeftRight size={14} />
            Slider
          </button>
        </span>
      )}
    </div>
  );

  const stage = (
    <section className="ed-stage">
      {toolbar}
      <div
        ref={canvasArea}
        className={`ed-canvas ${dropOver ? 'drop-over' : ''} ${zoom.scale > 1 ? 'ip-zoomed' : ''}`}
        onWheel={event => {
          if (!source) return;
          zoomTo(zoom.scale * Math.exp(-event.deltaY * 0.0015), fromCentre(event));
        }}
        onPointerDownCapture={event => {
          if (!source || !(event.button === 1 || event.button === 2 || spaceHeld.current)) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY, from: { x: zoom.x, y: zoom.y } };
        }}
        onPointerMoveCapture={event => {
          const start = pan.current;
          if (!start || start.id !== event.pointerId) return;
          event.stopPropagation();
          setZoom(value => ({
            ...value,
            x: start.from.x + event.clientX - start.x,
            y: start.from.y + event.clientY - start.y,
          }));
        }}
        onPointerUpCapture={event => {
          if (pan.current?.id === event.pointerId) {
            pan.current = undefined;
            event.stopPropagation();
          }
        }}
        onContextMenu={event => event.preventDefault()}
        {...imageDropProps(
          setDropOver,
          transfer => {
            const drop = droppedImage(transfer, snapshot.history);
            if (drop) void startFrom(() => sourceFromDrop(drop));
            else setError('Drop a PNG, JPG or WebP picture.');
          },
          busy,
        )}
      >
        {!source ? (
          <div className="ed-empty">
            <strong>Inpaint with your own model</strong>
            <p>Paint a spot, describe it, and your SDXL model and LoRAs redraw just that part.</p>
            {snapshot.history.length > 0 && (
              <div className="ed-recent" aria-label="Recent pictures">
                {snapshot.history
                  .filter(record => record.imageUrl)
                  .slice(0, 8)
                  .map(record => (
                    <button
                      type="button"
                      key={record.id}
                      title="Inpaint this picture"
                      disabled={busy}
                      draggable
                      onDragStart={event => startRecordDrag(event, record)}
                      onClick={() => void startFrom(() => window.latent.useOutputAsSource(record.id))}
                    >
                      <img src={record.imageUrl} alt="" />
                    </button>
                  ))}
              </div>
            )}
            <div className="ed-row">
              <button
                type="button"
                className="ed-btn"
                disabled={busy}
                onClick={() => void startFrom(() => window.latent.importSourceImage())}
              >
                <ImagePlus size={15} />
                Import picture
              </button>
            </div>
          </div>
        ) : (
          <div
            className="ed-frame"
            style={{
              width: fit.width,
              height: fit.height,
              transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
            }}
          >
            <img
              src={showingResult ? shown!.imageUrl : sourceUrl(source.id)}
              alt={showingResult ? 'Result' : 'Picture'}
            />
            <div className={shown ? 'ip-paint-hidden' : undefined}>
              <EditPaint
                ref={paint}
                width={source.normalized.width}
                height={source.normalized.height}
                tool={tool}
                brush={brush}
                onPaintedChange={setPainted}
                onPick={(x, y) => void pickArea(x, y)}
              />
            </div>
          </div>
        )}
        {source && baseSize && (
          <div className="ed-corner tr">
            <span className="ed-pill">
              {baseSize.width} × {baseSize.height}
            </span>
          </div>
        )}
        {source && (
          <div className="ed-corner br ip-zoom">
            <button type="button" aria-label="Zoom out" onClick={() => zoomTo(zoom.scale / 1.25)}>
              <ZoomOut size={14} />
            </button>
            <button
              type="button"
              title="Fit the picture (wheel to zoom, middle or right drag, or Space + drag, to move)"
              onClick={() => setZoom({ scale: 1, x: 0, y: 0 })}
            >
              {zoom.scale === 1 ? 'Fit' : `${Math.round(zoom.scale * 100)}%`}
            </button>
            <button type="button" aria-label="Zoom in" onClick={() => zoomTo(zoom.scale * 1.25)}>
              <ZoomIn size={14} />
            </button>
          </div>
        )}
        {shown && (
          <div className="ed-corner bl">
            <span className="ed-pill acc">
              {view === 'before' ? 'Before' : `Try ${results.length - results.indexOf(shown)}`} · strength{' '}
              {Math.round((shown.draft.imageInput?.denoise ?? 0) * 100)}%
            </span>
          </div>
        )}
        {tooBig && (
          <p className="ed-corner tl ed-error">
            Inpaint works on pictures up to {INPAINT_LIMITS.maxSourceSide} pixels per side.
          </p>
        )}
      </div>
      {error && <Notice error>{error}</Notice>}
      <div className="ed-dock">
        {assistNote && (
          <p className="ip-note">
            <Sparkles size={13} />
            <span>{assistNote}</span>
            <button type="button" className="ed-icon" aria-label="Dismiss" onClick={() => setAssistNote('')}>
              <X size={13} />
            </button>
          </p>
        )}
        <div className="ed-quick" role="group" aria-label="Quick setups">
          {QUICK.map(item => (
            <button
              type="button"
              key={item.label}
              className="ed-chip"
              disabled={!source}
              onClick={() =>
                setState(value => ({
                  ...value,
                  ...item.patch,
                  prompt: item.patch.prompt ?? value.prompt,
                  settings: { ...value.settings, ...item.settings },
                }))
              }
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="ip-write">
          <div className="ed-text">
            <textarea
              aria-label="What should the painted part show?"
              value={state.prompt}
              maxLength={16000}
              rows={2}
              placeholder="What should the painted part show? For example: a red wool scarf"
              onChange={event => edit({ prompt: event.target.value })}
            />
            <span className="ip-assist">
              <button
                type="button"
                className="ed-chip"
                disabled={
                  !source || !checkpoint || pending.assist || !assistant?.ready || !assistant.vision || !painted
                }
                title={
                  !assistant?.ready
                    ? (assistant?.reason ?? 'Set up the assistant in Settings first.')
                    : !assistant.vision
                      ? 'The assistant needs a model that can see pictures for this. Pick one in Settings.'
                      : 'The assistant looks at the painted part and writes a prompt for it'
                }
                onClick={() => void askAssistant('describe')}
              >
                {pending.assist ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
                Fill in for me
              </button>
              <button
                type="button"
                className="ed-chip"
                disabled={!source || !checkpoint || pending.assist || !assistant?.ready || !state.prompt.trim()}
                title={
                  assistant?.ready
                    ? 'The assistant rewrites this for just the painted part, in the way your model likes'
                    : (assistant?.reason ?? 'Set up the assistant in Settings first.')
                }
                onClick={() => void askAssistant('improve')}
              >
                <Sparkles size={13} />
                Tidy up
              </button>
            </span>
          </div>
          <textarea
            aria-label="Things to avoid"
            value={state.negativePrompt}
            maxLength={16000}
            rows={2}
            placeholder="Things to avoid"
            onChange={event => edit({ negativePrompt: event.target.value })}
          />
        </div>
        <div className="ed-run ip-run">
          <span className="ed-anchor">
            <button
              type="button"
              className="ed-chip set ip-model-chip"
              aria-expanded={menu === 'model'}
              onClick={() => setMenu(menu === 'model' ? undefined : 'model')}
            >
              <em>Model</em> <span>{modelLabel}</span> <ChevronDown size={13} />
            </button>
            <Popover open={menu === 'model'} onClose={closeMenu} className="ed-menu ed-tune ip-model">
              <div className="ip-pick">
                <span className="ip-thumb big">
                  {checkpoint && (
                    <ModelArtwork model={checkpoint} history={snapshot.history} showCivitai={showCivitai} />
                  )}
                </span>
                <span>
                  <small>SDXL model</small>
                  <b title={checkpoint?.filename}>{checkpoint ? nameOf(checkpoint) : 'None picked'}</b>
                </span>
                <button
                  type="button"
                  className="ed-btn"
                  onClick={() => {
                    setMenu(undefined);
                    setPicker('checkpoint');
                  }}
                >
                  {checkpoint ? 'Change' : 'Pick'}
                </button>
              </div>
              <label className="ed-check">
                <input
                  type="checkbox"
                  checked={settings.inpaintModel}
                  onChange={event => tune({ inpaintModel: event.target.checked })}
                />
                <span>
                  This is an inpaint model
                  <small>Made for inpainting. Usually has "inpaint" in its name.</small>
                </span>
              </label>
              <div className="ip-loras">
                <span className="ip-label">LoRAs</span>
                {state.loras.length === 0 && <small className="ip-muted">None. Add one below.</small>}
                {state.loras.map((lora, index) => {
                  const asset = loraAssets.find(model => model.id === lora.modelId);
                  return (
                    <div key={lora.modelId} className={`ip-lora ${lora.off ? 'off' : ''}`}>
                      <input
                        type="checkbox"
                        aria-label={`Use ${asset ? nameOf(asset) : 'this LoRA'}`}
                        checked={!lora.off}
                        onChange={event =>
                          edit({
                            loras: state.loras.map((item, at) =>
                              at === index ? { ...item, off: event.target.checked ? undefined : true } : item,
                            ),
                          })
                        }
                      />
                      <span className="ip-thumb">
                        {asset && <ModelArtwork model={asset} history={snapshot.history} showCivitai={showCivitai} />}
                      </span>
                      <span title={asset?.filename ?? lora.modelId}>{asset ? nameOf(asset) : 'Missing LoRA'}</span>
                      <input
                        type="range"
                        min={-2}
                        max={2}
                        step={0.05}
                        value={lora.weight}
                        aria-label="Weight"
                        onChange={event => {
                          const weight = Number(event.target.value);
                          edit({
                            loras: state.loras.map((item, at) =>
                              at === index ? { ...item, weight, clipWeight: weight } : item,
                            ),
                          });
                        }}
                      />
                      <b>{lora.weight.toFixed(2)}</b>
                      <button
                        type="button"
                        className="ed-icon"
                        aria-label="Remove"
                        onClick={() => edit({ loras: state.loras.filter((_, at) => at !== index) })}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  className="ed-btn ip-add"
                  onClick={() => {
                    setMenu(undefined);
                    setPicker('lora');
                  }}
                >
                  <Plus size={14} />
                  Add a LoRA
                </button>
              </div>
              <button
                type="button"
                className="ed-btn"
                onClick={() => {
                  const next = fromCreate(createDraft);
                  edit({
                    checkpointId: next.checkpointId || state.checkpointId,
                    loras: next.loras,
                    prompt: next.prompt,
                    negativePrompt: next.negativePrompt,
                    steps: next.steps,
                    cfg: next.cfg,
                    sampler: next.sampler,
                    scheduler: next.scheduler,
                  });
                }}
              >
                <Undo2 size={14} />
                Copy from Create
              </button>
            </Popover>
          </span>
          <span className="ed-anchor">
            <button
              type="button"
              className="ed-chip set"
              aria-expanded={menu === 'strength'}
              onClick={() => setMenu(menu === 'strength' ? undefined : 'strength')}
            >
              <em>Strength</em> {Math.round(state.denoise * 100)}% <ChevronDown size={13} />
            </button>
            <Popover open={menu === 'strength'} onClose={closeMenu} className="ed-menu ed-tune">
              <label>
                Strength · {Math.round(state.denoise * 100)}%
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.01}
                  value={state.denoise}
                  onChange={event => edit({ denoise: Number(event.target.value) })}
                />
              </label>
              <small className="ip-muted">
                Low keeps the shape and colours and just cleans up. High redraws the spot from scratch.
              </small>
            </Popover>
          </span>
          <span className="ed-anchor">
            <button
              type="button"
              className="ed-chip set"
              aria-expanded={menu === 'edge'}
              onClick={() => setMenu(menu === 'edge' ? undefined : 'edge')}
            >
              <em>Edge</em> {settings.grow >= 0 ? '+' : ''}
              {settings.grow}, soft {settings.blur} <ChevronDown size={13} />
            </button>
            <Popover open={menu === 'edge'} onClose={closeMenu} className="ed-menu ed-tune">
              <label>
                Grow the paint · {settings.grow} px
                <input
                  type="range"
                  min={INPAINT_LIMITS.minGrow}
                  max={INPAINT_LIMITS.maxGrow}
                  value={settings.grow}
                  onChange={event => tune({ grow: Number(event.target.value) })}
                />
              </label>
              <label>
                Soften the edge · {settings.blur} px
                <input
                  type="range"
                  min={0}
                  max={INPAINT_LIMITS.maxBlur}
                  value={settings.blur}
                  onChange={event => tune({ blur: Number(event.target.value) })}
                />
              </label>
              <label className="ed-check">
                <input
                  type="checkbox"
                  checked={settings.soft}
                  onChange={event => tune({ soft: event.target.checked })}
                />
                <span>
                  Gentle blend
                  <small>The soft edge also changes less, so seams vanish. Uses differential diffusion.</small>
                </span>
              </label>
            </Popover>
          </span>
          <span className="ed-anchor">
            <button
              type="button"
              className="ed-chip set"
              aria-expanded={menu === 'area'}
              onClick={() => setMenu(menu === 'area' ? undefined : 'area')}
            >
              <em>Area</em> {settings.area === 'painted' ? 'Up close' : 'Whole picture'} <ChevronDown size={13} />
            </button>
            <Popover open={menu === 'area'} onClose={closeMenu} className="ed-menu ed-tune">
              <span className="ed-seg ip-wide" role="group" aria-label="Area">
                <button
                  type="button"
                  aria-pressed={settings.area === 'painted'}
                  onClick={() => tune({ area: 'painted' })}
                >
                  Up close
                </button>
                <button type="button" aria-pressed={settings.area === 'whole'} onClick={() => tune({ area: 'whole' })}>
                  Whole picture
                </button>
              </span>
              <small className="ip-muted">
                {settings.area === 'painted'
                  ? 'Zooms in on the paint and works on it at full detail, then puts it back.'
                  : `The whole picture is worked at ${workSize ? `${workSize.width} × ${workSize.height}` : 'about 1 MP'}, then only the paint is kept.`}
              </small>
              {settings.area === 'painted' && (
                <label>
                  Room around the paint · {settings.padding} px
                  <input
                    type="range"
                    min={0}
                    max={INPAINT_LIMITS.maxPadding}
                    step={8}
                    value={settings.padding}
                    onChange={event => tune({ padding: Number(event.target.value) })}
                  />
                </label>
              )}
              <label className="ed-check">
                <input
                  type="checkbox"
                  checked={settings.detail === 'high'}
                  onChange={event => tune({ detail: event.target.checked ? 'high' : 'standard' })}
                />
                <span>
                  Extra detail
                  <small>Works at about 1.6 MP instead of 1 MP. A bit slower.</small>
                </span>
              </label>
            </Popover>
          </span>
          <span className="ed-anchor">
            <button
              type="button"
              className="ed-chip set"
              aria-expanded={menu === 'fill'}
              onClick={() => setMenu(menu === 'fill' ? undefined : 'fill')}
            >
              <em>Fill</em> {fillLabel(settings.fill)} <ChevronDown size={13} />
            </button>
            <Popover open={menu === 'fill'} onClose={closeMenu} className="ed-menu">
              {FILL.map(item => (
                <button
                  type="button"
                  key={item.value}
                  aria-pressed={settings.fill === item.value}
                  disabled={settings.inpaintModel && item.value !== 'keep'}
                  onClick={() => {
                    tune({ fill: item.value });
                    setMenu(undefined);
                  }}
                >
                  {item.label}
                  <small>{item.detail}</small>
                </button>
              ))}
            </Popover>
          </span>
          <span className="ed-anchor">
            <button
              type="button"
              className="ed-chip set"
              aria-expanded={menu === 'tries'}
              onClick={() => setMenu(menu === 'tries' ? undefined : 'tries')}
            >
              <em>Tries</em> {state.tries} <ChevronDown size={13} />
            </button>
            <Popover open={menu === 'tries'} onClose={closeMenu} className="ed-menu ed-menu-row">
              {[1, 2, 3, 4].map(count => (
                <button
                  type="button"
                  key={count}
                  aria-pressed={state.tries === count}
                  onClick={() => {
                    edit({ tries: count });
                    setMenu(undefined);
                  }}
                >
                  {count}
                </button>
              ))}
            </Popover>
          </span>
          <span className="ed-anchor">
            <button
              type="button"
              className="ed-chip set"
              aria-expanded={menu === 'tune'}
              onClick={() => setMenu(menu === 'tune' ? undefined : 'tune')}
            >
              <em>Tune</em> {state.steps} steps, CFG {state.cfg} <ChevronRight size={13} />
            </button>
            <Popover open={menu === 'tune'} onClose={closeMenu} className="ed-menu ed-tune">
              <div className="ip-pair">
                <label>
                  Steps
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={state.steps}
                    onChange={event => edit({ steps: Math.max(1, Math.min(100, Number(event.target.value) || 1)) })}
                  />
                </label>
                <label>
                  CFG
                  <input
                    type="number"
                    min={0}
                    max={30}
                    step={0.5}
                    value={state.cfg}
                    onChange={event => edit({ cfg: Math.max(0, Math.min(30, Number(event.target.value) || 0)) })}
                  />
                </label>
              </div>
              <div className="ip-pair">
                <label>
                  Sampler
                  <select value={state.sampler} onChange={event => edit({ sampler: event.target.value })}>
                    {SAMPLERS.map(name => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Scheduler
                  <select value={state.scheduler} onChange={event => edit({ scheduler: event.target.value })}>
                    {SCHEDULERS.map(name => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                Seed
                <span className="ed-inline">
                  <input
                    value={state.seed}
                    maxLength={20}
                    onChange={event => edit({ seed: event.target.value.trim() || 'random' })}
                  />
                  <button
                    type="button"
                    className="ed-icon"
                    aria-label="Use a random seed"
                    title="Random"
                    onClick={() => edit({ seed: 'random' })}
                  >
                    <Dices size={15} />
                  </button>
                </span>
              </label>
            </Popover>
          </span>
          <span className="ed-go">
            {!engineReady ? (
              <button
                type="button"
                className="ed-primary"
                disabled={pending.start || !['stopped', 'error'].includes(snapshot.backend.state)}
                onClick={() => void action('start', () => window.latent.startBackend())}
              >
                <Play size={16} />
                Start the engine
              </button>
            ) : (
              <button
                type="button"
                className="ed-primary"
                disabled={!source || !checkpoint || !painted || busy || Boolean(tooBig)}
                title={blockedReason}
                onClick={() => void inpaint()}
              >
                {pending.queue ? <LoaderCircle className="spin" size={16} /> : <Paintbrush size={16} />}
                Inpaint{state.tries > 1 ? ` · ${state.tries} tries` : ''}
              </button>
            )}
          </span>
        </div>
      </div>
    </section>
  );

  const side = (
    <aside className="ed-side" aria-label="Tries">
      <header>
        <strong>Tries</strong>
        <small>{source ? `${results.length} from this picture` : 'Pick a picture'}</small>
      </header>
      <div className="ed-steps">
        {working.map((job, index) => (
          <div key={job.id} className="ed-step run" aria-live="polite">
            <span className="ed-step-wait">
              <LoaderCircle className="spin" size={18} />
            </span>
            <span>
              <b>{job.status === 'running' ? 'Working…' : 'Waiting'}</b>
              <small>
                Try {results.length + working.length - index} · strength{' '}
                {Math.round((job.draft.imageInput?.denoise ?? 0) * 100)}%
              </small>
              {job.status === 'running' && (
                <span className="ed-bar">
                  <i style={{ width: `${Math.round((job.progress / Math.max(1, job.progressMax)) * 100)}%` }} />
                </span>
              )}
            </span>
          </div>
        ))}
        {failed.map(job => (
          <div key={job.id} className="ed-step failed">
            <span className="ed-step-wait">
              <X size={18} />
            </span>
            <span>
              <b>That try failed</b>
              <small>{job.error ?? 'Something went wrong in the engine.'}</small>
            </span>
          </div>
        ))}
        {results.map((record, index) => (
          <button
            type="button"
            key={record.id}
            className={`ed-step ${record.id === picked ? 'sel' : ''}`}
            draggable
            onDragStart={event => startRecordDrag(event, record)}
            onClick={() => {
              setPicked(record.id === picked ? undefined : record.id);
              setView('after');
            }}
          >
            <img src={record.imageUrl} alt="" />
            <span>
              <b>{record.draft.prompt || 'No prompt'}</b>
              <small>
                <em className="tag acc">Try {results.length - index}</em>
                <em className="tag">{Math.round((record.draft.imageInput?.denoise ?? 0) * 100)}%</em>
                <em className="tag">{record.draft.imageInput?.studio?.area === 'whole' ? 'Whole' : 'Up close'}</em>
              </small>
            </span>
          </button>
        ))}
        {source && !results.length && !working.length && (
          <p className="ip-muted ip-empty-side">Your tries show up here. Click one to see it on the picture.</p>
        )}
      </div>
      {source && (
        <footer>
          <button
            type="button"
            className="ed-btn"
            disabled={busy || !shown}
            onClick={() => shown && void keepGoing(shown)}
          >
            <Pencil size={15} />
            Keep going
          </button>
          <button
            type="button"
            className="ed-btn"
            disabled={busy}
            onClick={() => void startFrom(() => window.latent.importSourceImage())}
          >
            <ImagePlus size={15} />
            New picture
          </button>
        </footer>
      )}
    </aside>
  );

  return (
    <div
      className="ed-root"
      onKeyDown={event => {
        if (!event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
          event.preventDefault();
          if (!compare) void inpaint();
        }
      }}
    >
      <section className="ed" aria-label="Inpaint">
        {stage}
        {side}
      </section>
      {picker && (
        <ModelPicker
          snapshot={snapshot}
          kind={picker}
          family={checkpoint?.family}
          selectedIds={picker === 'checkpoint' ? [state.checkpointId] : state.loras.map(lora => lora.modelId)}
          onUpdated={onSnapshot}
          onClose={() => setPicker(undefined)}
          onChoose={model => {
            if (picker === 'checkpoint') edit({ checkpointId: model.id });
            else if (!state.loras.some(lora => lora.modelId === model.id))
              edit({ loras: [...state.loras, { modelId: model.id, weight: 0.8, clipWeight: 0.8 }] });
            setPicker(undefined);
          }}
        />
      )}
      {compare && source && (
        <CompareImage
          before={{
            url: sourceUrl(source.id),
            label: 'Before',
            width: source.normalized.width,
            height: source.normalized.height,
          }}
          after={{ url: compare.imageUrl, label: 'After', width: compare.width, height: compare.height }}
          alignment="stretch"
          onClose={() => setCompare(undefined)}
        />
      )}
    </div>
  );
}

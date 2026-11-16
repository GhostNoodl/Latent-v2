import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ImagePlus, X } from 'lucide-react';
import type { SourceImageAsset } from '../shared/source-types';
import type { VideoAvailability, VideoDraft, VideoSpeed } from '../shared/video-types';
import { resolveVideoDuration, textOnGpu, videoDraftSchema } from '../shared/video-plan';
import { videoProfileReady } from '../shared/video-assets';
import { formatDuration } from './video-url';

export const VIDEO_SIZES = [
  { width: 832, height: 480, label: 'Wide' },
  { width: 1024, height: 576, label: 'Wide' },
  { width: 1344, height: 768, label: 'Wide, largest' },
  { width: 480, height: 832, label: 'Tall' },
  { width: 576, height: 1024, label: 'Tall' },
  { width: 768, height: 1344, label: 'Tall, largest' },
  { width: 768, height: 768, label: 'Square' },
  { width: 960, height: 960, label: 'Square, largest' },
] as const;
const LENGTHS = [5, 6, 8, 10, 12, 15];
const QUALITY: { profile: VideoDraft['profile']; label: string; hint: string }[] = [
  { profile: 'fused4', label: 'Fast', hint: '4 steps' },
  { profile: 'turbo8', label: 'Better', hint: '8 steps' },
  { profile: 'base', label: 'Best', hint: '20 steps' },
];
export const qualityName = (profile: VideoDraft['profile']) => QUALITY.find(item => item.profile === profile)!;

type Panel = 'speed' | 'length' | 'size' | 'seed' | 'firstFrame' | 'lastFrame';

function Seg<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean; title?: string }[];
  disabled?: boolean;
  onChange(value: T): void;
}) {
  return (
    <div className="vp-field">
      <span className="vp-label">{label}</span>
      <div className="vp-seg" role="group" aria-label={label}>
        {options.map(option => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            disabled={disabled || option.disabled}
            title={option.title}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
function Switch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="vp-switch-row toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        className="toggle"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
      />
    </label>
  );
}

export interface VideoDockProps {
  draft: VideoDraft;
  status: VideoAvailability;
  sources: readonly SourceImageAsset[];
  busy: boolean;
  estimateMs?: number;
  selectedImageAvailable: boolean;
  lastSeed?: string;
  onChange(draft: VideoDraft): void;
  onImportSource(role: 'firstFrame' | 'lastFrame'): void;
  onUseSelectedImage(role: 'firstFrame' | 'lastFrame'): void;
  onInstallSol(): void;
  solBusy: boolean;
  onGenerate(): void;
}

/** The floating prompt dock: what happens, the start frames, and the chips that open small panels. */
export function VideoDock(props: VideoDockProps) {
  const { draft, status, busy, onChange } = props;
  const [open, setOpen] = useState<Panel>();
  const dock = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!dock.current?.contains(event.target as Node)) setOpen(undefined);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(undefined);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const update = (patch: Partial<VideoDraft>) => onChange({ ...draft, ...patch });
  const speed = (patch: Partial<VideoSpeed>) => update({ speed: { ...draft.speed, ...patch } });
  const toggle = (panel: Panel) => setOpen(current => (current === panel ? undefined : panel));
  const parsed = videoDraftSchema.safeParse(draft);
  const filesReady = videoProfileReady(status.assets, draft.profile);
  let frames = 0;
  try {
    frames = resolveVideoDuration(draft.requestedDurationSeconds).frames;
  } catch {
    /* half-typed length */
  }
  const problem = !draft.prompt.trim()
    ? 'Describe what happens first.'
    : draft.mode === 'img2vid' && !draft.firstFrame && !draft.lastFrame
      ? 'Pick a first or last frame.'
      : !parsed.success
        ? parsed.error.issues[0]?.message
        : !filesReady
          ? 'This quality needs its files. See the setup above.'
          : !status.canGenerate
            ? status.message
            : undefined;
  const gpuText = textOnGpu(draft.speed, status.bigCard === true, draft.profile);
  const chip = (panel: Panel, label: string, value: ReactNode, extra = '') => (
    <button
      type="button"
      className={`vp-chip ${extra}`}
      aria-expanded={open === panel}
      aria-haspopup="dialog"
      disabled={busy}
      onClick={() => toggle(panel)}
    >
      {label && <b>{label}</b>}
      {value}
    </button>
  );
  const frameSlot = (role: 'firstFrame' | 'lastFrame') => {
    const reference = draft[role];
    const source = reference && props.sources.find(item => item.id === reference.sourceId);
    const name = role === 'firstFrame' ? 'First frame' : 'Last frame';
    return (
      <div className="vp-anchor">
        {reference && source ? (
          <button
            type="button"
            className="vp-frame"
            aria-label={`${name}: ${source.name}. Change`}
            aria-expanded={open === role}
            disabled={busy}
            onClick={() => toggle(role)}
          >
            <img src={`latent-asset://source/${source.id}`} alt="" />
          </button>
        ) : (
          <button
            type="button"
            className="vp-slot"
            aria-expanded={open === role}
            disabled={busy}
            onClick={() => toggle(role)}
          >
            {reference ? `${name} missing` : `+ ${name}`}
            {role === 'lastFrame' && !reference && <small>optional</small>}
          </button>
        )}
        {open === role && (
          <div className="vp-pop vp-pop-frames" role="dialog" aria-label={name}>
            <div className="vp-pop-grid">
              {props.sources.slice(0, 12).map(item => (
                <button
                  key={item.id}
                  type="button"
                  className={`vp-thumb ${reference?.sourceId === item.id ? 'on' : ''}`}
                  aria-label={item.name}
                  title={`${item.name} · ${item.normalized.width} × ${item.normalized.height}`}
                  onClick={() => {
                    update({ [role]: { sourceId: item.id, sha256: item.normalized.sha256 } });
                    setOpen(undefined);
                  }}
                >
                  <img src={`latent-asset://source/${item.id}`} alt="" />
                </button>
              ))}
            </div>
            <div className="vp-pop-actions">
              <button
                type="button"
                onClick={() => {
                  setOpen(undefined);
                  props.onImportSource(role);
                }}
              >
                <ImagePlus size={14} /> Open an image…
              </button>
              {props.selectedImageAvailable && (
                <button
                  type="button"
                  onClick={() => {
                    setOpen(undefined);
                    props.onUseSelectedImage(role);
                  }}
                >
                  Use the image picked in Create
                </button>
              )}
              {reference && (
                <button
                  type="button"
                  onClick={() => {
                    update({ [role]: undefined });
                    setOpen(undefined);
                  }}
                >
                  <X size={14} /> Remove
                </button>
              )}
            </div>
            <Seg
              label="Fit"
              value={draft.resize}
              options={[
                { value: 'center-crop', label: 'Crop to fill' },
                { value: 'stretch', label: 'Stretch' },
              ]}
              onChange={resize => update({ resize })}
            />
          </div>
        )}
      </div>
    );
  };
  return (
    <form
      ref={dock}
      className="vp-dock"
      aria-label="Make a clip"
      onSubmit={event => {
        event.preventDefault();
        if (!problem && !busy) props.onGenerate();
      }}
    >
      <div className="vp-start">
        <div className="vp-seg" role="group" aria-label="Start from">
          <button
            type="button"
            aria-pressed={draft.mode === 'txt2vid'}
            disabled={busy}
            onClick={() => update({ mode: 'txt2vid', firstFrame: undefined, lastFrame: undefined })}
          >
            Text
          </button>
          <button
            type="button"
            aria-pressed={draft.mode === 'img2vid'}
            disabled={busy}
            onClick={() => update({ mode: 'img2vid' })}
          >
            Image
          </button>
        </div>
        {draft.mode === 'img2vid' && (
          <div className="vp-frames">
            {frameSlot('firstFrame')}
            {frameSlot('lastFrame')}
          </div>
        )}
      </div>
      <div className="vp-compose">
        <label htmlFor="vp-prompt" className="vp-label">
          What happens?
        </label>
        <textarea
          id="vp-prompt"
          rows={2}
          value={draft.prompt}
          disabled={busy}
          placeholder="A slow push in on a beach at sunset, waves rolling in…"
          onChange={event => update({ prompt: event.target.value })}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              if (!problem && !busy) props.onGenerate();
            }
          }}
        />
        <div className="vp-chips">
          <div className="vp-anchor">
            {chip('speed', 'Speed', `${qualityName(draft.profile).label} · ${qualityName(draft.profile).hint}`)}
            {open === 'speed' && (
              <div className="vp-pop vp-pop-speed" role="dialog" aria-label="Speed">
                <Seg
                  label="Quality"
                  value={draft.profile}
                  options={QUALITY.map(item => ({
                    value: item.profile,
                    label: `${item.label} · ${item.hint.split(' ')[0]}`,
                    disabled: !videoProfileReady(status.assets, item.profile) && item.profile !== draft.profile,
                    title: videoProfileReady(status.assets, item.profile) ? undefined : 'Needs its own files',
                  }))}
                  onChange={profile => update({ profile })}
                />
                <hr />
                <span className="vp-label">Your graphics card{status.bigCard ? ' · extra memory on' : ''}</span>
                <Switch
                  label="Read the prompt on the GPU"
                  checked={gpuText}
                  onChange={on => speed({ textOnGpu: on === status.bigCard ? 'auto' : on ? 'on' : 'off' })}
                />
                <Seg
                  label="Attention"
                  value={draft.speed.attention}
                  options={[
                    { value: 'normal', label: 'Normal' },
                    { value: 'sage', label: 'Sage' },
                    {
                      value: 'sage-sol',
                      label: 'Sage + Sol',
                      disabled: !status.solInstalled,
                      title: status.solInstalled ? undefined : 'Install Sol first',
                    },
                  ]}
                  onChange={attention => speed({ attention })}
                />
                {!status.solInstalled && (
                  <button type="button" className="vp-link" disabled={props.solBusy} onClick={props.onInstallSol}>
                    {props.solBusy ? 'Installing Sol…' : 'Install Sol (small add-on, restarts the engine)'}
                  </button>
                )}
                <Seg
                  label="Final step"
                  value={draft.speed.finish}
                  options={[
                    { value: 'quick', label: 'Quick' },
                    { value: 'low-memory', label: 'Low memory' },
                  ]}
                  onChange={finish => speed({ finish })}
                />
                <p className="vp-note">
                  {draft.speed.attention === 'sage-sol'
                    ? 'Sage + Sol is the fastest. It can change the clip a little.'
                    : !status.bigCard && gpuText
                      ? 'On cards under 20 GB, reading on the GPU can run out of memory.'
                      : 'Pick Low memory if a clip stops with an out of memory error.'}
                </p>
              </div>
            )}
          </div>
          <div className="vp-anchor">
            {chip('length', 'Length', `${draft.requestedDurationSeconds} s`)}
            {open === 'length' && (
              <div className="vp-pop" role="dialog" aria-label="Length">
                <div className="vp-pop-list">
                  {LENGTHS.map(seconds => (
                    <button
                      key={seconds}
                      type="button"
                      aria-pressed={draft.requestedDurationSeconds === seconds}
                      onClick={() => {
                        update({ requestedDurationSeconds: seconds });
                        setOpen(undefined);
                      }}
                    >
                      {seconds} seconds
                    </button>
                  ))}
                </div>
                {frames > 0 && <p className="vp-note">{frames} frames at 24 fps.</p>}
              </div>
            )}
          </div>
          <div className="vp-anchor">
            {chip('size', '', `${draft.width}×${draft.height}`, 'mono')}
            {open === 'size' && (
              <div className="vp-pop" role="dialog" aria-label="Size">
                <div className="vp-pop-list">
                  {VIDEO_SIZES.map(size => (
                    <button
                      key={`${size.width}x${size.height}`}
                      type="button"
                      aria-pressed={draft.width === size.width && draft.height === size.height}
                      onClick={() => {
                        update({ width: size.width, height: size.height });
                        setOpen(undefined);
                      }}
                    >
                      <span className="mono">
                        {size.width}×{size.height}
                      </span>
                      <small>{size.label}</small>
                    </button>
                  ))}
                </div>
                <p className="vp-note">Bigger sizes look sharper and take longer.</p>
              </div>
            )}
          </div>
          <button
            type="button"
            className="vp-chip"
            aria-pressed={draft.audio !== 'none'}
            disabled={busy}
            onClick={() => update({ audio: draft.audio === 'none' ? 'stereo-candidate' : 'none' })}
          >
            <b>Sound</b>
            {draft.audio === 'none' ? 'Off' : 'On'}
          </button>
          <div className="vp-anchor">
            {chip('seed', '', draft.seed === 'random' ? 'Seed random' : `Seed ${draft.seed}`, 'mono')}
            {open === 'seed' && (
              <div className="vp-pop" role="dialog" aria-label="Seed">
                <label className="vp-field">
                  <span className="vp-label">Seed</span>
                  <input
                    className="mono"
                    inputMode="numeric"
                    value={draft.seed === 'random' ? '' : draft.seed}
                    placeholder="random"
                    onChange={event => update({ seed: event.target.value.trim() || 'random' })}
                  />
                </label>
                <div className="vp-pop-actions">
                  <button type="button" onClick={() => update({ seed: 'random' })}>
                    Random
                  </button>
                  {props.lastSeed && (
                    <button type="button" onClick={() => update({ seed: props.lastSeed! })}>
                      Last clip’s seed
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="vp-go-col">
        <button type="submit" className="vp-go" disabled={busy || Boolean(problem)}>
          Make clip
        </button>
        <span className="vp-estimate" title={problem}>
          {problem ?? (props.estimateMs ? `About ${formatDuration(props.estimateMs)}` : '')}
        </span>
      </div>
    </form>
  );
}

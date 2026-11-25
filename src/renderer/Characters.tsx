import { useRef, useState, type PointerEvent } from 'react';
import { ArrowLeftRight, Plus, X } from 'lucide-react';
import {
  REGIONAL_PROMPT_LIMITS,
  activeRegionalPromptRegions,
  applyRegionalLayout,
  createCharacterSettings,
  type RegionalLayout,
  type RegionalPromptRegion,
  type RegionalPromptSettings,
} from '../shared/regional-prompt-types';
import type { ModelAsset } from '../shared/types';
import { RegionalPrompts } from './RegionalPrompts';
import { Notice } from './ui';
import './regional-prompts.css';

export const CHARACTER_COLORS = ['#c2a2f4', '#64ceb4', '#e3ad70', '#df8fb3'];
const PRESETS: Array<{ id: Exclude<RegionalLayout, 'custom'>; label: string }> = [
  { id: 'side', label: 'Side by side' },
  { id: 'stack', label: 'Top and bottom' },
  { id: 'big-small', label: 'Big and small' },
];
const OVERLAP = 0.04;

export interface CharactersProps {
  value?: RegionalPromptSettings;
  width: number;
  height: number;
  disabledReason?: string;
  /** Installed LoRAs that fit the current model. */
  loras: ModelAsset[];
  backdropUrl?: string;
  onChange(value: RegionalPromptSettings | undefined): void;
}

function PresetIcon({ id }: { id: RegionalLayout }) {
  const [a, b] = CHARACTER_COLORS;
  return (
    <svg viewBox="0 0 26 16" width={26} height={16} aria-hidden="true">
      {id === 'side' && (
        <>
          <rect x={0} y={0} width={12} height={16} rx={2} fill={a} />
          <rect x={14} y={0} width={12} height={16} rx={2} fill={b} />
        </>
      )}
      {id === 'stack' && (
        <>
          <rect x={0} y={0} width={26} height={7} rx={2} fill={a} />
          <rect x={0} y={9} width={26} height={7} rx={2} fill={b} />
        </>
      )}
      {id === 'big-small' && (
        <>
          <rect x={0} y={0} width={17} height={16} rx={2} fill={a} />
          <rect x={19} y={6} width={7} height={10} rx={2} fill={b} />
        </>
      )}
      {id === 'custom' && (
        <rect x={0.5} y={0.5} width={25} height={15} rx={3} fill="none" stroke="currentColor" strokeDasharray="3 2" />
      )}
    </svg>
  );
}

/** Characters: one prompt and LoRA set per person, placed with a quick layout. */
export function Characters({ value, width, height, disabledReason, loras, backdropUrl, onChange }: CharactersProps) {
  const enabled = Boolean(value?.enabled);
  const isCharacters = value?.separation !== undefined;
  const settings = value && isCharacters ? value : undefined;
  const map = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const update = (next: RegionalPromptSettings) => onChange(next);
  const patch = (index: number, change: Partial<RegionalPromptRegion>) =>
    settings &&
    update({
      ...settings,
      regions: settings.regions.map((region, at) => (at === index ? { ...region, ...change } : region)),
    });
  const layout = settings?.layout ?? 'custom';
  const count = settings?.regions.length ?? 0;
  const splittable = settings && count === 2 && (layout === 'side' || layout === 'stack');
  const active = settings ? activeRegionalPromptRegions(settings).length : 0;

  function toggle(on: boolean) {
    if (!on) return onChange(value ? { ...value, enabled: false } : undefined);
    if (settings) return update({ ...settings, enabled: true });
    update(
      value?.regions.some(region => region.positivePrompt.trim() || region.negativePrompt.trim())
        ? { ...applyRegionalLayout(value, 'side'), enabled: true }
        : createCharacterSettings(),
    );
  }
  function pickLayout(id: Exclude<RegionalLayout, 'custom'>) {
    if (settings) update(applyRegionalLayout(settings, id, id === 'big-small' ? 2 : Math.max(2, count)));
  }
  function addCharacter() {
    if (!settings || count >= REGIONAL_PROMPT_LIMITS.maxRegions) return;
    if (layout !== 'custom')
      return update(applyRegionalLayout(settings, layout === 'big-small' ? 'side' : layout, count + 1));
    const letter = 'ABCD'.split('').find(name => !settings.regions.some(region => region.name === name)) ?? 'D';
    update({
      ...settings,
      regions: [
        ...settings.regions,
        {
          id: `character_${crypto.randomUUID()}`,
          name: letter,
          x: 0.3,
          y: 0.2,
          width: 0.4,
          height: 0.8,
          positivePrompt: '',
          negativePrompt: '',
          strength: 1,
          feather: 48,
        },
      ],
    });
  }
  function removeCharacter(index: number) {
    if (!settings || count <= 1) return;
    const kept = { ...settings, regions: settings.regions.filter((_, at) => at !== index) };
    update(layout === 'custom' ? kept : applyRegionalLayout(kept, layout === 'big-small' ? 'side' : layout, count - 1));
  }
  function swap() {
    if (!settings || count < 2) return;
    const [first, second] = settings.regions;
    const words = (region: RegionalPromptRegion) => ({
      name: region.name,
      positivePrompt: region.positivePrompt,
      negativePrompt: region.negativePrompt,
      loras: region.loras,
    });
    update({
      ...settings,
      regions: [{ ...first, ...words(second) }, { ...second, ...words(first) }, ...settings.regions.slice(2)],
    });
  }
  function split(event: PointerEvent<SVGSVGElement>) {
    if (dragging === null || !settings || !map.current) return;
    const box = map.current.getBoundingClientRect();
    const horizontal = layout === 'side';
    const at = horizontal ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height;
    const middle = Math.round(Math.min(0.8, Math.max(0.2, at)) * 100) / 100;
    const [a, b] = settings.regions;
    const first = horizontal ? { x: 0, width: middle + OVERLAP } : { y: 0, height: middle + OVERLAP };
    const second = horizontal
      ? { x: middle - OVERLAP, width: 1 - middle + OVERLAP }
      : { y: middle - OVERLAP, height: 1 - middle + OVERLAP };
    update({
      ...settings,
      regions: [
        { ...a, ...first },
        { ...b, ...second },
      ],
    });
  }
  const middle = splittable
    ? layout === 'side'
      ? settings.regions[0].x + settings.regions[0].width - OVERLAP
      : settings.regions[0].y + settings.regions[0].height - OVERLAP
    : 0;
  const separation = settings?.separation ?? 0.6;
  const apart = separation === 0 ? 'Off' : separation < 0.45 ? 'Soft' : separation < 0.75 ? 'Medium' : 'Strong';
  const feather = settings?.regions[0]?.feather ?? 48;

  return (
    <section className="characters" aria-label="Characters">
      <div className="characters-heading">
        <label className="toggle">
          <input
            type="checkbox"
            checked={enabled}
            disabled={Boolean(disabledReason) && !enabled}
            onChange={event => toggle(event.target.checked)}
          />
          <span>Characters</span>
        </label>
        {enabled && settings && <span className="muted small">{active ? `${active} in use` : 'Add some words'}</span>}
      </div>
      {disabledReason && <Notice>{disabledReason}</Notice>}
      {!enabled && <p className="muted small">Give each person in the picture their own prompt and LoRAs.</p>}
      {enabled && value && !isCharacters && (
        <div className="characters-old">
          <p className="muted small">This picture uses the older area setup.</p>
          <button type="button" className="text-button" onClick={() => update(applyRegionalLayout(value, 'side'))}>
            Switch to characters
          </button>
        </div>
      )}
      {enabled && settings && (
        <>
          <div className="characters-presets" role="group" aria-label="Layout">
            {PRESETS.map(preset => (
              <button
                key={preset.id}
                type="button"
                aria-pressed={layout === preset.id}
                className={layout === preset.id ? 'active' : ''}
                disabled={preset.id === 'big-small' && count > 2}
                title={preset.id === 'big-small' && count > 2 ? 'Fits two characters' : undefined}
                onClick={() => pickLayout(preset.id)}
              >
                <PresetIcon id={preset.id} />
                {preset.label}
              </button>
            ))}
            <RegionalPrompts
              compact
              value={settings}
              width={width}
              height={height}
              backdropUrl={backdropUrl}
              onChange={next => next && update({ ...next, layout: 'custom' })}
            />
          </div>
          <svg
            ref={map}
            className="characters-map"
            viewBox={`0 0 ${width} ${height}`}
            style={{ aspectRatio: `${width} / ${height}` }}
            role="img"
            aria-label={`Layout preview, ${width} by ${height}`}
            onPointerMove={split}
            onPointerUp={() => setDragging(null)}
            onPointerCancel={() => setDragging(null)}
          >
            {settings.regions.map((region, index) => (
              <g key={region.id}>
                <rect
                  x={region.x * width}
                  y={region.y * height}
                  width={region.width * width}
                  height={region.height * height}
                  fill={CHARACTER_COLORS[index]}
                  fillOpacity={0.28}
                  stroke={CHARACTER_COLORS[index]}
                  strokeWidth={Math.max(width, height) / 160}
                />
                <text
                  x={(region.x + region.width / 2) * width}
                  y={(region.y + region.height / 2) * height}
                  fontSize={Math.max(width, height) / 12}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={CHARACTER_COLORS[index]}
                >
                  {region.name.slice(0, 6)}
                </text>
              </g>
            ))}
            {splittable && (
              <rect
                className={`characters-split ${layout}`}
                x={layout === 'side' ? middle * width - width / 40 : 0}
                y={layout === 'side' ? 0 : middle * height - height / 40}
                width={layout === 'side' ? width / 20 : width}
                height={layout === 'side' ? height : height / 20}
                onPointerDown={event => {
                  event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId);
                  setDragging(event.pointerId);
                }}
              >
                <title>Drag to move the split</title>
              </rect>
            )}
          </svg>
          {settings.regions.map((region, index) => (
            <CharacterCard
              key={region.id}
              region={region}
              color={CHARACTER_COLORS[index]}
              loras={loras}
              canRemove={count > 1}
              onChange={change => patch(index, change)}
              onRemove={() => removeCharacter(index)}
            />
          ))}
          <div className="characters-actions">
            <button type="button" disabled={count >= REGIONAL_PROMPT_LIMITS.maxRegions} onClick={addCharacter}>
              <Plus size={14} />
              Add character
            </button>
            <button type="button" disabled={count < 2} onClick={swap}>
              <ArrowLeftRight size={14} />
              Swap A and B
            </button>
          </div>
          <div className="characters-sliders">
            <label className="characters-slider">
              <span>
                Blend edge <span className="muted">{feather === 0 ? 'Hard' : feather < 40 ? 'Slight' : 'Soft'}</span>
              </span>
              <input
                type="range"
                min={0}
                max={128}
                step={8}
                value={feather}
                onChange={event =>
                  update({
                    ...settings,
                    regions: settings.regions.map(region => ({ ...region, feather: Number(event.target.value) })),
                  })
                }
              />
            </label>
            <label className="characters-slider">
              <span>
                Keep them apart <span className="muted">{apart}</span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={separation}
                onChange={event => update({ ...settings, separation: Number(event.target.value) })}
              />
            </label>
          </div>
          <div className="characters-sliders">
            <label className="toggle characters-touch">
              <input
                type="checkbox"
                checked={Boolean(settings.touchUp)}
                onChange={event =>
                  update({ ...settings, touchUp: event.target.checked ? { strength: 0.35 } : undefined })
                }
              />
              <span>Touch up each character</span>
            </label>
            {settings.touchUp && (
              <label className="characters-slider">
                <span>
                  Strength <span className="muted">{Math.round(settings.touchUp.strength * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0.15}
                  max={0.6}
                  step={0.05}
                  value={settings.touchUp.strength}
                  onChange={event => update({ ...settings, touchUp: { strength: Number(event.target.value) } })}
                />
              </label>
            )}
          </div>
          <p className="muted small">
            {settings.touchUp
              ? 'Redoes each character after, with only their own words and LoRAs. Takes a bit longer.'
              : 'Your main prompt is the shared scene. Each character adds their own words.'}
          </p>
        </>
      )}
    </section>
  );
}

function CharacterCard({
  region,
  color,
  loras,
  canRemove,
  onChange,
  onRemove,
}: {
  region: RegionalPromptRegion;
  color: string;
  loras: ModelAsset[];
  canRemove: boolean;
  onChange(change: Partial<RegionalPromptRegion>): void;
  onRemove(): void;
}) {
  const [avoidOpen, setAvoidOpen] = useState(false);
  const picked = region.loras ?? [];
  const available = loras.filter(asset => !picked.some(lora => lora.modelId === asset.id));
  const setLoras = (next: typeof picked) => onChange({ loras: next.length ? next : undefined });
  const hasWord = (word: string) =>
    region.positivePrompt
      .split(',')
      .map(part => part.trim().toLowerCase())
      .includes(word.trim().toLowerCase());
  return (
    <div className="character-card" style={{ borderLeftColor: color }}>
      <div className="character-card-top">
        <input
          className="character-name"
          aria-label="Character name"
          value={region.name}
          maxLength={40}
          onChange={event => onChange({ name: event.target.value || '?' })}
        />
        {canRemove && (
          <button type="button" className="icon-button" aria-label={`Remove ${region.name}`} onClick={onRemove}>
            <X size={14} />
          </button>
        )}
      </div>
      <textarea
        aria-label={`${region.name} prompt`}
        placeholder="What they look like, wear and do"
        rows={2}
        value={region.positivePrompt}
        onChange={event => onChange({ positivePrompt: event.target.value })}
      />
      {(avoidOpen || region.negativePrompt) && (
        <input
          className="character-avoid"
          aria-label={`${region.name} avoid`}
          placeholder="Things to keep off this character"
          value={region.negativePrompt}
          onChange={event => onChange({ negativePrompt: event.target.value })}
        />
      )}
      <div className="character-loras">
        {picked.map((lora, index) => {
          const asset = loras.find(item => item.id === lora.modelId);
          const name = asset?.name ?? lora.modelId.replace(/^lora:/, '');
          const triggers = (asset?.triggers ?? []).filter(word => word.trim() && !hasWord(word)).slice(0, 6);
          return (
            <div key={lora.modelId} className="character-lora">
              <div className="character-lora-row">
                <span className="character-lora-name" title={asset?.filename ?? lora.modelId} style={{ color }}>
                  {name}
                </span>
                <input
                  type="number"
                  step={0.05}
                  aria-label={`Weight for ${name}`}
                  value={lora.weight}
                  onChange={event =>
                    setLoras(
                      picked.map((item, at) =>
                        at === index
                          ? { ...item, weight: Number(event.target.value), clipWeight: Number(event.target.value) }
                          : item,
                      ),
                    )
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${name}`}
                  onClick={() => setLoras(picked.filter((_, at) => at !== index))}
                >
                  <X size={12} />
                </button>
              </div>
              {triggers.length > 0 && (
                <div className="character-triggers">
                  {triggers.map(word => (
                    <button
                      key={word}
                      type="button"
                      title="Add to this character's prompt"
                      onClick={() =>
                        onChange({
                          positivePrompt: [word, region.positivePrompt.trim()].filter(Boolean).join(', '),
                        })
                      }
                    >
                      + {word}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <div className="character-adds">
          {picked.length < 4 && (
            <select
              aria-label={`Add a LoRA to ${region.name}`}
              value=""
              disabled={!available.length}
              onChange={event =>
                event.target.value &&
                setLoras([...picked, { modelId: event.target.value, weight: 0.8, clipWeight: 0.8 }])
              }
            >
              <option value="">{available.length ? '+ LoRA' : 'No LoRAs installed'}</option>
              {available.map(asset => (
                <option key={asset.id} value={asset.id}>
                  {asset.name}
                </option>
              ))}
            </select>
          )}
          {!avoidOpen && !region.negativePrompt && (
            <button type="button" className="text-button" onClick={() => setAvoidOpen(true)}>
              + Avoid
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

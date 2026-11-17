import { SAMPLERS, SCHEDULERS } from '../shared/defaults';
import { IMAGE_MODELS, fitImageModelSize, imageModelStartingSettings, type ImageModelId } from '../shared/image-models';

/** Settings Latent remembers for each newer model, so your tweaks come back when you switch to it again. */
export interface ImageModelSettings {
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  width: number;
  height: number;
  negativePrompt: string;
}

const key = (id: ImageModelId) => `latent.image-model.${id}`;

export function rememberImageModelSettings(id: ImageModelId, settings: ImageModelSettings) {
  const { steps, cfg, sampler, scheduler, width, height, negativePrompt } = settings;
  try {
    localStorage.setItem(key(id), JSON.stringify({ steps, cfg, sampler, scheduler, width, height, negativePrompt }));
  } catch {
    /* Storage can be unavailable; the recommended settings still apply. */
  }
}

export function forgetImageModelSettings(id: ImageModelId) {
  try {
    localStorage.removeItem(key(id));
  } catch {
    /* Nothing saved to forget. */
  }
}

function saved(id: ImageModelId): Partial<ImageModelSettings> {
  let value: unknown;
  try {
    value = JSON.parse(localStorage.getItem(key(id)) ?? 'null');
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const result: Partial<ImageModelSettings> = {};
  const number = (name: string, min: number, max: number) =>
    typeof raw[name] === 'number' && Number.isFinite(raw[name]) && raw[name] >= min && raw[name] <= max;
  if (number('steps', 1, 150)) result.steps = Math.round(raw.steps as number);
  if (number('cfg', 0, 30)) result.cfg = raw.cfg as number;
  if (typeof raw.sampler === 'string' && SAMPLERS.includes(raw.sampler)) result.sampler = raw.sampler;
  if (typeof raw.scheduler === 'string' && SCHEDULERS.includes(raw.scheduler)) result.scheduler = raw.scheduler;
  if (number('width', 256, 2048) && number('height', 256, 2048)) {
    result.width = raw.width as number;
    result.height = raw.height as number;
  }
  if (typeof raw.negativePrompt === 'string' && raw.negativePrompt.length <= 20_000)
    result.negativePrompt = raw.negativePrompt;
  return result;
}

/**
 * What to fill in when switching to a model: your last settings for it if you used it before,
 * otherwise the recommended ones. The size you had is kept when the model handles it well.
 */
export function imageModelSettingsFor(
  id: ImageModelId,
  current: { width: number; height: number },
  options: { recommended?: boolean } = {},
): ImageModelSettings {
  const previous = options.recommended ? {} : saved(id);
  const size =
    previous.width && previous.height
      ? fitImageModelSize(id, previous.width, previous.height)
      : fitImageModelSize(id, current.width, current.height);
  return { ...imageModelStartingSettings(id), ...previous, ...size };
}

/** Short "8–12 steps · CFG 1" summary of what the makers recommend. */
export function recommendedSummary(id: ImageModelId) {
  const { steps, cfg } = IMAGE_MODELS[id].guide;
  const range = ([a, b]: [number, number]) => (a === b ? `${a}` : `${a}–${b}`);
  return `${range(steps)} steps · CFG ${range(cfg)}`;
}

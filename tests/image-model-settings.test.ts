// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { IMAGE_MODEL_IDS, IMAGE_MODELS, fitImageModelSize, imageModelSizes } from '../src/shared/image-models';
import {
  forgetImageModelSettings,
  imageModelSettingsFor,
  rememberImageModelSettings,
} from '../src/renderer/image-model-settings';

beforeEach(() => localStorage.clear());

it('suggests sizes near each model sweet spot, in multiples of 16', () => {
  for (const id of IMAGE_MODEL_IDS) {
    const ideal = IMAGE_MODELS[id].guide.megapixels.ideal;
    for (const size of imageModelSizes(id)) {
      expect(size.width % 16).toBe(0);
      expect(size.height % 16).toBe(0);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(2048);
      expect((size.width * size.height) / 1048576).toBeGreaterThan(ideal * 0.85);
      expect((size.width * size.height) / 1048576).toBeLessThan(ideal * 1.15);
    }
  }
});

it('keeps a size the model handles and fixes one it does not', () => {
  expect(fitImageModelSize('z-image-turbo', 1216, 832)).toEqual({ width: 1216, height: 832 });
  // Not a multiple of 16 and too big for Anima: closest landscape suggestion instead.
  const fixed = fitImageModelSize('anima-turbo', 2000, 1500);
  expect(fixed.width / fixed.height).toBeCloseTo(4 / 3, 1);
  expect(fixed.width % 16).toBe(0);
});

it('starts from the best settings, then remembers your tweaks per model', () => {
  const first = imageModelSettingsFor('anima-aesthetic', { width: 1024, height: 1024 });
  expect(first).toMatchObject({ steps: 30, cfg: 4, width: 1024, height: 1024 });
  expect(first.negativePrompt).toContain('worst quality');
  rememberImageModelSettings('anima-aesthetic', { ...first, steps: 44, cfg: 4.5, negativePrompt: 'blurry' });
  expect(imageModelSettingsFor('anima-aesthetic', { width: 512, height: 512 })).toMatchObject({
    steps: 44,
    cfg: 4.5,
    negativePrompt: 'blurry',
    width: 1024,
  });
  // Other models are untouched, and "best settings" ignores what was saved.
  expect(imageModelSettingsFor('anima-turbo', { width: 1024, height: 1024 }).steps).toBe(8);
  expect(imageModelSettingsFor('anima-aesthetic', { width: 1024, height: 1024 }, { recommended: true }).steps).toBe(30);
  forgetImageModelSettings('anima-aesthetic');
  expect(imageModelSettingsFor('anima-aesthetic', { width: 1024, height: 1024 }).steps).toBe(30);
});

it('ignores junk in saved settings', () => {
  localStorage.setItem(
    'latent.image-model.flux3-klein',
    JSON.stringify({ steps: 'lots', cfg: 99, sampler: 'not-a-sampler', width: 1024, height: 768, extra: true }),
  );
  expect(imageModelSettingsFor('flux3-klein', { width: 1024, height: 1024 })).toMatchObject({
    steps: 16,
    cfg: 1,
    sampler: 'euler',
    width: 1024,
    height: 768,
  });
});

it('spots steps and CFG outside the recommended range', async () => {
  const { offRecommended, negativeUnused } = await import('../src/renderer/image-model-settings');
  expect(offRecommended('anima-turbo', { steps: 10, cfg: 1 })).toEqual({ steps: false, cfg: false });
  expect(offRecommended('anima-turbo', { steps: 30, cfg: 4 })).toEqual({ steps: true, cfg: true });
  for (const id of IMAGE_MODEL_IDS)
    expect(offRecommended(id, IMAGE_MODELS[id].defaults)).toEqual({ steps: false, cfg: false });
  expect(negativeUnused('anima-turbo', 1)).toBe(true);
  expect(negativeUnused('anima-aesthetic', 4.5)).toBe(false);
});

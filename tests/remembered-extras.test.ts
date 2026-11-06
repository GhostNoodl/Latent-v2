// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { recallExtra, rememberExtra } from '../src/renderer/remembered-extras';

beforeEach(() => localStorage.clear());

it('brings back the last values over the defaults', () => {
  rememberExtra('face', { profile: 'anime', strength: 0.6, steps: 30, sampler: 'dpmpp_2m' });
  expect(recallExtra('face', { profile: 'illustrated', strength: 0.45, steps: 20, sampler: 'euler', cfg: 7 })).toEqual({
    profile: 'anime',
    strength: 0.6,
    steps: 30,
    sampler: 'dpmpp_2m',
    cfg: 7,
  });
});

it('ignores unknown fields and wrong types, and keeps listed optional ones', () => {
  localStorage.setItem(
    'latent.last-hires-fix',
    JSON.stringify({ steps: 'many', denoise: 0.4, scaleFactor: 2, junk: 1, workflowVersion: 'x' }),
  );
  expect(recallExtra('hires', { steps: 20, denoise: 0.3 }, ['scaleFactor'])).toEqual({
    steps: 20,
    denoise: 0.4,
    scaleFactor: 2,
  });
});

it('falls back to the defaults when nothing was saved or storage is broken', () => {
  expect(recallExtra('hires', { steps: 20 })).toEqual({ steps: 20 });
  localStorage.setItem('latent.last-hires-fix', '{not json');
  expect(recallExtra('hires', { steps: 20 })).toEqual({ steps: 20 });
});

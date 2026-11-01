import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import {
  augmentSplitWorkflow,
  defaultPauseStep,
  finishDraft,
  pausedDraft,
  splitBlockedReason,
} from '../src/shared/split-sampling';
import type { GenerationDraft, ModelAsset } from '../src/shared/types';
import { draftSchema } from '../src/shared/validation';
import { buildWorkflow } from '../src/shared/workflow';

const checkpoint: ModelAsset = {
  id: 'checkpoint:example.safetensors',
  name: 'Example',
  filename: 'example.safetensors',
  kind: 'checkpoint',
  family: 'sdxl',
  bytes: 100,
  sha256: 'b'.repeat(64),
  triggers: [],
  status: 'ready',
};
const base: GenerationDraft = {
  ...DEFAULT_DRAFT,
  family: 'sdxl',
  checkpointId: checkpoint.id,
  prompt: 'a red fox',
  negativePrompt: 'blurry',
  steps: 20,
  cfg: 6,
};
const graphFor = (draft: GenerationDraft, before?: { positive: string; negative: string }) =>
  augmentSplitWorkflow(buildWorkflow(draft, [checkpoint], '42', 'job'), draft, before);

describe('pause and tweak', () => {
  it('stops partway and saves the clean guess, not the noisy middle', () => {
    const draft = pausedDraft(base, 8);
    expect(draftSchema.parse(draft).split).toEqual({ atStep: 8, stop: true });
    const graph = graphFor(draft);
    expect(graph['5']).toBeUndefined();
    expect(graph['83']).toMatchObject({ class_type: 'SplitSigmas', inputs: { step: 8 } });
    expect(graph['86'].inputs).toMatchObject({ positive: ['2', 0], negative: ['3', 0], cfg: 6 });
    expect(graph['87'].inputs).toMatchObject({ sigmas: ['83', 0], latent_image: ['4', 0] });
    expect(graph['6'].inputs.samples).toEqual(['87', 1]);
    expect(graph['90']).toBeUndefined();
    expect(graph['7'].inputs.filename_prefix).toBe('Latent_job');
  });

  it('finishes by replaying the first part unchanged and running the rest with the tweaks', () => {
    const paused = pausedDraft(base, 8);
    const stopGraph = graphFor(paused);
    const finished = finishDraft(paused, '42', { prompt: 'a red fox in snow', negativePrompt: 'blurry', cfg: 4 });
    expect(finished).toMatchObject({
      prompt: 'a red fox in snow',
      cfg: 4,
      seed: '42',
      split: { atStep: 8, before: { prompt: 'a red fox', negativePrompt: 'blurry', cfg: 6 } },
    });
    expect(finished.split?.stop).toBeUndefined();
    const graph = graphFor(finished, { positive: 'a red fox', negative: 'blurry' });
    // The first half matches the paused run, so the engine can reuse it.
    expect(graph['84'].inputs.text).toBe(stopGraph['2'].inputs.text);
    expect(graph['86'].inputs.cfg).toBe(stopGraph['86'].inputs.cfg);
    expect(graph['80']).toEqual(stopGraph['80']);
    expect(graph['82']).toEqual(stopGraph['82']);
    expect(graph['2'].inputs.text).toBe('a red fox in snow');
    expect(graph['89'].inputs).toMatchObject({ positive: ['2', 0], negative: ['3', 0], cfg: 4 });
    expect(graph['90'].inputs).toMatchObject({ noise: ['88', 0], sigmas: ['83', 1], latent_image: ['87', 0] });
    expect(graph['6'].inputs.samples).toEqual(['90', 0]);
  });

  it('only pauses plain images', () => {
    expect(splitBlockedReason(base)).toBeUndefined();
    expect(splitBlockedReason({ ...base, hiresFix: {} as never })).toMatch(/hires fix/);
    expect(splitBlockedReason({ ...base, prompt: 'a {red|blue} fox' })).toMatch(/wildcards/);
    expect(splitBlockedReason({ ...base, steps: 1 })).toMatch(/2 steps/);
    expect(() => graphFor({ ...base, split: { atStep: 20, stop: true } })).toThrow(/before the last step/);
    const finished = finishDraft(pausedDraft(base, 5), '42', { prompt: 'x', negativePrompt: '', cfg: 5 });
    expect(() => graphFor(finished)).toThrow(/paused prompt/);
    expect(() =>
      draftSchema.parse({
        ...base,
        split: { atStep: 4, stop: true, before: { prompt: '', negativePrompt: '', cfg: 5 } },
      }),
    ).toThrow();
  });

  it('picks a pause point a bit under halfway', () => {
    expect(defaultPauseStep(28)).toBe(11);
    expect(defaultPauseStep(2)).toBe(1);
    expect(pausedDraft(base, 99).split?.atStep).toBe(19);
  });
});

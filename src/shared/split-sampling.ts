import { usesDynamicPrompts } from './dynamic-prompt-recipe';
import type { ComfyWorkflow, GenerationDraft } from './types';

export const SPLIT_WORKFLOW_VERSION = 'sdxl-split@1';

/** Settings that change the graph beyond one plain text-to-image pass. */
const BLOCKING: Array<[keyof GenerationDraft, string]> = [
  ['imageInput', 'a source image'],
  ['hiresFix', 'hires fix'],
  ['upscale', 'resizing'],
  ['enhance', 'Enhance'],
  ['controlNet', 'ControlNet'],
  ['ipAdapter', 'a reference image'],
  ['regionalPrompts', 'regions'],
  ['faceDetailer', 'face fixing'],
  ['autoFace', 'face fixing'],
  ['qwenEdit', 'Edit'],
  ['sweep', 'Compare settings'],
];

/** Why this draft can't pause partway, or undefined when it can. */
export function splitBlockedReason(draft: GenerationDraft): string | undefined {
  for (const [key, label] of BLOCKING) {
    const value = draft[key] as unknown;
    if (key === 'regionalPrompts' ? draft.regionalPrompts?.settings.enabled : value)
      return `Pausing works on plain images. Turn off ${label} first.`;
  }
  if (usesDynamicPrompts(draft)) return 'Pausing works on plain images. Turn off wildcards first.';
  if (draft.steps < 2) return 'Pausing needs at least 2 steps.';
  return undefined;
}

/** A sensible default pause point: a bit under halfway, when the layout has settled. */
export function defaultPauseStep(steps: number) {
  return Math.max(1, Math.min(steps - 1, Math.round(steps * 0.4)));
}

/** The paused image's recipe: same draft, stop partway. */
export function pausedDraft(draft: GenerationDraft, atStep: number): GenerationDraft {
  return { ...draft, split: { atStep: Math.max(1, Math.min(draft.steps - 1, Math.round(atStep))), stop: true } };
}

/**
 * Finish a paused image with tweaks. The first part replays with the paused prompt
 * (the engine usually still has it in memory, so it costs nothing), then the rest
 * runs with the new prompt and guidance.
 */
export function finishDraft(
  paused: GenerationDraft,
  actualSeed: string,
  tweaks: { prompt: string; negativePrompt: string; cfg: number },
): GenerationDraft {
  if (!paused.split?.stop) throw new Error('This image is not paused.');
  return {
    ...paused,
    ...tweaks,
    seed: actualSeed,
    dynamicPrompts: undefined,
    promptTriggerSpans: undefined,
    split: {
      atStep: paused.split.atStep,
      before: { prompt: paused.prompt, negativePrompt: paused.negativePrompt, cfg: paused.cfg },
    },
  };
}

/**
 * Swap the plain sampler for two halves of one schedule. `beforeText` is the already
 * resolved first-part prompt pair (with triggers), used only when finishing.
 */
export function augmentSplitWorkflow(
  base: ComfyWorkflow,
  draft: GenerationDraft,
  beforeText?: { positive: string; negative: string },
): ComfyWorkflow {
  const split = draft.split;
  if (!split) throw new Error('This draft does not pause.');
  const blocked = splitBlockedReason(draft);
  if (blocked) throw new Error(blocked);
  if (split.atStep >= draft.steps) throw new Error('Pick a pause step before the last step.');
  if (Boolean(split.before) !== Boolean(beforeText)) throw new Error('The paused prompt is missing.');
  const sampler = base['5'];
  if (sampler?.class_type !== 'KSampler' || base['6']?.class_type !== 'VAEDecode')
    throw new Error('Pausing works on plain images only.');
  const graph = structuredClone(base);
  const { model, seed, steps, sampler_name, scheduler } = sampler.inputs;
  const clip = graph['2'].inputs.clip;
  delete graph['5'];
  graph['80'] = { class_type: 'RandomNoise', inputs: { noise_seed: seed } };
  graph['81'] = { class_type: 'KSamplerSelect', inputs: { sampler_name } };
  graph['82'] = { class_type: 'BasicScheduler', inputs: { model, scheduler, steps, denoise: 1 } };
  graph['83'] = { class_type: 'SplitSigmas', inputs: { sigmas: ['82', 0], step: split.atStep } };
  let positive: [string, number] = ['2', 0];
  let negative: [string, number] = ['3', 0];
  if (beforeText) {
    graph['84'] = { class_type: 'CLIPTextEncode', inputs: { text: beforeText.positive, clip } };
    graph['85'] = { class_type: 'CLIPTextEncode', inputs: { text: beforeText.negative, clip } };
    positive = ['84', 0];
    negative = ['85', 0];
  }
  graph['86'] = {
    class_type: 'CFGGuider',
    inputs: { model, positive, negative, cfg: split.before ? split.before.cfg : draft.cfg },
  };
  graph['87'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: {
      noise: ['80', 0],
      guider: ['86', 0],
      sampler: ['81', 0],
      sigmas: ['83', 0],
      latent_image: ['4', 0],
    },
  };
  if (split.stop) {
    // The sampler's second output is its best guess at the clean image, not the noisy middle.
    graph['6'].inputs.samples = ['87', 1];
    return graph;
  }
  graph['88'] = { class_type: 'DisableNoise', inputs: {} };
  graph['89'] = { class_type: 'CFGGuider', inputs: { model, positive: ['2', 0], negative: ['3', 0], cfg: draft.cfg } };
  graph['90'] = {
    class_type: 'SamplerCustomAdvanced',
    inputs: { noise: ['88', 0], guider: ['89', 0], sampler: ['81', 0], sigmas: ['83', 1], latent_image: ['87', 0] },
  };
  graph['6'].inputs.samples = ['90', 0];
  return graph;
}

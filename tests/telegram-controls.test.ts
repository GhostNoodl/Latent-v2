import { expect, it } from 'vitest';
import {
  applySetting,
  effectiveDraft,
  splitPromptFlags,
  telegramDraft,
  type ControlContext,
} from '../src/main/telegram-controls';
import { DEFAULT_DRAFT, SIZE_PRESETS } from '../src/shared/defaults';
import type { GenerationDraft, ModelAsset } from '../src/shared/types';

const asset = (id: string, name: string, kind: 'checkpoint' | 'lora') =>
  ({
    id,
    name,
    filename: `${id}.safetensors`,
    kind,
    family: 'illustrious',
    bytes: 1,
    triggers: [],
    status: 'ready',
  }) as ModelAsset;
const ctx: ControlContext = {
  studio: { ...structuredClone(DEFAULT_DRAFT), checkpointId: 'model-a', seed: '5' },
  models: [
    asset('model-a', 'Alpha XL', 'checkpoint'),
    asset('model-b', 'Alpha Turbo', 'checkpoint'),
    asset('l1', 'Detail', 'lora'),
  ],
  presets: [
    { id: 'p1', name: 'Cozy', draft: { ...structuredClone(DEFAULT_DRAFT), checkpointId: 'model-b', steps: 40 } },
  ],
  sizes: SIZE_PRESETS,
};

it('turns the studio draft into a plain text-to-image job', () => {
  const base = {
    ...structuredClone(DEFAULT_DRAFT),
    prompt: 'old',
    imageInput: { mode: 'img2img', sourceId: 'a', sourceSha256: 'b', denoise: 0.5, resize: 'stretch' },
    assetHashes: { 'model-a': 'a'.repeat(64) },
    triggerResolutionVersion: 'visible@3',
  } as GenerationDraft;
  const draft = telegramDraft(base, 'new prompt');
  expect(draft).toMatchObject({ prompt: 'new prompt', triggerResolutionVersion: 'punctuation@2' });
  expect(draft.imageInput).toBeUndefined();
  expect(draft.assetHashes).toBeUndefined();
  expect(base.prompt).toBe('old');
});

it('keeps remote seeds random unless the chat pins one', () => {
  expect(effectiveDraft(ctx.studio, {}, 'x').seed).toBe('random');
  expect(effectiveDraft(ctx.studio, applySetting(ctx, {}, 'seed', '77').overrides, 'x').seed).toBe('77');
});

it('validates and explains each setting', () => {
  expect(() => applySetting(ctx, {}, 'model', 'alpha')).toThrow(/matches several/);
  expect(applySetting(ctx, {}, 'model', 'turbo').overrides).toMatchObject({
    checkpointId: 'model-b',
    modelSampling: null,
  });
  expect(() => applySetting(ctx, {}, 'size', '1000x1000')).toThrow(/multiples of 64/);
  expect(() => applySetting(ctx, {}, 'sampler', 'nope')).toThrow(/Unknown sampler/);
  expect(applySetting(ctx, {}, 'batch', '4').overrides.batchSize).toBe(4);

  const hires = applySetting(ctx, {}, 'hires', 'on 2 0.4').overrides;
  const sized = applySetting(ctx, hires, 'size', 'portrait').overrides;
  // Hires output follows the chat's size.
  expect(effectiveDraft(ctx.studio, sized, 'x').hiresFix).toMatchObject({ width: 1664, height: 2432, denoise: 0.4 });
  expect(effectiveDraft(ctx.studio, applySetting(ctx, sized, 'hires', 'off').overrides, 'x').hiresFix).toBeUndefined();

  const lora = applySetting(ctx, {}, 'lora', '1 0.5').overrides;
  expect(lora.loras).toEqual([{ modelId: 'l1', weight: 0.5, clipWeight: 0.5 }]);
  expect(applySetting(ctx, lora, 'lora', 'remove detail').overrides.loras).toEqual([]);

  const preset = applySetting(ctx, {}, 'preset', 'cozy');
  expect(preset.message).toContain('Cozy');
  expect(effectiveDraft(ctx.studio, preset.overrides, 'x')).toMatchObject({ checkpointId: 'model-b', steps: 40 });
});

it('splits one-off flags off the end of a prompt', () => {
  expect(splitPromptFlags('a cat --steps 30 --neg ugly, blurry --size 832x1216')).toEqual({
    prompt: 'a cat',
    flags: [
      { key: 'steps', args: '30' },
      { key: 'neg', args: 'ugly, blurry' },
      { key: 'size', args: '832x1216' },
    ],
  });
  expect(splitPromptFlags('em--dash and --unknown stay put').flags).toEqual([]);
});

it('switches to a newer model with its best settings and back to the SDXL setup', () => {
  const withModels: ControlContext = { ...ctx, imageModels: ['z-image-turbo'] };
  const tuned = applySetting(withModels, applySetting(withModels, {}, 'lora', '1 0.7').overrides, 'steps', '33');
  const newer = applySetting(withModels, tuned.overrides, 'model', 'z-image');
  expect(newer.overrides).toMatchObject({ imageModel: 'z-image-turbo', checkpointId: '', loras: [], hiresFix: null });
  expect(newer.message).toContain('Z-Image');
  expect(newer.classic).toMatchObject({ steps: 33, loras: [{ modelId: 'l1', weight: 0.7 }] });
  const draft = effectiveDraft(ctx.studio, newer.overrides, 'x');
  expect(draft.loras).toEqual([]);
  expect(draft.steps).not.toBe(33);
  // Newer models leave out LoRAs, hires and face fix.
  expect(() => applySetting(withModels, newer.overrides, 'lora', '1')).toThrow(/text only/);
  expect(() => applySetting(withModels, newer.overrides, 'hires', 'on')).toThrow(/text only/);

  const back = applySetting(
    { ...withModels, classic: newer.classic ?? undefined },
    newer.overrides,
    'model',
    'alpha xl',
  );
  expect(back.classic).toBeNull();
  expect(effectiveDraft(ctx.studio, back.overrides, 'x')).toMatchObject({
    checkpointId: 'model-a',
    steps: 33,
    loras: [{ modelId: 'l1', weight: 0.7 }],
  });
  expect(effectiveDraft(ctx.studio, back.overrides, 'x').imageModel).toBeUndefined();
});

it('leaves newer-model extras out even when the studio has them set', () => {
  const studio = {
    ...structuredClone(DEFAULT_DRAFT),
    imageModel: 'anima-turbo',
    checkpointId: '',
    loras: [{ modelId: 'l1', weight: 1, clipWeight: 1 }],
    split: { atStep: 4, stop: true },
  } as GenerationDraft;
  const draft = effectiveDraft(studio, {}, 'x');
  expect(draft.loras).toEqual([]);
  expect(draft.split).toBeUndefined();
});

it('switches single LoRAs off and on without losing them', () => {
  const added = applySetting(ctx, {}, 'lora', 'detail 0.6').overrides;
  const off = applySetting(ctx, added, 'lora', 'off detail').overrides;
  expect(off.loras).toEqual([{ modelId: 'l1', weight: 0.6, clipWeight: 0.6, off: true }]);
  const on = applySetting(ctx, off, 'lora', 'on 1').overrides;
  expect(on.loras).toEqual([{ modelId: 'l1', weight: 0.6, clipWeight: 0.6 }]);
  expect(applySetting(ctx, on, 'lora', 'remove 1').overrides.loras).toEqual([]);
});

it('takes decimal CFG and only sizes in multiples of 64', () => {
  expect(applySetting(ctx, {}, 'cfg', '4.25').overrides.cfg).toBe(4.25);
  expect(applySetting(ctx, {}, 'size', '896x1152').overrides).toMatchObject({ width: 896, height: 1152 });
  expect(() => applySetting(ctx, {}, 'size', '2560x1024')).toThrow(/2048/);
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import {
  applyRegionalLayout,
  createCharacterSettings,
  createDefaultRegionalPromptSettings,
  regionalPromptSettingsSchema,
  type RegionalMaskAsset,
  type RegionalPromptSettings,
} from '../src/shared/regional-prompt-types';
import {
  augmentRegionalPromptWorkflow,
  augmentRegionalTouchUp,
  rasterizeRegionalMask,
  touchUpGeometry,
} from '../src/shared/regional-prompt-workflow';
import { augmentHiresWorkflow } from '../src/shared/advanced-image-workflow';
import { faceCharacters } from '../src/main/automatic-faces';
import type { ComfyWorkflow, GenerationDraft, GenerationRecord, ModelAsset } from '../src/shared/types';
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
const mika = { id: 'lora:mika.safetensors', filename: 'chars/mika.safetensors', sha256: 'c'.repeat(64) };
const base: GenerationDraft = {
  ...DEFAULT_DRAFT,
  family: 'sdxl',
  checkpointId: checkpoint.id,
  prompt: 'two friends at a cafe',
  negativePrompt: 'blurry',
  width: 1216,
  height: 832,
  batchSize: 1,
  steps: 20,
  cfg: 6,
};

function characters(): RegionalPromptSettings {
  const settings = createCharacterSettings();
  settings.regions[0] = {
    ...settings.regions[0],
    positivePrompt: '1girl, silver hair',
    loras: [{ modelId: mika.id, weight: 0.8, clipWeight: 0.8 }],
  };
  settings.regions[1] = { ...settings.regions[1], positivePrompt: '1boy, glasses' };
  return settings;
}
async function masksFor(settings: RegionalPromptSettings, draft: GenerationDraft): Promise<RegionalMaskAsset[]> {
  return Promise.all(
    settings.regions.map(async region => {
      const raster = await rasterizeRegionalMask(region, draft);
      return {
        regionId: region.id,
        filename: `regional-masks/${'d'.repeat(63)}${settings.regions.indexOf(region)}.png`,
        sha256: `${'d'.repeat(63)}${settings.regions.indexOf(region)}`,
        rawMaskSha256: raster.rawMaskSha256,
        width: draft.width,
        height: draft.height,
        channel: 'red' as const,
        encoding: 'png-u8-red@1' as const,
      };
    }),
  );
}
const classes = (graph: ComfyWorkflow) => Object.values(graph).map(node => node.class_type);

describe('character layouts', () => {
  it('starts with two soft, slightly overlapping halves', () => {
    const settings = regionalPromptSettingsSchema.parse(createCharacterSettings());
    expect(settings.regions.map(region => [region.x, region.width])).toEqual([
      [0, 0.54],
      [0.46, 0.54],
    ]);
    expect(settings.regions.every(region => region.feather > 0)).toBe(true);
    expect(settings.separation).toBe(0.6);
  });
  it('keeps words and LoRAs when switching presets or adding characters', () => {
    const settings = characters();
    const stacked = applyRegionalLayout(settings, 'stack');
    expect(stacked.regions[0].positivePrompt).toBe('1girl, silver hair');
    expect(stacked.regions[0].loras).toEqual(settings.regions[0].loras);
    expect(stacked.regions[0]).toMatchObject({ x: 0, width: 1, height: 0.54 });
    const three = applyRegionalLayout(settings, 'side', 3);
    expect(three.regions).toHaveLength(3);
    expect(three.regions[2].name).toBe('C');
    expect(regionalPromptSettingsSchema.parse(three).regions[1].positivePrompt).toBe('1boy, glasses');
  });
  it('does not allow character extras on the old region recipe', () => {
    const old = createDefaultRegionalPromptSettings();
    old.regions[0].loras = [{ modelId: mika.id, weight: 1, clipWeight: 1 }];
    expect(() => regionalPromptSettingsSchema.parse(old)).toThrow('character layout');
  });
});

describe('character graph', () => {
  it('joins the scene to each character, hooks its LoRA and dims the scene inside the characters', async () => {
    const settings = characters();
    const graph = buildWorkflow(base, [checkpoint], '42', 'job');
    const result = await augmentRegionalPromptWorkflow(
      graph,
      base,
      settings,
      await masksFor(settings, base),
      undefined,
      [mika],
    );
    expect(result.plan.version).toBe('sdxl-regional-conditioning@2');
    expect(result.plan.loraFiles).toEqual([{ modelId: mika.id, filename: mika.filename, sha256: mika.sha256 }]);
    const nodes = Object.values(result.workflow);
    const texts = nodes.filter(node => node.class_type === 'CLIPTextEncode').map(node => node.inputs.text);
    expect(texts).toContain('1girl, silver hair, two friends at a cafe');
    expect(texts).toContain('1boy, glasses, two friends at a cafe');
    const hook = nodes.find(node => node.class_type === 'CreateHookLora')!;
    expect(hook.inputs).toMatchObject({ lora_name: mika.filename, strength_model: 0.8, strength_clip: 0.8 });
    // Only the first character's text goes through the hooked CLIP.
    const hooked = Object.entries(result.workflow).find(([, node]) => node.class_type === 'SetClipHooks')![0];
    const hookedTexts = nodes.filter(
      node => node.class_type === 'CLIPTextEncode' && JSON.stringify(node.inputs.clip) === JSON.stringify([hooked, 0]),
    );
    expect(hookedTexts.map(node => node.inputs.text)).toEqual(['1girl, silver hair, two friends at a cafe', 'blurry']);
    expect(nodes.find(node => node.class_type === 'SolidMask' && node.inputs.value === 0.6)).toBeTruthy();
    expect(classes(result.workflow).filter(type => type === 'ConditioningSetMask')).toHaveLength(6);
    // No LoRA leaks onto the shared model chain.
    expect(classes(result.workflow)).not.toContain('LoraLoader');
  });
  it('works with hires fix and batches, and the touch-up rewires the finished picture', async () => {
    const settings = { ...characters(), touchUp: { strength: 0.35 } };
    const draft = { ...base, batchSize: 2 };
    const graph = buildWorkflow(draft, [checkpoint], '42', 'job');
    const regional = await augmentRegionalPromptWorkflow(
      graph,
      draft,
      settings,
      await masksFor(settings, draft),
      undefined,
      [mika],
    );
    const hires = augmentHiresWorkflow(
      regional.workflow,
      draft,
      {
        method: 'latent',
        width: 1824,
        height: 1248,
        steps: 8,
        cfg: 6,
        sampler: draft.sampler,
        scheduler: draft.scheduler,
        denoise: 0.4,
        seed: '7',
      } as never,
      '7',
    );
    const touched = augmentRegionalTouchUp(hires.workflow, draft, regional.plan, { width: 1824, height: 1248 });
    const finalSave = Object.values(touched).find(
      node => node.class_type === 'SaveImage' && String(node.inputs.filename_prefix).endsWith('_final_%batch_num%'),
    )!;
    const composite = touched[(finalSave.inputs.images as [string, number])[0]];
    expect(composite.class_type).toBe('ImageCompositeMasked');
    const samplers = Object.values(touched).filter(node => node.class_type === 'KSampler');
    expect(samplers).toHaveLength(4);
    expect(samplers.slice(2).every(node => node.inputs.denoise === 0.35)).toBe(true);
    // The touch-up uses a plain LoRA loader for the character that has one.
    expect(Object.values(touched).filter(node => node.class_type === 'LoraLoader')).toHaveLength(1);
    // Base picture stays untouched.
    expect(JSON.stringify(touched['7'])).toBe(JSON.stringify(hires.workflow['7']));
  });
  it('leaves old layouts exactly as they were', async () => {
    const settings = createDefaultRegionalPromptSettings();
    settings.regions[0].positivePrompt = 'a cat';
    const graph = buildWorkflow(base, [checkpoint], '42', 'job');
    const result = await augmentRegionalPromptWorkflow(
      graph,
      base,
      settings,
      await masksFor({ ...settings, regions: [settings.regions[0]] }, base),
    );
    expect(result.plan.version).toBe('sdxl-regional-conditioning@1');
    expect(result.plan.loraFiles).toBeUndefined();
    expect(classes(result.workflow)).not.toContain('SolidMask');
    expect(augmentRegionalTouchUp(result.workflow, base, result.plan, base)).toBe(result.workflow);
  });
});

describe('touch-up geometry', () => {
  it('pads, snaps to 8 pixels and works near one megapixel', () => {
    const { crop, working, feather } = touchUpGeometry(
      { x: 0, y: 0, width: 656, height: 832 },
      { width: 1216, height: 832 },
      { width: 1216, height: 832 },
    );
    expect(crop).toEqual({ x: 0, y: 0, width: 680, height: 832 });
    expect(working.width % 8).toBe(0);
    expect(working.width * working.height).toBeGreaterThan(900_000);
    expect(feather).toEqual({ left: 0, top: 0, right: 16, bottom: 0 });
  });
});

describe('face fix per character', () => {
  it("gives each face its own character's words and LoRA", () => {
    const settings = characters();
    const plan = {
      version: 'sdxl-regional-conditioning@2',
      applied: true,
      canvas: { width: 1216, height: 832 },
      settings,
      regions: settings.regions.map((region, index) => ({
        regionId: region.id,
        pixelBounds: index === 0 ? { x: 0, y: 0, width: 657, height: 832 } : { x: 559, y: 0, width: 657, height: 832 },
      })),
      loraFiles: [{ modelId: mika.id, filename: mika.filename }],
    };
    const record = {
      width: 1824,
      height: 1248,
      resolvedPrompt: 'two friends at a cafe',
      draft: base,
      regionalPrompts: plan,
    } as unknown as GenerationRecord;
    const result = faceCharacters(
      record,
      [{ box: { x: 1500, y: 300, width: 100, height: 100 } }, { box: { x: 200, y: 300, width: 100, height: 100 } }],
      true,
    )!;
    expect(result[0]).toEqual({ prompt: '1boy, glasses, two friends at a cafe', negativePrompt: 'blurry', loras: [] });
    expect(result[1]?.loras).toEqual([{ filename: mika.filename, weight: 0.8, clipWeight: 0.8 }]);
    expect(faceCharacters(record, [{ box: { x: 200, y: 300, width: 100, height: 100 } }], false)![0]?.loras).toEqual(
      [],
    );
  });
});

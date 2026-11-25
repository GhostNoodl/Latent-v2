import { samplingValidationGraph } from './workflow';
import { nodeAllocator } from './graph-builder';
import { decodePaint, rasterizePaint } from './regional-paint';
import type { ComfyWorkflow, GenerationDraft } from './types';
import { draftSchema } from './validation';
import {
  activeRegionLoras,
  activeRegionalPromptRegions,
  characterNegative,
  characterPrompt,
  regionLoraIds,
  REGIONAL_PROMPT_LIMITS,
  regionalMaskAssetSchema,
  regionalPromptPlanSchema,
  regionalPromptRegionSchema,
  regionalPromptSettingsSchema,
  type RegionalMaskAsset,
  type RegionalPromptPlan,
  type RegionalPromptRegion,
  type RegionalPromptSettings,
  type RegionalPromptWorkflowResult,
} from './regional-prompt-types';

export interface RegionalCanvas {
  width: number;
  height: number;
}
export interface RegionalMaskGeometry {
  pixelBounds: { x: number; y: number; width: number; height: number };
  featherPixels: number;
}
function canvas(value: RegionalCanvas) {
  if (
    ![value.width, value.height].every(
      side => Number.isSafeInteger(side) && side >= 256 && side <= 2048 && side % 64 === 0,
    ) ||
    value.width * value.height > REGIONAL_PROMPT_LIMITS.maxCanvasPixels
  )
    throw new Error('Regional prompting requires a 256–2048 canvas in multiples of 64, up to 4 megapixels.');
}
export function regionalMaskGeometry(region: RegionalPromptRegion, dimensions: RegionalCanvas): RegionalMaskGeometry {
  region = regionalPromptRegionSchema.parse(region);
  canvas(dimensions);
  const left = Math.floor(region.x * dimensions.width);
  const top = Math.floor(region.y * dimensions.height);
  const right = Math.min(dimensions.width, Math.ceil(Math.min(1, region.x + region.width) * dimensions.width));
  const bottom = Math.min(dimensions.height, Math.ceil(Math.min(1, region.y + region.height) * dimensions.height));
  return {
    pixelBounds: { x: left, y: top, width: right - left, height: bottom - top },
    featherPixels: Math.min(region.feather, Math.floor(Math.min(right - left, bottom - top) / 2)),
  };
}
/** Exact u8 mask: outward pixel bounds, inward minimum-edge-distance ramp. */
export function rasterizeRegionalMaskPixels(
  region: RegionalPromptRegion,
  dimensions: RegionalCanvas,
): RegionalMaskGeometry & { pixels: Uint8Array } {
  const geometry = regionalMaskGeometry(region, dimensions);
  if (region.paint) {
    const featherPixels = Math.min(region.feather, 128);
    return {
      ...geometry,
      featherPixels,
      pixels: rasterizePaint(decodePaint(region.paint), dimensions, featherPixels),
    };
  }
  const { pixelBounds: box, featherPixels: feather } = geometry;
  const pixels = new Uint8Array(dimensions.width * dimensions.height);
  for (let y = 0; y < box.height; y++)
    for (let x = 0; x < box.width; x++) {
      const distance = Math.min(x + 1, box.width - x, y + 1, box.height - y);
      pixels[(box.y + y) * dimensions.width + box.x + x] =
        feather === 0 ? 255 : Math.round(255 * Math.min(1, distance / feather));
    }
  return { ...geometry, pixels };
}
export async function regionalSha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer)), value =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}
export async function rasterizeRegionalMask(region: RegionalPromptRegion, dimensions: RegionalCanvas) {
  const result = rasterizeRegionalMaskPixels(region, dimensions);
  return { ...result, rawMaskSha256: await regionalSha256(result.pixels) };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const linkEquals = (value: unknown, expected: [string, number]) => JSON.stringify(value) === JSON.stringify(expected);
function validateBase(workflow: ComfyWorkflow, draft: GenerationDraft): [string, number] {
  workflow = samplingValidationGraph(workflow, draft);
  const expected: Record<string, string> = {
    '1': 'CheckpointLoaderSimple',
    '2': 'CLIPTextEncode',
    '3': 'CLIPTextEncode',
    '4': 'EmptyLatentImage',
    '5': 'KSampler',
    '6': 'VAEDecode',
    '7': 'SaveImage',
  };
  for (const [id, type] of Object.entries(expected))
    if (workflow[id]?.class_type !== type)
      throw new Error('Regional prompting requires the baseline workflow at nodes 1–7.');
  for (const [id, node] of Object.entries(workflow))
    if (!/^\d{1,6}$/.test(id) || (!expected[id] && node.class_type !== 'LoraLoader'))
      throw new Error('Regional prompting cannot yet combine with another advanced workflow.');
  for (const [actual, expectedLink] of [
    [workflow['5'].inputs.positive, ['2', 0]],
    [workflow['5'].inputs.negative, ['3', 0]],
    [workflow['5'].inputs.latent_image, ['4', 0]],
    [workflow['6'].inputs.samples, ['5', 0]],
    [workflow['6'].inputs.vae, ['1', 2]],
    [workflow['7'].inputs.images, ['6', 0]],
  ] as Array<[unknown, [string, number]]>)
    if (!linkEquals(actual, expectedLink))
      throw new Error('The baseline conditioning, latent or output links were changed.');
  if (
    workflow['4'].inputs.width !== draft.width ||
    workflow['4'].inputs.height !== draft.height ||
    workflow['4'].inputs.batch_size !== draft.batchSize
  )
    throw new Error('The regional canvas differs from the base latent.');
  const clip = workflow['2'].inputs.clip;
  if (
    !Array.isArray(clip) ||
    clip.length !== 2 ||
    typeof clip[0] !== 'string' ||
    clip[1] !== 1 ||
    !linkEquals(workflow['3'].inputs.clip, clip as [string, number]) ||
    !linkEquals(workflow['5'].inputs.model, [clip[0], 0])
  )
    throw new Error('Regions require the same post-LoRA CLIP and model chain as the global prompts.');
  let current = clip[0];
  const visited = new Set<string>();
  while (current !== '1') {
    if (visited.has(current)) throw new Error('The regional model chain contains a cycle.');
    visited.add(current);
    const node = workflow[current];
    const previous = node?.inputs.clip;
    if (
      node?.class_type !== 'LoraLoader' ||
      !Array.isArray(previous) ||
      typeof previous[0] !== 'string' ||
      previous[1] !== 1 ||
      !linkEquals(node.inputs.model, [previous[0], 0])
    )
      throw new Error('The regional model chain is not a baseline LoRA chain.');
    current = previous[0];
  }
  if (Object.entries(workflow).some(([id, node]) => node.class_type === 'LoraLoader' && !visited.has(id)))
    throw new Error('The regional graph contains an unused or disconnected LoRA.');
  return [clip[0], 1];
}

/** A character LoRA file main has checked is installed and matches the draft. */
export interface RegionLoraAsset {
  id: string;
  filename: string;
  sha256?: string;
}

/** Main provides only immutable mask PNGs it independently verified. */
export async function augmentRegionalPromptWorkflow(
  workflow: ComfyWorkflow,
  draft: GenerationDraft,
  input: RegionalPromptSettings,
  suppliedMasks: RegionalMaskAsset[],
  frozenPlan?: RegionalPromptPlan,
  loraAssets: RegionLoraAsset[] = [],
): Promise<RegionalPromptWorkflowResult> {
  draftSchema.parse(draft);
  const settings = regionalPromptSettingsSchema.parse(input);
  const dimensions = { width: draft.width, height: draft.height };
  canvas(dimensions);
  if (
    !['sdxl', 'illustrious'].includes(draft.family) ||
    draft.imageInput ||
    draft.upscale ||
    draft.controlNet ||
    draft.split
  )
    throw new Error('Characters work for SDXL and Illustrious pictures made from text, without ControlNet.');
  const v2 = settings.separation !== undefined;
  const clip = validateBase(workflow, draft);
  const regions = activeRegionalPromptRegions(settings);
  if (settings.enabled && !regions.length)
    throw new Error(
      'Enter a positive or negative prompt in at least one region with strength above zero, or turn regional prompting off.',
    );
  const masks = suppliedMasks.map(asset => regionalMaskAssetSchema.parse(asset));
  if (masks.length !== regions.length || new Set(masks.map(asset => asset.regionId)).size !== masks.length)
    throw new Error('The saved masks do not match the active regional prompts.');
  const entries: RegionalPromptPlan['regions'] = [];
  for (const region of regions) {
    const mask = masks.find(asset => asset.regionId === region.id);
    if (!mask || mask.width !== dimensions.width || mask.height !== dimensions.height)
      throw new Error(`The saved mask for ${region.name} has different dimensions or is missing.`);
    const raster = await rasterizeRegionalMask(region, dimensions);
    if (raster.rawMaskSha256 !== mask.rawMaskSha256)
      throw new Error(`The saved mask for ${region.name} differs from its recorded rectangle or feather.`);
    entries.push({ regionId: region.id, pixelBounds: raster.pixelBounds, featherPixels: raster.featherPixels, mask });
  }
  const loraFiles = regionLoraIds(settings).map(id => {
    const asset = loraAssets.find(item => item.id === id);
    if (!asset) throw new Error("A character's LoRA is missing. Add it again or remove it.");
    return { modelId: id, filename: asset.filename, ...(asset.sha256 ? { sha256: asset.sha256 } : {}) };
  });
  const data = {
    version: v2 ? ('sdxl-regional-conditioning@2' as const) : ('sdxl-regional-conditioning@1' as const),
    canvas: dimensions,
    settings,
    regions: entries,
    maskPolicy: 'outward-pixels-inward-linear-u8@1' as const,
    promptPolicy: v2 ? ('regions-joined-with-scene@2' as const) : ('literal-regions-global-separate@1' as const),
    conditioningPolicy: v2
      ? ('scene-dimmed-hooked-regions@2' as const)
      : ('ordered-mask-combine-default-area@1' as const),
    ...(v2 ? { loraFiles } : {}),
    clip,
    applied: regions.length > 0,
  };
  const computed = regionalPromptPlanSchema.parse({
    ...data,
    sha256: await regionalSha256(new TextEncoder().encode(canonical(data))),
  });
  const plan = frozenPlan ? regionalPromptPlanSchema.parse(frozenPlan) : computed;
  if (canonical(plan) !== canonical(computed))
    throw new Error(
      'The frozen regional recipe differs from its prompts, order, geometry, masks or model chain. Restore its original recipe or deliberately start a new layout.',
    );
  const graph = structuredClone(workflow);
  const add = nodeAllocator(graph);
  const conditioning: Record<'positive' | 'negative', [string, number]> = { positive: ['2', 0], negative: ['3', 0] };
  if (v2) {
    if (regions.length) buildCharacters(graph, add, plan, regions, clip, conditioning);
  } else
    for (let index = 0; index < regions.length; index++) {
      const region = regions[index];
      const mask = add('LoadImageMask', { image: entries[index].mask.filename, channel: 'red' });
      for (const side of ['positive', 'negative'] as const) {
        const text = side === 'positive' ? region.positivePrompt : region.negativePrompt;
        if (!text.trim()) continue;
        const encoded = add('CLIPTextEncode', { text, clip: [...clip] });
        const masked = add('ConditioningSetMask', {
          conditioning: [encoded, 0],
          mask: [mask, 0],
          strength: region.strength,
          set_cond_area: 'default',
        });
        const combined = add('ConditioningCombine', {
          conditioning_1: conditioning[side],
          conditioning_2: [masked, 0],
        });
        conditioning[side] = [combined, 0];
      }
    }
  if (regions.length) {
    graph['5'].inputs.positive = conditioning.positive;
    graph['5'].inputs.negative = conditioning.negative;
  }
  return { workflow: graph, workflowVersion: plan.version, plan: structuredClone(plan) };
}

type Link = [string, number];
type Add = ReturnType<typeof nodeAllocator>;
const fileFor = (plan: RegionalPromptPlan, modelId: string) => {
  const file = plan.loraFiles?.find(entry => entry.modelId === modelId);
  if (!file) throw new Error("A character's LoRA is missing from the saved recipe.");
  return file.filename;
};

/**
 * v2 characters. Each character gets the scene text after its own words, its own
 * LoRAs through hooks (they only touch conditioning that carries them), and a
 * negative of its own so guidance stays balanced. The scene steps back inside
 * the characters by `separation`, so their words win where they stand.
 */
function buildCharacters(
  graph: ComfyWorkflow,
  add: Add,
  plan: RegionalPromptPlan,
  regions: RegionalPromptRegion[],
  clip: Link,
  conditioning: Record<'positive' | 'negative', Link>,
) {
  const scene = String(graph['2'].inputs.text ?? '');
  const sceneNegative = String(graph['3'].inputs.text ?? '');
  const masks: Link[] = [];
  const characters: Record<'positive' | 'negative', Link[]> = { positive: [], negative: [] };
  for (let index = 0; index < regions.length; index++) {
    const region = regions[index];
    const mask = add('LoadImageMask', { image: plan.regions[index].mask.filename, channel: 'red' });
    masks.push([mask, 0]);
    let characterClip: Link = [...clip];
    let hooks: Link | undefined;
    for (const lora of activeRegionLoras(region)) {
      const hook = add('CreateHookLora', {
        lora_name: fileFor(plan, lora.modelId),
        strength_model: lora.weight,
        strength_clip: lora.clipWeight,
        ...(hooks ? { prev_hooks: hooks } : {}),
      });
      hooks = [hook, 0];
    }
    if (hooks)
      characterClip = [
        add('SetClipHooks', { clip: characterClip, apply_to_conds: true, schedule_clip: false, hooks }),
        0,
      ];
    for (const side of ['positive', 'negative'] as const) {
      const text = side === 'positive' ? characterPrompt(region, scene) : characterNegative(region, sceneNegative);
      const encoded = add('CLIPTextEncode', { text, clip: characterClip });
      const masked = add('ConditioningSetMask', {
        conditioning: [encoded, 0],
        mask: [mask, 0],
        strength: region.strength,
        set_cond_area: 'default',
      });
      characters[side].push([masked, 0]);
    }
  }
  const separation = plan.settings.separation ?? 0;
  if (separation > 0) {
    let union = masks[0];
    for (const mask of masks.slice(1))
      union = [add('MaskComposite', { destination: union, source: mask, x: 0, y: 0, operation: 'add' }), 0];
    const { width, height } = plan.canvas;
    const amount = add('SolidMask', { value: separation, width, height });
    const dimmed = add('MaskComposite', { destination: union, source: [amount, 0], x: 0, y: 0, operation: 'multiply' });
    const full = add('SolidMask', { value: 1, width, height });
    const sceneMask = add('MaskComposite', {
      destination: [full, 0],
      source: [dimmed, 0],
      x: 0,
      y: 0,
      operation: 'subtract',
    });
    for (const side of ['positive', 'negative'] as const)
      conditioning[side] = [
        add('ConditioningSetMask', {
          conditioning: conditioning[side],
          mask: [sceneMask, 0],
          strength: 1,
          set_cond_area: 'default',
        }),
        0,
      ];
  }
  for (const side of ['positive', 'negative'] as const)
    for (const link of characters[side])
      conditioning[side] = [
        add('ConditioningCombine', { conditioning_1: conditioning[side], conditioning_2: link }),
        0,
      ];
}

/** Where the touch-up pass works, in final picture pixels. */
export function touchUpGeometry(
  bounds: { x: number; y: number; width: number; height: number },
  base: RegionalCanvas,
  final: RegionalCanvas,
) {
  const sx = final.width / base.width;
  const sy = final.height / base.height;
  const pad = Math.round(24 * Math.max(sx, sy));
  const left = Math.max(0, Math.floor((bounds.x * sx - pad) / 8) * 8);
  const top = Math.max(0, Math.floor((bounds.y * sy - pad) / 8) * 8);
  const right = Math.min(final.width, Math.ceil(((bounds.x + bounds.width) * sx + pad) / 8) * 8);
  const bottom = Math.min(final.height, Math.ceil(((bounds.y + bounds.height) * sy + pad) / 8) * 8);
  const crop = { x: left, y: top, width: right - left, height: bottom - top };
  // Work near one megapixel, never smaller than the crop itself, and at most double it.
  const scale = Math.min(2, Math.max(1, Math.sqrt((1024 * 1024) / (crop.width * crop.height))));
  const working = {
    width: Math.max(64, Math.round((crop.width * scale) / 8) * 8),
    height: Math.max(64, Math.round((crop.height * scale) / 8) * 8),
  };
  const soft = Math.round(16 * Math.max(sx, sy));
  const feather = {
    left: left > 0 ? soft : 0,
    top: top > 0 ? soft : 0,
    right: right < final.width ? soft : 0,
    bottom: bottom < final.height ? soft : 0,
  };
  return { crop, working, feather };
}

/**
 * Touch up each character: after the picture (and hires fix) is done, crop each
 * character's area, redo it near one megapixel with only that character's words and
 * LoRAs, and blend it back through its own soft mask. Rewires the last saved picture.
 */
export function augmentRegionalTouchUp(
  workflow: ComfyWorkflow,
  draft: GenerationDraft,
  planInput: RegionalPromptPlan,
  final: RegionalCanvas,
): ComfyWorkflow {
  const plan = regionalPromptPlanSchema.parse(planInput);
  const touchUp = plan.settings.touchUp;
  if (!touchUp || plan.version !== 'sdxl-regional-conditioning@2' || !plan.applied) return workflow;
  const graph = structuredClone(workflow);
  const saves = Object.entries(graph).filter(([, node]) => node.class_type === 'SaveImage');
  const finalSave =
    saves.find(([, node]) => String(node.inputs.filename_prefix).endsWith('_final_%batch_num%'))?.[0] ??
    (saves.length === 1 && saves[0][0] === '7' ? '7' : undefined);
  if (!finalSave) throw new Error('The touch-up pass could not find the finished picture.');
  const base = graph['5']?.inputs;
  if (!base || graph['5'].class_type !== 'KSampler') throw new Error('The touch-up pass needs the base sampler.');
  const model = (graph['5'].inputs.model as Link) ?? ['1', 0];
  const clip = graph['2'].inputs.clip as Link;
  const scene = String(graph['2'].inputs.text ?? '');
  const sceneNegative = String(graph['3'].inputs.text ?? '');
  const vae: Link = ['1', 2];
  const add = nodeAllocator(graph);
  const regions = activeRegionalPromptRegions(plan.settings);
  const scaled = final.width !== plan.canvas.width || final.height !== plan.canvas.height;
  let previous = graph[finalSave].inputs.images as Link;
  for (let index = 0; index < regions.length; index++) {
    const region = regions[index];
    const entry = plan.regions[index];
    const { crop, working, feather } = touchUpGeometry(entry.pixelBounds, plan.canvas, final);
    let characterModel: Link = [...model];
    let characterClip: Link = [...clip];
    for (const lora of activeRegionLoras(region)) {
      const loader = add('LoraLoader', {
        model: characterModel,
        clip: characterClip,
        lora_name: fileFor(plan, lora.modelId),
        strength_model: lora.weight,
        strength_clip: lora.clipWeight,
      });
      characterModel = [loader, 0];
      characterClip = [loader, 1];
    }
    const positive = add('CLIPTextEncode', { text: characterPrompt(region, scene), clip: characterClip });
    const negative = add('CLIPTextEncode', { text: characterNegative(region, sceneNegative), clip: characterClip });
    let mask: Link = [add('LoadImageMask', { image: entry.mask.filename, channel: 'red' }), 0];
    if (scaled) {
      const picture = add('MaskToImage', { mask });
      const resized = add('ImageScale', {
        image: [picture, 0],
        upscale_method: 'bilinear',
        width: final.width,
        height: final.height,
        crop: 'disabled',
      });
      mask = [add('ImageToMask', { image: [resized, 0], channel: 'red' }), 0];
    }
    let cropMask: Link = [add('CropMask', { mask, ...crop }), 0];
    if (feather.left || feather.top || feather.right || feather.bottom)
      cropMask = [add('FeatherMask', { mask: cropMask, ...feather }), 0];
    const cropped = add('ImageCrop', { image: previous, ...crop });
    const enlarged = add('ImageScale', {
      image: [cropped, 0],
      upscale_method: 'lanczos',
      ...working,
      crop: 'disabled',
    });
    const encoded = add('VAEEncode', { pixels: [enlarged, 0], vae });
    const sampler = add('KSampler', {
      model: characterModel,
      positive: [positive, 0],
      negative: [negative, 0],
      latent_image: [encoded, 0],
      seed: (Number(base.seed) + 101 + index) % (Number.MAX_SAFE_INTEGER + 1),
      steps: draft.steps,
      cfg: draft.cfg,
      sampler_name: draft.sampler,
      scheduler: draft.scheduler,
      denoise: touchUp.strength,
    });
    const decoded = add('VAEDecode', { samples: [sampler, 0], vae });
    const returned = add('ImageScale', {
      image: [decoded, 0],
      upscale_method: 'lanczos',
      width: crop.width,
      height: crop.height,
      crop: 'disabled',
    });
    previous = [
      add('ImageCompositeMasked', {
        destination: previous,
        source: [returned, 0],
        x: crop.x,
        y: crop.y,
        resize_source: false,
        mask: cropMask,
      }),
      0,
    ];
  }
  graph[finalSave].inputs.images = previous;
  return graph;
}

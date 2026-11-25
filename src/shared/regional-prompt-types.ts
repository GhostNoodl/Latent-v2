import { z } from 'zod';
import type { ComfyWorkflow } from './types';
import { PAINT_PATTERN, PAINT_TEXT_LENGTH, decodePaint, paintBounds } from './regional-paint';

export const REGIONAL_PROMPT_LIMITS = Object.freeze({
  maxRegions: 4,
  maxPromptLength: 4000,
  minExtent: 0.01,
  maxFeather: 256,
  maxCanvasPixels: 4 * 1024 * 1024,
});
const position = z.number().finite().min(0).max(1);
const extent = z.number().finite().min(REGIONAL_PROMPT_LIMITS.minExtent).max(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const side = z.number().int().min(256).max(2048).multipleOf(64);
/** A LoRA that only works inside one character's area. */
export const regionLoraSchema = z
  .object({
    modelId: z.string().min(1).max(500),
    weight: z.number().finite(),
    clipWeight: z.number().finite(),
    off: z.boolean().optional(),
  })
  .strict();
export type RegionLora = z.infer<typeof regionLoraSchema>;
export const REGIONAL_LAYOUTS = ['side', 'stack', 'big-small', 'custom'] as const;
export type RegionalLayout = (typeof REGIONAL_LAYOUTS)[number];
export const regionalPromptRegionSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/),
    name: z.string().trim().min(1).max(80),
    x: position,
    y: position,
    width: extent,
    height: extent,
    positivePrompt: z.string().max(REGIONAL_PROMPT_LIMITS.maxPromptLength),
    negativePrompt: z.string().max(REGIONAL_PROMPT_LIMITS.maxPromptLength),
    strength: z.number().finite().min(0).max(2),
    feather: z.number().int().min(0).max(REGIONAL_PROMPT_LIMITS.maxFeather),
    /** A painted area (see regional-paint.ts). The box above is then just its bounds. */
    paint: z.string().length(PAINT_TEXT_LENGTH).regex(PAINT_PATTERN).optional(),
    /** Character LoRAs, applied only inside this area. */
    loras: z.array(regionLoraSchema).max(4).optional(),
  })
  .strict()
  .superRefine((region, ctx) => {
    if (region.paint !== undefined && !paintBounds(decodePaint(region.paint)))
      ctx.addIssue({ code: 'custom', message: 'Paint some of the area, or remove the region.' });
    if (region.x + region.width > 1 + Number.EPSILON * 4 || region.y + region.height > 1 + Number.EPSILON * 4)
      ctx.addIssue({ code: 'custom', message: 'Every region must fit inside the canvas.' });
  });
export type RegionalPromptRegion = z.infer<typeof regionalPromptRegionSchema>;
export const regionalPromptSettingsSchema = z
  .object({
    enabled: z.boolean(),
    regions: z.array(regionalPromptRegionSchema).max(REGIONAL_PROMPT_LIMITS.maxRegions),
    /**
     * Character layouts (v2). How much the shared scene prompt steps back inside
     * each character's area, 0 to 1. Its presence switches on the v2 recipe:
     * scene text joined to each character, LoRAs per character.
     */
    separation: z.number().finite().min(0).max(1).optional(),
    /** Redo each character's area after the picture is made, with only its own prompt and LoRAs. */
    touchUp: z
      .object({ strength: z.number().finite().min(0.05).max(0.8) })
      .strict()
      .optional(),
    /** The preset the layout started from, for the editor only. */
    layout: z.enum(REGIONAL_LAYOUTS).optional(),
  })
  .strict()
  .superRefine((settings, ctx) => {
    if (new Set(settings.regions.map(region => region.id)).size !== settings.regions.length)
      ctx.addIssue({ code: 'custom', message: 'Region IDs must be unique.' });
    if (
      settings.separation === undefined &&
      (settings.touchUp || settings.regions.some(region => region.loras?.length))
    )
      ctx.addIssue({ code: 'custom', message: 'Character LoRAs and touch-ups need a character layout.' });
  });
export type RegionalPromptSettings = z.infer<typeof regionalPromptSettingsSchema>;

export const regionalMaskAssetSchema = z
  .object({
    regionId: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9_-]+$/),
    filename: z.string().regex(/^regional-masks\/[a-f0-9]{64}\.png$/),
    sha256: hash,
    rawMaskSha256: hash,
    width: side,
    height: side,
    channel: z.literal('red'),
    encoding: z.literal('png-u8-red@1'),
  })
  .strict()
  .refine(
    asset => asset.filename === `regional-masks/${asset.sha256}.png`,
    'The regional mask filename must identify its exact PNG bytes.',
  );
export type RegionalMaskAsset = z.infer<typeof regionalMaskAssetSchema>;
const rect = z
  .object({
    x: z.number().int().min(0).max(2047),
    y: z.number().int().min(0).max(2047),
    width: z.number().int().min(1).max(2048),
    height: z.number().int().min(1).max(2048),
  })
  .strict();
export const regionalPromptPlanSchema = z
  .object({
    version: z.enum(['sdxl-regional-conditioning@1', 'sdxl-regional-conditioning@2']),
    canvas: z.object({ width: side, height: side }).strict(),
    settings: regionalPromptSettingsSchema,
    regions: z
      .array(
        z
          .object({
            regionId: z.string(),
            pixelBounds: rect,
            featherPixels: z.number().int().min(0).max(256),
            mask: regionalMaskAssetSchema,
          })
          .strict(),
      )
      .max(4),
    maskPolicy: z.literal('outward-pixels-inward-linear-u8@1'),
    promptPolicy: z.enum(['literal-regions-global-separate@1', 'regions-joined-with-scene@2']),
    conditioningPolicy: z.enum(['ordered-mask-combine-default-area@1', 'scene-dimmed-hooked-regions@2']),
    /** v2: the exact LoRA files each character uses. */
    loraFiles: z
      .array(
        z
          .object({
            modelId: z.string().min(1).max(500),
            filename: z.string().min(1).max(1000),
            sha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .strict(),
      )
      .max(16)
      .optional(),
    clip: z.tuple([z.string().regex(/^\d{1,6}$/), z.number().int().min(0).max(32)]),
    applied: z.boolean(),
    sha256: hash,
  })
  .strict()
  .superRefine((plan, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
    const active = activeRegionalPromptRegions(plan.settings);
    if (plan.applied !== active.length > 0 || plan.regions.length !== active.length)
      fail('Regional mask entries do not match the active regions.');
    const v2 = plan.settings.separation !== undefined;
    if (
      (plan.version === 'sdxl-regional-conditioning@2') !== v2 ||
      (plan.promptPolicy === 'regions-joined-with-scene@2') !== v2 ||
      (plan.conditioningPolicy === 'scene-dimmed-hooked-regions@2') !== v2 ||
      (plan.loraFiles !== undefined) !== v2
    )
      fail('The regional recipe version does not match its settings.');
    if (plan.canvas.width * plan.canvas.height > REGIONAL_PROMPT_LIMITS.maxCanvasPixels)
      fail('The regional canvas exceeds the initial size bound.');
    for (let index = 0; index < plan.regions.length; index++) {
      const entry = plan.regions[index];
      const region = active[index];
      if (
        !region ||
        region.id !== entry.regionId ||
        entry.mask.regionId !== entry.regionId ||
        entry.mask.width !== plan.canvas.width ||
        entry.mask.height !== plan.canvas.height
      )
        fail('Regional mask identity, order or dimensions are inconsistent.');
      if (
        entry.pixelBounds.x + entry.pixelBounds.width > plan.canvas.width ||
        entry.pixelBounds.y + entry.pixelBounds.height > plan.canvas.height
      )
        fail('Regional pixel bounds exceed the canvas.');
    }
  });
export type RegionalPromptPlan = z.infer<typeof regionalPromptPlanSchema>;
export interface RegionalPromptWorkflowResult {
  workflow: ComfyWorkflow;
  workflowVersion: RegionalPromptPlan['version'];
  plan: RegionalPromptPlan;
}

export function activeRegionalPromptRegions(settings: RegionalPromptSettings): RegionalPromptRegion[] {
  return settings.enabled
    ? settings.regions.filter(
        region =>
          region.strength > 0 && (region.positivePrompt.trim().length > 0 || region.negativePrompt.trim().length > 0),
      )
    : [];
}

/** The LoRAs a character really uses: switched on and with some weight. */
export function activeRegionLoras(region: RegionalPromptRegion): RegionLora[] {
  return (region.loras ?? []).filter(lora => !lora.off && (lora.weight !== 0 || lora.clipWeight !== 0));
}
/** Every LoRA id the active characters use, in first-use order. */
export function regionLoraIds(settings: RegionalPromptSettings): string[] {
  return [
    ...new Set(
      settings.separation === undefined
        ? []
        : activeRegionalPromptRegions(settings).flatMap(region => activeRegionLoras(region).map(lora => lora.modelId)),
    ),
  ];
}
const joinText = (...parts: string[]) =>
  parts
    .map(part => part.trim())
    .filter(Boolean)
    .join(', ');
/** v2: a character's own words come first, then the shared scene. */
export function characterPrompt(region: RegionalPromptRegion, scene: string) {
  return joinText(region.positivePrompt, scene);
}
export function characterNegative(region: RegionalPromptRegion, sceneNegative: string) {
  return joinText(region.negativePrompt, sceneNegative);
}

const character = (id: string, name: string, box: { x: number; y: number; width: number; height: number }) => ({
  id,
  name,
  ...box,
  positivePrompt: '',
  negativePrompt: '',
  strength: 1,
  feather: 48,
});
const LAYOUT_BOXES: Record<
  Exclude<RegionalLayout, 'custom'>,
  Array<{ x: number; y: number; width: number; height: number }>
> = {
  // Neighbours overlap a little so the soft edges blend instead of leaving a seam.
  side: [
    { x: 0, y: 0, width: 0.54, height: 1 },
    { x: 0.46, y: 0, width: 0.54, height: 1 },
  ],
  stack: [
    { x: 0, y: 0, width: 1, height: 0.54 },
    { x: 0, y: 0.46, width: 1, height: 0.54 },
  ],
  'big-small': [
    { x: 0, y: 0, width: 0.66, height: 1 },
    { x: 0.6, y: 0.3, width: 0.4, height: 0.7 },
  ],
};
/** Side by side for three or four characters: equal columns that overlap a little. */
function columns(count: number) {
  const overlap = 0.04;
  return Array.from({ length: count }, (_, index) => {
    const x = Math.max(0, index / count - overlap);
    const right = Math.min(1, (index + 1) / count + overlap);
    return { x, y: 0, width: right - x, height: 1 };
  });
}
const NAMES = ['A', 'B', 'C', 'D'];
/**
 * Lays out characters with a preset, keeping each one's words and LoRAs.
 * Big and small only fits two; more characters fall back to columns.
 */
export function applyRegionalLayout(
  settings: RegionalPromptSettings,
  layout: Exclude<RegionalLayout, 'custom'>,
  count = Math.max(2, settings.regions.length),
): RegionalPromptSettings {
  count = Math.min(REGIONAL_PROMPT_LIMITS.maxRegions, Math.max(1, count));
  const boxes =
    count === 1
      ? [{ x: 0, y: 0, width: 1, height: 1 }]
      : count === 2
        ? LAYOUT_BOXES[layout]
        : layout === 'stack'
          ? columns(count).map(box => ({ x: 0, y: box.x, width: 1, height: box.width }))
          : columns(count);
  const regions = boxes.map((box, index) => {
    const previous = settings.regions[index];
    const fresh = character(`character_${NAMES[index].toLowerCase()}`, NAMES[index], box);
    if (!previous) return fresh;
    const { paint: _paint, ...kept } = previous;
    return { ...kept, ...box, feather: Math.max(previous.feather, 32) };
  });
  return {
    ...settings,
    separation: settings.separation ?? 0.6,
    layout,
    regions,
  };
}

export function createCharacterSettings(): RegionalPromptSettings {
  return applyRegionalLayout({ enabled: true, regions: [] }, 'side', 2);
}

export function createDefaultRegionalPromptSettings(): RegionalPromptSettings {
  return {
    enabled: true,
    regions: [
      {
        id: 'region_left',
        name: 'Left region',
        x: 0,
        y: 0,
        width: 0.5,
        height: 1,
        positivePrompt: '',
        negativePrompt: '',
        strength: 1,
        feather: 0,
      },
      {
        id: 'region_right',
        name: 'Right region',
        x: 0.5,
        y: 0,
        width: 0.5,
        height: 1,
        positivePrompt: '',
        negativePrompt: '',
        strength: 1,
        feather: 0,
      },
    ],
  };
}

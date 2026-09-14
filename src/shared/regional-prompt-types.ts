import { z } from 'zod';
import type { ComfyWorkflow } from './types';

export const REGIONAL_PROMPT_LIMITS = Object.freeze({ maxRegions: 4, maxPromptLength: 4000, minExtent: 0.01, maxFeather: 256, maxCanvasPixels: 4 * 1024 * 1024 });
const position = z.number().finite().min(0).max(1);
const extent = z.number().finite().min(REGIONAL_PROMPT_LIMITS.minExtent).max(1);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const side = z.number().int().min(256).max(2048).multipleOf(64);
export const regionalPromptRegionSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/), name: z.string().trim().min(1).max(80),
  x: position, y: position, width: extent, height: extent,
  positivePrompt: z.string().max(REGIONAL_PROMPT_LIMITS.maxPromptLength), negativePrompt: z.string().max(REGIONAL_PROMPT_LIMITS.maxPromptLength),
  strength: z.number().finite().min(0).max(2), feather: z.number().int().min(0).max(REGIONAL_PROMPT_LIMITS.maxFeather),
}).strict().superRefine((region, ctx) => {
  if (region.x + region.width > 1 + Number.EPSILON * 4 || region.y + region.height > 1 + Number.EPSILON * 4) ctx.addIssue({ code: 'custom', message: 'Every region must fit inside the canvas.' });
});
export type RegionalPromptRegion = z.infer<typeof regionalPromptRegionSchema>;
export const regionalPromptSettingsSchema = z.object({ enabled: z.boolean(), regions: z.array(regionalPromptRegionSchema).max(REGIONAL_PROMPT_LIMITS.maxRegions) }).strict().superRefine((settings, ctx) => {
  if (new Set(settings.regions.map(region => region.id)).size !== settings.regions.length) ctx.addIssue({ code: 'custom', message: 'Region IDs must be unique.' });
});
export type RegionalPromptSettings = z.infer<typeof regionalPromptSettingsSchema>;

export const regionalMaskAssetSchema = z.object({ regionId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/), filename: z.string().regex(/^regional-masks\/[a-f0-9]{64}\.png$/), sha256: hash, rawMaskSha256: hash, width: side, height: side, channel: z.literal('red'), encoding: z.literal('png-u8-red@1') }).strict().refine(asset => asset.filename === `regional-masks/${asset.sha256}.png`, 'The regional mask filename must identify its exact PNG bytes.');
export type RegionalMaskAsset = z.infer<typeof regionalMaskAssetSchema>;
const rect = z.object({ x: z.number().int().min(0).max(2047), y: z.number().int().min(0).max(2047), width: z.number().int().min(1).max(2048), height: z.number().int().min(1).max(2048) }).strict();
export const regionalPromptPlanSchema = z.object({
  version: z.literal('sdxl-regional-conditioning@1'), canvas: z.object({ width: side, height: side }).strict(),
  settings: regionalPromptSettingsSchema,
  regions: z.array(z.object({ regionId: z.string(), pixelBounds: rect, featherPixels: z.number().int().min(0).max(256), mask: regionalMaskAssetSchema }).strict()).max(4),
  maskPolicy: z.literal('outward-pixels-inward-linear-u8@1'),
  promptPolicy: z.literal('literal-regions-global-separate@1'),
  conditioningPolicy: z.literal('ordered-mask-combine-default-area@1'),
  clip: z.tuple([z.string().regex(/^\d{1,6}$/), z.number().int().min(0).max(32)]),
  applied: z.boolean(), sha256: hash,
}).strict().superRefine((plan, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const active = activeRegionalPromptRegions(plan.settings);
  if (plan.applied !== (active.length > 0) || plan.regions.length !== active.length) fail('Regional mask entries do not match the active regions.');
  if (plan.canvas.width * plan.canvas.height > REGIONAL_PROMPT_LIMITS.maxCanvasPixels) fail('The regional canvas exceeds the initial size bound.');
  for (let index = 0; index < plan.regions.length; index++) {
    const entry = plan.regions[index]; const region = active[index];
    if (!region || region.id !== entry.regionId || entry.mask.regionId !== entry.regionId || entry.mask.width !== plan.canvas.width || entry.mask.height !== plan.canvas.height) fail('Regional mask identity, order or dimensions are inconsistent.');
    if (entry.pixelBounds.x + entry.pixelBounds.width > plan.canvas.width || entry.pixelBounds.y + entry.pixelBounds.height > plan.canvas.height) fail('Regional pixel bounds exceed the canvas.');
  }
});
export type RegionalPromptPlan = z.infer<typeof regionalPromptPlanSchema>;
export interface RegionalPromptWorkflowResult { workflow: ComfyWorkflow; workflowVersion: 'sdxl-regional-conditioning@1'; plan: RegionalPromptPlan; }

export function activeRegionalPromptRegions(settings: RegionalPromptSettings): RegionalPromptRegion[] {
  return settings.enabled ? settings.regions.filter(region => region.strength > 0 && (region.positivePrompt.trim().length > 0 || region.negativePrompt.trim().length > 0)) : [];
}

export function createDefaultRegionalPromptSettings(): RegionalPromptSettings {
  return { enabled: true, regions: [
    { id: 'region_left', name: 'Left region', x: 0, y: 0, width: 0.5, height: 1, positivePrompt: '', negativePrompt: '', strength: 1, feather: 0 },
    { id: 'region_right', name: 'Right region', x: 0.5, y: 0, width: 0.5, height: 1, positivePrompt: '', negativePrompt: '', strength: 1, feather: 0 },
  ] };
}

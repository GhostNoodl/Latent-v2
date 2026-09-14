import { z } from 'zod';
import type { ComfyWorkflow } from './types';

export const CROP_INPAINT_LIMITS = Object.freeze({ maxSourceSide: 8192, absoluteMaxSourcePixels: 32 * 1024 * 1024, initialMaxSourcePixels: 4 * 1024 * 1024, minWorkingSide: 256, maxWorkingSide: 2048, maxPadding: 2048, alignment: 8 });
export const DEFAULT_CROP_INPAINT_SETTINGS = Object.freeze({ mode: 'refine' as const, contextPadding: 128 });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/);
const sourceSide = z.number().int().min(1).max(CROP_INPAINT_LIMITS.maxSourceSide);
const workingSide = z.number().int().min(256).max(2048).multipleOf(64);
export const cropRectangleSchema = z.object({ x: z.number().int().min(0).max(8191), y: z.number().int().min(0).max(8191), width: sourceSide, height: sourceSide }).strict();
export const cropInpaintSettingsSchema = z.object({ mode: z.enum(['replace', 'refine']), contextPadding: z.number().int().min(0).max(CROP_INPAINT_LIMITS.maxPadding) }).strict();
export type CropInpaintSettings = z.infer<typeof cropInpaintSettingsSchema>;
export type CropRectangle = z.infer<typeof cropRectangleSchema>;

export const cropInpaintPlanSchema = z.object({
  version: z.literal('sdxl-crop-inpaint@1'),
  source: z.object({ id, sha256: hash, width: sourceSide, height: sourceSide }).strict(),
  mask: z.object({ id, sha256: hash, channel: z.literal('red'), threshold: z.literal('>0') }).strict(),
  selectedPixels: z.number().int().min(1).max(CROP_INPAINT_LIMITS.initialMaxSourcePixels),
  maskBounds: cropRectangleSchema, crop: cropRectangleSchema,
  alignment: z.literal('outward-grid-8-clamped-v1'),
  working: z.object({ width: workingSide, height: workingSide, resize: z.literal('stretch'), imageInterpolation: z.literal('lanczos'), maskInterpolation: z.literal('bilinear') }).strict(),
  settings: cropInpaintSettingsSchema.extend({ denoise: z.number().min(0).max(1), replaceGrowMaskBy: z.literal(0) }).strict(),
  derivedMask: z.object({ encoding: z.literal('u8-red-crop-row-major@1'), stage: z.literal('before-working-resize'), sha256: hash, width: sourceSide, height: sourceSide }).strict(),
  output: z.object({ width: sourceSide, height: sourceSide, batchSize: z.literal(1), originalAlpha: z.literal('retained') }).strict(),
  preservation: z.literal('original-mask-zero-pixels'),
}).strict().superRefine((plan, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const { source, maskBounds, crop } = plan;
  if (source.width * source.height > CROP_INPAINT_LIMITS.initialMaxSourcePixels) fail('The initial crop-inpaint profile supports source canvases up to 4 megapixels.');
  for (const region of [maskBounds, crop]) if (region.x + region.width > source.width || region.y + region.height > source.height) fail('The inpaint rectangle lies outside its original source.');
  if (crop.x > maskBounds.x || crop.y > maskBounds.y || crop.x + crop.width < maskBounds.x + maskBounds.width || crop.y + crop.height < maskBounds.y + maskBounds.height) fail('The crop must contain every selected mask pixel.');
  const padding = plan.settings.contextPadding;
  const left = Math.max(0, Math.floor((maskBounds.x - padding) / 8) * 8); const top = Math.max(0, Math.floor((maskBounds.y - padding) / 8) * 8);
  const right = Math.min(source.width, Math.ceil((maskBounds.x + maskBounds.width + padding) / 8) * 8); const bottom = Math.min(source.height, Math.ceil((maskBounds.y + maskBounds.height + padding) / 8) * 8);
  if (crop.x !== left || crop.y !== top || crop.width !== right - left || crop.height !== bottom - top) fail('The crop does not match its recorded padding and alignment.');
  if (plan.selectedPixels > maskBounds.width * maskBounds.height) fail('The mask pixel count exceeds its bounding box.');
  if (plan.derivedMask.width !== crop.width || plan.derivedMask.height !== crop.height) fail('The derived raw mask must have the exact crop dimensions.');
  if (plan.output.width !== source.width || plan.output.height !== source.height) fail('Crop inpainting retains the original canvas dimensions.');
});
export type CropInpaintPlan = z.infer<typeof cropInpaintPlanSchema>;
export interface CropInpaintWorkflowResult { workflow: ComfyWorkflow; workflowVersion: 'sdxl-crop-inpaint@1'; plan: CropInpaintPlan; output: { nodeId: '7'; width: number; height: number; batchSize: 1; filenamePrefix: string }; }

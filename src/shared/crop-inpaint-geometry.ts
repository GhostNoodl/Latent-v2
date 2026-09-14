import type { SourceImageAsset, SourceMaskAsset } from './source-types';
import { CROP_INPAINT_LIMITS, cropInpaintPlanSchema, cropInpaintSettingsSchema, type CropInpaintPlan, type CropInpaintSettings, type CropRectangle } from './crop-inpaint-types';

function dimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > CROP_INPAINT_LIMITS.maxSourceSide || height > CROP_INPAINT_LIMITS.maxSourceSide || width * height > CROP_INPAINT_LIMITS.absoluteMaxSourcePixels) throw new Error('The original source exceeds the 8192-side / 32 megapixel import bounds.');
  if (width * height > CROP_INPAINT_LIMITS.initialMaxSourcePixels) throw new Error('The initial crop-inpaint profile supports source canvases up to 4 megapixels.');
}

/** Main calls this only after decoding and verifying an immutable saved mask. */
export function redMaskFromRgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  dimensions(width, height);
  if (!(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) throw new Error('Decoded mask pixels do not match the original source dimensions.');
  const red = new Uint8Array(width * height); for (let index = 0; index < red.length; index++) red[index] = rgba[index * 4]; return red;
}

export function deriveCropInpaintGeometry(red: Uint8Array, width: number, height: number, contextPadding: number): { selectedPixels: number; maskBounds: CropRectangle; crop: CropRectangle; croppedMaskRed: Uint8Array } {
  dimensions(width, height); cropInpaintSettingsSchema.parse({ mode: 'refine', contextPadding });
  if (!(red instanceof Uint8Array) || red.length !== width * height) throw new Error('The red-channel mask does not match the source dimensions.');
  let minX = width; let minY = height; let maxX = -1; let maxY = -1; let selectedPixels = 0;
  for (let index = 0; index < red.length; index++) if (red[index] > 0) { const x = index % width; const y = Math.floor(index / width); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); selectedPixels++; }
  if (!selectedPixels) throw new Error('The mask is empty. Select an area before crop inpainting.');
  const maskBounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const left = Math.max(0, Math.floor((minX - contextPadding) / 8) * 8); const top = Math.max(0, Math.floor((minY - contextPadding) / 8) * 8);
  const right = Math.min(width, Math.ceil((maxX + 1 + contextPadding) / 8) * 8); const bottom = Math.min(height, Math.ceil((maxY + 1 + contextPadding) / 8) * 8);
  const crop = { x: left, y: top, width: right - left, height: bottom - top };
  const croppedMaskRed = new Uint8Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y++) croppedMaskRed.set(red.subarray((crop.y + y) * width + crop.x, (crop.y + y) * width + crop.x + crop.width), y * crop.width);
  return { selectedPixels, maskBounds, crop, croppedMaskRed };
}

export interface CreateCropInpaintPlanInput {
  source: SourceImageAsset; mask: SourceMaskAsset; maskRed: Uint8Array;
  working: { width: number; height: number }; settings: CropInpaintSettings; denoise: number;
}

/** SHA identifies exact cropped 8-bit red samples before backend interpolation. */
export async function createCropInpaintPlan(input: CreateCropInpaintPlanInput): Promise<{ plan: CropInpaintPlan; croppedMaskRed: Uint8Array }> {
  const source = structuredClone(input.source); const mask = structuredClone(input.mask); const settings = cropInpaintSettingsSchema.parse(input.settings);
  const working = { ...input.working }; const denoise = input.denoise;
  if (mask.sourceId !== source.id || mask.sourceSha256 !== source.normalized.sha256 || mask.width !== source.normalized.width || mask.height !== source.normalized.height || mask.channel !== 'red' || mask.polarity !== 'white-edits') throw new Error('Crop inpainting requires a verified mask for this exact normalized source.');
  const geometry = deriveCropInpaintGeometry(input.maskRed, source.normalized.width, source.normalized.height, settings.contextPadding);
  const bytes = Uint8Array.from(geometry.croppedMaskRed);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer)), value => value.toString(16).padStart(2, '0')).join('');
  const plan = cropInpaintPlanSchema.parse({
    version: 'sdxl-crop-inpaint@1', source: { id: source.id, sha256: source.normalized.sha256, width: source.normalized.width, height: source.normalized.height }, mask: { id: mask.id, sha256: mask.sha256, channel: 'red', threshold: '>0' },
    selectedPixels: geometry.selectedPixels, maskBounds: geometry.maskBounds, crop: geometry.crop, alignment: 'outward-grid-8-clamped-v1',
    working: { ...working, resize: 'stretch', imageInterpolation: 'lanczos', maskInterpolation: 'bilinear' }, settings: { ...settings, denoise, replaceGrowMaskBy: 0 },
    derivedMask: { encoding: 'u8-red-crop-row-major@1', stage: 'before-working-resize', sha256: hash, width: geometry.crop.width, height: geometry.crop.height },
    output: { width: source.normalized.width, height: source.normalized.height, batchSize: 1, originalAlpha: 'retained' }, preservation: 'original-mask-zero-pixels',
  });
  return { plan, croppedMaskRed: bytes };
}

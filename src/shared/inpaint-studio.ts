import { z } from 'zod';
import { nodeAllocator } from './graph-builder';
import type { ComfyWorkflow, GenerationDraft } from './types';

/**
 * The Inpaint studio on the Edit page: paint a spot and redraw it with your own SDXL
 * checkpoint and LoRAs. The engine crops around the paint, works on it at SDXL's own size,
 * then blends the result back into the full-size picture with a soft edge.
 */
export const INPAINT_STUDIO_VERSION = 'sdxl-inpaint-studio@1';
export const INPAINT_LIMITS = Object.freeze({
  maxSourceSide: 4096,
  maxPadding: 512,
  minGrow: -32,
  maxGrow: 64,
  maxBlur: 31,
  maxWorkingSide: 2048,
  minWorkingSide: 256,
});

export const inpaintStudioSettingsSchema = z
  .object({
    /** painted: crop around the paint and work on it up close. whole: redraw at the picture's own framing. */
    area: z.enum(['painted', 'whole']),
    /** Extra picture around the paint the model gets to see, in picture pixels. */
    padding: z.number().int().min(0).max(INPAINT_LIMITS.maxPadding),
    /** Grows (or shrinks, when negative) the painted area before anything else. */
    grow: z.number().int().min(INPAINT_LIMITS.minGrow).max(INPAINT_LIMITS.maxGrow),
    /** Softens the edge of the painted area, so the new part fades into the old. */
    blur: z.number().int().min(0).max(INPAINT_LIMITS.maxBlur),
    /** What sits under the paint before redrawing: the original, a blur of it, or nothing. */
    fill: z.enum(['keep', 'blur', 'blank']),
    /** Differential diffusion: the soft edge also changes less, not just blends. */
    soft: z.boolean(),
    /** The checkpoint is an inpainting model (9 input channels). */
    inpaintModel: z.boolean(),
    /** Working size: about 1 megapixel, or about 1.6 for more detail. */
    detail: z.enum(['standard', 'high']),
  })
  .strict();
export type InpaintStudioSettings = z.infer<typeof inpaintStudioSettingsSchema>;

export const DEFAULT_INPAINT_STUDIO: InpaintStudioSettings = Object.freeze({
  area: 'painted',
  padding: 96,
  grow: 8,
  blur: 12,
  fill: 'keep',
  soft: true,
  inpaintModel: false,
  detail: 'standard',
}) as InpaintStudioSettings;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface InpaintStudioPlan {
  version: typeof INPAINT_STUDIO_VERSION;
  source: { width: number; height: number };
  maskBounds: Rect;
  crop: Rect;
  working: { width: number; height: number };
}

/** Bounds of the painted (red > 0) pixels of an RGBA mask, or undefined when nothing is painted. */
export function maskBoundsFromRgba(rgba: Uint8Array, width: number, height: number): Rect | undefined {
  if (rgba.length !== width * height * 4) throw new Error("The mask isn't the same size as the picture.");
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++)
      if (rgba[row + x * 4] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  }
  if (maxX < 0) return undefined;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

const round64 = (value: number) => Math.max(64, Math.round(value / 64) * 64);
const clampSide = (value: number) =>
  Math.min(INPAINT_LIMITS.maxWorkingSide, Math.max(INPAINT_LIMITS.minWorkingSide, value));

/** SDXL-friendly working size for a crop: about 1 MP (or 1.6 MP), sides multiples of 64. */
export function inpaintWorkingSize(width: number, height: number, detail: InpaintStudioSettings['detail']) {
  const target = detail === 'high' ? 1280 * 1280 : 1024 * 1024;
  const scale = Math.sqrt(target / (width * height));
  return { width: clampSide(round64(width * scale)), height: clampSide(round64(height * scale)) };
}

export function planInpaintStudio(
  source: { width: number; height: number },
  maskBounds: Rect,
  settings: InpaintStudioSettings,
): InpaintStudioPlan {
  inpaintStudioSettingsSchema.parse(settings);
  const { width, height } = source;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 64 ||
    height < 64 ||
    width > INPAINT_LIMITS.maxSourceSide ||
    height > INPAINT_LIMITS.maxSourceSide
  )
    throw new Error(`Inpaint works on pictures from 64 to ${INPAINT_LIMITS.maxSourceSide} pixels per side.`);
  let crop: Rect = { x: 0, y: 0, width, height };
  if (settings.area === 'painted') {
    // The edge reaches past the paint by the grow and the blur, then the padding adds context.
    const reach = Math.max(0, settings.grow) + settings.blur + settings.padding;
    const left = Math.max(0, Math.floor((maskBounds.x - reach) / 8) * 8);
    const top = Math.max(0, Math.floor((maskBounds.y - reach) / 8) * 8);
    const right = Math.min(width, Math.ceil((maskBounds.x + maskBounds.width + reach) / 8) * 8);
    const bottom = Math.min(height, Math.ceil((maskBounds.y + maskBounds.height + reach) / 8) * 8);
    // Very thin crops make odd working shapes; give each side at least 64 pixels of picture.
    const widen = (start: number, end: number, limit: number): [number, number] => {
      if (end - start >= 64 || limit < 64) return [start, end];
      const center = (start + end) / 2;
      const to = Math.min(limit, Math.max(0, Math.floor((center - 32) / 8) * 8) + 64);
      return [Math.max(0, to - 64), to];
    };
    const [x0, x1] = widen(left, right, width);
    const [y0, y1] = widen(top, bottom, height);
    crop = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }
  return {
    version: INPAINT_STUDIO_VERSION,
    source: { width, height },
    maskBounds: { ...maskBounds },
    crop,
    working: inpaintWorkingSize(crop.width, crop.height, settings.detail),
  };
}

type Link = [string, number];
const same = (value: unknown, expected: Link) => JSON.stringify(value) === JSON.stringify(expected);
function safeFilename(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !/\.png$/i.test(value) ||
    value
      .split('/')
      .some(
        part =>
          !/^[a-z0-9][a-z0-9_. -]{0,239}$/i.test(part) ||
          part.endsWith('.') ||
          part.endsWith(' ') ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error('Inpaint needs a saved PNG picture and mask.');
  return value;
}

export interface InpaintStudioWorkflowInput {
  sourceFilename: string;
  maskFilename: string;
  plan: InpaintStudioPlan;
  settings: InpaintStudioSettings;
  denoise: number;
}

/** Turns Latent's plain SDXL graph (nodes 1-7, LoRAs allowed) into the inpaint studio graph. */
export function augmentInpaintStudioWorkflow(
  workflow: ComfyWorkflow,
  draft: GenerationDraft,
  input: InpaintStudioWorkflowInput,
): ComfyWorkflow {
  const settings = inpaintStudioSettingsSchema.parse(input.settings);
  const { plan } = input;
  if (plan.version !== INPAINT_STUDIO_VERSION) throw new Error('This inpaint recipe is from a newer version.');
  if (plan.working.width !== draft.width || plan.working.height !== draft.height)
    throw new Error("The inpaint working size doesn't match the recipe.");
  if (draft.batchSize !== 1) throw new Error('Inpaint makes one picture per try.');
  if (!Number.isFinite(input.denoise) || input.denoise <= 0 || input.denoise > 1)
    throw new Error('Strength must be above 0 and at most 100%.');
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
    if (workflow[id]?.class_type !== type) throw new Error('Inpaint needs a plain SDXL picture setup.');
  if (
    !same(workflow['5'].inputs.latent_image, ['4', 0]) ||
    !same(workflow['6'].inputs.samples, ['5', 0]) ||
    !same(workflow['6'].inputs.vae, ['1', 2]) ||
    !same(workflow['7'].inputs.images, ['6', 0])
  )
    throw new Error('Inpaint needs a plain SDXL picture setup.');
  const sourceFilename = safeFilename(input.sourceFilename);
  const maskFilename = safeFilename(input.maskFilename);
  const graph = structuredClone(workflow);
  const add = nodeAllocator(graph);
  const vae: Link = ['1', 2];
  const { crop, working } = plan;

  const loaded = add('LoadImage', { image: sourceFilename });
  const source: Link = [loaded, 0];
  const rawMask = add('LoadImageMask', { image: maskFilename, channel: 'red' });
  // Hard mask: the paint, grown or shrunk. Soft mask: the hard mask with a blurred edge.
  let hard: Link = [rawMask, 0];
  if (settings.grow !== 0) hard = [add('GrowMask', { mask: hard, expand: settings.grow, tapered_corners: true }), 0];
  let soft: Link = hard;
  if (settings.blur > 0) {
    const asImage = add('MaskToImage', { mask: hard });
    const blurred = add('ImageBlur', {
      image: [asImage, 0],
      blur_radius: settings.blur,
      sigma: Math.min(10, Math.max(0.1, settings.blur / 2)),
    });
    soft = [add('ImageToMask', { image: [blurred, 0], channel: 'red' }), 0];
  }

  // What the model sees under the paint.
  let pixels: Link = source;
  if (settings.fill === 'blur' && !settings.inpaintModel) {
    const smeared = add('ImageBlur', { image: source, blur_radius: 31, sigma: 10 });
    pixels = [
      add('ImageCompositeMasked', {
        destination: source,
        source: [smeared, 0],
        x: 0,
        y: 0,
        resize_source: false,
        mask: hard,
      }),
      0,
    ];
  }

  const cropped = add('ImageCrop', { image: pixels, ...crop });
  const workingImage = add('ImageScale', {
    image: [cropped, 0],
    upscale_method: 'lanczos',
    width: working.width,
    height: working.height,
    crop: 'disabled',
  });
  const croppedSoft = add('CropMask', { mask: soft, ...crop });
  const softImage = add('MaskToImage', { mask: [croppedSoft, 0] });
  const workingSoftImage = add('ImageScale', {
    image: [softImage, 0],
    upscale_method: 'bilinear',
    width: working.width,
    height: working.height,
    crop: 'disabled',
  });
  const workingMask: Link = [add('ImageToMask', { image: [workingSoftImage, 0], channel: 'red' }), 0];

  if (settings.inpaintModel) {
    const conditioned = add('InpaintModelConditioning', {
      positive: graph['5'].inputs.positive,
      negative: graph['5'].inputs.negative,
      vae,
      pixels: [workingImage, 0],
      mask: workingMask,
      noise_mask: true,
    });
    graph['5'].inputs.positive = [conditioned, 0];
    graph['5'].inputs.negative = [conditioned, 1];
    graph['5'].inputs.latent_image = [conditioned, 2];
    delete graph['4'];
  } else if (settings.fill === 'blank') {
    graph['4'] = {
      class_type: 'VAEEncodeForInpaint',
      inputs: { pixels: [workingImage, 0], vae, mask: workingMask, grow_mask_by: 0 },
    };
    graph['5'].inputs.latent_image = ['4', 0];
  } else {
    graph['4'] = { class_type: 'VAEEncode', inputs: { pixels: [workingImage, 0], vae } };
    const masked = add('SetLatentNoiseMask', { samples: ['4', 0], mask: workingMask });
    graph['5'].inputs.latent_image = [masked, 0];
  }
  if (settings.soft) {
    const model = graph['5'].inputs.model;
    graph['5'].inputs.model = [add('DifferentialDiffusion', { model }), 0];
  }
  graph['5'].inputs.denoise = input.denoise;

  // Back to the crop's own size, then blended into the untouched full-size picture.
  const returned = add('ImageScale', {
    image: ['6', 0],
    upscale_method: 'lanczos',
    width: crop.width,
    height: crop.height,
    crop: 'disabled',
  });
  const composite = add('ImageCompositeMasked', {
    destination: source,
    source: [returned, 0],
    x: crop.x,
    y: crop.y,
    resize_source: false,
    mask: [croppedSoft, 0],
  });
  // LoadImage output 1 is the inverted alpha; this keeps the picture's own transparency.
  const alpha = add('JoinImageWithAlpha', { image: [composite, 0], alpha: [loaded, 1] });
  graph['7'].inputs.images = [alpha, 0];
  return graph;
}

/** Inpaint-model checkpoints usually say so in their name. */
export const looksLikeInpaintModel = (name: string) => /inpaint/i.test(name);

import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import {
  augmentInpaintStudioWorkflow,
  DEFAULT_INPAINT_STUDIO,
  inpaintWorkingSize,
  looksLikeInpaintModel,
  maskBoundsFromRgba,
  planInpaintStudio,
  type InpaintStudioSettings,
} from '../src/shared/inpaint-studio';
import type { ComfyWorkflow, GenerationDraft, ModelAsset } from '../src/shared/types';
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
const sourceId = 'src_00000000-0000-0000-0000-000000000001';
const maskId = 'mask_00000000-0000-0000-0000-000000000002';
const draftFor = (settings: InpaintStudioSettings, working: { width: number; height: number }): GenerationDraft => ({
  ...DEFAULT_DRAFT,
  family: 'sdxl',
  checkpointId: checkpoint.id,
  prompt: 'a red scarf',
  negativePrompt: 'blurry',
  batchSize: 1,
  ...working,
  imageInput: {
    mode: 'inpaint',
    sourceId,
    sourceSha256: 'a'.repeat(64),
    maskId,
    maskSha256: 'c'.repeat(64),
    denoise: 0.75,
    resize: 'stretch',
    studio: settings,
  },
});
const build = (settings: InpaintStudioSettings, source = { width: 1600, height: 2000 }) => {
  const plan = planInpaintStudio(source, { x: 700, y: 900, width: 120, height: 80 }, settings);
  const draft = draftFor(settings, plan.working);
  const graph = augmentInpaintStudioWorkflow(buildWorkflow(draft, [checkpoint], '42', 'job'), draft, {
    sourceFilename: `source-images/${sourceId}/image.png`,
    maskFilename: `source-images/${maskId}/mask.png`,
    plan,
    settings,
    denoise: 0.75,
  });
  return { plan, graph, draft };
};
const nodes = (graph: ComfyWorkflow, type: string) => Object.values(graph).filter(node => node.class_type === type);

describe('inpaint studio', () => {
  it('accepts studio settings in a draft', () => {
    const plan = planInpaintStudio(
      { width: 1024, height: 1024 },
      { x: 10, y: 10, width: 50, height: 50 },
      DEFAULT_INPAINT_STUDIO,
    );
    expect(draftSchema.parse(draftFor(DEFAULT_INPAINT_STUDIO, plan.working)).imageInput?.studio).toEqual(
      DEFAULT_INPAINT_STUDIO,
    );
  });

  it('finds the painted bounds', () => {
    const rgba = new Uint8Array(10 * 6 * 4);
    rgba[(2 * 10 + 3) * 4] = 255;
    rgba[(4 * 10 + 7) * 4] = 255;
    expect(maskBoundsFromRgba(rgba, 10, 6)).toEqual({ x: 3, y: 2, width: 5, height: 3 });
    expect(maskBoundsFromRgba(new Uint8Array(10 * 6 * 4), 10, 6)).toBeUndefined();
  });

  it('crops around the paint with room for grow, blur and padding, and works near 1 MP', () => {
    const { plan } = build(DEFAULT_INPAINT_STUDIO);
    const reach = DEFAULT_INPAINT_STUDIO.grow + DEFAULT_INPAINT_STUDIO.blur + DEFAULT_INPAINT_STUDIO.padding;
    expect(plan.crop.x).toBeLessThanOrEqual(700 - reach);
    expect(plan.crop.x + plan.crop.width).toBeGreaterThanOrEqual(820 + reach);
    expect(plan.crop.x % 8).toBe(0);
    expect(plan.working.width % 64).toBe(0);
    expect(plan.working.width * plan.working.height).toBeGreaterThan(800_000);
    expect(plan.working.width * plan.working.height).toBeLessThan(1_300_000);
  });

  it('whole picture works on the full frame and keeps its shape', () => {
    const { plan } = build({ ...DEFAULT_INPAINT_STUDIO, area: 'whole' });
    expect(plan.crop).toEqual({ x: 0, y: 0, width: 1600, height: 2000 });
    expect(plan.working.height / plan.working.width).toBeCloseTo(1.25, 1);
  });

  it('keeps working sides inside SDXL limits for long thin crops', () => {
    const size = inpaintWorkingSize(4096, 64, 'high');
    expect(size.width).toBeLessThanOrEqual(2048);
    expect(size.height).toBeGreaterThanOrEqual(256);
  });

  it('builds a soft blended, full size result that keeps unpainted pixels', () => {
    const { graph } = build(DEFAULT_INPAINT_STUDIO);
    expect(nodes(graph, 'EmptyLatentImage')).toHaveLength(0);
    expect(nodes(graph, 'GrowMask')[0].inputs.expand).toBe(8);
    expect(nodes(graph, 'ImageBlur')[0].inputs.blur_radius).toBe(12);
    expect(nodes(graph, 'SetLatentNoiseMask')).toHaveLength(1);
    expect(nodes(graph, 'DifferentialDiffusion')).toHaveLength(1);
    expect(graph['5'].inputs.denoise).toBe(0.75);
    const composite = nodes(graph, 'ImageCompositeMasked').at(-1)!;
    expect(composite.inputs.x).toBeGreaterThan(0);
    const save = graph['7'].inputs.images as [string, number];
    expect(graph[save[0]].class_type).toBe('JoinImageWithAlpha');
  });

  it('blank fill clears the paint and blur fill smears it first', () => {
    const blank = build({ ...DEFAULT_INPAINT_STUDIO, fill: 'blank', soft: false }).graph;
    expect(graph4(blank)).toBe('VAEEncodeForInpaint');
    expect(nodes(blank, 'DifferentialDiffusion')).toHaveLength(0);
    const blur = build({ ...DEFAULT_INPAINT_STUDIO, fill: 'blur', blur: 0, grow: 0 }).graph;
    expect(nodes(blur, 'ImageBlur')[0].inputs.blur_radius).toBe(31);
    expect(nodes(blur, 'GrowMask')).toHaveLength(0);
  });

  it('inpaint models get the masked picture as conditioning', () => {
    const { graph } = build({ ...DEFAULT_INPAINT_STUDIO, inpaintModel: true });
    const [id] = Object.entries(graph).find(([, node]) => node.class_type === 'InpaintModelConditioning')!;
    expect(graph['5'].inputs.positive).toEqual([id, 0]);
    expect(graph['5'].inputs.negative).toEqual([id, 1]);
    expect(graph['5'].inputs.latent_image).toEqual([id, 2]);
    expect(graph['4']).toBeUndefined();
    expect(looksLikeInpaintModel('juggernautXL_v9-inpainting.safetensors')).toBe(true);
  });

  it('refuses a strength of zero and a mismatched working size', () => {
    const { plan, draft } = build(DEFAULT_INPAINT_STUDIO);
    const base = buildWorkflow(draft, [checkpoint], '42', 'job');
    const input = {
      sourceFilename: 'a/image.png',
      maskFilename: 'b/mask.png',
      plan,
      settings: DEFAULT_INPAINT_STUDIO,
      denoise: 0,
    };
    expect(() => augmentInpaintStudioWorkflow(base, draft, input)).toThrow(/Strength/);
    expect(() =>
      augmentInpaintStudioWorkflow(base, { ...draft, width: draft.width + 64 }, { ...input, denoise: 0.5 }),
    ).toThrow(/working size/);
  });
});

function graph4(graph: ComfyWorkflow) {
  return graph['4']?.class_type;
}

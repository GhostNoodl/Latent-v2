import { describe, expect, it } from 'vitest';
import {
  IMAGE_MODEL_IDS,
  IMAGE_MODELS,
  allImageModelFiles,
  bindImageModelWorkflow,
  buildImageModelWorkflow,
  compareEngineVersions,
  engineSupportsImageModel,
  imageModelFileKey,
  imageModelNodes,
  recordImageModelName,
  validateImageModelBundle,
  type ImageModelBundle,
  type ImageModelId,
} from '../src/shared/image-models';
import {
  IMAGE_MODELS_SET_ID,
  latestReviewedRuntimeSet,
  reviewedRuntimeSet,
} from '../src/main/reviewed-runtime-channel';
import { draftSchema } from '../src/shared/validation';
import { DEFAULT_DRAFT } from '../src/shared/defaults';

const bundle = (id: ImageModelId): ImageModelBundle => {
  const definition = IMAGE_MODELS[id];
  return {
    id,
    workflowVersion: definition.workflowVersion,
    files: {
      diffusion: { ...definition.files.diffusion, verifiedAt: '2026-11-16T00:00:00.000Z' },
      encoder: { ...definition.files.encoder, verifiedAt: '2026-11-16T00:00:00.000Z' },
      vae: { ...definition.files.vae, verifiedAt: '2026-11-16T00:00:00.000Z' },
    },
  };
};
const draft = (id: ImageModelId) => ({
  prompt: 'a lighthouse at dusk',
  negativePrompt: 'blurry',
  width: 1024,
  height: 1024,
  batchSize: 1,
  ...IMAGE_MODELS[id].defaults,
});

describe('newer image models', () => {
  it('pins every file with a size, a full checksum and a fixed revision', () => {
    for (const file of allImageModelFiles()) {
      expect(file.bytes).toBeGreaterThan(100_000_000);
      expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(file.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(file.filename).toMatch(/\.safetensors$/);
    }
    const keys = allImageModelFiles().map(imageModelFileKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('shares the same encoder and VAE files between models instead of downloading twice', () => {
    expect(IMAGE_MODELS['krea2-turbo'].files.encoder.sha256).toBe(IMAGE_MODELS['flux3-klein'].files.encoder.sha256);
    expect(IMAGE_MODELS['krea2-turbo'].files.vae.sha256).toBe(IMAGE_MODELS['anima-turbo'].files.vae.sha256);
    expect(allImageModelFiles().length).toBeLessThan(IMAGE_MODEL_IDS.length * 3);
  });

  it.each(IMAGE_MODEL_IDS)('builds a complete text-to-image graph for %s', id => {
    const workflow = buildImageModelWorkflow(draft(id), bundle(id), '42', 'job-1');
    const model = IMAGE_MODELS[id];
    expect(workflow['2'].inputs.type).toBe(model.clipType);
    expect(workflow['6'].class_type).toBe(model.latent);
    expect(workflow['8'].inputs).toMatchObject({ seed: 42, steps: model.defaults.steps, cfg: model.defaults.cfg });
    expect(workflow['8'].inputs.model).toEqual(model.sampling ? ['7', 0] : ['1', 0]);
    expect(workflow['5'].class_type).toBe(model.negative === 'zero' ? 'ConditioningZeroOut' : 'CLIPTextEncode');
    expect(workflow['10'].inputs.filename_prefix).toBe('Latent_job-1');
    const used = new Set(Object.values(workflow).map(node => node.class_type));
    expect([...used].every(name => imageModelNodes(id).includes(name))).toBe(true);
  });

  it('spells loader file names the way a Windows engine lists them', () => {
    const workflow = buildImageModelWorkflow(draft('anima-turbo'), bundle('anima-turbo'), '1', 'job');
    const listed = (name: string) => `latent-image-models\\${name}`;
    const objects = {
      UNETLoader: {
        input: { required: { unet_name: [[listed('anima-turbo-v1.1.safetensors'), 'other.safetensors']] } },
      },
      CLIPLoader: {
        input: { required: { clip_name: ['COMBO', { options: [listed('qwen_3_06b_base.safetensors')] }] } },
      },
      VAELoader: { input: { required: { vae_name: [[listed('qwen_image_vae.safetensors')]] } } },
    };
    const bound = bindImageModelWorkflow(workflow, objects);
    expect(bound['1'].inputs.unet_name).toBe(listed('anima-turbo-v1.1.safetensors'));
    expect(bound['2'].inputs.clip_name).toBe(listed('qwen_3_06b_base.safetensors'));
    expect(bound['3'].inputs.vae_name).toBe(listed('qwen_image_vae.safetensors'));
    expect(bound['4']).toEqual(workflow['4']);
    expect(() =>
      bindImageModelWorkflow(workflow, { ...objects, VAELoader: { input: { required: { vae_name: [[]] } } } }),
    ).toThrow(/can't see qwen_image_vae/);
  });

  it('uses the Klein shift from the official graph', () => {
    const workflow = buildImageModelWorkflow(draft('flux3-klein'), bundle('flux3-klein'), '1', 'job');
    expect(workflow['7'].inputs.max_shift).toBeCloseTo(2.77259, 4);
    expect(workflow['7'].inputs.base_shift).toBeCloseTo(2.77259, 4);
  });

  it('refuses a bundle whose files do not match the pins', () => {
    const changed = bundle('z-image-turbo');
    changed.files.vae = { ...changed.files.vae, sha256: '0'.repeat(64) };
    expect(() => validateImageModelBundle(changed)).toThrow(/vae/);
    expect(() => buildImageModelWorkflow(draft('z-image-turbo'), bundle('z-image-turbo'), '-1', 'job')).toThrow(/seed/);
  });

  it('checks engine versions numerically', () => {
    expect(compareEngineVersions('0.45.2', '0.43.0')).toBeGreaterThan(0);
    expect(compareEngineVersions('0.9.0', '0.10.0')).toBeLessThan(0);
    expect(engineSupportsImageModel('0.34.0', 'anima-turbo')).toBe(true);
    expect(engineSupportsImageModel('0.34.0', 'flux3-klein')).toBe(false);
    expect(engineSupportsImageModel('0.37.0', 'moss-image')).toBe(false);
    expect(engineSupportsImageModel(undefined, 'anima-turbo')).toBe(false);
  });

  it('accepts a draft that uses a newer model, and rejects unknown ones', () => {
    expect(draftSchema.safeParse({ ...DEFAULT_DRAFT, imageModel: 'moss-image' }).success).toBe(true);
    expect(draftSchema.safeParse({ ...DEFAULT_DRAFT, imageModel: 'not-a-model' }).success).toBe(false);
  });

  it('names saved images by their model', () => {
    expect(recordImageModelName({ imageModel: { id: 'krea2-turbo' } })).toBe('Krea 2 Turbo');
    expect(recordImageModelName({})).toBeUndefined();
  });
});

describe('engine 0.45.2 update', () => {
  it('is the regular engine update and can run every newer model', () => {
    const set = latestReviewedRuntimeSet();
    expect(set.id).toBe(IMAGE_MODELS_SET_ID);
    expect(set.optional).toBeFalsy();
    for (const id of IMAGE_MODEL_IDS) {
      expect(engineSupportsImageModel(set.backend.version, id)).toBe(true);
      expect(set.workflowVersions).toContain(IMAGE_MODELS[id].workflowVersion);
    }
  });

  it('keeps every workflow and node the older engines promised', () => {
    const set = reviewedRuntimeSet(IMAGE_MODELS_SET_ID);
    for (const older of ['comfy-0-34-0-cu130-workflows-1', 'comfy-0-37-0-qwen21-1'].map(reviewedRuntimeSet)) {
      expect(set.sequence).toBeGreaterThan(older.sequence);
      for (const version of older.workflowVersions) expect(set.workflowVersions).toContain(version);
      for (const node of older.mandatoryNodes) expect(set.mandatoryNodes).toContain(node);
    }
    expect(new Set(set.packages.map(pin => pin.name)).size).toBe(set.packages.length);
  });
});

import { z } from 'zod';
import type { ComfyWorkflow } from './types';

/**
 * Newer image models that load as separate files (diffusion model, text encoder, VAE)
 * instead of one SDXL checkpoint. Every file is pinned to an exact publisher revision,
 * size and SHA-256 (checked from the Hugging Face file listing on 2026-11-16).
 * Graphs follow the official ComfyUI templates for each model.
 */
export type ImageModelRole = 'diffusion' | 'encoder' | 'vae';
export interface ImageModelFile {
  role: ImageModelRole;
  directory: 'diffusion_models' | 'text_encoders' | 'vae';
  /** Stored under `<directory>/latent-image-models/<filename>`; identical names always mean identical bytes. */
  filename: string;
  repository: string;
  revision: string;
  sourceFile: string;
  bytes: number;
  sha256: string;
}
export const IMAGE_MODEL_NAMESPACE = 'latent-image-models';
export const IMAGE_MODEL_IDS = [
  'anima-turbo',
  'anima-aesthetic',
  'z-image-turbo',
  'flux3-klein',
  'moss-image',
  'krea2-turbo',
] as const;
export type ImageModelId = (typeof IMAGE_MODEL_IDS)[number];
export const imageModelIdSchema = z.enum(IMAGE_MODEL_IDS);

export interface ImageModelDefinition {
  id: ImageModelId;
  /** Groups variants of one model in the picker. */
  group: 'Anima' | 'Z-Image' | 'FLUX.3 Klein' | 'MOSS-Image' | 'Krea 2';
  name: string;
  blurb: string;
  /** Short prompt advice shown under the picker card. */
  promptTip: string;
  license: { name: string; url: string; note: string };
  files: Record<ImageModelRole, ImageModelFile>;
  clipType: string;
  latent: 'EmptyLatentImage' | 'EmptySD3LatentImage' | 'EmptyFlux2LatentImage';
  sampling?: { node: 'ModelSamplingAuraFlow'; shift: number } | { node: 'ModelSamplingFlux'; alpha: number };
  /** cfg 1 models ignore the negative; the official graphs zero it out. */
  negative: 'text' | 'zero';
  defaults: { steps: number; cfg: number; sampler: string; scheduler: string };
  /** Lowest ComfyUI version with native support for this model. */
  minEngine: string;
  workflowVersion: string;
}

const hf =
  (repository: string, revision: string) =>
  (
    role: ImageModelRole,
    directory: ImageModelFile['directory'],
    sourceFile: string,
    bytes: number,
    sha256: string,
  ): ImageModelFile => ({
    role,
    directory,
    filename: sourceFile.split('/').at(-1)!,
    repository,
    revision,
    sourceFile,
    bytes,
    sha256,
  });
const anima = hf('circlestone-labs/Anima', 'f973fc41ec7545364ac9776c2440285f43ff2a30');
const zImage = hf('Comfy-Org/Z-Image-Turbo', '6fc90a3b1b653e935a0d175e260736de25b84df5');
const krea = hf('Comfy-Org/Krea-2', '1171f4dc7e325bf3734586942e737872506c73e1');
const moss = hf('Comfy-Org/MOSS-Image', '2929efe3cdd506c0a430bcfca70a9a8d805cc095');
// Ungated copy of black-forest-labs/flux-3-image-klein-comfy; sizes match the official listing.
const klein = hf('ml-resources/flux-3-image-klein-comfy', '3ba0f7064cbb1666a71e2820d3cc5c2273bb6cd0');

const ANIMA_ENCODER = anima(
  'encoder',
  'text_encoders',
  'split_files/text_encoders/qwen_3_06b_base.safetensors',
  1192135096,
  'cd2a512003e2f9f3cd3c32a9c3573f820bb28c940f73c57b1ddaa983d9223eba',
);
const QWEN_IMAGE_VAE = anima(
  'vae',
  'vae',
  'split_files/vae/qwen_image_vae.safetensors',
  253806246,
  'a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f',
);
const QWEN3VL_4B_INT8 = krea(
  'encoder',
  'text_encoders',
  'text_encoders/qwen3vl_4b_int8_convrot.safetensors',
  4858559240,
  '32de113cbf8282b02cbff0794b637b9d6676da09314a1db5a30bcea9bf4ee01c',
);
const FLUX2_VAE = moss(
  'vae',
  'vae',
  'vae/flux2-vae.safetensors',
  336211292,
  '868fe7b343cc8f3a19dbcfcafbc3d5f888802be3f89bd81b65b3621a066ce8f3',
);
const ANIMA_LICENSE = {
  name: 'CircleStone Labs Non-Commercial License',
  url: 'https://huggingface.co/circlestone-labs/Anima/blob/f973fc41ec7545364ac9776c2440285f43ff2a30/LICENSE.md',
  note: 'Your images are yours to use, even commercially. The model itself is non-commercial.',
};

export const IMAGE_MODELS: Readonly<Record<ImageModelId, ImageModelDefinition>> = {
  'anima-turbo': {
    id: 'anima-turbo',
    group: 'Anima',
    name: 'Anima Turbo',
    blurb: 'Fast anime model. Reads Danbooru tags and plain English. 8 steps.',
    promptTip: 'Use spaces in tags, not underscores. Artists are written @name.',
    license: ANIMA_LICENSE,
    files: {
      diffusion: anima(
        'diffusion',
        'diffusion_models',
        'split_files/diffusion_models/anima-turbo-v1.1.safetensors',
        4182230656,
        'fba11953276b57edf59d1dc4f1857ac05aa079c56f982b4d7c20298d57d3f7eb',
      ),
      encoder: ANIMA_ENCODER,
      vae: QWEN_IMAGE_VAE,
    },
    clipType: 'stable_diffusion',
    latent: 'EmptyLatentImage',
    negative: 'text',
    defaults: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' },
    minEngine: '0.34.0',
    workflowVersion: 'anima-txt2img@1',
  },
  'anima-aesthetic': {
    id: 'anima-aesthetic',
    group: 'Anima',
    name: 'Anima Aesthetic',
    blurb: 'Anima tuned on its best images. Slower, prettier. 30 steps.',
    promptTip: 'Start with "masterpiece, best quality, score_7, safe," for the house look.',
    license: ANIMA_LICENSE,
    files: {
      diffusion: anima(
        'diffusion',
        'diffusion_models',
        'split_files/diffusion_models/anima-aesthetic-v1.1.safetensors',
        4182230656,
        '3c1868387a3a1ff504bbb87c33678321965ead381fcf87afbd0264daa600c082',
      ),
      encoder: ANIMA_ENCODER,
      vae: QWEN_IMAGE_VAE,
    },
    clipType: 'stable_diffusion',
    latent: 'EmptyLatentImage',
    negative: 'text',
    defaults: { steps: 30, cfg: 4, sampler: 'euler', scheduler: 'simple' },
    minEngine: '0.34.0',
    workflowVersion: 'anima-txt2img@1',
  },
  'z-image-turbo': {
    id: 'z-image-turbo',
    group: 'Z-Image',
    name: 'Z-Image Turbo',
    blurb: 'Fast photoreal model, good with English and Chinese text. 8 steps.',
    promptTip: 'Write full sentences. The negative prompt is ignored at CFG 1.',
    license: {
      name: 'Apache 2.0',
      url: 'https://huggingface.co/Comfy-Org/Z-Image-Turbo',
      note: 'No strings attached.',
    },
    files: {
      diffusion: zImage(
        'diffusion',
        'diffusion_models',
        'split_files/diffusion_models/z_image_turbo_int8_convrot.safetensors',
        6201001296,
        'be517ebd47c912a5626a588e1aeea43e6be4a43c0cdcd2b48a2a780d9f358635',
      ),
      encoder: zImage(
        'encoder',
        'text_encoders',
        'split_files/text_encoders/qwen_3_4b.safetensors',
        8044982048,
        '6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a',
      ),
      vae: zImage(
        'vae',
        'vae',
        'split_files/vae/ae.safetensors',
        335304388,
        'afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38',
      ),
    },
    clipType: 'lumina2',
    latent: 'EmptySD3LatentImage',
    sampling: { node: 'ModelSamplingAuraFlow', shift: 3 },
    negative: 'zero',
    defaults: { steps: 8, cfg: 1, sampler: 'res_multistep', scheduler: 'simple' },
    minEngine: '0.34.0',
    workflowVersion: 'z-image-txt2img@1',
  },
  'flux3-klein': {
    id: 'flux3-klein',
    group: 'FLUX.3 Klein',
    name: 'FLUX.3 Klein',
    blurb: 'Black Forest Labs all-rounder. Strong prompt following. 16 steps.',
    promptTip: 'Describe the scene in plain sentences. No negative prompt.',
    license: {
      name: 'FLUX Kommunity License',
      url: 'https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy',
      note: 'Selling images is only allowed under $5M yearly revenue, with a content filter.',
    },
    files: {
      diffusion: klein(
        'diffusion',
        'diffusion_models',
        'diffusion_models/flux3-image-klein-int8-convrot.safetensors',
        5827874779,
        '847d8933548afd93df4af2cac2498e70891bf28d9dae06d695f536992e168fe2',
      ),
      encoder: QWEN3VL_4B_INT8,
      vae: FLUX2_VAE,
    },
    clipType: 'flux3',
    latent: 'EmptyFlux2LatentImage',
    sampling: { node: 'ModelSamplingFlux', alpha: 16 },
    negative: 'text',
    defaults: { steps: 16, cfg: 1, sampler: 'euler', scheduler: 'simple' },
    minEngine: '0.41.0',
    workflowVersion: 'flux3-klein-txt2img@1',
  },
  'moss-image': {
    id: 'moss-image',
    group: 'MOSS-Image',
    name: 'MOSS-Image',
    blurb: 'Posters, signs and long text, uncensored. Slower: 25 steps with CFG.',
    promptTip: 'Put any text you want drawn in "quotes".',
    license: {
      name: 'Apache 2.0',
      url: 'https://huggingface.co/Comfy-Org/MOSS-Image',
      note: 'No strings attached.',
    },
    files: {
      diffusion: moss(
        'diffusion',
        'diffusion_models',
        'diffusion_models/moss_image_sft_int8_convrot.safetensors',
        5413698958,
        'b4d1475bc7eeffd7b809e82ea13a1fba1fb85c4e18365af3813722faa5c0fe4f',
      ),
      encoder: moss(
        'encoder',
        'text_encoders',
        'text_encoders/qwen3.5_9b_int8_convrot.safetensors',
        9748121532,
        '32e3787472f708fa5f83624acbf5ef23f7fc89c439e05065ea57cfe5a97f025a',
      ),
      vae: moss(
        'vae',
        'vae',
        'vae/flux2-vae_small.safetensors',
        249521340,
        'd8d52ba036475f5fb07c8b435e176d3d97ebfa82f0d1a1c317f9cc1e25bd013b',
      ),
    },
    clipType: 'moss_image',
    latent: 'EmptyFlux2LatentImage',
    negative: 'text',
    defaults: { steps: 25, cfg: 2.5, sampler: 'er_sde', scheduler: 'simple' },
    minEngine: '0.43.0',
    workflowVersion: 'moss-image-txt2img@1',
  },
  'krea2-turbo': {
    id: 'krea2-turbo',
    group: 'Krea 2',
    name: 'Krea 2 Turbo',
    blurb: 'Big photo model with the nicest looks. Heavy on 16 GB cards. 8 steps.',
    promptTip: 'Write full sentences. The negative prompt is ignored at CFG 1.',
    license: {
      name: 'Krea 2 Community License',
      url: 'https://huggingface.co/krea/Krea-2-Turbo/blob/main/LICENSE.pdf',
      note: 'Free under $1M yearly revenue. The license asks for a content filter.',
    },
    files: {
      diffusion: krea(
        'diffusion',
        'diffusion_models',
        'diffusion_models/krea2_turbo_int8_convrot.safetensors',
        13492686496,
        '8e4eeda70dd5037ab1ba2bef6b417f9f901e26093117cf397f741fc1fdaaf3f1',
      ),
      encoder: QWEN3VL_4B_INT8,
      vae: QWEN_IMAGE_VAE,
    },
    clipType: 'krea2',
    latent: 'EmptyLatentImage',
    negative: 'zero',
    defaults: { steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' },
    minEngine: '0.34.0',
    workflowVersion: 'krea2-txt2img@1',
  },
};

export function imageModel(id: string): ImageModelDefinition {
  const parsed = imageModelIdSchema.safeParse(id);
  if (!parsed.success) throw new Error('Choose one of the supported image models.');
  return IMAGE_MODELS[parsed.data];
}
export const imageModelFiles = (id: ImageModelId) => Object.values(IMAGE_MODELS[id].files);
export const imageModelBytes = (id: ImageModelId) => imageModelFiles(id).reduce((sum, file) => sum + file.bytes, 0);
/** Every distinct pinned file, shared ones once. */
export function allImageModelFiles(): ImageModelFile[] {
  const seen = new Map<string, ImageModelFile>();
  for (const id of IMAGE_MODEL_IDS)
    for (const file of imageModelFiles(id)) {
      const key = `${file.directory}/${file.filename}`;
      const existing = seen.get(key);
      if (existing && existing.sha256 !== file.sha256) throw new Error(`Conflicting pins for ${key}.`);
      seen.set(key, file);
    }
  return [...seen.values()];
}
export const imageModelFileKey = (file: Pick<ImageModelFile, 'directory' | 'filename'>) =>
  `${file.directory}/${file.filename}`;
/** The name ComfyUI lists for this file inside its model folder. */
export const imageModelEngineName = (file: Pick<ImageModelFile, 'filename'>) =>
  `${IMAGE_MODEL_NAMESPACE}/${file.filename}`;

export function compareEngineVersions(a: string, b: string) {
  const parse = (value: string) => value.split('.').map(part => Number.parseInt(part, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index++)
    if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) - (y[index] ?? 0);
  return 0;
}
export const engineSupportsImageModel = (engineVersion: string | undefined, id: ImageModelId) =>
  Boolean(engineVersion) && compareEngineVersions(engineVersion!, IMAGE_MODELS[id].minEngine) >= 0;

export interface ImageModelBundleFile extends ImageModelFile {
  verifiedAt: string;
}
/** The verified files a job was queued with; kept with the image for reuse checks. */
export interface ImageModelBundle {
  id: ImageModelId;
  files: Record<ImageModelRole, ImageModelBundleFile>;
  workflowVersion: string;
}
export interface ImageModelsStatus {
  state: 'idle' | 'installing' | 'error';
  message: string;
  installing?: ImageModelId;
  progress?: number;
  /** Models whose three files are all downloaded and verified. */
  ready: ImageModelId[];
  /** Files already on disk, so a shared encoder or VAE is not counted twice. */
  readyFiles: string[];
}

export interface ImageModelWorkflowDraft {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  batchSize: number;
}

export function validateImageModelBundle(bundle: ImageModelBundle) {
  const definition = imageModel(bundle?.id);
  if (bundle.workflowVersion !== definition.workflowVersion) throw new Error('This image model recipe is out of date.');
  for (const role of ['diffusion', 'encoder', 'vae'] as const) {
    const file = bundle.files?.[role],
      pin = definition.files[role];
    if (
      !file ||
      (['role', 'directory', 'filename', 'repository', 'revision', 'sourceFile', 'bytes', 'sha256'] as const).some(
        key => file[key] !== pin[key],
      )
    )
      throw new Error(`Download and verify the ${definition.name} ${role} file first.`);
  }
}

/** Text-to-image graph matching the official ComfyUI template for each model. */
export function buildImageModelWorkflow(
  draft: ImageModelWorkflowDraft,
  bundle: ImageModelBundle,
  seed: string,
  jobId: string,
): ComfyWorkflow {
  validateImageModelBundle(bundle);
  const model = IMAGE_MODELS[bundle.id];
  if (!/^\d+$/.test(seed) || BigInt(seed) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid resolved seed.');
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(jobId)) throw new Error('Invalid job id.');
  const workflow: ComfyWorkflow = {
    '1': {
      class_type: 'UNETLoader',
      inputs: { unet_name: imageModelEngineName(bundle.files.diffusion), weight_dtype: 'default' },
    },
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: imageModelEngineName(bundle.files.encoder), type: model.clipType, device: 'default' },
    },
    '3': { class_type: 'VAELoader', inputs: { vae_name: imageModelEngineName(bundle.files.vae) } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: draft.prompt, clip: ['2', 0] } },
    '5':
      model.negative === 'zero'
        ? { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['4', 0] } }
        : { class_type: 'CLIPTextEncode', inputs: { text: draft.negativePrompt, clip: ['2', 0] } },
    '6': {
      class_type: model.latent,
      inputs: { width: draft.width, height: draft.height, batch_size: draft.batchSize },
    },
    '8': {
      class_type: 'KSampler',
      inputs: {
        model: ['1', 0],
        positive: ['4', 0],
        negative: ['5', 0],
        latent_image: ['6', 0],
        seed: Number(seed),
        steps: draft.steps,
        cfg: draft.cfg,
        sampler_name: draft.sampler,
        scheduler: draft.scheduler,
        denoise: 1,
      },
    },
    '9': { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: `Latent_${jobId}` } },
  };
  if (model.sampling?.node === 'ModelSamplingAuraFlow')
    workflow['7'] = { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: model.sampling.shift } };
  else if (model.sampling?.node === 'ModelSamplingFlux') {
    // The official Klein graph feeds ln(alpha) into both shifts.
    const shift = Number(Math.log(model.sampling.alpha).toFixed(5));
    workflow['7'] = {
      class_type: 'ModelSamplingFlux',
      inputs: { model: ['1', 0], max_shift: shift, base_shift: shift, width: draft.width, height: draft.height },
    };
  }
  if (workflow['7']) workflow['8'].inputs.model = ['7', 0];
  return workflow;
}

/** Nodes each model's graph needs from the engine. */
export function imageModelNodes(id: ImageModelId): string[] {
  const model = IMAGE_MODELS[id];
  return [
    'UNETLoader',
    'CLIPLoader',
    'VAELoader',
    'CLIPTextEncode',
    'KSampler',
    'VAEDecode',
    'SaveImage',
    model.latent,
    ...(model.negative === 'zero' ? ['ConditioningZeroOut'] : []),
    ...(model.sampling ? [model.sampling.node] : []),
  ];
}

/** Display name for a saved image made with a newer model, if it was. */
export const recordImageModelName = (record: { imageModel?: Pick<ImageModelBundle, 'id'> }) =>
  record.imageModel ? (IMAGE_MODELS[record.imageModel.id]?.name ?? record.imageModel.id) : undefined;

/**
 * Spells the loader file names the way the engine lists them. ComfyUI on Windows lists files in
 * subfolders with backslashes and only accepts an exact match, so `latent-image-models/x` must be
 * sent as `latent-image-models\x` there.
 */
export function bindImageModelWorkflow(
  workflow: ComfyWorkflow,
  objects: Record<string, { input?: { required?: Record<string, unknown> } } | undefined>,
): ComfyWorkflow {
  const result = structuredClone(workflow);
  const fields: Record<string, string> = { UNETLoader: 'unet_name', CLIPLoader: 'clip_name', VAELoader: 'vae_name' };
  for (const node of Object.values(result)) {
    const field = fields[node.class_type];
    const value = field ? node.inputs[field] : undefined;
    if (typeof value !== 'string') continue;
    const spec = objects[node.class_type]?.input?.required?.[field] as unknown[] | undefined;
    const options = Array.isArray(spec?.[0])
      ? (spec[0] as unknown[])
      : ((spec?.[1] as { options?: unknown[] } | undefined)?.options ?? []);
    const wanted = value.replaceAll('\\', '/');
    const matches = options.filter(
      (option): option is string => typeof option === 'string' && option.replaceAll('\\', '/') === wanted,
    );
    if (matches.length !== 1)
      throw new Error(`The engine can't see ${wanted.split('/').at(-1)}. Restart the engine and try again.`);
    node.inputs[field] = matches[0];
  }
  return result;
}

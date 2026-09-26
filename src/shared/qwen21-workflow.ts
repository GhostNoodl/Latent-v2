import type { ComfyWorkflow } from './types';
import { QWEN21_IDENTITIES, QWEN21_RUNTIME } from './qwen21-release';
import { isQwen21Profile, qwenEditSettingsSchema, type QwenEditBundle, type QwenEditWorkflowInput, type QwenEditWorkflowPlan } from './qwen-edit-types';
import { qwenInferenceSize } from './qwen-edit-canvas';

export function validateQwen21Bundle(bundle: QwenEditBundle) {
  const runtime = QWEN21_RUNTIME;
  if (!isQwen21Profile(bundle?.profile) || bundle.id !== 'qwen-image-2.1-int8' || bundle.assets.lightning || Object.entries(runtime).some(([key, value]) => JSON.stringify(bundle.runtime?.[key as keyof typeof bundle.runtime]) !== JSON.stringify(value))) throw new Error('Install and verify the Qwen Image 2.1 bundle.');
  let total = 0;
  for (const role of ['diffusion', 'encoder', 'vae'] as const) {
    const asset = bundle.assets[role], pin = QWEN21_IDENTITIES[role];
    if (!asset || asset.role !== role || asset.status !== 'ready' || asset.format !== 'safetensors' || (['filename','directory','bytes','sha256'] as const).some(key => asset[key] !== pin[key])) throw new Error(`Verify the Qwen 2.1 ${role} model.`);
    total += asset.bytes;
  }
  if (bundle.totalBytes !== total) throw new Error('The Qwen 2.1 bundle is incomplete.');
}

function validateSource(source: QwenEditWorkflowInput['source'], filename?: string) {
  if (!source || !/^src_[a-f0-9-]{36}$/.test(source.id) || !/^[a-f0-9]{64}$/.test(source.normalized.sha256) || source.normalized.mimeType !== 'image/png' || !filename || filename.length > 512 || !/\.png$/i.test(filename) || filename.split('/').some(part => !/^[a-z0-9][a-z0-9_. -]{0,239}$/i.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Choose a verified source image from this studio.');
}

export function buildQwen21Workflow(input: QwenEditWorkflowInput, bundle: QwenEditBundle): QwenEditWorkflowPlan {
  validateQwen21Bundle(bundle);
  const parsed = qwenEditSettingsSchema.parse(input.settings);
  const settings = { ...parsed, steps: parsed.steps ?? 25, guidance: parsed.guidance ?? 1 };
  const workflowVersion = 'qwen-image-2.1@1';
  if (settings.profile !== bundle.profile || !isQwen21Profile(settings.profile) || settings.guidance !== 1 || input.workflowVersion && input.workflowVersion !== workflowVersion) throw new Error('Qwen 2.1 uses its own CFG 1 workflow.');
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.jobId) || !input.instruction.trim() || input.instruction.length > 4000 || input.instruction.includes('\0') || (input.negativePrompt?.length ?? 0) > 4000 || input.negativePrompt?.includes('\0')) throw new Error('Enter a valid Qwen instruction.');
  const operation = input.operation ?? 'edit';
  if (operation === 'edit') validateSource(input.source, input.sourceFilename);
  else if (input.source || input.references?.length) throw new Error('Create starts from text only. Choose Edit to use reference images.');
  if ((input.references?.length ?? 0) > 1) throw new Error('This station supports one additional reference image.');
  const aligned = qwenInferenceSize(settings.width, settings.height);
  const native = { width: Math.floor(aligned.width / 32) * 32, height: Math.floor(aligned.height / 32) * 32 };
  const filenamePrefix = `Latent_${input.jobId}_qwen_edit`;
  const prompt = input.transparent ? `This is an RGBA image with transparency. ${input.instruction}\nThe image has alpha channel and the background is transparent.` : input.instruction;
  const workflow: ComfyWorkflow = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: bundle.assets.diffusion.filename, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: bundle.assets.encoder.filename, type: 'qwen_image', device: 'cpu' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: bundle.assets.vae.filename } },
    '8': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2',0], vae: ['3',0], prompt, negative_prompt: input.negativePrompt ?? '', resolution: operation === 'edit' ? 0 : 1024 } },
    '12': { class_type: 'QwenImage21Cache', inputs: { model: ['1',0], device: 'auto', dtype: 'default' } },
    '15': { class_type: 'KSampler', inputs: { model: ['12',0], positive: ['8',0], negative: ['8',1], latent_image: [operation === 'edit' ? '8' : '6', operation === 'edit' ? 2 : 0], seed: Number(settings.seed), steps: settings.steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    '16': { class_type: 'VAEDecode', inputs: { samples: ['15',0], vae: ['3',0] } },
    '17': { class_type: 'ImageScale', inputs: { image: ['16',0], upscale_method: 'lanczos', width: settings.width, height: settings.height, crop: 'disabled' } },
    '7': { class_type: 'SaveImage', inputs: { images: ['17',0], filename_prefix: filenamePrefix } },
  };
  if (operation === 'edit') {
    workflow['4'] = { class_type: 'LoadImage', inputs: { image: input.sourceFilename! } };
    workflow['5'] = { class_type: 'ImageScale', inputs: { image: ['4',0], upscale_method: 'lanczos', width: native.width, height: native.height, crop: settings.resize === 'center-crop' ? 'center' : 'disabled' } };
    workflow['8'].inputs['images.image_1'] = ['5',0];
  } else {
    // Qwen's empty latent has 64 channels at 1/16 scale. The generic resizer uses
    // 1/8 units, so half-size arguments resize those zeros to the correct canvas.
    workflow['6'] = { class_type: 'LatentUpscale', inputs: { samples: ['8',2], upscale_method: 'nearest-exact', width: native.width / 2, height: native.height / 2, crop: 'disabled' } };
  }
  for (const reference of input.references ?? []) {
    validateSource(reference.source, reference.filename);
    const ratio = Math.max(0.25, Math.min(4, reference.source.normalized.width / reference.source.normalized.height));
    const referenceSize = { width: Math.max(32, Math.round(Math.sqrt(1048576 * ratio) / 32) * 32), height: Math.max(32, Math.round(Math.sqrt(1048576 / ratio) / 32) * 32) };
    workflow['20'] = { class_type: 'LoadImage', inputs: { image: reference.filename } };
    workflow['21'] = { class_type: 'ImageScale', inputs: { image: ['20',0], upscale_method: 'lanczos', ...referenceSize, crop: 'disabled' } };
    workflow['8'].inputs['images.image_2'] = ['21',0];
  }
  return { workflow, workflowVersion, bundle: structuredClone(bundle), source: input.source ? structuredClone(input.source) : undefined, operation, transparent: input.transparent ?? false, references: structuredClone(input.references ?? []), instruction: input.instruction, negativePrompt: input.negativePrompt ?? '', settings, sampler: { nodeId: '15', name: 'euler', scheduler: 'simple', denoise: 1, modelShift: null, cfgNorm: null, textEncoderDevice: 'cpu' }, output: { nodeId: '7', filenamePrefix, width: settings.width, height: settings.height, batchSize: 1 }, expectedOutputCount: 1, canvas: { sourceFitting: { ...native, mode: settings.resize }, inference: native, reference: native, output: { width: settings.width, height: settings.height, method: 'lanczos' } } };
}

export function validateQwen21Capabilities(objects: Record<string, any>, bundle: QwenEditBundle) {
  validateQwen21Bundle(bundle);
  for (const name of ['UNETLoader','CLIPLoader','VAELoader','LoadImage','ImageScale','KSampler','SaveImage','VAEDecode','TextEncodeQwenImage21','QwenImage21Cache','LatentUpscale']) if (!objects[name]) throw new Error('Set up the Qwen 2.1 engine update before generating.');
  if (JSON.stringify(objects.TextEncodeQwenImage21.output) !== JSON.stringify(['CONDITIONING','CONDITIONING','LATENT']) || objects.SaveImage.output_node !== true) throw new Error('The engine has an incompatible Qwen 2.1 workflow.');
}

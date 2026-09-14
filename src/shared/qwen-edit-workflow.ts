import type { ComfyWorkflow } from './types';
import { QWEN_EDIT_IDENTITIES, qwenEditSettingsSchema, qwenEditWorkflowVersionSchema, type QwenEditBundle, type QwenEditProfile, type QwenEditWorkflowInput, type QwenEditWorkflowPlan } from './qwen-edit-types';
import { qwenInferenceSize } from './qwen-edit-canvas';

export function validateQwenEditBundle(bundle: QwenEditBundle, profile: QwenEditProfile = bundle?.profile) {
  if (!bundle || bundle.id !== 'qwen-edit-2511-native-int8' || bundle.profile !== profile || !['base', 'fast'].includes(profile) || bundle.runtime?.route !== 'native-int8-convrot' || bundle.runtime.comfySourceCommit !== '12d5279438bfefc058a269eae805ceab6047777f' || bundle.runtime.comfyVersion !== '0.34.0' || bundle.runtime.torchVersion !== '2.11.0+cu130' || bundle.runtime.comfyKitchenVersion !== '0.2.31' || !Array.isArray(bundle.runtime.customNodes) || bundle.runtime.customNodes.length || bundle.runtime.cpuTextEncoder !== true) throw new Error('Verify the reviewed native Qwen edit bundle and runtime before editing.');
  let bytes = 0;
  for (const role of ['diffusion', 'encoder', 'vae', ...(profile === 'fast' ? ['lightning'] : [])] as const) {
    const key = role as keyof typeof QWEN_EDIT_IDENTITIES; const expected = QWEN_EDIT_IDENTITIES[key]; const asset = bundle.assets?.[key];
    if (!asset || asset.role !== role || asset.status !== 'ready' || asset.format !== 'safetensors' || Object.entries(expected).some(([field, value]) => asset[field as keyof typeof asset] !== value)) throw new Error(`Verify the exact reviewed Qwen ${role} asset before editing.`);
    bytes += asset.bytes;
  }
  if (bundle.totalBytes !== bytes || profile === 'base' && bundle.assets.lightning) throw new Error('The Qwen profile and its installed artifact set do not match.');
}

function sourceFilename(value: string) {
  if (typeof value !== 'string' || value.length > 512 || !/\.png$/i.test(value) || value.split('/').some(part => !/^[a-z0-9][a-z0-9_. -]{0,239}$/i.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Qwen edit needs a verified relative PNG filename inside studio inputs.');
  return value;
}

/** Native one-image 2511 recipe. Its input pixels must be resolved and rehashed by the job service. */
export function buildQwenEditWorkflow(input: QwenEditWorkflowInput, bundle: QwenEditBundle): QwenEditWorkflowPlan {
  const parsed = qwenEditSettingsSchema.parse(input.settings); validateQwenEditBundle(bundle, parsed.profile);
  const settings = { ...parsed, steps: parsed.steps ?? (parsed.profile === 'fast' ? 4 : 40), guidance: parsed.guidance ?? (parsed.profile === 'fast' ? 1 : 4) };
  const workflowVersion = qwenEditWorkflowVersionSchema.parse(input.workflowVersion ?? 'qwen-image-edit-2511-int8@2');
  const aligned = workflowVersion === 'qwen-image-edit-2511-int8@2';
  const native = aligned ? qwenInferenceSize(settings.width, settings.height) : { width: settings.width, height: settings.height };
  const source = input.source; const size = source?.normalized; const filename = sourceFilename(input.sourceFilename);
  if (!/^src_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source?.id ?? '') || !/^[0-9a-f]{64}$/.test(size?.sha256 ?? '') || size?.mimeType !== 'image/png' || !Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width < 1 || size.height < 1 || Math.max(size.width, size.height) > 8192 || size.width * size.height > 32 * 1024 * 1024) throw new Error('Qwen edit requires a bounded immutable source image and its SHA-256 identity.');
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.jobId)) throw new Error('The Qwen job identifier is invalid.');
  if (typeof input.instruction !== 'string' || !input.instruction.trim() || input.instruction.length > 4000 || input.instruction.includes('\0') || input.negativePrompt !== undefined && (typeof input.negativePrompt !== 'string' || input.negativePrompt.length > 4000 || input.negativePrompt.includes('\0'))) throw new Error('Enter an edit instruction of 1–4000 characters.');
  const negativePrompt = input.negativePrompt ?? ''; const filenamePrefix = `Latent_${input.jobId}_qwen_edit`;
  const workflow: ComfyWorkflow = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: bundle.assets.diffusion.filename, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: bundle.assets.encoder.filename, type: 'qwen_image', device: 'cpu' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: bundle.assets.vae.filename } },
    '4': { class_type: 'LoadImage', inputs: { image: filename } },
    '5': { class_type: 'ImageScale', inputs: { image: ['4', 0], upscale_method: 'lanczos', width: native.width, height: native.height, crop: settings.resize === 'center-crop' ? 'center' : 'disabled' } },
    '6': { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['3', 0] } },
    '7': { class_type: 'SaveImage', inputs: { images: [aligned ? '17' : '16', 0], filename_prefix: filenamePrefix } },
    '8': { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], prompt: input.instruction, vae: ['3', 0], image1: ['5', 0] } },
    '9': { class_type: 'TextEncodeQwenImageEditPlus', inputs: { clip: ['2', 0], prompt: negativePrompt, vae: ['3', 0], image1: ['5', 0] } },
    '10': { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['8', 0], reference_latents_method: 'index_timestep_zero' } },
    '11': { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { conditioning: ['9', 0], reference_latents_method: 'index_timestep_zero' } },
    '12': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3.1 } },
    '13': { class_type: 'CFGNorm', inputs: { model: ['12', 0], strength: 1, pre_cfg: false } },
    '15': { class_type: 'KSampler', inputs: { model: [parsed.profile === 'fast' ? '14' : '13', 0], seed: Number(settings.seed), steps: settings.steps, cfg: settings.guidance, sampler_name: 'euler', scheduler: 'simple', positive: ['10', 0], negative: ['11', 0], latent_image: ['6', 0], denoise: 1 } },
    '16': { class_type: 'VAEDecode', inputs: { samples: ['15', 0], vae: ['3', 0] } },
  };
  if (parsed.profile === 'fast') workflow['14'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['13', 0], lora_name: bundle.assets.lightning!.filename, strength_model: 1 } };
  if (aligned) workflow['17'] = { class_type: 'ImageScale', inputs: { image: ['16', 0], upscale_method: 'lanczos', width: settings.width, height: settings.height, crop: 'disabled' } };
  return { workflow, workflowVersion, bundle: structuredClone(bundle), source: structuredClone(source), instruction: input.instruction, negativePrompt, settings, sampler: { nodeId: '15', name: 'euler', scheduler: 'simple', denoise: 1, modelShift: 3.1, cfgNorm: 1, textEncoderDevice: 'cpu' }, output: { nodeId: '7', filenamePrefix, width: settings.width, height: settings.height, batchSize: 1 }, expectedOutputCount: 1, ...(aligned ? { canvas: { sourceFitting: { ...native, mode: settings.resize }, inference: { ...native }, reference: { ...native }, output: { width: settings.width, height: settings.height, method: 'lanczos' as const } } } : {}) };
}

/** Read-only preflight using fresh /object_info; model enums must include the registered private paths. */
export function validateQwenEditCapabilities(objects: Record<string, any>, bundle: QwenEditBundle) {
  validateQwenEditBundle(bundle);
  const fields: Record<string, Record<string, string>> = {
    VAEEncode: { pixels: 'IMAGE', vae: 'VAE' }, VAEDecode: { samples: 'LATENT', vae: 'VAE' },
    ImageScale: { image: 'IMAGE', width: 'INT', height: 'INT' }, TextEncodeQwenImageEditPlus: { clip: 'CLIP', prompt: 'STRING', vae: 'VAE', image1: 'IMAGE' },
    FluxKontextMultiReferenceLatentMethod: { conditioning: 'CONDITIONING' }, ModelSamplingAuraFlow: { model: 'MODEL', shift: 'FLOAT' }, CFGNorm: { model: 'MODEL', strength: 'FLOAT', pre_cfg: 'BOOLEAN' },
    KSampler: { model: 'MODEL', seed: 'INT', steps: 'INT', cfg: 'FLOAT', positive: 'CONDITIONING', negative: 'CONDITIONING', latent_image: 'LATENT', denoise: 'FLOAT' }, SaveImage: { images: 'IMAGE', filename_prefix: 'STRING' },
    ...(bundle.profile === 'fast' ? { LoraLoaderModelOnly: { model: 'MODEL', strength_model: 'FLOAT' } } : {}),
  };
  const definition = (node: string, field: string) => objects[node]?.input?.required?.[field] ?? objects[node]?.input?.optional?.[field];
  const choices = (value: any): unknown[] => Array.isArray(value?.[0]) ? value[0] : value?.[0] === 'COMBO' && Array.isArray(value?.[1]?.options) ? value[1].options : [];
  for (const [node, inputs] of Object.entries(fields)) for (const [field, type] of Object.entries(inputs)) if (definition(node, field)?.[0] !== type) throw new Error(`The engine does not provide reviewed ${node}.${field}.`);
  const enums = [['UNETLoader', 'unet_name', bundle.assets.diffusion.filename], ['UNETLoader', 'weight_dtype', 'default'], ['CLIPLoader', 'clip_name', bundle.assets.encoder.filename], ['CLIPLoader', 'type', 'qwen_image'], ['CLIPLoader', 'device', 'cpu'], ['VAELoader', 'vae_name', bundle.assets.vae.filename], ['ImageScale', 'upscale_method', 'lanczos'], ['ImageScale', 'crop', 'center'], ['ImageScale', 'crop', 'disabled'], ['FluxKontextMultiReferenceLatentMethod', 'reference_latents_method', 'index_timestep_zero'], ['KSampler', 'sampler_name', 'euler'], ['KSampler', 'scheduler', 'simple'], ...(bundle.profile === 'fast' ? [['LoraLoaderModelOnly', 'lora_name', bundle.assets.lightning!.filename]] : [])];
  for (const [node, field, value] of enums) if (!choices(definition(node, field)).some(option => typeof option === 'string' && option.replaceAll('\\', '/') === value)) throw new Error(`The engine does not offer reviewed ${node}.${field}; verify model paths and restart the private engine.`);
  const outputs: Record<string, string> = { UNETLoader: 'MODEL', CLIPLoader: 'CLIP', VAELoader: 'VAE', LoadImage: 'IMAGE', ImageScale: 'IMAGE', VAEEncode: 'LATENT', VAEDecode: 'IMAGE', TextEncodeQwenImageEditPlus: 'CONDITIONING', FluxKontextMultiReferenceLatentMethod: 'CONDITIONING', ModelSamplingAuraFlow: 'MODEL', CFGNorm: 'MODEL', KSampler: 'LATENT', SaveImage: 'IMAGE', ...(bundle.profile === 'fast' ? { LoraLoaderModelOnly: 'MODEL' } : {}) };
  for (const [node, type] of Object.entries(outputs)) if (objects[node]?.output?.[0] !== type) throw new Error(`The engine does not provide reviewed ${node} output.`);
  if (!Array.isArray(definition('LoadImage', 'image')?.[0]) && definition('LoadImage', 'image')?.[0] !== 'COMBO') throw new Error('The engine does not provide the reviewed source-image loader.');
}

/** Windows reports backslashes in model COMBO values. Bind only the exact canonical reviewed name. */
export function bindQwenEditWorkflow(plan: QwenEditWorkflowPlan, objects: Record<string, any>): QwenEditWorkflowPlan {
  validateQwenEditCapabilities(objects, plan.bundle); const result = structuredClone(plan);
  const fields = [['1', 'unet_name', plan.bundle.assets.diffusion.filename], ['2', 'clip_name', plan.bundle.assets.encoder.filename], ['3', 'vae_name', plan.bundle.assets.vae.filename], ...(plan.bundle.profile === 'fast' ? [['14', 'lora_name', plan.bundle.assets.lightning!.filename]] : [])];
  for (const [id, field, canonical] of fields) {
    const node = result.workflow[id]; const definition = objects[node.class_type]?.input?.required?.[field]; const options: unknown[] = Array.isArray(definition?.[0]) ? definition[0] : definition?.[0] === 'COMBO' && Array.isArray(definition?.[1]?.options) ? definition[1].options : [];
    const matches = options.filter(option => typeof option === 'string' && option.replaceAll('\\', '/') === canonical);
    if (matches.length !== 1) throw new Error(`The engine returned ambiguous reviewed Qwen ${field} choices.`);
    node.inputs[field] = matches[0] as string;
  }
  return result;
}

import { buildQwen21Workflow, validateQwen21Bundle, validateQwen21Capabilities } from './qwen21-workflow';
import type { ComfyWorkflow } from './types';
import { QWEN_GGUF_RELEASE } from './qwen-gguf-release';
import {
  isQwen21Profile,
  QWEN_LIGHTNING8_IDENTITY,
  qwenProfileSteps,
  QWEN_COMPACT_DIFFUSION,
  isFastQwenProfile,
  QWEN_EDIT_IDENTITIES,
  qwenEditSettingsSchema,
  qwenEditWorkflowVersionSchema,
  isQwenEditV3,
  qwenOutputSizeSchema,
  qwenAreaSchema,
  type QwenEditBundle,
  type QwenEditProfile,
  type QwenEditWorkflowInput,
  type QwenEditWorkflowPlan,
} from './qwen-edit-types';
import { qwenInferenceSize } from './qwen-edit-canvas';
import { qwenWorkingSize } from './qwen-area';

export function validateQwenEditBundle(bundle: QwenEditBundle, profile: QwenEditProfile = bundle?.profile) {
  if (isQwen21Profile(profile)) {
    validateQwen21Bundle(bundle);
    return;
  }
  const compact = profile === 'compact';
  if (
    !bundle ||
    bundle.id !== (compact ? 'qwen-edit-2511-gguf-q4ks' : 'qwen-edit-2511-native-int8') ||
    bundle.profile !== profile ||
    !['base', 'fast', 'compact', 'lightning8'].includes(profile) ||
    bundle.runtime?.route !== (compact ? 'gguf-q4ks' : 'native-int8-convrot') ||
    bundle.runtime.comfySourceCommit !== '12d5279438bfefc058a269eae805ceab6047777f' ||
    bundle.runtime.comfyVersion !== '0.34.0' ||
    bundle.runtime.torchVersion !== '2.11.0+cu130' ||
    bundle.runtime.comfyKitchenVersion !== '0.2.31' ||
    !Array.isArray(bundle.runtime.customNodes) ||
    JSON.stringify(bundle.runtime.customNodes) !== JSON.stringify(compact ? [QWEN_GGUF_RELEASE.revision] : []) ||
    bundle.runtime.cpuTextEncoder !== true
  )
    throw new Error('Verify the selected Qwen edit bundle and runtime before editing.');
  let bytes = 0;
  for (const role of ['diffusion', 'encoder', 'vae', ...(isFastQwenProfile(profile) ? ['lightning'] : [])] as const) {
    const key = role as keyof typeof QWEN_EDIT_IDENTITIES;
    const expected =
      profile === 'lightning8' && key === 'lightning'
        ? QWEN_LIGHTNING8_IDENTITY
        : compact && key === 'diffusion'
          ? QWEN_COMPACT_DIFFUSION
          : QWEN_EDIT_IDENTITIES[key];
    const asset = bundle.assets?.[key];
    if (
      !asset ||
      asset.role !== role ||
      asset.status !== 'ready' ||
      asset.format !== (compact && key === 'diffusion' ? 'gguf' : 'safetensors') ||
      Object.entries(expected).some(([field, value]) => asset[field as keyof typeof asset] !== value)
    )
      throw new Error(`Verify the exact reviewed Qwen ${role} asset before editing.`);
    bytes += asset.bytes;
  }
  if (bundle.totalBytes !== bytes || (profile === 'base' && bundle.assets.lightning))
    throw new Error('The Qwen profile and its installed artifact set do not match.');
}

function sourceFilename(value: string) {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !/\.png$/i.test(value) ||
    value
      .split('/')
      .some(
        part =>
          !/^[a-z0-9][a-z0-9_. -]{0,239}$/i.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error('Qwen edit needs a verified relative PNG filename inside studio inputs.');
  return value;
}

/** Native one-image 2511 recipe. Its input pixels must be resolved and rehashed by the job service. */
export function buildQwenEditWorkflow(input: QwenEditWorkflowInput, bundle: QwenEditBundle): QwenEditWorkflowPlan {
  if (isQwen21Profile(input.settings.profile)) return buildQwen21Workflow(input, bundle);
  if (input.operation === 'create' || input.transparent)
    throw new Error('Creation and transparency require Qwen Image 2.1.');
  if (!input.source || !input.sourceFilename) throw new Error('Choose an input image before editing.');
  const parsed = qwenEditSettingsSchema.parse(input.settings);
  validateQwenEditBundle(bundle, parsed.profile);
  const settings = {
    ...parsed,
    steps: parsed.steps ?? qwenProfileSteps(parsed.profile),
    guidance: parsed.guidance ?? (isFastQwenProfile(parsed.profile) ? 1 : 4),
  };
  const workflowVersion = qwenEditWorkflowVersionSchema.parse(
    input.workflowVersion ??
      (parsed.profile === 'compact' ? 'qwen-image-edit-2511-gguf-q4ks@2' : 'qwen-image-edit-2511-int8@3'),
  );
  if (
    workflowVersion.startsWith('qwen-image-2.1') ||
    (parsed.profile === 'compact') !== workflowVersion.startsWith('qwen-image-edit-2511-gguf')
  )
    throw new Error('The Qwen model route does not match this recorded recipe.');
  const v3 = isQwenEditV3(workflowVersion);
  const references = input.references ?? [];
  if (references.length && !v3) throw new Error('This older recipe does not use extra pictures.');
  if (references.length > 2) throw new Error('Qwen Edit takes up to two extra pictures.');
  if ((input.area || input.output) && !v3) throw new Error('This older recipe edits the whole picture.');
  const aligned = workflowVersion !== 'qwen-image-edit-2511-int8@1';
  const native = aligned
    ? qwenInferenceSize(settings.width, settings.height)
    : { width: settings.width, height: settings.height };
  const source = input.source;
  const size = source?.normalized;
  const filename = sourceFilename(input.sourceFilename);
  if (
    !/^src_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(source?.id ?? '') ||
    !/^[0-9a-f]{64}$/.test(size?.sha256 ?? '') ||
    size?.mimeType !== 'image/png' ||
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width < 1 ||
    size.height < 1 ||
    Math.max(size.width, size.height) > 8192 ||
    size.width * size.height > 32 * 1024 * 1024
  )
    throw new Error('Qwen edit requires a bounded immutable source image and its SHA-256 identity.');
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.jobId)) throw new Error('The Qwen job identifier is invalid.');
  if (
    typeof input.instruction !== 'string' ||
    !input.instruction.trim() ||
    input.instruction.length > 4000 ||
    input.instruction.includes('\0') ||
    (input.negativePrompt !== undefined &&
      (typeof input.negativePrompt !== 'string' ||
        input.negativePrompt.length > 4000 ||
        input.negativePrompt.includes('\0')))
  )
    throw new Error('Enter an edit instruction of 1–4000 characters.');
  const negativePrompt = input.negativePrompt ?? '';
  const filenamePrefix = `Latent_${input.jobId}_qwen_edit`;
  for (const reference of references) {
    const ref = reference.source?.normalized;
    if (
      !/^src_[0-9a-f-]{36}$/i.test(reference.source?.id ?? '') ||
      !/^[0-9a-f]{64}$/.test(ref?.sha256 ?? '') ||
      ref?.mimeType !== 'image/png'
    )
      throw new Error('An extra picture is missing its saved identity.');
    sourceFilename(reference.filename);
  }
  const area = input.area ? qwenAreaSchema.parse(input.area) : undefined;
  const crop = area?.crop;
  if (area) {
    if (!crop || !input.maskFilename) throw new Error('A painted edit needs its painted area.');
    sourceFilename(input.maskFilename);
    if (
      crop.x % 8 ||
      crop.y % 8 ||
      crop.x + crop.width > size.width ||
      crop.y + crop.height > size.height ||
      (crop.width % 8 && crop.x + crop.width !== size.width) ||
      (crop.height % 8 && crop.y + crop.height !== size.height)
    )
      throw new Error('The painted area lies outside the picture.');
    const working = qwenWorkingSize(crop.width, crop.height);
    if (settings.width !== working.width || settings.height !== working.height || settings.resize !== 'stretch')
      throw new Error('A painted edit works at the size of its painted area.');
  }
  const output = area
    ? { width: size.width, height: size.height }
    : input.output
      ? qwenOutputSizeSchema.parse(input.output)
      : { width: settings.width, height: settings.height };
  if (area && input.output && (input.output.width !== size.width || input.output.height !== size.height))
    throw new Error('A painted edit keeps the size of the picture.');
  const workflow: ComfyWorkflow = {
    '1':
      parsed.profile === 'compact'
        ? { class_type: 'UnetLoaderGGUF', inputs: { unet_name: bundle.assets.diffusion.filename } }
        : {
            class_type: 'UNETLoader',
            inputs: { unet_name: bundle.assets.diffusion.filename, weight_dtype: 'default' },
          },
    '2': {
      class_type: 'CLIPLoader',
      inputs: {
        clip_name: bundle.assets.encoder.filename,
        type: 'qwen_image',
        device: input.textEncoderDevice ?? 'cpu',
      },
    },
    '3': { class_type: 'VAELoader', inputs: { vae_name: bundle.assets.vae.filename } },
    '4': { class_type: 'LoadImage', inputs: { image: filename } },
    '5': {
      class_type: 'ImageScale',
      inputs: {
        image: [crop ? '30' : '4', 0],
        upscale_method: 'lanczos',
        width: native.width,
        height: native.height,
        crop: settings.resize === 'center-crop' ? 'center' : 'disabled',
      },
    },
    '6': { class_type: 'VAEEncode', inputs: { pixels: ['5', 0], vae: ['3', 0] } },
    '7': {
      class_type: 'SaveImage',
      inputs: { images: [crop ? '37' : aligned ? '17' : '16', 0], filename_prefix: filenamePrefix },
    },
    '8': {
      class_type: 'TextEncodeQwenImageEditPlus',
      inputs: { clip: ['2', 0], prompt: input.instruction, vae: ['3', 0], image1: ['5', 0] },
    },
    '9': {
      class_type: 'TextEncodeQwenImageEditPlus',
      inputs: { clip: ['2', 0], prompt: negativePrompt, vae: ['3', 0], image1: ['5', 0] },
    },
    '10': {
      class_type: 'FluxKontextMultiReferenceLatentMethod',
      inputs: { conditioning: ['8', 0], reference_latents_method: 'index_timestep_zero' },
    },
    '11': {
      class_type: 'FluxKontextMultiReferenceLatentMethod',
      inputs: { conditioning: ['9', 0], reference_latents_method: 'index_timestep_zero' },
    },
    '12': { class_type: 'ModelSamplingAuraFlow', inputs: { model: ['1', 0], shift: 3.1 } },
    '13': { class_type: 'CFGNorm', inputs: { model: ['12', 0], strength: 1, pre_cfg: false } },
    '15': {
      class_type: 'KSampler',
      inputs: {
        model: [isFastQwenProfile(parsed.profile) ? '14' : '13', 0],
        seed: Number(settings.seed),
        steps: settings.steps,
        cfg: settings.guidance,
        sampler_name: 'euler',
        scheduler: 'simple',
        positive: ['10', 0],
        negative: ['11', 0],
        latent_image: ['6', 0],
        denoise: 1,
      },
    },
    '16': { class_type: 'VAEDecode', inputs: { samples: ['15', 0], vae: ['3', 0] } },
  };
  if (isFastQwenProfile(parsed.profile))
    workflow['14'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model: ['13', 0], lora_name: bundle.assets.lightning!.filename, strength_model: 1 },
    };
  if (parsed.profile === 'lightning8') {
    workflow['14'].inputs.model = ['1', 0];
    workflow['12'].inputs.model = ['14', 0];
    workflow['15'].inputs.model = ['13', 0];
  }
  if (aligned)
    workflow['17'] = {
      class_type: 'ImageScale',
      inputs: {
        image: ['16', 0],
        upscale_method: 'lanczos',
        width: crop ? crop.width : output.width,
        height: crop ? crop.height : output.height,
        crop: 'disabled',
      },
    };
  references.forEach((reference, index) => {
    const id = String(40 + index);
    workflow[id] = { class_type: 'LoadImage', inputs: { image: sourceFilename(reference.filename) } };
    workflow['8'].inputs[`image${index + 2}`] = [id, 0];
    workflow['9'].inputs[`image${index + 2}`] = [id, 0];
  });
  if (area && crop) {
    const rect = { width: crop.width, height: crop.height, x: crop.x, y: crop.y };
    workflow['30'] = { class_type: 'ImageCrop', inputs: { image: ['4', 0], ...rect } };
    workflow['31'] = { class_type: 'LoadImageMask', inputs: { image: input.maskFilename!, channel: 'red' } };
    workflow['32'] = { class_type: 'CropMask', inputs: { mask: ['31', 0], ...rect } };
    let mask: [string, number] = ['32', 0];
    if (area.blend > 0) {
      workflow['33'] = {
        class_type: 'GrowMask',
        inputs: { mask: ['32', 0], expand: area.blend, tapered_corners: true },
      };
      workflow['34'] = { class_type: 'MaskToImage', inputs: { mask: ['33', 0] } };
      workflow['35'] = {
        class_type: 'ImageBlur',
        inputs: {
          image: ['34', 0],
          blur_radius: Math.min(31, area.blend),
          sigma: Math.round(Math.min(10, Math.max(0.1, area.blend / 3)) * 10) / 10,
        },
      };
      workflow['36'] = { class_type: 'ImageToMask', inputs: { image: ['35', 0], channel: 'red' } };
      mask = ['36', 0];
    }
    workflow['37'] = {
      class_type: 'ImageCompositeMasked',
      inputs: {
        destination: ['4', 0],
        source: ['17', 0],
        x: crop.x,
        y: crop.y,
        resize_source: false,
        mask,
      },
    };
  }
  return {
    workflow,
    workflowVersion,
    bundle: structuredClone(bundle),
    source: structuredClone(source),
    ...(references.length ? { references: structuredClone(references) } : {}),
    ...(area && crop ? { area: { ...structuredClone(area), crop: { ...crop } } } : {}),
    instruction: input.instruction,
    negativePrompt,
    settings,
    sampler: {
      nodeId: '15',
      name: 'euler',
      scheduler: 'simple',
      denoise: 1,
      modelShift: 3.1,
      cfgNorm: 1,
      textEncoderDevice: input.textEncoderDevice ?? 'cpu',
    },
    output: { nodeId: '7', filenamePrefix, width: output.width, height: output.height, batchSize: 1 },
    expectedOutputCount: 1,
    ...(aligned
      ? {
          canvas: {
            sourceFitting: { ...native, mode: settings.resize },
            inference: { ...native },
            reference: { ...native },
            output: { width: output.width, height: output.height, method: 'lanczos' as const },
          },
        }
      : {}),
  };
}

/** Read-only preflight using fresh /object_info; model enums must include the registered private paths. */
export function validateQwenEditCapabilities(
  objects: Record<string, any>,
  bundle: QwenEditBundle,
  plan?: Pick<QwenEditWorkflowPlan, 'references' | 'area'>,
) {
  if (isQwen21Profile(bundle.profile)) {
    validateQwen21Capabilities(objects, bundle);
    return;
  }
  validateQwenEditBundle(bundle);
  const extraPictures = plan?.references?.length ?? 0;
  const fields: Record<string, Record<string, string>> = {
    ...(plan?.area
      ? {
          ImageCrop: { image: 'IMAGE', width: 'INT', height: 'INT', x: 'INT', y: 'INT' },
          CropMask: { mask: 'MASK', x: 'INT', y: 'INT', width: 'INT', height: 'INT' },
          ImageCompositeMasked: { destination: 'IMAGE', source: 'IMAGE', x: 'INT', y: 'INT', mask: 'MASK' },
          ...(plan.area.blend > 0
            ? {
                GrowMask: { mask: 'MASK', expand: 'INT', tapered_corners: 'BOOLEAN' },
                MaskToImage: { mask: 'MASK' },
                ImageBlur: { image: 'IMAGE', blur_radius: 'INT', sigma: 'FLOAT' },
                ImageToMask: { image: 'IMAGE' },
              }
            : {}),
        }
      : {}),
    VAEEncode: { pixels: 'IMAGE', vae: 'VAE' },
    VAEDecode: { samples: 'LATENT', vae: 'VAE' },
    ImageScale: { image: 'IMAGE', width: 'INT', height: 'INT' },
    TextEncodeQwenImageEditPlus: {
      clip: 'CLIP',
      prompt: 'STRING',
      vae: 'VAE',
      image1: 'IMAGE',
      ...(extraPictures ? { image2: 'IMAGE' } : {}),
      ...(extraPictures > 1 ? { image3: 'IMAGE' } : {}),
    },
    FluxKontextMultiReferenceLatentMethod: { conditioning: 'CONDITIONING' },
    ModelSamplingAuraFlow: { model: 'MODEL', shift: 'FLOAT' },
    CFGNorm: { model: 'MODEL', strength: 'FLOAT', pre_cfg: 'BOOLEAN' },
    KSampler: {
      model: 'MODEL',
      seed: 'INT',
      steps: 'INT',
      cfg: 'FLOAT',
      positive: 'CONDITIONING',
      negative: 'CONDITIONING',
      latent_image: 'LATENT',
      denoise: 'FLOAT',
    },
    SaveImage: { images: 'IMAGE', filename_prefix: 'STRING' },
    ...(isFastQwenProfile(bundle.profile) ? { LoraLoaderModelOnly: { model: 'MODEL', strength_model: 'FLOAT' } } : {}),
  };
  const definition = (node: string, field: string) =>
    objects[node]?.input?.required?.[field] ?? objects[node]?.input?.optional?.[field];
  const choices = (value: any): unknown[] =>
    Array.isArray(value?.[0])
      ? value[0]
      : value?.[0] === 'COMBO' && Array.isArray(value?.[1]?.options)
        ? value[1].options
        : [];
  for (const [node, inputs] of Object.entries(fields))
    for (const [field, type] of Object.entries(inputs))
      if (definition(node, field)?.[0] !== type)
        throw new Error(`The engine does not provide reviewed ${node}.${field}.`);
  const loader = bundle.profile === 'compact' ? 'UnetLoaderGGUF' : 'UNETLoader';
  const enums = [
    [loader, 'unet_name', bundle.assets.diffusion.filename],
    ...(bundle.profile === 'compact' ? [] : [['UNETLoader', 'weight_dtype', 'default']]),
    ['CLIPLoader', 'clip_name', bundle.assets.encoder.filename],
    ['CLIPLoader', 'type', 'qwen_image'],
    ['CLIPLoader', 'device', 'cpu'],
    ['VAELoader', 'vae_name', bundle.assets.vae.filename],
    ['ImageScale', 'upscale_method', 'lanczos'],
    ['ImageScale', 'crop', 'center'],
    ['ImageScale', 'crop', 'disabled'],
    ['FluxKontextMultiReferenceLatentMethod', 'reference_latents_method', 'index_timestep_zero'],
    ['KSampler', 'sampler_name', 'euler'],
    ['KSampler', 'scheduler', 'simple'],
    ...(plan?.area ? [['LoadImageMask', 'channel', 'red']] : []),
    ...(plan?.area && plan.area.blend > 0 ? [['ImageToMask', 'channel', 'red']] : []),
    ...(isFastQwenProfile(bundle.profile)
      ? [['LoraLoaderModelOnly', 'lora_name', bundle.assets.lightning!.filename]]
      : []),
  ];
  for (const [node, field, value] of enums)
    if (
      !choices(definition(node, field)).some(
        option => typeof option === 'string' && option.replaceAll('\\', '/') === value,
      )
    )
      throw new Error(
        `The engine does not offer reviewed ${node}.${field}; verify model paths and restart the private engine.`,
      );
  const outputs: Record<string, string> = {
    [loader]: 'MODEL',
    CLIPLoader: 'CLIP',
    VAELoader: 'VAE',
    LoadImage: 'IMAGE',
    ImageScale: 'IMAGE',
    VAEEncode: 'LATENT',
    VAEDecode: 'IMAGE',
    TextEncodeQwenImageEditPlus: 'CONDITIONING',
    FluxKontextMultiReferenceLatentMethod: 'CONDITIONING',
    ModelSamplingAuraFlow: 'MODEL',
    CFGNorm: 'MODEL',
    KSampler: 'LATENT',
    SaveImage: 'IMAGE',
    ...(isFastQwenProfile(bundle.profile) ? { LoraLoaderModelOnly: 'MODEL' } : {}),
    ...(plan?.area
      ? {
          ImageCrop: 'IMAGE',
          LoadImageMask: 'MASK',
          CropMask: 'MASK',
          ImageCompositeMasked: 'IMAGE',
          ...(plan.area.blend > 0
            ? { GrowMask: 'MASK', MaskToImage: 'IMAGE', ImageBlur: 'IMAGE', ImageToMask: 'MASK' }
            : {}),
        }
      : {}),
  };
  for (const [node, type] of Object.entries(outputs))
    if (objects[node]?.output?.[0] !== type) throw new Error(`The engine does not provide reviewed ${node} output.`);
  if (!Array.isArray(definition('LoadImage', 'image')?.[0]) && definition('LoadImage', 'image')?.[0] !== 'COMBO')
    throw new Error('The engine does not provide the reviewed source-image loader.');
}

/** Windows reports backslashes in model COMBO values. Bind only the exact canonical reviewed name. */
export function bindQwenEditWorkflow(plan: QwenEditWorkflowPlan, objects: Record<string, any>): QwenEditWorkflowPlan {
  validateQwenEditCapabilities(objects, plan.bundle, plan);
  const result = structuredClone(plan);
  const fields = [
    ['1', 'unet_name', plan.bundle.assets.diffusion.filename],
    ['2', 'clip_name', plan.bundle.assets.encoder.filename],
    ['3', 'vae_name', plan.bundle.assets.vae.filename],
    ...(isFastQwenProfile(plan.bundle.profile) ? [['14', 'lora_name', plan.bundle.assets.lightning!.filename]] : []),
  ];
  for (const [id, field, canonical] of fields) {
    const node = result.workflow[id];
    const definition = objects[node.class_type]?.input?.required?.[field];
    const options: unknown[] = Array.isArray(definition?.[0])
      ? definition[0]
      : definition?.[0] === 'COMBO' && Array.isArray(definition?.[1]?.options)
        ? definition[1].options
        : [];
    const matches = options.filter(option => typeof option === 'string' && option.replaceAll('\\', '/') === canonical);
    if (matches.length !== 1) throw new Error(`The engine returned ambiguous reviewed Qwen ${field} choices.`);
    node.inputs[field] = matches[0] as string;
  }
  return result;
}

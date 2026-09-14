import type { ReviewedRuntimeSet } from './runtime-update-types';
/** Live engine ABI check, independent of whether optional model payloads are installed. */
export function validateRuntimeUpdateCapabilities(objects: Record<string, any>, set: ReviewedRuntimeSet, customNodeNames: readonly string[] = []) {
  for (const name of set.mandatoryNodes) if (!objects[name]) throw new Error(`Updated runtime is missing mandatory node ${name}.`);
  const required: Record<string, Record<string, string>> = {
    CLIPTextEncode: { text: 'STRING', clip: 'CLIP' }, EmptyLatentImage: { width: 'INT', height: 'INT', batch_size: 'INT' },
    KSampler: { model: 'MODEL', seed: 'INT', steps: 'INT', cfg: 'FLOAT', positive: 'CONDITIONING', negative: 'CONDITIONING', latent_image: 'LATENT', denoise: 'FLOAT' },
    VAEDecode: { samples: 'LATENT', vae: 'VAE' }, SaveImage: { images: 'IMAGE', filename_prefix: 'STRING' },
    VAEEncode: { pixels: 'IMAGE', vae: 'VAE' }, VAEEncodeForInpaint: { pixels: 'IMAGE', vae: 'VAE', mask: 'MASK', grow_mask_by: 'INT' },
    ImageScale: { image: 'IMAGE', width: 'INT', height: 'INT' }, ImageCompositeMasked: { destination: 'IMAGE', source: 'IMAGE', x: 'INT', y: 'INT', resize_source: 'BOOLEAN', mask: 'MASK' },
    Canny: { image: 'IMAGE', low_threshold: 'FLOAT', high_threshold: 'FLOAT' }, ControlNetApplyAdvanced: { positive: 'CONDITIONING', negative: 'CONDITIONING', control_net: 'CONTROL_NET', image: 'IMAGE', vae: 'VAE' },
    TextEncodeQwenImageEditPlus: { clip: 'CLIP', prompt: 'STRING', vae: 'VAE', image1: 'IMAGE' }, CFGNorm: { model: 'MODEL', strength: 'FLOAT', pre_cfg: 'BOOLEAN' }, ModelSamplingAuraFlow: { model: 'MODEL', shift: 'FLOAT' },
    LoraLoader: { model: 'MODEL', clip: 'CLIP', strength_model: 'FLOAT', strength_clip: 'FLOAT' }, LoraLoaderModelOnly: { model: 'MODEL', strength_model: 'FLOAT' },
    ImageUpscaleWithModel: { upscale_model: 'UPSCALE_MODEL', image: 'IMAGE' }, LatentUpscale: { samples: 'LATENT', width: 'INT', height: 'INT' }, GetImageSize: { image: 'IMAGE' }, LatentFromBatch: { samples: 'LATENT', batch_index: 'INT', length: 'INT' },
    MaskToImage: { mask: 'MASK' }, ImageToMask: { image: 'IMAGE' }, RepeatLatentBatch: { samples: 'LATENT', amount: 'INT' }, RepeatImageBatch: { image: 'IMAGE', amount: 'INT' },
    ImageCrop: { image: 'IMAGE', x: 'INT', y: 'INT', width: 'INT', height: 'INT' }, CropMask: { mask: 'MASK', x: 'INT', y: 'INT', width: 'INT', height: 'INT' }, SetLatentNoiseMask: { samples: 'LATENT', mask: 'MASK' }, JoinImageWithAlpha: { image: 'IMAGE', alpha: 'MASK' }, SplitImageWithAlpha: { image: 'IMAGE' },
    ConditioningSetMask: { conditioning: 'CONDITIONING', mask: 'MASK', strength: 'FLOAT' }, ConditioningCombine: { conditioning_1: 'CONDITIONING', conditioning_2: 'CONDITIONING' },
  };
  if (customNodeNames.includes('latent_ipadapter_plus')) { required.IPAdapterAdvanced = { model: 'MODEL', ipadapter: 'IPADAPTER', image: 'IMAGE', clip_vision: 'CLIP_VISION' }; if (!objects.IPAdapterModelLoader) throw new Error('Updated runtime did not load the retained reviewed IP Adapter loader.'); }
  const definition = (node: string, input: string) => objects[node]?.input?.required?.[input] ?? objects[node]?.input?.optional?.[input];
  for (const [node, inputs] of Object.entries(required)) for (const [input, expected] of Object.entries(inputs)) if (definition(node, input)?.[0] !== expected) throw new Error(`Updated runtime changed mandatory input ${node}.${input}.`);
  const options = (node: string, input: string): unknown[] => { const value = definition(node, input); return Array.isArray(value?.[0]) ? value[0] : value?.[0] === 'COMBO' && Array.isArray(value?.[1]?.options) ? value[1].options : []; };
  for (const [node, input, expected] of [['KSampler', 'sampler_name', 'euler'], ['KSampler', 'scheduler', 'simple'], ['CLIPLoader', 'type', 'qwen_image'], ['CLIPLoader', 'device', 'cpu'], ['FluxKontextMultiReferenceLatentMethod', 'reference_latents_method', 'index_timestep_zero'], ['SetUnionControlNetType', 'type', 'canny/lineart/anime_lineart/mlsd']]) if (!options(node, input).includes(expected)) throw new Error(`Updated runtime does not offer required ${node}.${input} option.`);
  if (objects.SaveImage?.output_node !== true) throw new Error('Updated runtime cannot guarantee durable SaveImage publication.');
  for (const [node, outputs] of Object.entries({ CheckpointLoaderSimple: ['MODEL', 'CLIP', 'VAE'], CLIPTextEncode: ['CONDITIONING'], KSampler: ['LATENT'], VAEDecode: ['IMAGE'], SaveImage: ['IMAGE'], GetImageSize: ['INT', 'INT', 'INT'], LatentFromBatch: ['LATENT'], SplitImageWithAlpha: ['IMAGE', 'MASK'], VAEEncode: ['LATENT'], TextEncodeQwenImageEditPlus: ['CONDITIONING'] })) if (JSON.stringify(objects[node]?.output) !== JSON.stringify(outputs)) throw new Error(`Updated runtime changed mandatory ${node} outputs.`);
}

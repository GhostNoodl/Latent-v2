import { isLoraFamilyCompatible } from './types';
import type { ComfyWorkflow, GenerationDraft, ModelAsset } from './types';
import { draftSchema } from './validation';
export const WORKFLOW_VERSION = 'sdxl-txt2img@1';
export function automaticTriggerWords(draft: GenerationDraft, models: ModelAsset[]): string[] {
  if (!draft.autoTriggers || draft.triggerResolutionVersion === 'visible@3') return [];
  const manual = draft.prompt.toLocaleLowerCase();
  const triggers = draft.loras.flatMap(selected => draft.triggerWords?.[selected.modelId] ?? models.find(model => model.id === selected.modelId)?.triggers ?? []);
  const seen = new Set<string>();
  const automatic = triggers.map(t => t.trim()).filter(trigger => {
    const key = trigger.toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Punctuation can surround an authored trigger, including a literal trigger
    // that contains punctuation. Letters, numbers, combining marks and connector
    // characters (such as _) keep it inside a longer word/identifier instead.
    // Unversioned saved recipes predate punctuation matching. Rebuild their
    // original text exactly, including historical duplicate trigger prefixes.
    const boundary = draft.triggerResolutionVersion === 'punctuation@2' ? '[^\\p{L}\\p{N}\\p{M}\\p{Pc}]' : '[\\s,;]';
    return !new RegExp(`(^|${boundary})${escaped}(?=$|${boundary})`, 'u').test(manual);
  });
  return automatic;
}
export function resolvePrompt(draft: GenerationDraft, models: ModelAsset[]): string {
  return [...automaticTriggerWords(draft, models), draft.prompt].filter(Boolean).join(', ');
}
export function validateAssets(draft: GenerationDraft, models: ModelAsset[]): { checkpoint: ModelAsset; loras: ModelAsset[] } {
  draftSchema.parse(draft);
  const checkpoint = models.find(model => model.id === draft.checkpointId && model.kind === 'checkpoint' && model.status === 'ready');
  if (!checkpoint) throw new Error('Choose an installed checkpoint before generating.');
  if (checkpoint.family !== draft.family) throw new Error('The checkpoint family does not match this draft. Choose a compatible model.');
  if (new Set(draft.loras.map(l => l.modelId)).size !== draft.loras.length) throw new Error('A LoRA can only be selected once.');
  const loras = draft.loras.map(selected => {
    const asset = models.find(model => model.id === selected.modelId && model.kind === 'lora' && model.status === 'ready');
    if (!asset) throw new Error('A selected LoRA is missing. Restore it or remove it from the draft.');
    if (!isLoraFamilyCompatible(asset.family, draft.family)) throw new Error(`The LoRA ${asset.name} does not match this model family.`);
    return asset;
  });
  for (const asset of [checkpoint, ...loras]) if (draft.assetHashes?.[asset.id] && draft.assetHashes[asset.id] !== asset.sha256) throw new Error(`${asset.name} has different model bytes from this image. Restore the original file or deliberately select a replacement.`);
  return { checkpoint, loras };
}
export function buildWorkflow(draft: GenerationDraft, models: ModelAsset[], actualSeed: string, jobId: string): ComfyWorkflow {
  const { checkpoint, loras } = validateAssets(draft, models);
  if (!/^\d+$/.test(actualSeed) || BigInt(actualSeed) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid resolved seed.');
  const workflow: ComfyWorkflow = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: checkpoint.filename } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: resolvePrompt(draft, models), clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: draft.negativePrompt, clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width: draft.width, height: draft.height, batch_size: draft.batchSize } },
    '5': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0], seed: Number(actualSeed), steps: draft.steps, cfg: draft.cfg, sampler_name: draft.sampler, scheduler: draft.scheduler, denoise: 1 } },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { images: ['6', 0], filename_prefix: `Latent_${jobId}` } },
  };
  let model: [string, number] = ['1', 0];
  let clip: [string, number] = ['1', 1];
  loras.forEach((lora, index) => {
    const node = String(50 + index);
    workflow[node] = { class_type: 'LoraLoader', inputs: { model, clip, lora_name: lora.filename, strength_model: draft.loras[index].weight, strength_clip: draft.loras[index].clipWeight } };
    model = [node, 0]; clip = [node, 1];
  });
  if (draft.modelSampling) {
    workflow['49'] = {class_type:'ModelSamplingDiscrete',inputs:{model,sampling:draft.modelSampling.prediction,zsnr:draft.modelSampling.zeroTerminalSnr}};
    model = ['49',0];
  }
  workflow['5'].inputs.model = model;
  workflow['2'].inputs.clip = clip; workflow['3'].inputs.clip = clip;
  return workflow;
}

/** Validate the optional sampling wrapper, then expose the original chain to strict baseline checks. */
export function samplingValidationGraph(graph: ComfyWorkflow, draft: GenerationDraft): ComfyWorkflow {
 if (!draft.modelSampling) return graph;
 const node=graph['49'], model=node?.inputs.model;
 if(node?.class_type!=='ModelSamplingDiscrete'||node.inputs.sampling!==draft.modelSampling.prediction||node.inputs.zsnr!==draft.modelSampling.zeroTerminalSnr||Object.keys(node.inputs).sort().join()!=='model,sampling,zsnr'||!Array.isArray(model)||model.length!==2||typeof model[0]!=='string'||model[1]!==0||JSON.stringify(graph['5']?.inputs.model)!==JSON.stringify(['49',0]))throw Error('The model sampling override differs from this draft.');
 const copy=structuredClone(graph);copy['5'].inputs.model=model;delete copy['49'];return copy;
}

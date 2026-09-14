import type { ComfyWorkflow, GenerationDraft } from './types';
import type { SourceImageAsset } from './source-types';
import { controlNetSettingsSchema, type ControlNetPlan, type ControlNetSettings, type ReviewedControlNetAsset } from './controlnet-types';
import { draftSchema } from './validation';

export const CANNY_UNION_TYPE = 'canny/lineart/anime_lineart/mlsd';
function safeFilename(value: string) {
  if (typeof value !== 'string' || value.length > 512 || !/\.png$/i.test(value) || value.split('/').some(part => !/^[a-z0-9][a-z0-9_. -]{0,239}$/i.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('The control source must be a verified relative PNG inside studio inputs.');
  return value;
}
export function augmentControlNetWorkflow(workflow: ComfyWorkflow, draft: GenerationDraft, requested: ControlNetSettings, input: { source: SourceImageAsset; sourceFilename: string; jobId: string }, asset: ReviewedControlNetAsset): ControlNetPlan {
  draftSchema.parse(draft); const settings = controlNetSettingsSchema.parse(requested); const sourceFilename = safeFilename(input.sourceFilename);
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.jobId) || input.source.id !== settings.sourceId || input.source.normalized.sha256 !== settings.sourceSha256) throw new Error('The immutable control source does not match these settings.');
  const sourceSize = input.source.normalized; if (!Number.isInteger(sourceSize.width) || !Number.isInteger(sourceSize.height) || sourceSize.width < 1 || sourceSize.height < 1 || Math.max(sourceSize.width, sourceSize.height) > 8192 || sourceSize.width * sourceSize.height > 32 * 1024 * 1024 || draft.width * draft.height > 4 * 1024 * 1024) throw new Error('The control source or resized control map exceeds its image bounds.');
  if (draft.upscale || draft.hiresFix || draft.imageInput?.mode === 'inpaint' || Object.values(workflow).some(node => ['VAEEncodeForInpaint', 'ImageCompositeMasked', 'ControlNetApplyAdvanced'].includes(node.class_type)) || Object.values(workflow).filter(node => node.class_type === 'KSampler').length !== 1) throw new Error('Initial Canny control supports one ordinary sampling pass; hires, inpainting, standalone upscale and stacked controls need separate testing.');
  if (!asset || asset.id !== 'xinsir-union-sdxl-1' || asset.filename !== 'xinsir-union-sdxl-1.0.safetensors' || asset.sha256 !== 'a9e13fd61f3193887791c8a0dd07a07202174dc47d5ddaea94ea1344f07c7467' || asset.status !== 'ready' || asset.architecture !== 'union-sdxl' || asset.loaderPolicy !== 'pinned-publisher-safetensors') throw new Error('Verify the reviewed Xinsir union SDXL asset before applying control.');
  if (workflow['5']?.class_type !== 'KSampler' || workflow['6']?.class_type !== 'VAEDecode' || workflow['7']?.class_type !== 'SaveImage' || workflow['7'].inputs.filename_prefix !== `Latent_${input.jobId}`) throw new Error('Canny control requires the original sampling/output graph for this job.');
  for (const link of [workflow['5'].inputs.positive, workflow['5'].inputs.negative, workflow['6'].inputs.vae]) if (!Array.isArray(link) || typeof link[0] !== 'string' || !workflow[link[0]] || !Number.isInteger(link[1]) || link[1] < 0) throw new Error('The graph has an invalid conditioning or VAE link.');
  const graph = structuredClone(workflow); let next = Math.max(7, ...Object.keys(graph).filter(id => /^\d+$/.test(id)).map(Number)) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('Workflow node identifiers are invalid.');
  const add = (class_type: string, inputs: ComfyWorkflow[string]['inputs']) => { while (graph[String(next)]) next++; const id = String(next++); graph[id] = { class_type, inputs }; return id; };
  const loaded = add('LoadImage', { image: sourceFilename }); const resized = add('ImageScale', { image: [loaded, 0], upscale_method: 'lanczos', width: draft.width, height: draft.height, crop: settings.resize === 'center-crop' ? 'center' : 'disabled' });
  const canny = settings.kind !== 'canny' ? resized : add('Canny', { image: [resized, 0], low_threshold: settings.lowThreshold, high_threshold: settings.highThreshold });
  const filenamePrefix = `Latent_${input.jobId}_control_${settings.kind}`; const saved = add('SaveImage', { images: [canny, 0], filename_prefix: filenamePrefix });
  if (settings.strength > 0) {
    const loader = add('ControlNetLoader', { control_net_name: asset.filename }); const union = add('SetUnionControlNetType', { control_net: [loader, 0], type: settings.kind === 'depth' ? 'depth' : settings.kind === 'pose' ? 'openpose' : CANNY_UNION_TYPE });
    const applied = add('ControlNetApplyAdvanced', { positive: graph['5'].inputs.positive, negative: graph['5'].inputs.negative, control_net: [union, 0], image: [saved, 0], vae: graph['6'].inputs.vae, strength: settings.strength, start_percent: settings.startPercent, end_percent: settings.endPercent });
    graph['5'].inputs.positive = [applied, 0]; graph['5'].inputs.negative = [applied, 1];
  }
  return { workflow: graph, workflowVersion: settings.kind === 'canny' ? 'sdxl-canny-controlnet@1' : 'sdxl-prepared-controlnet@1', source: structuredClone(input.source), settings, asset: structuredClone(asset), controlMap: { nodeId: saved, role: 'control-map', kind: settings.kind, filenamePrefix, width: draft.width, height: draft.height, batchSize: 1 }, samplingNodeId: '5', applied: settings.strength > 0 };
}

/** The exact required inputs/outputs in pinned Comfy 0.34; call with fresh /object_info. */
export function validateControlNetCapabilities(objects: Record<string, any>, asset: ReviewedControlNetAsset) {
  const required: Record<string, Record<string, string>> = { ImageScale: { image: 'IMAGE', width: 'INT', height: 'INT' }, Canny: { image: 'IMAGE', low_threshold: 'FLOAT', high_threshold: 'FLOAT' }, ControlNetApplyAdvanced: { positive: 'CONDITIONING', negative: 'CONDITIONING', control_net: 'CONTROL_NET', image: 'IMAGE', strength: 'FLOAT', start_percent: 'FLOAT', end_percent: 'FLOAT' }, SetUnionControlNetType: { control_net: 'CONTROL_NET' }, SaveImage: { images: 'IMAGE', filename_prefix: 'STRING' } };
  for (const [className, fields] of Object.entries(required)) for (const [name, type] of Object.entries(fields)) if (objects[className]?.input?.required?.[name]?.[0] !== type) throw new Error(`The engine does not provide the reviewed ${className}.${name} capability.`);
  const choices = (definition: any): unknown[] => Array.isArray(definition?.[0]) ? definition[0] : definition?.[0] === 'COMBO' && Array.isArray(definition?.[1]?.options) ? definition[1].options : [];
  if (!choices(objects.SetUnionControlNetType?.input?.required?.type).includes(CANNY_UNION_TYPE) || !choices(objects.ControlNetLoader?.input?.required?.control_net_name).includes(asset.filename)) throw new Error('The engine does not offer the reviewed union type or installed ControlNet filename.');
  if (!Array.isArray(objects.LoadImage?.input?.required?.image?.[0]) || objects.LoadImage?.output?.[0] !== 'IMAGE' || !choices(objects.ImageScale?.input?.required?.upscale_method).includes('lanczos') || !['disabled', 'center'].every(value => choices(objects.ImageScale?.input?.required?.crop).includes(value)) || objects.ControlNetApplyAdvanced?.input?.optional?.vae?.[0] !== 'VAE' || objects.ControlNetApplyAdvanced?.output?.join(',') !== 'CONDITIONING,CONDITIONING' || objects.Canny?.output?.[0] !== 'IMAGE' || objects.SetUnionControlNetType?.output?.[0] !== 'CONTROL_NET') throw new Error('The engine does not provide the complete reviewed control-map and conditioning interfaces.');
  if (objects.SaveImage?.output?.[0] !== 'IMAGE') throw new Error('The engine must support retaining the exact saved control-map image.');
}

import type { ComfyWorkflow, GenerationDraft } from './types';
import type { SourceImageAsset } from './source-types';
import { draftSchema } from './validation';
import { ipAdapterBundleSchema, ipAdapterPlanSchema, ipAdapterSettingsSchema, type IPAdapterPlan, type IPAdapterSettings, type IPAdapterWorkflowResult, type ReviewedIPAdapterBundle } from './ipadapter-types';

export function ipAdapterReferenceRectangle(width: number, height: number, framing: IPAdapterSettings['framing']) {
  if (![width, height].every(side => Number.isSafeInteger(side) && side > 0 && side <= 8192) || width * height > 4 * 1024 * 1024) throw new Error('The initial image-reference profile accepts source images up to 4 megapixels and 8192 pixels per side.');
  if (framing === 'stretch') return { x: 0, y: 0, width, height };
  if (framing !== 'center-crop') throw new Error('Unknown reference framing.');
  const side = Math.min(width, height); return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), width: side, height: side };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function validateBase(graph: ComfyWorkflow, draft: GenerationDraft): [string, 0] {
  const expected: Record<string, string> = { '1': 'CheckpointLoaderSimple', '2': 'CLIPTextEncode', '3': 'CLIPTextEncode', '4': 'EmptyLatentImage', '5': 'KSampler', '6': 'VAEDecode', '7': 'SaveImage' };
  for (const [id, type] of Object.entries(expected)) if (graph[id]?.class_type !== type) throw new Error('Image reference requires the baseline graph at nodes 1–7.');
  for (const [id, node] of Object.entries(graph)) if (!/^\d{1,6}$/.test(id) || !expected[id] && node.class_type !== 'LoraLoader') throw new Error('Image reference cannot yet combine with another advanced workflow.');
  const links = [[graph['5'].inputs.latent_image, ['4', 0]], [graph['5'].inputs.positive, ['2', 0]], [graph['5'].inputs.negative, ['3', 0]], [graph['6'].inputs.samples, ['5', 0]], [graph['6'].inputs.vae, ['1', 2]], [graph['7'].inputs.images, ['6', 0]]];
  if (links.some(([actual, expected]) => !same(actual, expected)) || graph['4'].inputs.width !== draft.width || graph['4'].inputs.height !== draft.height || graph['4'].inputs.batch_size !== 1) throw new Error('The baseline sampler, latent or output differs from this reference recipe.');
  const model = graph['5'].inputs.model;
  if (!Array.isArray(model) || typeof model[0] !== 'string' || model[1] !== 0 || !same(graph['2'].inputs.clip, [model[0], 1]) || !same(graph['3'].inputs.clip, [model[0], 1])) throw new Error('Image reference requires the same post-LoRA model and CLIP chain.');
  const visited = new Set<string>(); let current = model[0];
  while (current !== '1') {
    if (visited.has(current)) throw new Error('The image-reference model chain contains a cycle.'); visited.add(current);
    const node = graph[current]; const previous = node?.inputs.model;
    if (node?.class_type !== 'LoraLoader' || !Array.isArray(previous) || typeof previous[0] !== 'string' || previous[1] !== 0 || !same(node.inputs.clip, [previous[0], 1])) throw new Error('The image-reference model chain is invalid.'); current = previous[0];
  }
  if (Object.entries(graph).some(([id, node]) => node.class_type === 'LoraLoader' && !visited.has(id))) throw new Error('The image-reference graph contains a disconnected LoRA.');
  return [model[0], 0];
}
export function augmentIPAdapterWorkflow(base: ComfyWorkflow, draft: GenerationDraft, input: IPAdapterSettings, reference: { source: SourceImageAsset; sourceFilename: string }, bundle: ReviewedIPAdapterBundle, frozenPlan?: IPAdapterPlan): IPAdapterWorkflowResult {
  draftSchema.parse(draft); const settings = ipAdapterSettingsSchema.parse(input); const assets = ipAdapterBundleSchema.parse(bundle);
  if (!['sdxl', 'illustrious'].includes(draft.family) || draft.batchSize !== 1 || draft.qwenEdit || draft.imageInput || draft.hiresFix || draft.upscale || draft.controlNet || draft.regionalPrompts?.settings.enabled) throw new Error('Initial IP Adapter reference supports one baseline SDXL or Illustrious image without other advanced workflows.');
  const source = reference.source;
  if (source.id !== settings.sourceId || source.normalized.sha256 !== settings.sourceSha256) throw new Error('The retained reference differs from this draft. Choose its original source or a deliberate replacement.');
  const filename = reference.sourceFilename;
  if (typeof filename !== 'string' || filename.length > 512 || !/\.png$/i.test(filename) || filename.split('/').some(part => !/^[a-z0-9][a-z0-9_. -]{0,239}$/i.test(part) || part.endsWith('.') || part.endsWith(' ') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Image reference requires a verified private normalized PNG filename.');
  const rectangle = ipAdapterReferenceRectangle(source.normalized.width, source.normalized.height, settings.framing); const model = validateBase(base, draft); const graph = structuredClone(base);
  const weightType = ({ balanced: 'linear', style: 'style transfer', composition: 'composition' } as const)[settings.mode];
  let next = Math.max(...Object.keys(graph).map(Number)) + 1; const add = (class_type: string, inputs: ComfyWorkflow[string]['inputs']) => { const id = String(next++); graph[id] = { class_type, inputs }; return id; };
  let adapterNodeId: string | undefined;
  if (settings.weight > 0) {
    const loaded = add('LoadImage', { image: filename });
    const prepared = settings.framing === 'center-crop' ? add('ImageCrop', { image: [loaded, 0], ...rectangle }) : add('ImageScale', { image: [loaded, 0], upscale_method: 'bicubic', width: 224, height: 224, crop: 'disabled' });
    const adapter = add('IPAdapterModelLoader', { ipadapter_file: assets.models[0].filename }); const encoder = add('CLIPVisionLoader', { clip_name: assets.models[1].filename });
    adapterNodeId = add('IPAdapterAdvanced', { model, ipadapter: [adapter, 0], image: [prepared, 0], clip_vision: [encoder, 0], weight: settings.weight, weight_type: weightType, combine_embeds: 'concat', start_at: settings.startPercent, end_at: settings.endPercent, embeds_scaling: 'V only' }); graph['5'].inputs.model = [adapterNodeId, 0];
  }
  const computed = ipAdapterPlanSchema.parse({ version: 'sdxl-ipadapter-reference@1', settings, source: { id: source.id, sha256: source.normalized.sha256, name: source.name, width: source.normalized.width, height: source.normalized.height }, assets, preprocessing: { version: 'explicit-square-then-upstream-clip224@1', sourceRectangle: rectangle, cropNode: settings.framing === 'center-crop' ? 'ImageCrop' : 'none', explicitResize: settings.framing === 'stretch' ? 'bicubic-224-stretch' : 'none', upstream: 'clip_preprocess-bicubic-antialias-round-u8-normalize', encoderSize: 224, alpha: 'RGB-encoder-ignores-alpha' }, conditioning: { weightType, combineEmbeds: 'concat', embedsScaling: 'V only', inputModel: model }, samplerNodeId: '5', applied: settings.weight > 0, adapterNodeId });
  if (frozenPlan) {
    const frozen = ipAdapterPlanSchema.parse(frozenPlan);
    // A fresh file verification time is observational; all content, settings,
    // dependency versions and transforms must still match the frozen recipe.
    const comparison = structuredClone(computed); comparison.assets.verifiedAt = frozen.assets.verifiedAt;
    if (!same(frozen, comparison)) throw new Error('The frozen image-reference recipe differs from its source, models, code, settings or transforms.');
    return { workflow: graph, workflowVersion: computed.version, plan: frozen };
  }
  return { workflow: graph, workflowVersion: computed.version, plan: computed };
}

export function validateIPAdapterCapabilities(objects: Record<string, any>, bundle: ReviewedIPAdapterBundle) {
  const assets = ipAdapterBundleSchema.parse(bundle);
  for (const name of ['IPAdapterModelLoader', 'IPAdapterAdvanced', 'CLIPVisionLoader']) if (!objects[name]) throw new Error(`The managed engine is missing ${name}. Activate the reviewed reference tools while the engine is stopped, then restart it.`);
  const allowed = (node: string, key: string) => { const definition = objects[node]?.input?.required?.[key]; return definition?.[0] === 'COMBO' ? definition[1]?.options : definition?.[0]; };
  for (const [node, key, values] of [['IPAdapterModelLoader', 'ipadapter_file', [assets.models[0].filename]], ['CLIPVisionLoader', 'clip_name', [assets.models[1].filename]], ['IPAdapterAdvanced', 'weight_type', ['linear', 'style transfer', 'composition']], ['IPAdapterAdvanced', 'combine_embeds', ['concat']], ['IPAdapterAdvanced', 'embeds_scaling', ['V only']]] as Array<[string, string, string[]]>) {
    const options = allowed(node, key); if (!Array.isArray(options) || values.some(value => !options.includes(value))) throw new Error(`The managed engine's ${node}.${key} does not match the reviewed reference configuration.`);
  }
}

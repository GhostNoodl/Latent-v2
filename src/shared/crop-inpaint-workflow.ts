import type { ComfyWorkflow, GenerationDraft } from './types';
import { draftSchema } from './validation';
import { cropInpaintPlanSchema, type CropInpaintPlan, type CropInpaintWorkflowResult } from './crop-inpaint-types';

export interface CropInpaintWorkflowInput { sourceFilename: string; maskFilename: string; plan: CropInpaintPlan; }
type Link = [string, number];
const sameLink = (value: unknown, expected: Link) => JSON.stringify(value) === JSON.stringify(expected);
function filename(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || !/\.png$/i.test(value) || value.split('/').some(part => !/^[a-z0-9][a-z0-9_. -]{0,239}$/i.test(part) || part.endsWith('.') || part.endsWith(' ') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Crop inpainting needs a safe normalized PNG filename inside studio inputs.');
  return value;
}
function validateBase(graph: ComfyWorkflow, draft: GenerationDraft) {
  const expected: Record<string, string> = { '1': 'CheckpointLoaderSimple', '2': 'CLIPTextEncode', '3': 'CLIPTextEncode', '4': 'EmptyLatentImage', '5': 'KSampler', '6': 'VAEDecode', '7': 'SaveImage' };
  for (const [id, type] of Object.entries(expected)) if (graph[id]?.class_type !== type) throw new Error('Crop inpainting requires the unmodified baseline graph at nodes 1–7.');
  for (const [id, node] of Object.entries(graph)) if (!/^\d{1,6}$/.test(id) || !expected[id] && node.class_type !== 'LoraLoader') throw new Error('Crop inpainting cannot compose with an unrecognized advanced graph.');
  for (const [value, expectedLink] of [[graph['5'].inputs.latent_image, ['4', 0]], [graph['5'].inputs.positive, ['2', 0]], [graph['5'].inputs.negative, ['3', 0]], [graph['6'].inputs.samples, ['5', 0]], [graph['6'].inputs.vae, ['1', 2]], [graph['7'].inputs.images, ['6', 0]]] as Array<[unknown, Link]>) if (!sameLink(value, expectedLink)) throw new Error('The baseline image workflow has modified sampler, VAE or output links.');
  if (graph['4'].inputs.width !== draft.width || graph['4'].inputs.height !== draft.height || graph['4'].inputs.batch_size !== 1) throw new Error('The base latent dimensions differ from the requested working crop.');
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('The baseline graph contains a cycle.'); if (visited.has(id)) return;
    const node = graph[id]; if (!node) throw new Error('The baseline graph references a missing node.'); visiting.add(id);
    for (const value of Object.values(node.inputs)) if (Array.isArray(value)) { if (value.length !== 2 || typeof value[0] !== 'string' || !Number.isInteger(value[1]) || value[1] < 0) throw new Error('The baseline graph has an invalid node link.'); visit(value[0]); }
    visiting.delete(id); visited.add(id);
  };
  for (const id of Object.keys(graph)) visit(id);
}

/** Crops conditioning only. The output remains the full original source canvas. */
export function augmentCropInpaintWorkflow(workflow: ComfyWorkflow, draft: GenerationDraft, requested: CropInpaintWorkflowInput): CropInpaintWorkflowResult {
  draftSchema.parse(draft); const plan = cropInpaintPlanSchema.parse(requested.plan);
  if (draft.batchSize !== 1) throw new Error('Crop inpainting currently requires batch size 1.');
  if (draft.hiresFix || draft.upscale) throw new Error('Disable hires fix and standalone enlargement before crop inpainting.');
  if (plan.working.width !== draft.width || plan.working.height !== draft.height) throw new Error('The crop plan differs from the working generation dimensions.');
  if (draft.imageInput && (draft.imageInput.mode !== 'inpaint' || draft.imageInput.sourceId !== plan.source.id || draft.imageInput.sourceSha256 !== plan.source.sha256 || draft.imageInput.maskId !== plan.mask.id || draft.imageInput.maskSha256 !== plan.mask.sha256 || draft.imageInput.denoise !== plan.settings.denoise)) throw new Error('The crop plan does not match this draft source, mask and strength.');
  const sourceFilename = filename(requested.sourceFilename); const maskFilename = filename(requested.maskFilename); validateBase(workflow, draft);
  const graph = structuredClone(workflow); let next = Math.max(...Object.keys(graph).map(Number)) + 1;
  const add = (class_type: string, inputs: ComfyWorkflow[string]['inputs']) => { const id = String(next++); graph[id] = { class_type, inputs }; return id; };
  const loaded = add('LoadImage', { image: sourceFilename });
  let result: Link = [loaded, 0];
  if (plan.settings.denoise > 0) {
    const originalMask = add('LoadImageMask', { image: maskFilename, channel: 'red' });
    const crop = add('ImageCrop', { image: [loaded, 0], ...plan.crop });
    const cropMask = add('CropMask', { mask: [originalMask, 0], ...plan.crop });
    const workingImage = add('ImageScale', { image: [crop, 0], upscale_method: 'lanczos', width: plan.working.width, height: plan.working.height, crop: 'disabled' });
    const maskImage = add('MaskToImage', { mask: [cropMask, 0] });
    const workingMaskImage = add('ImageScale', { image: [maskImage, 0], upscale_method: 'bilinear', width: plan.working.width, height: plan.working.height, crop: 'disabled' });
    const workingMask = add('ImageToMask', { image: [workingMaskImage, 0], channel: 'red' });
    if (plan.settings.mode === 'replace') {
      graph['4'] = { class_type: 'VAEEncodeForInpaint', inputs: { pixels: [workingImage, 0], vae: ['1', 2], mask: [workingMask, 0], grow_mask_by: 0 } };
      graph['5'].inputs.latent_image = ['4', 0];
    } else {
      graph['4'] = { class_type: 'VAEEncode', inputs: { pixels: [workingImage, 0], vae: ['1', 2] } };
      const maskedLatent = add('SetLatentNoiseMask', { samples: ['4', 0], mask: [workingMask, 0] }); graph['5'].inputs.latent_image = [maskedLatent, 0];
    }
    graph['5'].inputs.denoise = plan.settings.denoise;
    const returnedCrop = add('ImageScale', { image: ['6', 0], upscale_method: 'lanczos', width: plan.crop.width, height: plan.crop.height, crop: 'disabled' });
    const composite = add('ImageCompositeMasked', { destination: [loaded, 0], source: [returnedCrop, 0], x: plan.crop.x, y: plan.crop.y, resize_source: false, mask: [cropMask, 0] }); result = [composite, 0];
  } else {
    // Prune unused sampling nodes, so a no-op cannot schedule diffusion or a VAE.
    for (const id of Object.keys(graph)) if (id !== '7' && id !== loaded) delete graph[id];
  }
  // LoadImage output 1 is inverted source alpha; this core node reinverts it.
  const alpha = add('JoinImageWithAlpha', { image: result, alpha: [loaded, 1] }); graph['7'].inputs.images = [alpha, 0];
  const prefix = graph['7'].inputs.filename_prefix;
  if (typeof prefix !== 'string' || !/^Latent_[A-Za-z0-9-]{1,80}$/.test(prefix)) throw new Error('Crop inpainting requires the original private job output prefix.');
  return { workflow: graph, workflowVersion: 'sdxl-crop-inpaint@1', plan: structuredClone(plan), output: { nodeId: '7', width: plan.output.width, height: plan.output.height, batchSize: 1, filenamePrefix: prefix } };
}

function equalGraphValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>; const b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equalGraphValue(a[key], b[key]));
}

/** Validate saved transforms without adopting a newly generated plan or graph. */
export function validateFrozenCropInpaintWorkflow(workflow: ComfyWorkflow, draft: GenerationDraft, requested: CropInpaintWorkflowInput): void {
  const plan = cropInpaintPlanSchema.parse(requested.plan);
  if (plan.settings.denoise === 0) {
    const source = Object.entries(workflow).filter(([, node]) => node.class_type === 'LoadImage');
    const alpha = Object.entries(workflow).filter(([, node]) => node.class_type === 'JoinImageWithAlpha');
    if (source.length !== 1 || alpha.length !== 1) throw new Error('The frozen zero-strength crop workflow is inconsistent.');
    const expected = {
      [source[0][0]]: { class_type: 'LoadImage', inputs: { image: filename(requested.sourceFilename) } },
      [alpha[0][0]]: { class_type: 'JoinImageWithAlpha', inputs: { image: [source[0][0], 0], alpha: [source[0][0], 1] } },
      '7': { class_type: 'SaveImage', inputs: { filename_prefix: workflow['7']?.inputs.filename_prefix, images: [alpha[0][0], 0] } },
    };
    if (!equalGraphValue(workflow, expected)) throw new Error('The frozen zero-strength crop workflow is inconsistent.');
    return;
  }
  // Retain the authored model, prompt and sampler nodes; independently rebuild
  // only this version's crop transforms for comparison with the frozen graph.
  const base: ComfyWorkflow = {};
  for (const [id, node] of Object.entries(workflow)) if (['1', '2', '3', '5', '6', '7'].includes(id) || node.class_type === 'LoraLoader') base[id] = structuredClone(node);
  if (!base['5'] || !base['7']) throw new Error('The frozen crop workflow is missing its sampler or output.');
  base['4'] = { class_type: 'EmptyLatentImage', inputs: { width: draft.width, height: draft.height, batch_size: 1 } };
  base['5'].inputs.latent_image = ['4', 0]; base['5'].inputs.denoise = 1; base['7'].inputs.images = ['6', 0];
  const expected = augmentCropInpaintWorkflow(base, draft, requested).workflow;
  if (!equalGraphValue(workflow, expected)) throw new Error('The frozen crop workflow differs from its recorded crop, mask or compositing transforms.');
}

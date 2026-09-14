import type { ComfyWorkflow, GenerationDraft } from './types';
import { faceRefinementPlanSchema, type FaceRefinementPlan } from './face-detailer-types';
export { faceRefinementPlanSchema, type FaceRefinementPlan } from './face-detailer-types';
import { augmentCropInpaintWorkflow } from './crop-inpaint-workflow';
import { canonicalModelPaths } from './workflow-model-paths';

export interface FaceRefinementWorkflowInput { plan: FaceRefinementPlan; sourceFilename: string; maskFilenames: Record<string, string>; }
export interface FaceRefinementOutput { nodeId: string; role: 'face-pass' | 'final'; passIndex: number; faceId: string; seed: string; width: number; height: number; batchSize: 1; filenamePrefix: string; }

/** A single graph holds sequential passes; each pass crops the previous composite. */
export function buildFaceRefinementWorkflow(baseline: ComfyWorkflow, draft: GenerationDraft, input: FaceRefinementWorkflowInput) {
  const plan = faceRefinementPlanSchema.parse(input.plan);
  if (draft.width !== 512 || draft.height !== 512 || draft.batchSize !== 1 || draft.imageInput || draft.hiresFix || draft.upscale || draft.controlNet || draft.qwenEdit || draft.regionalPrompts?.settings.enabled || 'ipAdapter' in draft && draft.ipAdapter) throw new Error('Face refinement requires baseline SDXL/Illustrious, batch 1, 512 square working size, and no other advanced image transform.');
  // Reuse the existing strict baseline and private filename validation for every mask.
  for (const pass of plan.passes) augmentCropInpaintWorkflow(baseline, draft, { sourceFilename: input.sourceFilename, maskFilename: input.maskFilenames[pass.crop.mask.id], plan: pass.crop });
  const graph = structuredClone(baseline); const sampling = structuredClone(graph['5'].inputs); const prefix = String(graph['7'].inputs.filename_prefix);
  delete graph['4']; delete graph['5']; delete graph['6']; delete graph['7'];
  let next = Math.max(7, ...Object.keys(graph).map(Number)) + 1;
  const add = (class_type: string, inputs: ComfyWorkflow[string]['inputs']) => { const id = String(next++); graph[id] = { class_type, inputs }; return id; };
  type Link = [string, number];
  const loaded = add('LoadImage', { image: input.sourceFilename }); let previous: Link = [loaded, 0]; const outputs: FaceRefinementOutput[] = [];
  for (const [passIndex, pass] of plan.passes.entries()) {
    const c = pass.crop;
    if (c.settings.denoise > 0) {
      const mask = add('LoadImageMask', { image: input.maskFilenames[c.mask.id], channel: 'red' });
      const crop = add('ImageCrop', { image: previous, ...c.crop }); const cropMask = add('CropMask', { mask: [mask, 0], ...c.crop });
      const image = add('ImageScale', { image: [crop, 0], upscale_method: 'lanczos', width: 512, height: 512, crop: 'disabled' });
      const maskImage = add('MaskToImage', { mask: [cropMask, 0] }); const maskScaled = add('ImageScale', { image: [maskImage, 0], upscale_method: 'bilinear', width: 512, height: 512, crop: 'disabled' });
      const workingMask = add('ImageToMask', { image: [maskScaled, 0], channel: 'red' }); const encoded = add('VAEEncode', { pixels: [image, 0], vae: ['1', 2] });
      const latent = add('SetLatentNoiseMask', { samples: [encoded, 0], mask: [workingMask, 0] }); const sampler = add('KSampler', { ...sampling, latent_image: [latent, 0], seed: Number(pass.seed), denoise: c.settings.denoise });
      const decoded = add('VAEDecode', { samples: [sampler, 0], vae: ['1', 2] });
      const returned = add('ImageScale', { image: [decoded, 0], upscale_method: 'lanczos', width: c.crop.width, height: c.crop.height, crop: 'disabled' });
      const composite = add('ImageCompositeMasked', { destination: previous, source: [returned, 0], x: c.crop.x, y: c.crop.y, resize_source: false, mask: [cropMask, 0] }); previous = [composite, 0];
    }
    const alpha = add('JoinImageWithAlpha', { image: previous, alpha: [loaded, 1] }); const final = passIndex === plan.passes.length - 1;
    const filenamePrefix = final ? prefix : `${prefix}_face_${passIndex + 1}`;
    const nodeId = final ? '7' : add('SaveImage', { images: [alpha, 0], filename_prefix: filenamePrefix });
    if (final) graph['7'] = { class_type: 'SaveImage', inputs: { images: [alpha, 0], filename_prefix: filenamePrefix } };
    outputs.push({ nodeId, role: final ? 'final' : 'face-pass', passIndex, faceId: pass.faceId, seed: pass.seed, width: plan.source.width, height: plan.source.height, batchSize: 1, filenamePrefix });
    // SaveImage returns its input only after publishing the PNG. This dependency
    // makes earlier passes durable before later sampling; split RGBA back to RGB.
    if (!final) previous = [add('SplitImageWithAlpha', { image: [nodeId, 0] }), 0];
  }
  if (plan.passes.every(pass => pass.crop.settings.denoise === 0)) {
    for (const [id, node] of Object.entries(graph)) if (['CheckpointLoaderSimple', 'LoraLoader', 'CLIPTextEncode'].includes(node.class_type)) delete graph[id];
  }
  return { workflow: graph, workflowVersion: 'sdxl-face-refinement@1' as const, plan, outputs };
}

export function validateFaceRefinementCapabilities(objects: Record<string, any>) {
  if (objects.SaveImage?.output?.[0] !== 'IMAGE' || objects.SaveImage?.output_node !== true || objects.SplitImageWithAlpha?.output?.[0] !== 'IMAGE' || objects.SplitImageWithAlpha?.input?.required?.image?.[0] !== 'IMAGE') throw new Error('This engine cannot guarantee saved intermediate face passes. Restore the reviewed SaveImage and SplitImageWithAlpha nodes.');
}

export function validateFrozenFaceRefinementWorkflow(workflow: ComfyWorkflow, baseline: ComfyWorkflow, draft: GenerationDraft, input: FaceRefinementWorkflowInput) {
  const expected = buildFaceRefinementWorkflow(baseline, draft, input).workflow;
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
    return JSON.stringify(value);
  };
  if (canonical(canonicalModelPaths(workflow)) !== canonical(canonicalModelPaths(expected))) throw new Error('The frozen face-refinement graph differs from its saved masks, pass ordering or recipe.');
}

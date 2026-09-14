import type { ComfyWorkflow, GenerationDraft } from './types';
import { draftSchema } from './validation';

export interface ImageWorkflowInputs {
  mode: 'img2img' | 'inpaint';
  sourceFilename: string;
  maskFilename?: string;
  denoise: number;
  resize: 'stretch' | 'center-crop';
}

function inputFilename(filename: unknown): string {
  // The importer owns these relative subfolders. Never permit traversal or Comfy annotations.
  if (typeof filename !== 'string' || filename.length > 512 || !/\.(png|jpe?g|webp)$/i.test(filename) || filename.split('/').some(segment => !/^[a-z0-9][a-z0-9_. -]{0,239}$/i.test(segment) || segment.endsWith('.') || segment.endsWith(' ') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error('Image inputs must use a safe relative image filename inside this studio input directory.');
  return filename;
}

/** Native Comfy 0.34.0 image conditioning; source/mask files must be normalized single frames. */
export function augmentImageWorkflow(workflow: ComfyWorkflow, draft: GenerationDraft, inputs: ImageWorkflowInputs): ComfyWorkflow {
  draftSchema.parse(draft);
  if (!inputs || !['img2img', 'inpaint'].includes(inputs.mode) || !['stretch', 'center-crop'].includes(inputs.resize)) throw new Error('Choose a valid image workflow mode and resize policy.');
  if (typeof inputs.denoise !== 'number' || !Number.isFinite(inputs.denoise) || inputs.denoise < 0 || inputs.denoise > 1) throw new Error('Image denoise must be between 0 and 1.');
  const sourceFilename = inputFilename(inputs.sourceFilename);
  if (inputs.mode === 'inpaint' && draft.batchSize !== 1) throw new Error('Masked inpainting currently requires batch size 1.');
  const maskFilename = inputs.mode === 'inpaint' ? inputFilename(inputs.maskFilename) : undefined;
  const required: Record<string, string> = { '1': 'CheckpointLoaderSimple', '2': 'CLIPTextEncode', '3': 'CLIPTextEncode', '4': 'EmptyLatentImage', '5': 'KSampler', '6': 'VAEDecode', '7': 'SaveImage' };
  for (const [id, expected] of Object.entries(required)) if (workflow[id]?.class_type !== expected) throw new Error('Image conditioning requires an unmodified Latent image-generation graph.');
  if (JSON.stringify(workflow['6'].inputs.vae) !== JSON.stringify(['1', 2])) throw new Error('The image decoder must use the checkpoint VAE.');
  const result = structuredClone(workflow);
  let next = Math.max(7, ...Object.keys(result).filter(id => /^\d+$/.test(id)).map(Number)) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('The workflow node identifiers are invalid.');
  const add = (class_type: string, nodeInputs: ComfyWorkflow[string]['inputs']): string => {
    while (result[String(next)]) next += 1;
    const id = String(next++); result[id] = { class_type, inputs: nodeInputs }; return id;
  };
  const loaded = add('LoadImage', { image: sourceFilename });
  const crop = inputs.resize === 'center-crop' ? 'center' : 'disabled';
  const scaled = add('ImageScale', { image: [loaded, 0], upscale_method: 'lanczos', width: draft.width, height: draft.height, crop });
  result['4'] = { class_type: 'VAEEncode', inputs: { pixels: [scaled, 0], vae: ['1', 2] } };
  let finalImage: [string, number] = ['6', 0];
  if (inputs.mode === 'inpaint') {
    const loadedMask = add('LoadImageMask', { image: maskFilename!, channel: 'red' });
    const maskImage = add('MaskToImage', { mask: [loadedMask, 0] });
    const scaledMask = add('ImageScale', { image: [maskImage, 0], upscale_method: 'bilinear', width: draft.width, height: draft.height, crop });
    const mask = add('ImageToMask', { image: [scaledMask, 0], channel: 'red' });
    result['4'] = { class_type: 'VAEEncodeForInpaint', inputs: { pixels: [scaled, 0], vae: ['1', 2], mask: [mask, 0], grow_mask_by: 6 } };
    const composite = add('ImageCompositeMasked', { destination: [scaled, 0], source: ['6', 0], x: 0, y: 0, resize_source: false, mask: [mask, 0] });
    finalImage = [composite, 0];
  }
  if (draft.batchSize > 1) {
    const batch = add('RepeatLatentBatch', { samples: ['4', 0], amount: draft.batchSize });
    result['5'].inputs.latent_image = [batch, 0];
  } else result['5'].inputs.latent_image = ['4', 0];
  result['5'].inputs.denoise = inputs.denoise;
  // Zero strength preserves exact resized pixels, including batches, without a lossy VAE round trip.
  if (inputs.denoise === 0) {
    const preserved = draft.batchSize > 1 ? add('RepeatImageBatch', { image: [scaled, 0], amount: draft.batchSize }) : scaled;
    result['7'].inputs.images = [preserved, 0];
  } else result['7'].inputs.images = finalImage;
  return result;
}

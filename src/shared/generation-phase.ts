import type { ComfyWorkflow } from './types';
import type { AdvancedImagePlan } from './advanced-image-types';
import type { FaceRefinementPlan } from './face-detailer-types';

/** Labels come only from the current node in the frozen submitted workflow. */
export function generationPhase(workflow: ComfyWorkflow, currentNode: string | undefined, advanced?: AdvancedImagePlan, faces?: FaceRefinementPlan): string {
  const node = currentNode ? workflow[currentNode] : undefined;
  if (!node) return 'Preparing generation';
  if (node.class_type === 'SaveImage') return 'Saving image';
  if (node.class_type === 'KSampler') {
    if (faces) {
      const samplerIds = Object.entries(workflow).filter(([, item]) => item.class_type === 'KSampler').map(([id]) => id);
      const sampledPass = faces.passes.map((pass, index) => ({ pass, index })).filter(({ pass }) => pass.crop.settings.denoise > 0)[samplerIds.indexOf(currentNode!)];
      if (sampledPass) return `Refining face ${sampledPass.index + 1} of ${faces.passes.length}`;
    }
    const pass = advanced?.passes.find(item => item.nodeId === currentNode);
    return pass?.role === 'refine' ? 'Refining image' : pass?.role === 'base' ? 'Generating base image' : 'Generating image';
  }
  if (node.class_type === 'VAEDecode') return 'Decoding image';
  if (['ImageCompositeMasked', 'JoinImageWithAlpha'].includes(node.class_type)) return 'Compositing image';
  if (['ImageScale', 'ImageUpscaleWithModel', 'LatentUpscale'].includes(node.class_type)) return 'Resizing image';
  if (['LoadImage', 'LoadImageMask', 'ImageCrop', 'CropMask'].includes(node.class_type)) return 'Preparing image inputs';
  return 'Preparing generation';
}

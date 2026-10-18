import { DEFAULT_DRAFT } from './defaults';
import type { GenerationDraft } from './types';

/**
 * Settings that Simple mode hides but this draft still uses, so nothing hidden changes an image
 * without the person seeing it.
 */
export function hiddenAdvancedSettings(draft: GenerationDraft): string[] {
  const used: string[] = [];
  if (draft.imageInput) used.push(draft.imageInput.mode === 'inpaint' ? 'inpainting' : 'a source image');
  if (draft.controlNet) used.push('ControlNet');
  if (draft.regionalPrompts) used.push('regional prompts');
  if (draft.ipAdapter) used.push('an image reference');
  if (draft.sampler !== DEFAULT_DRAFT.sampler || draft.scheduler !== DEFAULT_DRAFT.scheduler)
    used.push(`${draft.sampler} / ${draft.scheduler} sampling`);
  if (draft.modelSampling) used.push('a custom prediction type');
  return used;
}

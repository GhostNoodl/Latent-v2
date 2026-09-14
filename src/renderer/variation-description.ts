import type { GenerationDraft } from '../shared/types';

export function variationDescription(draft: GenerationDraft): string {
  const effects = ['Chooses a new image seed.'];
  if (draft.dynamicPrompts?.enabled) effects.push('Chooses prompt variations again; the resulting text may differ.');
  if (draft.hiresFix) effects.push('Also chooses a new hires refinement seed.');
  return effects.join(' ');
}

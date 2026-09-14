import type { GenerationDraft } from './types';

/** Full recipe replacement must not inherit the receiving composer's version. */
export function restoreTriggerResolution(draft: GenerationDraft): GenerationDraft {
  return { ...structuredClone(draft), triggerResolutionVersion: draft.triggerResolutionVersion ?? 'legacy@1' };
}

const ownership = (draft: GenerationDraft) => JSON.stringify(draft.loras.map(lora => [lora.modelId, draft.triggerWords?.[lora.modelId] ?? null]));

/** New positive text or trigger ownership adopts current matching. Sampling
 * edits retain replay semantics; an explicit version marks a full recipe restore. */
export function applyTriggerResolutionChange(previous: GenerationDraft, change: Partial<GenerationDraft>): GenerationDraft {
  const next = { ...previous, ...change };
  if (Object.hasOwn(change, 'triggerResolutionVersion')) return restoreTriggerResolution(next);
  if (previous.prompt !== next.prompt || previous.autoTriggers !== next.autoTriggers || ownership(previous) !== ownership(next)) {
    next.triggerResolutionVersion = 'punctuation@2';
  }
  return next;
}

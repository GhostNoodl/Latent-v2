import type { GenerationDraft } from './types';
import type { HardwareProfileApplication } from './hardware-profile-types';
import { canonicalRuntimeJson } from './runtime-identity';
import { draftSchema } from './validation';

/** Check again after the async main request; its snapshot cannot see later renderer edits. */
export function acceptHardwareProfileApplication(application: HardwareProfileApplication, currentDraft: GenerationDraft, requestedRevision: number, currentRevision: number): GenerationDraft {
  if (requestedRevision !== currentRevision || canonicalRuntimeJson(draftSchema.parse(currentDraft)) !== canonicalRuntimeJson(draftSchema.parse(application.originalDraft))) {
    throw new Error('Your draft changed while these settings were being checked. Your latest edits are intact; recommend again before applying.');
  }
  return structuredClone(draftSchema.parse(application.proposedDraft));
}

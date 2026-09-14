import type { GenerationDraft, GenerationRecord } from './types';
import { faceRefinementRequestSchema, type FaceRefinementRequest } from './face-detailer-types';
import { restoreDynamicPromptRecipe } from './dynamic-prompt-recipe';
import { restoreTriggerResolution } from './trigger-resolution';

export function restoreFaceDraft(record: GenerationRecord): GenerationDraft {
  if (!record.faceDetailer || !record.draft.faceDetailer) throw new Error('This image has no saved face refinement recipe.');
  const dynamicRecipe = record.dynamicPromptRecipe ?? record.draft.dynamicPrompts?.frozen;
  if (record.draft.dynamicPrompts?.enabled && !dynamicRecipe) throw new Error('The saved wildcard choices are missing.');
  if (!Array.isArray(record.loras) || record.loras.some(model => !model || !Array.isArray(model.triggers) || model.triggers.some(trigger => typeof trigger !== 'string'))) throw new Error('The saved LoRA trigger metadata is incomplete.');
  const saved = restoreTriggerResolution(record.draft);
  const draft = dynamicRecipe ? restoreDynamicPromptRecipe(saved, dynamicRecipe) : saved;
  return { ...draft, seed: record.actualSeed, faceDetailer: { request: { ...draft.faceDetailer!.request, seed: record.actualSeed }, frozen: structuredClone(record.faceDetailer.plan) }, triggerWords: Object.fromEntries(record.loras.map(model => [model.id, [...model.triggers]])), assetHashes: Object.fromEntries([...(record.checkpoint ? [record.checkpoint] : []), ...record.loras].filter(model => model.sha256).map(model => [model.id, model.sha256!])) };
}
export function prepareFaceDraft(draft: GenerationDraft, input: FaceRefinementRequest): GenerationDraft {
  const request = faceRefinementRequestSchema.parse(input);
  const previous = draft.faceDetailer?.request;
  const same = previous && previous.detectionId === request.detectionId && previous.seed === request.seed && previous.denoise === request.denoise && previous.contextPadding === request.contextPadding && [...previous.faceIds].sort().join() === [...request.faceIds].sort().join();
  return { ...structuredClone(draft), width: 512, height: 512, batchSize: 1, seed: request.seed, faceDetailer: { request, ...(same && draft.faceDetailer?.frozen ? { frozen: structuredClone(draft.faceDetailer.frozen) } : {}) } };
}

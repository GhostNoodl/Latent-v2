import type { GenerationDraft, ModelAsset } from './types';
import { automaticTriggerWords } from './workflow';
import { prepareDynamicPromptDraft, type WildcardSnapshot } from './dynamic-prompt-recipe';
import { draftSchema } from './validation';

// Trigger metadata is literal text even when the authored prompt uses variations.
const escapeVariationLiteral = (text: string) => text.replace(/[\\{}|_]/g, '\\$&');

/** Transfer current automatic additions to authored ownership. Expressions stay
 * authored expressions; a seeded/frozen variation supplies matching context only.
 * Rebuilding its trace with a literal prefix consumes no new random choices. */
export async function editTriggersAsPromptText(
  input: GenerationDraft, models: ModelAsset[], wildcards: WildcardSnapshot, allocatedSeed?: string,
): Promise<{ draft: GenerationDraft; addedTriggers: string[] }> {
  if (!input.autoTriggers) throw new Error('Turn automatic trigger words on before moving them into your prompt.');
  const draft = structuredClone(input);
  const dynamic = draft.dynamicPrompts?.enabled;
  const variationSeed = draft.dynamicPrompts?.frozen?.resolutionSeed ?? (draft.seed === 'random' ? allocatedSeed : draft.seed);
  if (dynamic && !variationSeed) throw new Error('Choose a concrete variation seed before editing automatic triggers.');
  const prepared = dynamic ? await prepareDynamicPromptDraft(draft, variationSeed!, wildcards) : undefined;
  const addedTriggers = automaticTriggerWords({ ...draft, prompt: prepared?.prompt ?? draft.prompt }, models);
  // Nothing transferred means no ownership, seed or freeze should change.
  if (!addedTriggers.length) return { draft, addedTriggers };
  const literalPrefix = addedTriggers.join(', ');
  const authoredPrefix = dynamic ? escapeVariationLiteral(literalPrefix) : literalPrefix;
  draft.prompt = [authoredPrefix, draft.prompt].filter(Boolean).join(', ');
  draft.triggerWords = Object.fromEntries(draft.loras.map(lora => [lora.modelId, []]));
  draft.triggerResolutionVersion = 'punctuation@2';
  if (dynamic) {
    // Validate the old freeze first (above), then rebase its trace using its own
    // dictionary and seed, never today's dictionary or a rendered preview string.
    const rebased = await prepareDynamicPromptDraft({ ...draft, dynamicPrompts: { enabled: true } }, variationSeed!, prepared!.recipe!.wildcards);
    draft.dynamicPrompts = { enabled: true, frozen: rebased.recipe! };
    if (input.seed === 'random' && !input.dynamicPrompts?.frozen) draft.seed = variationSeed!;
  }
  return { draft: draftSchema.parse(draft), addedTriggers };
}

/** Explicitly release only this selected LoRA's saved trigger override. Model
 * byte pins, all other owners, authored text and frozen variations stay intact. */
export function useCurrentModelTriggers(input: GenerationDraft, modelId: string): GenerationDraft {
  if (!input.loras.some(lora => lora.modelId === modelId)) throw new Error('Select this LoRA before changing its trigger words.');
  const draft = structuredClone(input);
  if (draft.triggerWords) delete draft.triggerWords[modelId];
  draft.triggerResolutionVersion = 'punctuation@2';
  return draft;
}

import { z } from 'zod';
import { DYNAMIC_PROMPT_LIMITS, DYNAMIC_PROMPT_VERSION, DynamicPromptError, resolveDynamicPrompt, validateWildcardDictionary, type DynamicPromptChoice } from './dynamic-prompts';

export interface WildcardSnapshot { revision: string; entries: Record<string, string[]>; }
export interface DynamicPromptPart { authored: string; resolved: string; seed: string; choices: DynamicPromptChoice[]; }
export interface DynamicPromptRecipe {
  version: typeof DYNAMIC_PROMPT_VERSION;
  seedPolicy: 'actual-seed-domains-v1';
  resolutionSeed: string;
  positive: DynamicPromptPart;
  negative: DynamicPromptPart;
  wildcards: WildcardSnapshot;
}
export interface DynamicPromptAuthoring { enabled: boolean; frozen?: DynamicPromptRecipe; }
export interface DynamicPromptDraft { prompt: string; negativePrompt: string; dynamicPrompts?: DynamicPromptAuthoring; }
export interface PreparedDynamicPrompt { prompt: string; negativePrompt: string; recipe?: DynamicPromptRecipe; reusedFrozen: boolean; }
const promptText = z.string().max(DYNAMIC_PROMPT_LIMITS.input);
const concreteSeed = z.string().min(1).max(16).regex(/^\d+$/).refine(value => value.length <= 16 && /^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), 'Use a concrete integer image seed.');
export const wildcardEntriesSchema = z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/), z.array(promptText).min(1).max(DYNAMIC_PROMPT_LIMITS.dictionaryEntries)).superRefine((entries, context) => {
  let count = 0; let characters = 0;
  for (const values of Object.values(entries)) { count += values.length; for (const value of values) characters += value.length; }
  if (Object.keys(entries).length > DYNAMIC_PROMPT_LIMITS.dictionaryEntries || count > DYNAMIC_PROMPT_LIMITS.dictionaryEntries) context.addIssue({ code: 'custom', message: `Keep at most ${DYNAMIC_PROMPT_LIMITS.dictionaryEntries} wildcard entries in total.` });
  if (characters > DYNAMIC_PROMPT_LIMITS.dictionaryCharacters) context.addIssue({ code: 'custom', message: `Wildcard text exceeds ${DYNAMIC_PROMPT_LIMITS.dictionaryCharacters} characters.` });
});
export const wildcardSnapshotSchema: z.ZodType<WildcardSnapshot> = z.object({ revision: z.string().regex(/^[a-f0-9]{64}$/), entries: wildcardEntriesSchema }).strict();
const choiceSchema: z.ZodType<DynamicPromptChoice> = z.object({ kind: z.enum(['choice', 'wildcard']), source: z.string().max(180), start: z.number().int().min(0).max(16_000), end: z.number().int().min(0).max(16_000), tag: z.string().max(128).optional(), selectedIndex: z.number().int().min(0).max(1023), selectedValue: promptText, resolvedValue: z.string().max(DYNAMIC_PROMPT_LIMITS.output) }).strict().refine(value => value.end >= value.start, 'Choice source span is invalid.');
const partSchema: z.ZodType<DynamicPromptPart> = z.object({ authored: promptText, resolved: z.string().max(DYNAMIC_PROMPT_LIMITS.output), seed: z.string().max(DYNAMIC_PROMPT_LIMITS.seed), choices: z.array(choiceSchema).max(DYNAMIC_PROMPT_LIMITS.expansions) }).strict();
export const dynamicPromptRecipeSchema: z.ZodType<DynamicPromptRecipe> = z.object({ version: z.literal(DYNAMIC_PROMPT_VERSION), seedPolicy: z.literal('actual-seed-domains-v1'), resolutionSeed: concreteSeed, positive: partSchema, negative: partSchema, wildcards: wildcardSnapshotSchema }).strict();
export const dynamicPromptAuthoringSchema: z.ZodType<DynamicPromptAuthoring> = z.object({ enabled: z.boolean(), frozen: dynamicPromptRecipeSchema.optional() }).strict();

/** A stable content identity; entry order matters, dictionary-key order does not. */
export async function createWildcardSnapshot(input: Record<string, string[]>): Promise<WildcardSnapshot> {
  const parsed = wildcardEntriesSchema.parse(input); validateWildcardDictionary(parsed);
  const entries = Object.fromEntries(Object.keys(parsed).sort().map(key => [key, [...parsed[key]]]));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(entries)));
  return { revision: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join(''), entries };
}
export const EMPTY_WILDCARD_SNAPSHOT: WildcardSnapshot = Object.freeze({ revision: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', entries: Object.freeze({}) });
const canonicalJson = (input: unknown) => JSON.stringify(input, (_key, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
async function verifySnapshot(input: WildcardSnapshot): Promise<WildcardSnapshot> {
  const parsed = wildcardSnapshotSchema.parse(input); const verified = await createWildcardSnapshot(parsed.entries);
  if (verified.revision !== parsed.revision) throw new Error('The wildcard snapshot content does not match its saved revision.');
  return verified;
}
function resolvePart(kind: 'positive' | 'negative', authored: string, seed: string, wildcards: WildcardSnapshot): DynamicPromptPart {
  try { const result = resolveDynamicPrompt(authored, seed, wildcards.entries); return { authored, resolved: result.resolved, seed, choices: result.choices }; }
  catch (error) {
    if (!(error instanceof DynamicPromptError)) throw error;
    const entry = /^wildcard:(.+)\[(\d+)\]$/.exec(error.source);
    const text = entry ? wildcards.entries[entry[1]]?.[Number(entry[2])] ?? authored : authored;
    throw new DynamicPromptError(error.reason, `${kind}/${error.source}`, error.position, text);
  }
}
function resolveRecipe(draft: DynamicPromptDraft, actualSeed: string, wildcards: WildcardSnapshot): DynamicPromptRecipe {
  return { version: DYNAMIC_PROMPT_VERSION, seedPolicy: 'actual-seed-domains-v1', resolutionSeed: actualSeed, positive: resolvePart('positive', draft.prompt, `${actualSeed}:positive`, wildcards), negative: resolvePart('negative', draft.negativePrompt, `${actualSeed}:negative`, wildcards), wildcards: structuredClone(wildcards) };
}

/** Call after choosing actualSeed, before creating a queued job. No draft mutation. */
export async function prepareDynamicPromptDraft(draft: DynamicPromptDraft, actualSeed: string, currentWildcards: WildcardSnapshot = EMPTY_WILDCARD_SNAPSHOT): Promise<PreparedDynamicPrompt> {
  // Legacy literal braces and __tokens__ remain untouched while disabled.
  if (!draft.dynamicPrompts?.enabled) return { prompt: draft.prompt, negativePrompt: draft.negativePrompt, reusedFrozen: false };
  const options = dynamicPromptAuthoringSchema.parse(draft.dynamicPrompts);
  let recipe: DynamicPromptRecipe;
  if (options.frozen) {
    const frozen = options.frozen;
    if (frozen.positive.authored !== draft.prompt || frozen.negative.authored !== draft.negativePrompt) throw new Error('The frozen variations no longer match the authored prompts. Regenerate variations before queueing.');
    const snapshot = await verifySnapshot(frozen.wildcards);
    const expected = resolveRecipe(draft, frozen.resolutionSeed, snapshot);
    if (canonicalJson(expected) !== canonicalJson(frozen)) throw new Error('The saved prompt variation trace is inconsistent. Restore the original recipe or regenerate variations.');
    recipe = structuredClone(frozen);
  } else {
    concreteSeed.parse(actualSeed); const snapshot = await verifySnapshot(currentWildcards);
    recipe = resolveRecipe(draft, actualSeed, snapshot);
  }
  return { prompt: recipe.positive.resolved, negativePrompt: recipe.negative.resolved, recipe, reusedFrozen: !!options.frozen };
}

/** Call from the root draft-change path; image seed changes alone preserve a freeze. */
export function invalidateDynamicPromptFreeze<T extends DynamicPromptDraft>(previous: T, next: T, reroll = false): T {
  if (!next.dynamicPrompts?.frozen || (!reroll && previous.prompt === next.prompt && previous.negativePrompt === next.negativePrompt && previous.dynamicPrompts?.enabled === next.dynamicPrompts.enabled)) return next;
  return { ...next, dynamicPrompts: { enabled: next.dynamicPrompts.enabled } };
}
export function restoreDynamicPromptRecipe<T extends DynamicPromptDraft>(draft: T, input: DynamicPromptRecipe): T {
  const recipe = dynamicPromptRecipeSchema.parse(input);
  return { ...draft, prompt: recipe.positive.authored, negativePrompt: recipe.negative.authored, dynamicPrompts: { enabled: true, frozen: structuredClone(recipe) } };
}
/** Compositor memory preferences do not redact intentionally saved records/presets. */
export function redactDynamicPromptDraft<T extends DynamicPromptDraft>(draft: T, rememberPositive: boolean, rememberNegative: boolean): T {
  return { ...draft, prompt: rememberPositive ? draft.prompt : '', negativePrompt: rememberNegative ? draft.negativePrompt : '', ...(draft.dynamicPrompts ? { dynamicPrompts: rememberPositive && rememberNegative ? structuredClone(draft.dynamicPrompts) : { enabled: draft.dynamicPrompts.enabled } } : {}) };
}

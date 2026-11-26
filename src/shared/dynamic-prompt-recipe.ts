import { WILDCARD_PACKS } from './wildcard-packs';
import { z } from 'zod';
import {
  DYNAMIC_PROMPT_LIMITS,
  DYNAMIC_PROMPT_VERSION,
  DYNAMIC_PROMPT_VERSION_V1,
  DynamicPromptError,
  countDynamicCombinations,
  isWildcardNote,
  matchWildcardNames,
  parseDynamicPrompt,
  resolveDynamicPrompt,
  validateWildcardDictionary,
  walkDynamicNodes,
  type DynamicPromptChoice,
  type DynamicPromptVersion,
  type SparseWildcardList,
} from './dynamic-prompts';

export interface WildcardSnapshot {
  revision: string;
  entries: Record<string, string[]>;
}
/** What an image keeps: small lists in full, big ones as their size plus the lines it picked. */
export interface RecipeWildcards extends WildcardSnapshot {
  sparse?: Record<string, SparseWildcardList>;
}
export interface DynamicPromptPart {
  authored: string;
  resolved: string;
  seed: string;
  choices: DynamicPromptChoice[];
}
export interface DynamicPromptRecipe {
  version: DynamicPromptVersion;
  seedPolicy: 'actual-seed-domains-v1';
  resolutionSeed: string;
  positive: DynamicPromptPart;
  negative: DynamicPromptPart;
  wildcards: RecipeWildcards;
  /** Another roll with the same image seed (0 or missing is the first). */
  roll?: number;
  /** Every-combination mode: which combination of the main prompt this is. */
  combination?: number;
  /** Wildcards locked to a value. */
  pins?: Record<string, string>;
}
export interface DynamicPromptAuthoring {
  enabled: boolean;
  selections?: Record<string, string[]>;
  frozen?: DynamicPromptRecipe;
  roll?: number;
  combination?: number;
  pins?: Record<string, string>;
}
export interface DynamicPromptDraft {
  prompt: string;
  negativePrompt: string;
  dynamicPrompts?: DynamicPromptAuthoring;
}
export interface PreparedDynamicPrompt {
  prompt: string;
  negativePrompt: string;
  recipe?: DynamicPromptRecipe;
  reusedFrozen: boolean;
}
/** Lists longer than this are saved with an image as just their picked lines. */
export const RECIPE_FULL_LIST_LIMIT = 256;
/** Full lists an image keeps, all together. */
export const RECIPE_FULL_ENTRY_LIMIT = 4096;
const promptText = z.string().max(DYNAMIC_PROMPT_LIMITS.input);
const wildcardName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/);
const concreteSeed = z
  .string()
  .min(1)
  .max(16)
  .regex(/^\d+$/)
  .refine(
    value => value.length <= 16 && /^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
    'Use a concrete integer image seed.',
  );
function limitedEntries(perList: number, total: number, characters: number, names: number) {
  return z.record(wildcardName, z.array(promptText).min(1).max(perList)).superRefine((entries, context) => {
    let count = 0;
    let length = 0;
    for (const values of Object.values(entries)) {
      count += values.length;
      for (const value of values) length += value.length;
    }
    if (Object.keys(entries).length > names)
      context.addIssue({ code: 'custom', message: `Keep at most ${names} wildcard lists.` });
    if (count > total)
      context.addIssue({
        code: 'custom',
        message: `Keep at most ${total.toLocaleString('en-US')} wildcard entries in total.`,
      });
    if (length > characters)
      context.addIssue({
        code: 'custom',
        message: `Wildcard text goes over ${characters.toLocaleString('en-US')} characters.`,
      });
  });
}
export const wildcardEntriesSchema = limitedEntries(
  DYNAMIC_PROMPT_LIMITS.dictionaryEntries,
  DYNAMIC_PROMPT_LIMITS.dictionaryEntries,
  DYNAMIC_PROMPT_LIMITS.dictionaryCharacters,
  DYNAMIC_PROMPT_LIMITS.dictionaryNames,
);
/** Ticked choices and lists kept with an image stay small: they ride along in every saved draft. */
const smallEntriesSchema = limitedEntries(1024, 8192, 524_288, 1024);
export const wildcardSnapshotSchema: z.ZodType<WildcardSnapshot> = z
  .object({ revision: z.string().regex(/^[a-f0-9]{64}$/), entries: wildcardEntriesSchema })
  .strict();
const sparseListSchema: z.ZodType<SparseWildcardList> = z
  .object({
    count: z.number().int().min(1).max(DYNAMIC_PROMPT_LIMITS.dictionaryEntries),
    picks: z.record(z.string().regex(/^\d{1,6}$/), promptText).refine(picks => Object.keys(picks).length <= 1024),
  })
  .strict();
const recipeWildcardsSchema: z.ZodType<RecipeWildcards> = z
  .object({
    revision: z.string().regex(/^[a-f0-9]{64}$/),
    entries: smallEntriesSchema,
    sparse: z.record(wildcardName, sparseListSchema).optional(),
  })
  .strict();
const choiceSchema: z.ZodType<DynamicPromptChoice> = z
  .object({
    kind: z.enum(['choice', 'wildcard']),
    source: z.string().max(180),
    start: z.number().int().min(0).max(16_000),
    end: z.number().int().min(0).max(16_000),
    tag: z.string().max(128).optional(),
    list: z.string().max(128).optional(),
    selectedIndex: z.number().int().min(0).max(DYNAMIC_PROMPT_LIMITS.dictionaryEntries),
    selectedIndices: z
      .array(z.number().int().min(0).max(DYNAMIC_PROMPT_LIMITS.dictionaryEntries))
      .max(DYNAMIC_PROMPT_LIMITS.pick)
      .optional(),
    pinned: z.literal(true).optional(),
    selectedValue: z.string().max(DYNAMIC_PROMPT_LIMITS.output),
    resolvedValue: z.string().max(DYNAMIC_PROMPT_LIMITS.output),
  })
  .strict()
  .refine(value => value.end >= value.start, 'Choice source span is invalid.');
const partSchema: z.ZodType<DynamicPromptPart> = z
  .object({
    authored: promptText,
    resolved: z.string().max(DYNAMIC_PROMPT_LIMITS.output),
    seed: z.string().max(DYNAMIC_PROMPT_LIMITS.seed),
    choices: z.array(choiceSchema).max(DYNAMIC_PROMPT_LIMITS.expansions),
  })
  .strict();
const rollSchema = z.number().int().min(0).max(1_000_000);
const comboSchema = z
  .number()
  .int()
  .min(0)
  .max(DYNAMIC_PROMPT_LIMITS.combinations - 1);
const pinsSchema = z
  .record(z.string().regex(/^[A-Za-z0-9*][A-Za-z0-9_./*-]{0,127}$/), z.string().max(2000))
  .refine(pins => Object.keys(pins).length <= 64, 'Lock at most 64 wildcards.');
export const dynamicPromptRecipeSchema: z.ZodType<DynamicPromptRecipe> = z
  .object({
    version: z.enum([DYNAMIC_PROMPT_VERSION_V1, DYNAMIC_PROMPT_VERSION]),
    seedPolicy: z.literal('actual-seed-domains-v1'),
    resolutionSeed: concreteSeed,
    positive: partSchema,
    negative: partSchema,
    wildcards: recipeWildcardsSchema,
    roll: rollSchema.optional(),
    combination: comboSchema.optional(),
    pins: pinsSchema.optional(),
  })
  .strict();
export const dynamicPromptAuthoringSchema: z.ZodType<DynamicPromptAuthoring> = z
  .object({
    enabled: z.boolean(),
    selections: smallEntriesSchema.optional(),
    frozen: dynamicPromptRecipeSchema.optional(),
    roll: rollSchema.optional(),
    combination: comboSchema.optional(),
    pins: pinsSchema.optional(),
  })
  .strict();

/** A stable content identity; entry order matters, dictionary-key order does not. */
export async function createWildcardSnapshot(input: Record<string, string[]>): Promise<WildcardSnapshot> {
  const parsed = wildcardEntriesSchema.parse(input);
  // Your lists may use the starter packs by name (like __colors__) without a copy of their own.
  validateWildcardDictionary(parsed, builtInLists());
  const entries = sortedEntries(parsed);
  return { revision: await sha256(JSON.stringify(entries)), entries };
}
const sortedEntries = (input: Record<string, string[]>) =>
  Object.fromEntries(
    Object.keys(input)
      .sort()
      .map(key => [key, [...input[key]]]),
  );
async function sha256(text: string) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export const EMPTY_WILDCARD_SNAPSHOT: WildcardSnapshot = Object.freeze({
  revision: '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  entries: Object.freeze({}),
});
const canonicalJson = (input: unknown) =>
  JSON.stringify(input, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, value[key]]),
        )
      : value,
  );
/** Without big lists this is the same revision a plain snapshot of those lists has. */
async function recipeRevision(entries: Record<string, string[]>, sparse?: Record<string, SparseWildcardList>) {
  return sparse && Object.keys(sparse).length
    ? sha256(canonicalJson({ entries, sparse }))
    : sha256(JSON.stringify(sortedEntries(entries)));
}
async function verifyRecipeWildcards(input: RecipeWildcards): Promise<RecipeWildcards> {
  const parsed = recipeWildcardsSchema.parse(input);
  const entries = sortedEntries(parsed.entries);
  if ((await recipeRevision(entries, parsed.sparse)) !== parsed.revision)
    throw new Error('The wildcard snapshot content does not match its saved revision.');
  return { ...parsed, entries };
}
interface ResolveExtras {
  roll?: number;
  combination?: number;
  pins?: Record<string, string>;
}
function resolvePart(
  kind: 'positive' | 'negative',
  authored: string,
  seed: string,
  wildcards: RecipeWildcards,
  version: DynamicPromptVersion,
  extras: ResolveExtras,
) {
  try {
    const result = resolveDynamicPrompt(authored, seed, wildcards.entries, {
      version,
      sparse: wildcards.sparse,
      pins: extras.pins,
      combination: kind === 'positive' ? extras.combination : undefined,
    });
    return { part: { authored, resolved: result.resolved, seed, choices: result.choices }, used: result.used };
  } catch (error) {
    if (!(error instanceof DynamicPromptError)) throw error;
    const entry = /^wildcard:(.+)\[(\d+)\]$/.exec(error.source);
    const text = entry
      ? (wildcards.entries[entry[1]]?.filter(line => version !== DYNAMIC_PROMPT_VERSION || !isWildcardNote(line))[
          Number(entry[2])
        ] ??
        wildcards.sparse?.[entry[1]]?.picks[entry[2]] ??
        authored)
      : authored;
    throw new DynamicPromptError(error.reason, `${kind}/${error.source}`, error.position, text);
  }
}
/** Small lists stay whole; big ones keep their size and the lines this image used. */
function compactWildcards(input: RecipeWildcards, used: Map<string, Set<number>>) {
  const entries: Record<string, string[]> = {};
  const sparse: Record<string, SparseWildcardList> = {};
  let kept = 0;
  const sparseOf = (name: string, lines: string[]) => {
    const picks: Record<string, string> = {};
    for (const index of [...(used.get(name) ?? [])].sort((a, b) => a - b)) picks[String(index)] = lines[index];
    sparse[name] = { count: lines.length, picks };
  };
  for (const name of Object.keys(input.entries).sort()) {
    const values = input.entries[name];
    if (values.length <= RECIPE_FULL_LIST_LIMIT && kept + values.length <= RECIPE_FULL_ENTRY_LIMIT) {
      entries[name] = [...values];
      kept += values.length;
    } else
      sparseOf(
        name,
        values.filter(line => !isWildcardNote(line)),
      );
  }
  for (const [name, list] of Object.entries(input.sparse ?? {})) {
    const picks: Record<string, string> = {};
    for (const index of [...(used.get(name) ?? [])].sort((a, b) => a - b))
      picks[String(index)] = list.picks[String(index)];
    sparse[name] = { count: list.count, picks };
  }
  return { entries, sparse };
}
async function resolveRecipe(
  draft: DynamicPromptDraft,
  actualSeed: string,
  wildcards: RecipeWildcards,
  version: DynamicPromptVersion,
  extras: ResolveExtras = {},
): Promise<DynamicPromptRecipe> {
  if (version === DYNAMIC_PROMPT_VERSION_V1)
    return {
      version,
      seedPolicy: 'actual-seed-domains-v1',
      resolutionSeed: actualSeed,
      positive: resolvePart('positive', draft.prompt, `${actualSeed}:positive`, wildcards, version, {}).part,
      negative: resolvePart('negative', draft.negativePrompt, `${actualSeed}:negative`, wildcards, version, {}).part,
      wildcards: structuredClone(wildcards),
    };
  const domain = extras.roll ? `${actualSeed}:roll${extras.roll}` : actualSeed;
  const positive = resolvePart('positive', draft.prompt, `${domain}:positive`, wildcards, version, extras);
  const negative = resolvePart('negative', draft.negativePrompt, `${domain}:negative`, wildcards, version, extras);
  const used = new Map(positive.used);
  for (const [name, lines] of negative.used) used.set(name, new Set([...(used.get(name) ?? []), ...lines]));
  const compact = compactWildcards(wildcards, used);
  const hasSparse = Object.keys(compact.sparse).length > 0;
  return {
    version,
    seedPolicy: 'actual-seed-domains-v1',
    resolutionSeed: actualSeed,
    positive: positive.part,
    negative: negative.part,
    wildcards: {
      revision: await recipeRevision(compact.entries, hasSparse ? compact.sparse : undefined),
      entries: compact.entries,
      ...(hasSparse ? { sparse: compact.sparse } : {}),
    },
    ...(extras.roll ? { roll: extras.roll } : {}),
    ...(extras.combination !== undefined ? { combination: extras.combination } : {}),
    ...(extras.pins && Object.keys(extras.pins).length ? { pins: { ...extras.pins } } : {}),
  };
}
/** Saved lists came through createWildcardSnapshot already; only check their shape here. */
function currentEntries(input: WildcardSnapshot): Record<string, string[]> {
  if (!input || typeof input !== 'object' || !input.entries || typeof input.entries !== 'object')
    throw new TypeError('Wildcards must be a dictionary of text entries.');
  return input.entries;
}

/** Call after choosing actualSeed, before creating a queued job. No draft mutation. */
export async function prepareDynamicPromptDraft(
  draft: DynamicPromptDraft,
  actualSeed: string,
  currentWildcards: WildcardSnapshot = EMPTY_WILDCARD_SNAPSHOT,
): Promise<PreparedDynamicPrompt> {
  // Named wildcards work immediately; explicit enablement still supports inline choices.
  if (!usesDynamicPrompts(draft))
    return { prompt: draft.prompt, negativePrompt: draft.negativePrompt, reusedFrozen: false };
  const options = dynamicPromptAuthoringSchema.parse(draft.dynamicPrompts ?? { enabled: true });
  let recipe: DynamicPromptRecipe;
  if (options.frozen) {
    const frozen = options.frozen;
    if (frozen.positive.authored !== draft.prompt || frozen.negative.authored !== draft.negativePrompt)
      throw new Error(
        'The frozen variations no longer match the authored prompts. Regenerate variations before queueing.',
      );
    const snapshot = await verifyRecipeWildcards(frozen.wildcards);
    const expected = await resolveRecipe(draft, frozen.resolutionSeed, snapshot, frozen.version, {
      roll: frozen.roll,
      combination: frozen.combination,
      pins: frozen.pins,
    });
    if (canonicalJson(expected) !== canonicalJson(frozen))
      throw new Error(
        'The saved prompt variation trace is inconsistent. Restore the original recipe or regenerate variations.',
      );
    recipe = structuredClone(frozen);
  } else {
    concreteSeed.parse(actualSeed);
    const snapshot = await createWildcardSnapshot(resolveWildcardEntries(draft, currentEntries(currentWildcards)));
    recipe = await resolveRecipe(draft, actualSeed, snapshot, DYNAMIC_PROMPT_VERSION, {
      roll: options.roll,
      combination: options.combination,
      pins: options.pins,
    });
  }
  return {
    prompt: recipe.positive.resolved,
    negativePrompt: recipe.negative.resolved,
    recipe,
    reusedFrozen: !!options.frozen,
  };
}
/** How many different main prompts every-combination mode can make (up to the limit). */
export function countPromptCombinations(
  draft: DynamicPromptDraft,
  currentWildcards: WildcardSnapshot,
): { count: number; capped: boolean } {
  const entries = resolveWildcardEntries(draft, currentEntries(currentWildcards));
  return countDynamicCombinations(draft.prompt, 'count', entries, { pins: draft.dynamicPrompts?.pins });
}

/** Call from the root draft-change path; image seed changes alone preserve a freeze. */
export function invalidateDynamicPromptFreeze<T extends DynamicPromptDraft>(previous: T, next: T, reroll = false): T {
  if (
    !next.dynamicPrompts?.frozen ||
    (!reroll &&
      previous.prompt === next.prompt &&
      previous.negativePrompt === next.negativePrompt &&
      previous.dynamicPrompts?.enabled === next.dynamicPrompts.enabled)
  )
    return next;
  return {
    ...next,
    dynamicPrompts: {
      enabled: next.dynamicPrompts.enabled,
      selections: next.dynamicPrompts.selections,
      ...(next.dynamicPrompts.pins ? { pins: next.dynamicPrompts.pins } : {}),
    },
  };
}
export function restoreDynamicPromptRecipe<T extends DynamicPromptDraft>(draft: T, input: DynamicPromptRecipe): T {
  const recipe = dynamicPromptRecipeSchema.parse(input);
  return {
    ...draft,
    prompt: recipe.positive.authored,
    negativePrompt: recipe.negative.authored,
    dynamicPrompts: {
      enabled: true,
      selections: structuredClone(recipe.wildcards.entries),
      frozen: structuredClone(recipe),
      ...(recipe.pins ? { pins: { ...recipe.pins } } : {}),
      ...(recipe.roll ? { roll: recipe.roll } : {}),
      ...(recipe.combination !== undefined ? { combination: recipe.combination } : {}),
    },
  };
}
/** Compositor memory preferences do not redact intentionally saved records/presets. */
export function redactDynamicPromptDraft<T extends DynamicPromptDraft>(
  draft: T,
  rememberPositive: boolean,
  rememberNegative: boolean,
): T {
  return {
    ...draft,
    prompt: rememberPositive ? draft.prompt : '',
    negativePrompt: rememberNegative ? draft.negativePrompt : '',
    ...(draft.dynamicPrompts
      ? {
          dynamicPrompts:
            rememberPositive && rememberNegative
              ? structuredClone(draft.dynamicPrompts)
              : { enabled: draft.dynamicPrompts.enabled },
        }
      : {}),
  };
}

export function usesDynamicPrompts(draft: DynamicPromptDraft): boolean {
  const text = draft.prompt + '\n' + draft.negativePrompt;
  return (
    /(?<!\\)\{[^{}]*\|/.test(text) ||
    /(?<!\\)\{(?:\d{1,3})?(?:-\d{0,3})?\$\$/.test(text) ||
    /(?<!\\)\$\{[A-Za-z_]/.test(text) ||
    !!draft.dynamicPrompts?.enabled ||
    /(?<!\\)__[A-Za-z0-9*][A-Za-z0-9_./*-]*__/.test(text)
  );
}
let builtIns: Record<string, string[]> | undefined;
const builtInLists = () => (builtIns ??= Object.fromEntries(WILDCARD_PACKS.map(pack => [pack.id, [...pack.entries]])));
export function wildcardCatalog(saved: Record<string, string[]> = {}): Record<string, string[]> {
  const entries = Object.fromEntries(WILDCARD_PACKS.map(p => [p.id, [...(saved['starter_' + p.id] ?? p.entries)]]));
  return { ...entries, ...saved };
}
/** The lists a draft can reach (including through other lists and folders), ready to snapshot. */
export function resolveWildcardEntries(
  draft: DynamicPromptDraft,
  saved: Record<string, string[]>,
): Record<string, string[]> {
  const catalog = wildcardCatalog(saved);
  const overrides = draft.dynamicPrompts?.selections ?? {};
  const names = [...new Set([...Object.keys(catalog), ...Object.keys(overrides)])];
  const result: Record<string, string[]> = {};
  const seen = new Set<string>();
  const visit = (text: string) => {
    walkDynamicNodes(parseDynamicPrompt(text).nodes, node => {
      if (node.kind !== 'wildcard' || seen.has(node.tag)) return;
      seen.add(node.tag);
      for (const name of matchWildcardNames(node.tag, names)) {
        if (Object.hasOwn(result, name)) continue;
        const canonical = name.startsWith('starter_') ? name.slice(8) : name;
        const values = overrides[name] ?? overrides[canonical] ?? catalog[name] ?? catalog[canonical];
        if (!values) continue;
        result[name] = [...values];
        for (const value of values) if (!isWildcardNote(value)) visit(value);
      }
    });
  };
  visit(draft.prompt);
  visit(draft.negativePrompt);
  return result;
}

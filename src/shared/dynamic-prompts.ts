/** Pure, deterministic dynamic prompt syntax. No files, network, eval or global RNG. */
export const DYNAMIC_PROMPT_VERSION_V1 = 'latent-dynamic-v1' as const;
/** v2 adds weights, pick-several, folders (globs), variables, # comments in lists and pinned picks. */
export const DYNAMIC_PROMPT_VERSION = 'latent-dynamic-v2' as const;
export type DynamicPromptVersion = typeof DYNAMIC_PROMPT_VERSION_V1 | typeof DYNAMIC_PROMPT_VERSION;
export const DYNAMIC_PROMPT_LIMITS = Object.freeze({
  input: 16_000,
  output: 16_000,
  depth: 16,
  expansions: 1024,
  options: 256,
  /** All saved lists together. */
  dictionaryEntries: 100_000,
  dictionaryCharacters: 4_000_000,
  dictionaryNames: 5_000,
  seed: 1024,
  pick: 64,
  /** Every-combination mode counts at most this many. */
  combinations: 1000,
});
export type WildcardDictionary = Readonly<Record<string, readonly string[]>>;
/** A big list saved with an image keeps only its size and the lines that were actually picked. */
export interface SparseWildcardList {
  count: number;
  picks: Readonly<Record<string, string>>;
}
export type SparseWildcards = Readonly<Record<string, SparseWildcardList>>;
export interface PromptSpan {
  source: string;
  start: number;
  end: number;
}
export interface PickRange {
  min: number;
  max: number;
  separator?: string;
}
export type DynamicPromptNode =
  | (PromptSpan & { kind: 'text'; value: string })
  | (PromptSpan & { kind: 'choice'; options: DynamicPromptOption[]; pick?: PickRange })
  | (PromptSpan & { kind: 'wildcard'; tag: string })
  | (PromptSpan & { kind: 'setvar'; name: string; immediate: boolean; nodes: DynamicPromptNode[] })
  | (PromptSpan & { kind: 'getvar'; name: string; fallback?: DynamicPromptNode[] });
export interface DynamicPromptOption {
  start: number;
  end: number;
  /** Where the option's text starts after any "3::" weight. */
  textStart: number;
  weight: number;
  nodes: DynamicPromptNode[];
}
export interface ParsedDynamicPrompt {
  source: string;
  authored: string;
  nodes: DynamicPromptNode[];
}
export interface DynamicPromptChoice extends PromptSpan {
  kind: 'choice' | 'wildcard';
  tag?: string;
  /** The real list a folder wildcard such as __clothes/*__ picked from. */
  list?: string;
  selectedIndex: number;
  /** Every pick of a pick-several group, in order. */
  selectedIndices?: number[];
  /** The wildcard was locked to a value instead of rolled. */
  pinned?: boolean;
  /** Exact selected source substring or dictionary entry, before expansion. */
  selectedValue: string;
  resolvedValue: string;
}
export class DynamicPromptError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(
    readonly reason: string,
    readonly source: string,
    readonly position: number,
    authored: string,
  ) {
    const preceding = authored.slice(0, position).split('\n');
    const line = preceding.length;
    const column = preceding.at(-1)!.length + 1;
    super(`${reason} (${source}, line ${line}, column ${column}).`);
    this.name = 'DynamicPromptError';
    this.line = line;
    this.column = column;
  }
}

const TAG_V1 = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/;
const TAG_V2 = /^(?=[^]*[A-Za-z0-9])[A-Za-z0-9*][A-Za-z0-9_./*-]{0,127}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,63}/;
const PICK = /^(\d{1,3})?(?:(-)(\d{1,3})?)?\$\$/;
const WEIGHT = /^\s*(\d{1,4}(?:\.\d{1,4})?)::/;
export const isWildcardName = (name: string) => TAG_V1.test(name);
export const isWildcardPattern = (name: string) => TAG_V2.test(name);
/** Blank lines and lines starting with # are notes, not choices (new syntax only). */
export const isWildcardNote = (line: string) => !line.trim() || line.trimStart().startsWith('#');

/** Braces are always choice syntax; escape literal braces with backslashes. */
export function parseDynamicPrompt(
  authored: string,
  source = 'authored',
  version: DynamicPromptVersion = DYNAMIC_PROMPT_VERSION,
): ParsedDynamicPrompt {
  const v2 = version === DYNAMIC_PROMPT_VERSION;
  const fail = (message: string, at: number): never => {
    throw new DynamicPromptError(message, source, at, authored);
  };
  if (typeof authored !== 'string') throw new TypeError('A dynamic prompt must be text.');
  if (authored.length > DYNAMIC_PROMPT_LIMITS.input)
    fail(`Prompt exceeds ${DYNAMIC_PROMPT_LIMITS.input} characters`, DYNAMIC_PROMPT_LIMITS.input);
  let position = 0;
  function sequence(depth: number, within: 'top' | 'choice' | 'variable'): DynamicPromptNode[] {
    const nodes: DynamicPromptNode[] = [];
    let text = '';
    let textStart = position;
    const flush = () => {
      if (text) nodes.push({ kind: 'text', value: text, source, start: textStart, end: position });
      text = '';
      textStart = position;
    };
    while (position < authored.length) {
      const char = authored[position];
      if (within === 'choice' && (char === '|' || char === '}')) break;
      if (within === 'variable' && char === '}') break;
      if (char === '}') fail('Unexpected closing brace; use \\} for a literal brace', position);
      if (char === '\\') {
        if (position + 1 === authored.length) fail('A trailing backslash needs an escaped character', position);
        text += authored[position + 1];
        position += 2;
        continue;
      }
      if (v2 && char === '$' && authored[position + 1] === '{') {
        flush();
        const start = position;
        position += 2;
        if (depth >= DYNAMIC_PROMPT_LIMITS.depth)
          fail(`Nesting goes deeper than ${DYNAMIC_PROMPT_LIMITS.depth}`, start);
        const name = VARIABLE.exec(authored.slice(position, position + 64))?.[0];
        if (!name) fail('A variable name starts with a letter or underscore, like ${hair}', position);
        position += name!.length;
        const next = authored[position];
        if (next === '}') {
          position++;
          nodes.push({ kind: 'getvar', source, start, end: position, name: name! });
        } else if (next === ':' || next === '=') {
          position++;
          const immediate = next === '=' && authored[position] === '!';
          if (immediate) position++;
          const value = sequence(depth + 1, 'variable');
          if (authored[position] !== '}') fail('Unclosed variable; add a closing brace', start);
          position++;
          nodes.push(
            next === '='
              ? { kind: 'setvar', source, start, end: position, name: name!, immediate, nodes: value }
              : { kind: 'getvar', source, start, end: position, name: name!, fallback: value },
          );
        } else fail('Use ${name} to use a variable or ${name=...} to set one', position);
        textStart = position;
        continue;
      }
      if (char === '{') {
        flush();
        const start = position++;
        if (depth >= DYNAMIC_PROMPT_LIMITS.depth) fail(`Choice nesting exceeds ${DYNAMIC_PROMPT_LIMITS.depth}`, start);
        let pick: PickRange | undefined;
        const pickMatch = v2 ? PICK.exec(authored.slice(position, position + 12)) : null;
        if (pickMatch && (pickMatch[1] || pickMatch[3])) {
          const min = pickMatch[1] ? Number(pickMatch[1]) : 1;
          const max = pickMatch[3] ? Number(pickMatch[3]) : pickMatch[2] ? DYNAMIC_PROMPT_LIMITS.pick : min;
          if (max < min || max < 1) fail('Pick a range like {2$$a|b|c} or {1-3$$a|b|c}', start);
          position += pickMatch[0].length;
          pick = { min, max: Math.min(max, DYNAMIC_PROMPT_LIMITS.pick) };
          // {2$$ and $$a|b|c} joins the picks with " and ".
          for (let at = position; at < authored.length && !'|{}'.includes(authored[at]); at++)
            if (authored.startsWith('$$', at)) {
              pick.separator = authored.slice(position, at);
              position = at + 2;
              break;
            }
        }
        const options: DynamicPromptOption[] = [];
        while (true) {
          const optionStart = position;
          let weight = 1;
          const weightMatch = v2 ? WEIGHT.exec(authored.slice(position, position + 16)) : null;
          if (weightMatch) {
            weight = Number(weightMatch[1]);
            position += weightMatch[0].length;
          }
          const textStart = position;
          const children = sequence(depth + 1, 'choice');
          options.push({ start: optionStart, end: position, textStart, weight, nodes: children });
          if (options.length > DYNAMIC_PROMPT_LIMITS.options)
            fail(`A choice exceeds ${DYNAMIC_PROMPT_LIMITS.options} options`, start);
          if (position === authored.length) fail('Unclosed choice; add a closing brace', start);
          if (authored[position++] === '}') break;
        }
        if (options.length < 2 && !pick)
          fail('A choice needs at least two options separated by |; escape literal braces', start);
        if (!options.some(option => option.weight > 0)) fail('At least one option needs a weight above 0', start);
        nodes.push({ kind: 'choice', source, start, end: position, options, ...(pick ? { pick } : {}) });
        textStart = position;
        continue;
      }
      if (authored.startsWith('__', position)) {
        flush();
        const start = position;
        const end = authored.indexOf('__', position + 2);
        if (end === -1) fail('Unclosed wildcard; add a closing __', start);
        const tag = authored.slice(position + 2, end);
        if (!(v2 ? TAG_V2 : TAG_V1).test(tag))
          fail(
            v2
              ? 'Wildcard names use letters, digits, _ . / - and * for a whole folder, like __clothes/*__'
              : 'Wildcard names need 1–128 letters, digits, underscores, dots, slashes or hyphens, starting with a letter or digit',
            start + 2,
          );
        position = end + 2;
        nodes.push({ kind: 'wildcard', source, start, end: position, tag });
        textStart = position;
        continue;
      }
      text += char;
      position++;
    }
    flush();
    return nodes;
  }
  return { authored, source, nodes: sequence(0, 'top') };
}

/** Walks every node, including unchosen options, variable values and fallbacks. */
export function walkDynamicNodes(nodes: readonly DynamicPromptNode[], visit: (node: DynamicPromptNode) => void) {
  for (const node of nodes) {
    visit(node);
    if (node.kind === 'choice') for (const option of node.options) walkDynamicNodes(option.nodes, visit);
    if (node.kind === 'setvar') walkDynamicNodes(node.nodes, visit);
    if (node.kind === 'getvar' && node.fallback) walkDynamicNodes(node.fallback, visit);
  }
}

const globCache = new Map<string, RegExp>();
export function wildcardGlob(pattern: string): RegExp {
  let regex = globCache.get(pattern);
  if (!regex) {
    regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\/-]/g, '\\$&').replace(/\*/g, '.*')}$`);
    globCache.set(pattern, regex);
  }
  return regex;
}
/** List names a wildcard reads from: itself, or every match of a * pattern, sorted. */
export function matchWildcardNames(tag: string, names: Iterable<string>): string[] {
  if (!tag.includes('*')) return [tag];
  const glob = wildcardGlob(tag);
  return [...names].filter(name => glob.test(name)).sort();
}

interface ListPart {
  name: string;
  count: number;
  entry(index: number): ParsedDynamicPrompt | undefined;
}
interface ListView {
  count: number;
  parts: ListPart[];
}
interface PreparedPrompt {
  version: DynamicPromptVersion;
  root: ParsedDynamicPrompt;
  lists: Map<string, ListView>;
}
function prepare(
  authored: string,
  wildcards: WildcardDictionary,
  options: { version?: DynamicPromptVersion; sparse?: SparseWildcards; allTags?: boolean; tags?: string[] } = {},
): PreparedPrompt {
  const version = options.version ?? DYNAMIC_PROMPT_VERSION;
  const v2 = version === DYNAMIC_PROMPT_VERSION;
  const sparse = options.sparse ?? {};
  const root = parseDynamicPrompt(authored, 'authored', version);
  const lists = new Map<string, ListView>();
  const parts = new Map<string, ListPart>();
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  let entryCount = 0;
  let characters = 0;
  const fail = (message: string, node: PromptSpan, document: ParsedDynamicPrompt): never => {
    throw new DynamicPromptError(message, node.source, node.start, document.authored);
  };
  if (!wildcards || typeof wildcards !== 'object' || Array.isArray(wildcards))
    throw new TypeError('Wildcards must be a dictionary of text entries.');
  const allNames = () => [
    ...Object.keys(wildcards),
    ...Object.keys(sparse).filter(name => !Object.hasOwn(wildcards, name)),
  ];
  function part(name: string, node: PromptSpan, document: ParsedDynamicPrompt): ListPart {
    const known = parts.get(name);
    if (known) return known;
    let made: ListPart;
    if (Object.hasOwn(wildcards, name)) {
      const raw = wildcards[name];
      if (!Array.isArray(raw)) fail(`Wildcard __${name}__ needs a list of text entries`, node, document);
      const values = v2 ? raw.filter(value => typeof value !== 'string' || !isWildcardNote(value)) : raw;
      if (!values.length) fail(`Wildcard __${name}__ needs a nonempty list of text entries`, node, document);
      entryCount += values.length;
      if (entryCount > DYNAMIC_PROMPT_LIMITS.dictionaryEntries)
        fail(`Referenced dictionaries exceed ${DYNAMIC_PROMPT_LIMITS.dictionaryEntries} entries`, node, document);
      const documents = values.map((value, index) => {
        if (typeof value !== 'string') fail(`Wildcard __${name}__ entry ${index + 1} must be text`, node, document);
        characters += value.length;
        if (characters > DYNAMIC_PROMPT_LIMITS.dictionaryCharacters)
          fail(
            `Referenced dictionary text exceeds ${DYNAMIC_PROMPT_LIMITS.dictionaryCharacters} characters`,
            node,
            document,
          );
        return parseDynamicPrompt(value, `wildcard:${name}[${index}]`, version);
      });
      made = { name, count: documents.length, entry: index => documents[index] };
    } else if (v2 && Object.hasOwn(sparse, name)) {
      const list = sparse[name];
      const documents = new Map<number, ParsedDynamicPrompt>();
      for (const [key, value] of Object.entries(list.picks)) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= list.count)
          fail(`The saved picks for __${name}__ don't match its size`, node, document);
        documents.set(index, parseDynamicPrompt(value, `wildcard:${name}[${index}]`, version));
      }
      made = { name, count: list.count, entry: index => documents.get(index) };
    } else return fail(`Unknown wildcard __${name}__`, node, document);
    parts.set(name, made);
    return made;
  }
  function view(tag: string, node: PromptSpan, document: ParsedDynamicPrompt): ListView {
    const known = lists.get(tag);
    if (known) return known;
    const names = matchWildcardNames(tag, allNames());
    if (!names.length) fail(`No wildcard lists match __${tag}__`, node, document);
    const matched = names.map(name => part(name, node, document));
    const made = { count: matched.reduce((total, item) => total + item.count, 0), parts: matched };
    lists.set(tag, made);
    return made;
  }
  function depthOf(nodes: DynamicPromptNode[], document: ParsedDynamicPrompt): number {
    let maximum = 0;
    for (const node of nodes) {
      let depth = 0;
      if (node.kind === 'choice') depth = 1 + Math.max(...node.options.map(option => depthOf(option.nodes, document)));
      if (node.kind === 'setvar') depth = depthOf(node.nodes, document);
      if (node.kind === 'getvar' && node.fallback) depth = depthOf(node.fallback, document);
      if (node.kind === 'wildcard') {
        if (visiting.has(node.tag)) fail(`Wildcard cycle detected at __${node.tag}__`, node, document);
        if (!depths.has(node.tag)) {
          const list = view(node.tag, node, document);
          if (visiting.size >= DYNAMIC_PROMPT_LIMITS.depth)
            fail(`Wildcard nesting exceeds ${DYNAMIC_PROMPT_LIMITS.depth}`, node, document);
          visiting.add(node.tag);
          let nestedDepth = 0;
          for (const item of list.parts)
            for (let index = 0; index < item.count; index++) {
              const entry = item.entry(index);
              if (entry) nestedDepth = Math.max(nestedDepth, depthOf(entry.nodes, entry));
            }
          visiting.delete(node.tag);
          depths.set(node.tag, nestedDepth);
        }
        depth = 1 + depths.get(node.tag)!;
      }
      if (depth > DYNAMIC_PROMPT_LIMITS.depth)
        fail(`Combined choice/wildcard nesting exceeds ${DYNAMIC_PROMPT_LIMITS.depth}`, node, document);
      maximum = Math.max(maximum, depth);
    }
    return maximum;
  }
  depthOf(root.nodes, root);
  if (options.allTags) {
    const tags = options.tags ?? Object.keys(wildcards);
    if (tags.length > DYNAMIC_PROMPT_LIMITS.dictionaryNames)
      throw new Error(`Keep at most ${DYNAMIC_PROMPT_LIMITS.dictionaryNames} wildcard lists.`);
    for (const tag of tags) {
      const reference = parseDynamicPrompt(`__${tag}__`, `wildcard-name:${tag}`, version);
      depthOf(reference.nodes, reference);
    }
  }
  return { version, root, lists };
}

/** Validates all options and every reachable dictionary entry, even unselected ones. */
export function validateDynamicPrompt(authored: string, wildcards: WildcardDictionary = {}): ParsedDynamicPrompt {
  return prepare(authored, wildcards).root;
}
/**
 * For persistent user dictionaries, validate even currently unreferenced tags. `builtIn` lists
 * (the starter packs) may be referenced but are not checked themselves.
 */
export function validateWildcardDictionary(wildcards: WildcardDictionary, builtIn: WildcardDictionary = {}): void {
  prepare('', { ...builtIn, ...wildcards }, { allTags: true, tags: Object.keys(wildcards) });
}

// FNV-1a over UTF-16 code units followed by Mulberry32. This sequence is part
// of latent-dynamic-v1 and v2; changing it requires a version change in saved recipes.
function randomForSeed(seed: string) {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}
function weightedIndex(value: number, weights: readonly number[]) {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let target = value * total;
  for (let index = 0; index < weights.length; index++) {
    if (target < weights[index]) return index;
    target -= weights[index];
  }
  // Rounding can leave a sliver past the end: take the last option that can be picked.
  for (let index = weights.length - 1; index >= 0; index--) if (weights[index] > 0) return index;
  return 0;
}

export interface ResolveOptions {
  version?: DynamicPromptVersion;
  /** Big lists saved with an image (only their picked lines). */
  sparse?: SparseWildcards;
  /** Wildcards locked to a value: the roll still happens so other picks stay put. */
  pins?: Readonly<Record<string, string>>;
  /** Every-combination mode: walk choices in order and take this one. */
  combination?: number;
}
export interface ResolvedDynamicPrompt {
  resolved: string;
  choices: DynamicPromptChoice[];
  /** Lines read from each list, by their place in that list. */
  used: Map<string, Set<number>>;
}
type Chooser = (count: number, weights?: readonly number[]) => number;

function resolvePrepared(
  prepared: PreparedPrompt,
  seed: string,
  options: ResolveOptions,
  chooser?: Chooser,
): ResolvedDynamicPrompt {
  const v2 = prepared.version === DYNAMIC_PROMPT_VERSION;
  const random = randomForSeed(seed);
  const roll: Chooser = (count, weights) =>
    weights && weights.some(weight => weight !== weights[0])
      ? weightedIndex(random(), weights)
      : Math.floor(random() * count);
  const choose = chooser ?? roll;
  const choices: DynamicPromptChoice[] = [];
  const used = new Map<string, Set<number>>();
  const variables = new Map<
    string,
    { value: string } | { nodes: DynamicPromptNode[]; document: ParsedDynamicPrompt }
  >();
  const activeVariables = new Set<string>();
  const fail = (message: string, node: PromptSpan, document: ParsedDynamicPrompt): never => {
    throw new DynamicPromptError(message, node.source, node.start, document.authored);
  };
  function listEntry(tag: string, index: number, node: PromptSpan, document: ParsedDynamicPrompt) {
    const list = prepared.lists.get(tag)!;
    let local = index;
    for (const item of list.parts) {
      if (local < item.count) {
        const entry = item.entry(local);
        if (!entry) fail(`The saved picks for __${item.name}__ are missing a line`, node, document);
        if (!used.has(item.name)) used.set(item.name, new Set());
        used.get(item.name)!.add(local);
        return { entry: entry!, list: item.name };
      }
      local -= item.count;
    }
    return fail(`__${tag}__ has no line ${index + 1}`, node, document);
  }
  function record(choice: DynamicPromptChoice) {
    if (choices.length >= DYNAMIC_PROMPT_LIMITS.expansions)
      fail(`Prompt exceeds ${DYNAMIC_PROMPT_LIMITS.expansions} expansions`, choice, prepared.root);
    choices.push(choice);
    return choice;
  }
  function soleWildcard(nodes: DynamicPromptNode[]) {
    const meaningful = nodes.filter(node => node.kind !== 'text' || node.value.trim());
    return meaningful.length === 1 && meaningful[0].kind === 'wildcard' ? meaningful[0] : undefined;
  }
  function resolvePick(
    node: Extract<DynamicPromptNode, { kind: 'choice' }>,
    pick: PickRange,
    document: ParsedDynamicPrompt,
  ): string {
    const fromList = node.options.length === 1 ? soleWildcard(node.options[0].nodes) : undefined;
    const available = fromList
      ? prepared.lists.get(fromList.tag)!.count
      : node.options.filter(option => option.weight > 0).length;
    const top = Math.min(pick.max, available);
    const low = Math.min(pick.min, top);
    const count = top > low ? low + Math.floor(random() * (top - low + 1)) : top;
    const picked: number[] = [];
    const choice = record({
      kind: fromList ? 'wildcard' : 'choice',
      source: node.source,
      start: node.start,
      end: node.end,
      selectedIndex: 0,
      selectedIndices: picked,
      selectedValue: '',
      resolvedValue: '',
      ...(fromList ? { tag: fromList.tag } : {}),
    });
    const parts: string[] = [];
    const values: string[] = [];
    if (fromList) {
      const total = prepared.lists.get(fromList.tag)!.count;
      // Draw from the whole list, skipping repeats, so a big saved list only needs its picked lines.
      for (let attempt = 0; picked.length < count && attempt < count * 12 + 12; attempt++) {
        const index = Math.floor(random() * total);
        if (!picked.includes(index)) picked.push(index);
      }
      for (const index of picked) {
        const { entry } = listEntry(fromList.tag, index, fromList, document);
        values.push(entry.authored);
        parts.push(resolveNodes(entry.nodes, entry));
      }
    } else {
      const remaining = node.options.map((_option, index) => index).filter(index => node.options[index].weight > 0);
      while (picked.length < count && remaining.length) {
        const at = roll(
          remaining.length,
          remaining.map(index => node.options[index].weight),
        );
        picked.push(remaining.splice(at, 1)[0]);
      }
      for (const index of picked) {
        const option = node.options[index];
        values.push(document.authored.slice(option.textStart, option.end));
        parts.push(resolveNodes(option.nodes, document));
      }
    }
    choice.selectedIndex = picked[0] ?? 0;
    choice.selectedValue = values.join('|');
    choice.resolvedValue = parts.filter(part => part.trim()).join(pick.separator ?? ', ');
    return choice.resolvedValue;
  }
  function resolveNodes(nodes: DynamicPromptNode[], document: ParsedDynamicPrompt): string {
    let output = '';
    for (const node of nodes) {
      let value = '';
      if (node.kind === 'text') value = node.value;
      else if (node.kind === 'setvar') {
        variables.set(
          node.name,
          node.immediate ? { value: resolveNodes(node.nodes, document) } : { nodes: node.nodes, document },
        );
      } else if (node.kind === 'getvar') {
        const variable = variables.get(node.name);
        if (!variable) {
          if (!node.fallback)
            fail(`\${${node.name}} isn't set yet. Set it first with \${${node.name}=...}`, node, document);
          value = resolveNodes(node.fallback!, document);
        } else if ('value' in variable) value = variable.value;
        else {
          if (activeVariables.has(node.name)) fail(`\${${node.name}} refers to itself`, node, document);
          activeVariables.add(node.name);
          value = resolveNodes(variable.nodes, variable.document);
          activeVariables.delete(node.name);
        }
      } else if (node.kind === 'choice' && node.pick) value = resolvePick(node, node.pick, document);
      else if (node.kind === 'choice') {
        const choice = record({
          kind: 'choice',
          source: node.source,
          start: node.start,
          end: node.end,
          selectedIndex: 0,
          selectedValue: '',
          resolvedValue: '',
        });
        const selectedIndex = choose(node.options.length, v2 ? node.options.map(option => option.weight) : undefined);
        const option = node.options[selectedIndex];
        choice.selectedIndex = selectedIndex;
        choice.selectedValue = document.authored.slice(v2 ? option.textStart : option.start, option.end);
        value = resolveNodes(option.nodes, document);
        choice.resolvedValue = value;
      } else {
        const list = prepared.lists.get(node.tag)!;
        const pin = v2 ? options.pins?.[node.tag] : undefined;
        const choice = record({
          kind: 'wildcard',
          source: node.source,
          start: node.start,
          end: node.end,
          selectedIndex: 0,
          selectedValue: '',
          resolvedValue: '',
          tag: node.tag,
        });
        if (pin !== undefined) {
          // Still roll in normal mode, so every other pick lands where it would have.
          choice.selectedIndex = chooser ? 0 : roll(list.count);
          choice.pinned = true;
          choice.selectedValue = pin;
          value = pin;
        } else {
          const selectedIndex = choose(list.count);
          const { entry, list: name } = listEntry(node.tag, selectedIndex, node, document);
          choice.selectedIndex = selectedIndex;
          if (name !== node.tag) choice.list = name;
          choice.selectedValue = entry.authored;
          value = resolveNodes(entry.nodes, entry);
        }
        choice.resolvedValue = value;
      }
      if (output.length + value.length > DYNAMIC_PROMPT_LIMITS.output)
        fail(`Resolved prompt exceeds ${DYNAMIC_PROMPT_LIMITS.output} characters`, node, document);
      output += value;
    }
    return output;
  }
  return { resolved: resolveNodes(prepared.root.nodes, prepared.root), choices, used };
}

/** Walks the choices like an odometer: the last choice turns fastest. */
function combinationRun(prepared: PreparedPrompt, seed: string, options: ResolveOptions, prefix: number[]) {
  const counts: number[] = [];
  const chosen: number[] = [];
  const result = resolvePrepared(prepared, seed, options, count => {
    const at = counts.length;
    const pick = Math.min(prefix[at] ?? 0, count - 1);
    counts.push(count);
    chosen.push(pick);
    return pick;
  });
  let next: number[] | undefined;
  for (let index = counts.length - 1; index >= 0; index--)
    if (chosen[index] + 1 < counts[index]) {
      next = [...chosen.slice(0, index), chosen[index] + 1];
      break;
    }
  return { result, next };
}

export function resolveDynamicPrompt(
  authored: string,
  seed: string,
  wildcards: WildcardDictionary = {},
  options: ResolveOptions = {},
): ResolvedDynamicPrompt {
  if (typeof seed !== 'string' || seed.length > DYNAMIC_PROMPT_LIMITS.seed)
    throw new TypeError(`The dynamic prompt seed must be text of at most ${DYNAMIC_PROMPT_LIMITS.seed} characters.`);
  const prepared = prepare(authored, wildcards, options);
  if (options.combination === undefined) return resolvePrepared(prepared, seed, options);
  const target = options.combination;
  if (!Number.isInteger(target) || target < 0 || target >= DYNAMIC_PROMPT_LIMITS.combinations)
    throw new RangeError('That combination number is out of range.');
  let prefix: number[] = [];
  for (let index = 0; ; index++) {
    const { result, next } = combinationRun(prepared, seed, options, prefix);
    if (index === target) return result;
    if (!next) throw new RangeError(`This prompt only has ${index + 1} combinations.`);
    prefix = next;
  }
}

/** How many different prompts every-combination mode can make, up to the limit. */
export function countDynamicCombinations(
  authored: string,
  seed: string,
  wildcards: WildcardDictionary = {},
  options: ResolveOptions = {},
): { count: number; capped: boolean } {
  const prepared = prepare(authored, wildcards, options);
  let prefix: number[] | undefined = [];
  let count = 0;
  while (prefix && count < DYNAMIC_PROMPT_LIMITS.combinations) {
    prefix = combinationRun(prepared, seed, options, prefix).next;
    count++;
  }
  return { count, capped: !!prefix };
}

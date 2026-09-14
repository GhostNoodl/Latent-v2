/** Pure, deterministic dynamic prompt syntax. No files, network, eval or global RNG. */
export const DYNAMIC_PROMPT_VERSION = 'latent-dynamic-v1' as const;
export const DYNAMIC_PROMPT_LIMITS = Object.freeze({ input: 16_000, output: 16_000, depth: 16, expansions: 256, options: 256, dictionaryEntries: 1024, dictionaryCharacters: 262_144, seed: 1024 });
export type WildcardDictionary = Readonly<Record<string, readonly string[]>>;
export interface PromptSpan { source: string; start: number; end: number; }
export type DynamicPromptNode =
  | (PromptSpan & { kind: 'text'; value: string })
  | (PromptSpan & { kind: 'choice'; options: DynamicPromptOption[] })
  | (PromptSpan & { kind: 'wildcard'; tag: string });
export interface DynamicPromptOption { start: number; end: number; nodes: DynamicPromptNode[]; }
export interface ParsedDynamicPrompt { source: string; authored: string; nodes: DynamicPromptNode[]; }
export interface DynamicPromptChoice extends PromptSpan {
  kind: 'choice' | 'wildcard';
  tag?: string;
  selectedIndex: number;
  /** Exact selected source substring or dictionary entry, before expansion. */
  selectedValue: string;
  resolvedValue: string;
}
export class DynamicPromptError extends Error {
  readonly line: number;
  readonly column: number;
  constructor(readonly reason: string, readonly source: string, readonly position: number, authored: string) {
    const preceding = authored.slice(0, position).split('\n');
    const line = preceding.length; const column = preceding.at(-1)!.length + 1;
    super(`${reason} (${source}, line ${line}, column ${column}).`);
    this.name = 'DynamicPromptError'; this.line = line; this.column = column;
  }
}

/** Braces are always choice syntax; escape literal braces with backslashes. */
export function parseDynamicPrompt(authored: string, source = 'authored'): ParsedDynamicPrompt {
  const fail = (message: string, at: number): never => { throw new DynamicPromptError(message, source, at, authored); };
  if (typeof authored !== 'string') throw new TypeError('A dynamic prompt must be text.');
  if (authored.length > DYNAMIC_PROMPT_LIMITS.input) fail(`Prompt exceeds ${DYNAMIC_PROMPT_LIMITS.input} characters`, DYNAMIC_PROMPT_LIMITS.input);
  let position = 0;
  function sequence(depth: number, withinChoice: boolean): DynamicPromptNode[] {
    const nodes: DynamicPromptNode[] = [];
    let text = ''; let textStart = position;
    const flush = () => { if (text) nodes.push({ kind: 'text', value: text, source, start: textStart, end: position }); text = ''; textStart = position; };
    while (position < authored.length) {
      const char = authored[position];
      if (withinChoice && (char === '|' || char === '}')) break;
      if (char === '}') fail('Unexpected closing brace; use \\} for a literal brace', position);
      if (char === '\\') {
        if (position + 1 === authored.length) fail('A trailing backslash needs an escaped character', position);
        text += authored[position + 1]; position += 2; continue;
      }
      if (char === '{') {
        flush(); const start = position++;
        if (depth >= DYNAMIC_PROMPT_LIMITS.depth) fail(`Choice nesting exceeds ${DYNAMIC_PROMPT_LIMITS.depth}`, start);
        const options: DynamicPromptOption[] = [];
        while (true) {
          const optionStart = position; const children = sequence(depth + 1, true);
          options.push({ start: optionStart, end: position, nodes: children });
          if (options.length > DYNAMIC_PROMPT_LIMITS.options) fail(`A choice exceeds ${DYNAMIC_PROMPT_LIMITS.options} options`, start);
          if (position === authored.length) fail('Unclosed choice; add a closing brace', start);
          if (authored[position++] === '}') break;
        }
        if (options.length < 2) fail('A choice needs at least two options separated by |; escape literal braces', start);
        nodes.push({ kind: 'choice', source, start, end: position, options }); textStart = position; continue;
      }
      if (authored.startsWith('__', position)) {
        flush(); const start = position; const end = authored.indexOf('__', position + 2);
        if (end === -1) fail('Unclosed wildcard; add a closing __', start);
        const tag = authored.slice(position + 2, end);
        if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(tag)) fail('Wildcard names need 1–128 letters, digits, underscores, dots, slashes or hyphens, starting with a letter or digit', start + 2);
        position = end + 2; nodes.push({ kind: 'wildcard', source, start, end: position, tag }); textStart = position; continue;
      }
      text += char; position++;
    }
    flush(); return nodes;
  }
  return { authored, source, nodes: sequence(0, false) };
}

interface PreparedPrompt { root: ParsedDynamicPrompt; entries: Map<string, ParsedDynamicPrompt[]>; }
function prepare(authored: string, wildcards: WildcardDictionary, allTags = false): PreparedPrompt {
  const root = parseDynamicPrompt(authored);
  const entries = new Map<string, ParsedDynamicPrompt[]>(); const depths = new Map<string, number>(); const visiting = new Set<string>();
  let entryCount = 0; let characters = 0;
  const fail = (message: string, node: PromptSpan, document: ParsedDynamicPrompt): never => { throw new DynamicPromptError(message, node.source, node.start, document.authored); };
  if (!wildcards || typeof wildcards !== 'object' || Array.isArray(wildcards)) throw new TypeError('Wildcards must be a dictionary of text entries.');
  function depthOf(nodes: DynamicPromptNode[], document: ParsedDynamicPrompt): number {
    let maximum = 0;
    for (const node of nodes) {
      let depth = 0;
      if (node.kind === 'choice') depth = 1 + Math.max(...node.options.map(option => depthOf(option.nodes, document)));
      if (node.kind === 'wildcard') {
        if (visiting.has(node.tag)) fail(`Wildcard cycle detected at __${node.tag}__`, node, document);
        if (!depths.has(node.tag)) {
          if (!Object.hasOwn(wildcards, node.tag)) fail(`Unknown wildcard __${node.tag}__`, node, document);
          const values = wildcards[node.tag];
          if (!Array.isArray(values) || values.length === 0) fail(`Wildcard __${node.tag}__ needs a nonempty list of text entries`, node, document);
          entryCount += values.length;
          if (entryCount > DYNAMIC_PROMPT_LIMITS.dictionaryEntries) fail(`Referenced dictionaries exceed ${DYNAMIC_PROMPT_LIMITS.dictionaryEntries} entries`, node, document);
          if (visiting.size >= DYNAMIC_PROMPT_LIMITS.depth) fail(`Wildcard nesting exceeds ${DYNAMIC_PROMPT_LIMITS.depth}`, node, document);
          const documents = values.map((value, index) => {
            if (typeof value !== 'string') fail(`Wildcard __${node.tag}__ entry ${index + 1} must be text`, node, document);
            characters += value.length;
            if (characters > DYNAMIC_PROMPT_LIMITS.dictionaryCharacters) fail(`Referenced dictionary text exceeds ${DYNAMIC_PROMPT_LIMITS.dictionaryCharacters} characters`, node, document);
            return parseDynamicPrompt(value, `wildcard:${node.tag}[${index}]`);
          });
          entries.set(node.tag, documents); visiting.add(node.tag);
          const nestedDepth = Math.max(...documents.map(entry => depthOf(entry.nodes, entry)));
          visiting.delete(node.tag); depths.set(node.tag, nestedDepth);
        }
        depth = 1 + depths.get(node.tag)!;
      }
      if (depth > DYNAMIC_PROMPT_LIMITS.depth) fail(`Combined choice/wildcard nesting exceeds ${DYNAMIC_PROMPT_LIMITS.depth}`, node, document);
      maximum = Math.max(maximum, depth);
    }
    return maximum;
  }
  depthOf(root.nodes, root);
  if (allTags) {
    if (Object.keys(wildcards).length > DYNAMIC_PROMPT_LIMITS.dictionaryEntries) throw new Error(`Wildcard dictionary exceeds ${DYNAMIC_PROMPT_LIMITS.dictionaryEntries} names.`);
    for (const tag of Object.keys(wildcards)) { const reference = parseDynamicPrompt(`__${tag}__`, `wildcard-name:${tag}`); depthOf(reference.nodes, reference); }
  }
  return { root, entries };
}

/** Validates all options and every reachable dictionary entry, even unselected ones. */
export function validateDynamicPrompt(authored: string, wildcards: WildcardDictionary = {}): ParsedDynamicPrompt {
  return prepare(authored, wildcards).root;
}
/** For persistent user dictionaries, validate even currently unreferenced tags. */
export function validateWildcardDictionary(wildcards: WildcardDictionary): void { prepare('', wildcards, true); }

// FNV-1a over UTF-16 code units followed by Mulberry32. This sequence is part
// of latent-dynamic-v1; changing it requires a version change in saved recipes.
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

export function resolveDynamicPrompt(authored: string, seed: string, wildcards: WildcardDictionary = {}): { resolved: string; choices: DynamicPromptChoice[] } {
  if (typeof seed !== 'string' || seed.length > DYNAMIC_PROMPT_LIMITS.seed) throw new TypeError(`The dynamic prompt seed must be text of at most ${DYNAMIC_PROMPT_LIMITS.seed} characters.`);
  const prepared = prepare(authored, wildcards); const random = randomForSeed(seed); const choices: DynamicPromptChoice[] = [];
  const fail = (message: string, node: PromptSpan, document: ParsedDynamicPrompt): never => { throw new DynamicPromptError(message, node.source, node.start, document.authored); };
  function resolveNodes(nodes: DynamicPromptNode[], document: ParsedDynamicPrompt): string {
    let output = '';
    for (const node of nodes) {
      let value: string;
      if (node.kind === 'text') value = node.value;
      else {
        if (choices.length >= DYNAMIC_PROMPT_LIMITS.expansions) fail(`Prompt exceeds ${DYNAMIC_PROMPT_LIMITS.expansions} expansions`, node, document);
        const count = node.kind === 'choice' ? node.options.length : prepared.entries.get(node.tag)!.length;
        const selectedIndex = Math.floor(random() * count);
        const selectedOption = node.kind === 'choice' ? node.options[selectedIndex] : undefined;
        const selectedEntry = node.kind === 'wildcard' ? prepared.entries.get(node.tag)![selectedIndex] : undefined;
        const selectedValue = selectedOption ? document.authored.slice(selectedOption.start, selectedOption.end) : selectedEntry!.authored;
        const choice: DynamicPromptChoice = { kind: node.kind, source: node.source, start: node.start, end: node.end, selectedIndex, selectedValue, resolvedValue: '', ...(node.kind === 'wildcard' ? { tag: node.tag } : {}) };
        choices.push(choice); // Record parent first, in left-to-right evaluation order.
        value = selectedOption ? resolveNodes(selectedOption.nodes, document) : resolveNodes(selectedEntry!.nodes, selectedEntry!);
        choice.resolvedValue = value;
      }
      if (output.length + value.length > DYNAMIC_PROMPT_LIMITS.output) fail(`Resolved prompt exceeds ${DYNAMIC_PROMPT_LIMITS.output} characters`, node, document);
      output += value;
    }
    return output;
  }
  return { resolved: resolveNodes(prepared.root.nodes, prepared.root), choices };
}

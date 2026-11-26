/**
 * Reads wildcard files people share: .txt (one choice per line, the file path is the list name),
 * Dynamic Prompts style .yaml packs (nested keys become folder/list names) and .json.
 * Pure text in, lists out. Nothing here touches the disk.
 */
export const WILDCARD_FILE_TYPES = ['txt', 'yaml', 'yml', 'json'] as const;
export const WILDCARD_FILE_LIMIT = 8 * 1024 * 1024;

export interface WildcardImport {
  lists: Record<string, string[]>;
  skipped: string[];
}

/** "My Pack/Hair Colors.txt" -> "My_Pack/Hair_Colors". Empty when nothing usable is left. */
export function wildcardNameFromPath(path: string): string {
  const segments = path
    .replace(/\\/g, '/')
    .replace(/\.(txt|ya?ml|json)$/i, '')
    .split('/')
    .map(segment =>
      segment
        .trim()
        .replace(/\s+/g, '_')
        .replace(/[^A-Za-z0-9_.-]/g, '')
        .replace(/^[^A-Za-z0-9]+/, ''),
    )
    .filter(segment => segment && segment !== '.' && segment !== '..');
  return segments.join('/').slice(0, 128).replace(/\/+$/, '');
}

const cleanLines = (lines: Iterable<unknown>) =>
  [...lines]
    .map(line => (typeof line === 'string' ? line : typeof line === 'number' ? String(line) : ''))
    .map(line => line.replace(/\r$/, '').trimEnd())
    .filter(line => line.trim());

function flatten(value: unknown, name: string, out: Record<string, string[]>) {
  if (Array.isArray(value)) {
    const nested = value.filter(item => item && typeof item === 'object');
    const lines = cleanLines(value.filter(item => !item || typeof item !== 'object'));
    if (lines.length && name) out[name] = [...(out[name] ?? []), ...lines];
    for (const item of nested) flatten(item, name, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const childName = wildcardNameFromPath(name ? `${name}/${key}` : key);
      if (childName) flatten(child, childName, out);
    }
  } else if (typeof value === 'string' || typeof value === 'number') {
    const lines = cleanLines([value]);
    if (lines.length && name) out[name] = [...(out[name] ?? []), ...lines];
  }
}

const unquote = (text: string) => {
  const value = text.trim();
  if (value.length >= 2 && value[0] === '"' && value.at(-1) === '"')
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  if (value.length >= 2 && value[0] === "'" && value.at(-1) === "'") return value.slice(1, -1).replace(/''/g, "'");
  return value;
};
/** Drops a trailing "# comment" that sits outside quotes. */
function stripComment(line: string) {
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  return line;
}
function flowList(text: string): string[] {
  const inner = text.trim().slice(1, -1);
  const items: string[] = [];
  let quote = '';
  let current = '';
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ',') {
      items.push(unquote(current));
      current = '';
    } else current += char;
  }
  if (current.trim()) items.push(unquote(current));
  return items.filter(item => item);
}
/** Finds "key: value" outside quotes; a colon must be followed by a space or the line end. */
function splitKey(content: string): [string, string] | undefined {
  let quote = '';
  for (let index = 0; index < content.length; index++) {
    const char = content[index];
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ':' && (index + 1 === content.length || content[index + 1] === ' '))
      return [unquote(content.slice(0, index)), content.slice(index + 1).trim()];
  }
  return undefined;
}

/** Just enough YAML for wildcard packs: nested keys, "- item" lists, [a, b] lists and quoted text. */
export function parseWildcardYaml(text: string): unknown {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map(raw => stripComment(raw.replace(/\t/g, '  ')))
    .filter(line => line.trim() && !/^\s*(---|\.\.\.)\s*$/.test(line))
    .map(line => ({ indent: line.length - line.trimStart().length, content: line.trim() }));
  let at = 0;
  const scalar = (value: string): unknown =>
    value.startsWith('[') && value.endsWith(']') ? flowList(value) : /^[|>][+-]?$/.test(value) ? '' : unquote(value);
  function block(indent: number): unknown {
    if (at >= lines.length) return null;
    const isList = lines[at].content === '-' || lines[at].content.startsWith('- ');
    if (isList) {
      const items: unknown[] = [];
      while (at < lines.length && lines[at].indent === indent && /^-( |$)/.test(lines[at].content)) {
        const rest = lines[at].content.slice(1).trim();
        at++;
        if (!rest) {
          if (at < lines.length && lines[at].indent > indent) items.push(block(lines[at].indent));
        } else items.push(scalar(rest));
      }
      return items;
    }
    const map: Record<string, unknown> = {};
    while (at < lines.length && lines[at].indent === indent) {
      const pair = splitKey(lines[at].content);
      at++;
      if (!pair) continue;
      const [key, rest] = pair;
      if (rest) map[key] = scalar(rest);
      else if (at < lines.length && lines[at].indent > indent) map[key] = block(lines[at].indent);
      else if (at < lines.length && lines[at].indent === indent && /^-( |$)/.test(lines[at].content))
        map[key] = block(indent);
      else map[key] = null;
    }
    return map;
  }
  const result = block(lines[0]?.indent ?? 0);
  return result;
}

/** One file's lists. `path` is where it sits inside the folder picked (or just its file name). */
export function parseWildcardFile(path: string, text: string): WildcardImport {
  const extension = /\.([a-z]+)$/i.exec(path)?.[1].toLowerCase();
  const lists: Record<string, string[]> = {};
  try {
    if (extension === 'txt') {
      const name = wildcardNameFromPath(path);
      const lines = cleanLines(text.replace(/^﻿/, '').split(/\r?\n/));
      if (name && lines.length) lists[name] = lines;
    } else if (extension === 'json' || extension === 'yaml' || extension === 'yml') {
      const data = extension === 'json' ? (JSON.parse(text.replace(/^﻿/, '')) as unknown) : parseWildcardYaml(text);
      // A file holding a bare list is named after the file; a file of keys names lists by key.
      const base = Array.isArray(data)
        ? wildcardNameFromPath(path)
        : wildcardNameFromPath(path.replace(/[^/\\]+$/, ''));
      flatten(data, base, lists);
    } else return { lists, skipped: [path] };
  } catch {
    return { lists: {}, skipped: [path] };
  }
  return Object.keys(lists).length ? { lists, skipped: [] } : { lists, skipped: [path] };
}

/** Puts several files together; a list named twice keeps all its lines. */
export function mergeWildcardImports(imports: readonly WildcardImport[]): WildcardImport {
  const lists: Record<string, string[]> = {};
  const skipped: string[] = [];
  for (const item of imports) {
    skipped.push(...item.skipped);
    for (const [name, lines] of Object.entries(item.lists)) lists[name] = [...(lists[name] ?? []), ...lines];
  }
  return { lists, skipped };
}

/** Each list as a .txt file at its own path ("clothes/tops" -> "clothes/tops.txt"). */
export function wildcardExportFiles(entries: Record<string, readonly string[]>): { path: string; text: string }[] {
  return Object.keys(entries)
    .sort()
    .flatMap(name => {
      const safe = wildcardNameFromPath(name);
      return safe ? [{ path: `${safe}.txt`, text: entries[name].join('\n') + '\n' }] : [];
    });
}

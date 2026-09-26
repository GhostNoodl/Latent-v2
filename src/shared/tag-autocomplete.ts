export type TagSource = 'both' | 'e621' | 'danbooru' | 'off';
export interface TagEntry { name: string; aliases: string[]; count: number; source: 'e621' | 'danbooru' }
export interface TagSuggestion { name: string; count: number; sources: string[]; alias?: string }
export interface TagToken { start: number; end: number; query: string }

/** Complete the comma-delimited tag at the caret, retaining prompt weights. */
export function tagToken(value: string, caret: number, selectionEnd = caret): TagToken | undefined {
  if (caret !== selectionEnd) return;
  let start = caret; let end = caret;
  while (start > 0 && !',\n'.includes(value[start - 1])) start--;
  while (end < value.length && !',\n'.includes(value[end])) end++;
  const segment = value.slice(start, end);
  if (/[{}<>|]/.test(segment) || segment.includes('__')) return;
  const prefix = segment.match(/^\s*[([]*\s*/)?.[0] ?? '';
  start += prefix.length;
  end -= value.slice(start, end).match(/\s*$/)?.[0].length ?? 0;
  const wrappers = [...prefix].filter(c => c === '(' || c === '[');
  for (const opener of wrappers) {
    if (value[end - 1] === (opener === '(' ? ')' : ']') && value[end - 2] !== '\\') end--;
  }
  if (wrappers.length) end -= value.slice(start, end).match(/:[+-]?[\d.]+$/)?.[0].length ?? 0;
  if (caret < start || caret > end) return;
  const query = value.slice(start, caret).replace(/\\([()])/g, '$1').trim().toLowerCase().replace(/\s+/g, '_');
  if (query.length < 2 || query.length > 80) return;
  return { start, end, query };
}

export function insertTag(value: string, token: TagToken, name: string) {
  // Literal tag parentheses must not become Comfy prompt emphasis syntax.
  const text = name.replace(/[()]/g, '\\$&');
  let tail = value.slice(token.end);
  let caret = token.start + text.length;
  if (!tail.trim()) { tail = ', '; caret += 2; }
  else if (/^(?::[+-]?[\d.]+)?[)\]]+\s*$/.test(tail)) { tail = tail.trimEnd() + ', '; caret += tail.length; }
  return { value: value.slice(0, token.start) + text + tail, caret };
}

export function parseTagCsv(csv: string, source: TagEntry['source']): TagEntry[] {
  const result: TagEntry[] = [];
  for (const line of csv.split(/\r?\n/)) {
    // Upstream format: canonical name, category, post count, quoted aliases.
    const match = line.match(/^([^,]+),\d+,(\d+)(?:,(.*))?$/);
    if (!match) continue;
    const aliases = (match[3] ?? '').replace(/^"|"$/g, '').replace(/""/g, '"').split(',').filter(Boolean);
    result.push({ name: match[1], count: Number(match[2]), source, aliases });
  }
  return result;
}

export function searchTags(entries: TagEntry[], query: string, source: TagSource, limit = 12): TagSuggestion[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, '_');
  if (source === 'off' || q.length < 2 || q.length > 80) return [];
  const matches = new Map<string, TagSuggestion & { rank: number }>();
  const rank = (value: string) => { const s = value.toLowerCase(); return s === q ? 0 : s.startsWith(q) ? 1 : s.includes('_' + q) ? 2 : s.includes(q) ? 3 : 9; };
  for (const entry of entries) {
    if (source !== 'both' && source !== entry.source) continue;
    let score = rank(entry.name); let alias: string | undefined;
    for (const candidate of entry.aliases) { const r = rank(candidate) + 0.5; if (r < score) { score = r; alias = candidate; } }
    if (score >= 9) continue;
    const prior = matches.get(entry.name);
    if (prior) { prior.count = Math.max(prior.count, entry.count); if (!prior.sources.includes(entry.source)) prior.sources.push(entry.source); if (score < prior.rank) { prior.rank = score; prior.alias = alias; } }
    else matches.set(entry.name, { name: entry.name, count: entry.count, sources: [entry.source], alias, rank: score });
  }
  return [...matches.values()].sort((a, b) => a.rank - b.rank || b.count - a.count || a.name.localeCompare(b.name)).slice(0, limit).map(({ rank: _, ...entry }) => entry);
}

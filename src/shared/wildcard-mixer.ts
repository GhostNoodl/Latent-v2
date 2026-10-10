import { parseDynamicPrompt } from './dynamic-prompts';

/** Only manage top-level references; never rewrite choices or escaped literals. */
export function activeWildcardNames(prompt: string): Set<string> {
  return new Set(parseDynamicPrompt(prompt).nodes.flatMap(node => node.kind === 'wildcard' ? [node.tag] : []));
}

export function mixWildcardPrompt(prompt: string, enabled: ReadonlySet<string>, managed: ReadonlySet<string>): string {
  const nodes = parseDynamicPrompt(prompt).nodes;
  let result = prompt;
  for (const node of [...nodes].reverse()) {
    if (node.kind !== 'wildcard' || !managed.has(node.tag) || enabled.has(node.tag)) continue;
    let start = node.start, end = node.end;
    const following = /^\s*,\s*/.exec(result.slice(end));
    const preceding = /,\s*$/.exec(result.slice(0,start));
    if (following) end += following[0].length;
    else if (preceding) start -= preceding[0].length;
    result = result.slice(0,start) + result.slice(end);
  }
  const existing = activeWildcardNames(result);
  for (const name of enabled) if (!existing.has(name)) result += `${result.trim() ? ', ' : ''}__${name}__`;
  return result;
}

import type { ComfyWorkflow } from './types';

/**
 * Returns an `add(class_type, inputs)` that appends nodes to `graph` with fresh numeric ids,
 * starting after the highest numeric id (and after `floor`) and never reusing an existing id.
 * Every workflow builder shares this so id allocation cannot drift between them.
 */
export function nodeAllocator(graph: ComfyWorkflow, floor = 0) {
  let next =
    Math.max(
      floor,
      ...Object.keys(graph)
        .filter(id => /^\d+$/.test(id))
        .map(Number),
    ) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('Workflow node identifiers are invalid.');
  return (class_type: string, inputs: ComfyWorkflow[string]['inputs']): string => {
    while (graph[String(next)]) next += 1;
    const id = String(next++);
    graph[id] = { class_type, inputs };
    return id;
  };
}

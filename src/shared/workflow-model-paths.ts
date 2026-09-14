import type { ComfyWorkflow } from './types';

const modelInputs: Record<string, string> = { CheckpointLoaderSimple: 'ckpt_name', LoraLoader: 'lora_name' };
type Objects = Record<string, { input?: { required?: Record<string, unknown[]> } }>;

/** Recipes use portable separators; Comfy's dropdown values use host separators. */
export function canonicalModelPaths(workflow: ComfyWorkflow): ComfyWorkflow {
  const result = structuredClone(workflow);
  for (const node of Object.values(result)) {
    const field = modelInputs[node.class_type];
    if (field && typeof node.inputs[field] === 'string') node.inputs[field] = node.inputs[field].replaceAll('\\', '/');
  }
  return result;
}

/** Bind only known model filename fields, never general enum or prompt values. */
export function bindModelPaths(workflow: ComfyWorkflow, objects: Objects): ComfyWorkflow {
  const result = canonicalModelPaths(workflow);
  for (const node of Object.values(result)) {
    const field = modelInputs[node.class_type];
    if (!field || typeof node.inputs[field] !== 'string') continue;
    const definition = objects[node.class_type]?.input?.required?.[field];
    const choices = definition?.[0] === 'COMBO' ? (definition[1] as { options?: unknown[] } | undefined)?.options : definition?.[0];
    if (!Array.isArray(choices)) continue; // General capability validation handles other definitions.
    const matches = choices.filter(value => typeof value === 'string' && value.replaceAll('\\', '/') === node.inputs[field]);
    if (matches.length !== 1) throw new Error(`The engine does not offer one unambiguous ${String(node.inputs[field])} for ${node.class_type}.${field}. Refresh models and try again.`);
    node.inputs[field] = matches[0] as string;
  }
  return result;
}

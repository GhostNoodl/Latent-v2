import type { GenerationRecord } from '../shared/types';

/** The image collection that Review's Keep adds to. */
export const KEEPERS = 'Keepers';

export interface LibraryFilters {
  /** Checkpoint filename, or 'none' for images made without one (edits, resizes). */
  model?: string;
  /** LoRA filename, or 'none' for images made without any. */
  lora?: string;
  kept?: boolean;
}

export interface Facet {
  key: string;
  label: string;
  count: number;
}

const modelKey = (record: GenerationRecord) => record.checkpoint?.filename ?? 'none';

/** Every model and LoRA used in the library, most used first. */
export function libraryFacets(records: GenerationRecord[]) {
  const models = new Map<string, Facet>();
  const loras = new Map<string, Facet>();
  const bump = (map: Map<string, Facet>, key: string, label: string) => {
    const item = map.get(key) ?? { key, label, count: 0 };
    item.count += 1;
    map.set(key, item);
  };
  for (const record of records) {
    bump(models, modelKey(record), record.checkpoint?.name ?? (record.qwenEdit ? 'Image edits' : 'No model (resize)'));
    for (const lora of new Map((record.loras ?? []).map(item => [item.filename, item])).values())
      bump(loras, lora.filename, lora.name);
  }
  const order = (map: Map<string, Facet>) =>
    [...map.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  return { models: order(models), loras: order(loras) };
}

export function matchesFilters(record: GenerationRecord, filters: LibraryFilters, keptIds: Set<string>) {
  if (filters.model && modelKey(record) !== filters.model) return false;
  if (filters.lora === 'none' && (record.loras ?? []).length) return false;
  if (filters.lora && filters.lora !== 'none' && !(record.loras ?? []).some(lora => lora.filename === filters.lora))
    return false;
  if (filters.kept && !keptIds.has(record.id)) return false;
  return true;
}

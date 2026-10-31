import type { GenerationRecord } from '../shared/types';

export interface LineageStep {
  record: GenerationRecord;
  /** How the next image in the trail was made from this one. */
  how: string;
}

/** The image this one was made from (outside its own hires / face-fix versions), and how. */
export function madeFrom(
  record: GenerationRecord,
  byId: Map<string, GenerationRecord>,
): { parent: GenerationRecord; how: string } | undefined {
  const links: Array<[string | undefined, string]> = [
    [record.qwenEdit ? record.imageInput?.source.originGenerationId : undefined, 'Edited'],
    [record.draft.enhance?.parentRecordId, 'Enhanced'],
    [record.draft.autoFaceParentRecordId, 'Face fix'],
    [record.draft.variationOfRecordId, 'Variation'],
    [record.imageInput?.source.originGenerationId, record.imageInput?.mask ? 'Inpainted' : 'Image to image'],
  ];
  for (const [id, how] of links) {
    const parent = id && id !== record.id ? byId.get(id) : undefined;
    if (parent) return { parent, how };
  }
  return undefined;
}

/** Oldest ancestor first, ending with the record itself. Stops at 8 steps or a loop. */
export function lineage(record: GenerationRecord, records: GenerationRecord[]): LineageStep[] {
  const byId = new Map(records.map(item => [item.id, item]));
  const trail: LineageStep[] = [{ record, how: '' }];
  const seen = new Set([record.id]);
  let current = record;
  while (trail.length < 8) {
    const link = madeFrom(current, byId);
    if (!link || seen.has(link.parent.id)) break;
    seen.add(link.parent.id);
    trail.unshift({ record: link.parent, how: link.how });
    current = link.parent;
  }
  return trail;
}

/** Images made directly from this one. */
export function madeFromThis(record: GenerationRecord, records: GenerationRecord[]) {
  const byId = new Map(records.map(item => [item.id, item]));
  return records.filter(item => item.id !== record.id && madeFrom(item, byId)?.parent.id === record.id);
}

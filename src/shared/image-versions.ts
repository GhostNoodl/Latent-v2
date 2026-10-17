import type { AppSettings, GenerationRecord } from './types';

export type ImageVersionSettings = NonNullable<AppSettings['imageVersions']>;
export const DEFAULT_IMAGE_VERSIONS: ImageVersionSettings = {
  group: true,
  showOriginal: false,
  showRefined: false,
  showFaceSteps: false,
};

/** Where a record sits in one image's pipeline: the first render, the hires result, or a face fix. */
export type ImageVersionStage = 'original' | 'refined' | 'face';

type VersionRecord = Pick<
  GenerationRecord,
  'id' | 'jobId' | 'createdAt' | 'outputRole' | 'outputBatchIndex' | 'baseRecordId' | 'facePass' | 'advancedImage'
>;

export function imageVersionStage(record: VersionRecord): ImageVersionStage {
  if (record.facePass) return 'face';
  if (record.outputRole === 'final' && record.advancedImage?.hires) return 'refined';
  return 'original';
}

export function imageVersionLabel(record: VersionRecord): string {
  if (record.facePass) return record.outputRole === 'final' ? 'Face fix' : `Face fix step ${record.facePass.index + 1}`;
  if (record.outputRole === 'base') return 'Original';
  if (record.outputRole === 'final' && record.advancedImage?.hires) return 'Hires fix';
  return 'Original';
}

/** The record this one was made from inside the same pipeline, if it is still in history. */
function versionParent<T extends VersionRecord>(record: T, byId: Map<string, T>, records: readonly T[]) {
  if (record.facePass) {
    if (record.facePass.parentRecordId) return byId.get(record.facePass.parentRecordId);
    // Later face passes are linked once their job finishes; until then their sibling pass is the parent.
    if (record.facePass.index > 0)
      return records.find(item => item.jobId === record.jobId && item.facePass?.index === record.facePass!.index - 1);
    return undefined;
  }
  if (record.outputRole === 'final' && record.advancedImage?.hires) {
    if (record.baseRecordId) return byId.get(record.baseRecordId);
    return records.find(
      item =>
        item.jobId === record.jobId && item.outputRole === 'base' && item.outputBatchIndex === record.outputBatchIndex,
    );
  }
  return undefined;
}

export interface ImageVersionGroup<T> {
  /** The card shown for the whole group: the newest image that nothing else was made from. */
  lead: T;
  /** Every version, oldest pipeline stage first. */
  versions: T[];
}

const groupCache = new WeakMap<readonly VersionRecord[], ImageVersionGroup<VersionRecord>[]>();

/** Groups history (newest first) into one entry per generated image and its hires / face-fix versions.
 * Results are cached per history array, so callers can group on every render. */
export function groupImageVersions<T extends VersionRecord>(records: readonly T[]): ImageVersionGroup<T>[] {
  const cached = groupCache.get(records);
  if (cached) return cached as ImageVersionGroup<T>[];
  const groups = buildGroups(records);
  groupCache.set(records, groups);
  return groups;
}

function buildGroups<T extends VersionRecord>(records: readonly T[]): ImageVersionGroup<T>[] {
  const byId = new Map(records.map(record => [record.id, record]));
  const parents = new Map<string, T | undefined>();
  for (const record of records) parents.set(record.id, versionParent(record, byId, records));
  const rootOf = (record: T) => {
    const seen = new Set<string>();
    let current = record;
    while (!seen.has(current.id)) {
      seen.add(current.id);
      const parent = parents.get(current.id);
      if (!parent || parent.id === current.id) break;
      current = parent;
    }
    return current;
  };
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const root = rootOf(record).id;
    groups.set(root, [...(groups.get(root) ?? []), record]);
  }
  const hasChild = new Set([...parents.values()].filter(Boolean).map(parent => parent!.id));
  const depth = (record: T) => {
    let count = 0;
    for (let parent = parents.get(record.id); parent && count < records.length; parent = parents.get(parent.id))
      count += 1;
    return count;
  };
  const result: ImageVersionGroup<T>[] = [];
  for (const members of groups.values()) {
    const leaves = members.filter(record => !hasChild.has(record.id));
    const lead = (leaves.length ? leaves : members).reduce((best, record) =>
      Date.parse(record.createdAt) > Date.parse(best.createdAt) ? record : best,
    );
    const versions = [...members].sort(
      (a, b) => depth(a) - depth(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    result.push({ lead, versions });
  }
  // Keep history's newest-first order, placed where each group's lead sits.
  const position = new Map(records.map((record, index) => [record.id, index]));
  return result.sort((a, b) => position.get(a.lead.id)! - position.get(b.lead.id)!);
}

/** The versions that also get their own tile beside the lead when grouping is on. */
export function separatelyShownVersions<T extends VersionRecord>(
  group: ImageVersionGroup<T>,
  settings: ImageVersionSettings,
): T[] {
  return group.versions.filter(record => {
    if (record.id === group.lead.id) return false;
    const stage = imageVersionStage(record);
    return stage === 'original'
      ? settings.showOriginal
      : stage === 'refined'
        ? settings.showRefined
        : settings.showFaceSteps;
  });
}

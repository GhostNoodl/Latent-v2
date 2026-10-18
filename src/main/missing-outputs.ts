import fs from 'node:fs/promises';
import path from 'node:path';
import type { GenerationRecord } from '../shared/types';

/** Files checked at once during a full pass. */
const CONCURRENCY = 32;

/**
 * Remembers which history images were deleted from disk (Explorer, Recycle Bin) so the
 * gallery and sidebar stop showing them. Records stay in the database, so an image that is
 * restored from the Recycle Bin shows up again on the next check.
 */
export class MissingOutputs {
  private missing = new Set<string>();
  private running?: Promise<boolean>;
  private pendingFull = false;
  private pendingFiles = new Set<string>();
  private shown?: { records: readonly GenerationRecord[]; revision: number; visible: GenerationRecord[] };
  /** Bumps whenever the set of hidden images changes. */
  revision = 0;
  constructor(
    private readonly records: () => readonly GenerationRecord[],
    private readonly fileFor: (record: GenerationRecord) => string,
    private readonly changed: () => void,
  ) {}
  has(id: string): boolean {
    return this.missing.has(id);
  }
  /** The records still on disk. Repeated calls with the same list return the same array. */
  visible(records: readonly GenerationRecord[]): GenerationRecord[] {
    const shown = this.shown;
    if (shown && shown.records === records && shown.revision === this.revision) return shown.visible;
    const visible = records.filter(record => !this.missing.has(record.id));
    this.shown = { records, revision: this.revision, visible };
    return visible;
  }
  /**
   * Re-checks every image file, or only the ones at `files` when the caller knows what changed.
   * Overlapping calls share one pass plus one follow-up.
   */
  refresh(files?: Iterable<string>): Promise<boolean> {
    if (files) for (const file of files) this.pendingFiles.add(key(file));
    else this.pendingFull = true;
    if (this.running) return this.running;
    this.running = (async () => {
      let changed = false;
      while (this.pendingFull || this.pendingFiles.size) {
        const only = this.pendingFull ? undefined : this.pendingFiles;
        this.pendingFull = false;
        this.pendingFiles = new Set();
        changed = (await this.check(only)) || changed;
      }
      return changed;
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async check(only?: ReadonlySet<string>): Promise<boolean> {
    const targets: { id: string; file?: string }[] = [];
    for (const record of this.records()) {
      let file: string | undefined;
      try {
        file = this.fileFor(record);
      } catch {
        file = undefined; // Unresolvable paths are kept visible below.
      }
      if (!only || (file !== undefined && only.has(key(file)))) targets.push({ id: record.id, file });
    }
    const checking = new Set(targets.map(target => target.id));
    // A targeted pass keeps what it was not asked about.
    const next = new Set(only ? [...this.missing].filter(id => !checking.has(id)) : []);
    for (let start = 0; start < targets.length; start += CONCURRENCY) {
      const batch = targets.slice(start, start + CONCURRENCY);
      const present = await Promise.all(batch.map(target => exists(target.file)));
      batch.forEach((target, i) => {
        if (!present[i]) next.add(target.id);
      });
    }
    const changed = next.size !== this.missing.size || [...next].some(id => !this.missing.has(id));
    this.missing = next;
    if (changed) {
      this.revision++;
      this.changed();
    }
    return changed;
  }
}

function key(file: string) {
  const normal = path.resolve(file);
  return process.platform === 'win32' ? normal.toLowerCase() : normal;
}

async function exists(file: string | undefined): Promise<boolean> {
  if (file === undefined) return true;
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    // Only a confirmed absence hides an image; locks or permission hiccups keep it.
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

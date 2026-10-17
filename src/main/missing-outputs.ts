import fs from 'node:fs/promises';
import type { GenerationRecord } from '../shared/types';

/**
 * Remembers which history images were deleted from disk (Explorer, Recycle Bin) so the
 * gallery and sidebar stop showing them. Records stay in the database, so an image that is
 * restored from the Recycle Bin shows up again on the next check.
 */
export class MissingOutputs {
  private missing = new Set<string>();
  private running?: Promise<boolean>;
  private again = false;
  constructor(
    private readonly records: () => GenerationRecord[],
    private readonly fileFor: (record: GenerationRecord) => string,
    private readonly changed: () => void,
  ) {}
  has(id: string): boolean {
    return this.missing.has(id);
  }
  visible(records: GenerationRecord[]): GenerationRecord[] {
    return this.missing.size ? records.filter(record => !this.missing.has(record.id)) : records;
  }
  /** Re-checks every image file; overlapping calls share one pass plus one follow-up. */
  refresh(): Promise<boolean> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      let changed = false;
      do {
        this.again = false;
        changed = (await this.check()) || changed;
      } while (this.again);
      return changed;
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async check(): Promise<boolean> {
    const next = new Set<string>();
    for (const record of this.records()) {
      let present: boolean;
      try {
        await fs.access(this.fileFor(record));
        present = true;
      } catch (error) {
        // Only a confirmed absence hides an image; locks or permission hiccups keep it.
        present = (error as NodeJS.ErrnoException).code !== 'ENOENT';
      }
      if (!present) next.add(record.id);
    }
    const changed = next.size !== this.missing.size || [...next].some(id => !this.missing.has(id));
    this.missing = next;
    if (changed) this.changed();
    return changed;
  }
}

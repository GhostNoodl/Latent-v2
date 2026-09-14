/** Serialize rapid keyboard/click selections so the last explicit choice wins
 * on disk. A failed write is reported to its caller without poisoning later saves. */
export class PreviewSelectionSaver {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly write: (recordId: string) => Promise<void>) {}
  save(recordId: string): Promise<void> {
    const task = this.pending.catch(() => undefined).then(() => this.write(recordId));
    this.pending = task;
    return task;
  }
  async flush(): Promise<void> {
    let pending: Promise<void>;
    do { pending = this.pending; await pending; } while (pending !== this.pending);
  }
}

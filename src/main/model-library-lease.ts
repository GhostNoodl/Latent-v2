/** In-process shared readers and an exclusive structural change. Per-file OS
 * leases still protect publication against other processes in ModelService. */
export class ModelLibraryLease {
  private readers = new Map<symbol, string>();
  private writer?: string;
  status() { return { exclusive: this.writer, readers: [...this.readers.values()] }; }
  async withShared<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (this.writer) throw new Error(`The model library is busy ${this.writer}. Wait for it to finish, then retry.`);
    const token = Symbol(label); this.readers.set(token, label);
    try { return await task(); } finally { this.readers.delete(token); }
  }
  async withExclusive<T>(label: string, task: () => Promise<T>): Promise<T> {
    if (this.writer || this.readers.size) throw new Error(`The model library is busy ${this.writer ?? [...this.readers.values()][0]}. Finish that work, then retry the folder change.`);
    this.writer = label;
    try { return await task(); } finally { this.writer = undefined; }
  }
}
const libraries = new Map<string, ModelLibraryLease>();
export function modelLibraryLease(root: string) {
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  let lease = libraries.get(key); if (!lease) { lease = new ModelLibraryLease(); libraries.set(key, lease); }
  return lease;
}

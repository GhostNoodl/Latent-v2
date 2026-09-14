import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** Windows can briefly lock extracted binaries. Permanent errors still fail. */
export async function renameAssistantFile(source: string, destination: string, signal?: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { await fs.promises.rename(source, destination); return; }
    catch (error) {
      if (attempt >= 7 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await delay(Math.min(100 * 2 ** attempt, 1000), undefined, { signal });
    }
  }
}

/** Keep the previous directory available if activation fails or is cancelled. */
export async function activateAssistantRuntime(stage: string, destination: string, signal: AbortSignal, commit: () => Promise<void> = async () => {}): Promise<void> {
  const staged = await fs.promises.lstat(stage);
  if (!staged.isDirectory() || staged.isSymbolicLink()) throw new Error('Assistant staging must be a real directory.');
  let previous: string | undefined;
  try {
    const existing = await fs.promises.lstat(destination);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Assistant runtime must be a real directory.');
    previous = `${destination}.previous-${randomUUID()}`;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (previous) await renameAssistantFile(destination, previous, signal);
  let activated = false;
  try {
    await renameAssistantFile(stage, destination, signal); activated = true;
    signal.throwIfAborted(); await commit();
  }
  catch (error) {
    // Restoration must finish even when the user cancelled installation.
    try {
      if (activated) await renameAssistantFile(destination, stage);
      if (previous) await renameAssistantFile(previous, destination);
    } catch (restoreError) { throw new AggregateError([error, restoreError], `Assistant activation failed. Runtime files are preserved at ${stage}${previous ? ` and ${previous}` : ''}; restoration also failed.`); }
    throw error;
  }
}

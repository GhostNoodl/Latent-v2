import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppPaths } from '../shared/types';
import { assistantHash, type AssistantAsset } from './assistant-download';
import { containedPath, validateRuntimePaths } from './runtime-config';

/** Called only by an explicit repair while the owning service is stopped. */
export async function preserveChangedReviewedAsset(paths: AppPaths, filename: string, asset: Pick<AssistantAsset, 'bytes' | 'sha256'>, signal: AbortSignal): Promise<string | undefined> {
  const validate = () => {
    validateRuntimePaths(paths); containedPath(storageBoundary(paths, filename), filename);
    for (let current = path.resolve(filename); current !== storageBoundary(paths, filename); current = path.dirname(current)) {
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Repair cannot follow a symbolic link or junction. The existing file was preserved.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  };
  signal.throwIfAborted(); validate();
  const stat = await fs.promises.lstat(filename).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (!stat) return;
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('Repair requires an independent regular file. The existing file was preserved.');
  if (stat.size === asset.bytes && await assistantHash(filename, signal) === asset.sha256) return;
  signal.throwIfAborted(); validate();
  const current = await fs.promises.lstat(filename);
  if (current.dev !== stat.dev || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.nlink !== 1) throw new Error('The file changed during repair inspection. Retry after other file operations finish.');
  const preserved = `${filename}.preserved-${randomUUID()}`;
  await fs.promises.rename(filename, preserved);
  return preserved;
}

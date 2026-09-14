import fs from 'node:fs/promises';
import { inside } from './paths';

/** Windows can virtualize a packaged launcher's paths; Explorer needs the physical location. */
export async function privateShellPath(root: string, filename: string): Promise<string> {
  if (!inside(root, filename)) throw new Error('This location is outside the private studio.');
  const [physicalRoot, physicalFile, stat] = await Promise.all([fs.realpath(root), fs.realpath(filename), fs.lstat(filename)]);
  if (stat.isSymbolicLink() || !inside(physicalRoot, physicalFile)) throw new Error('This location is outside the private studio.');
  return physicalFile;
}

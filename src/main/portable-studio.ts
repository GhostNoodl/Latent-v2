import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createPaths } from './paths';

export const PORTABLE_STUDIO_FILENAME = 'Latent-v2-studio.json';
const pointerSchema = z.object({ schema: z.literal(1), appId: z.literal('studio.latent.v2'), root: z.string().min(1).max(2048) }).strict();
const markerSchema = z.object({ application: z.literal('latent-v2'), schema: z.literal(1) }).strict();
type Options = { isPackaged: boolean; defaultRoot: string; env: NodeJS.ProcessEnv };

function noLinkedAncestors(filename: string) {
  let current = path.resolve(filename);
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Linked studio or portable paths are not supported: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function boundedJson(filename: string): unknown {
  noLinkedAncestors(filename);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error(`Expected a small, unlinked metadata file: ${filename}`);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function markedRoot(root: string) {
  if (!path.isAbsolute(root) || root.includes('\0') || path.resolve(root) === path.parse(root).root) throw new Error('The saved studio root must be an absolute studio folder.');
  noLinkedAncestors(root);
  if (!fs.lstatSync(root).isDirectory()) throw new Error('The saved studio folder is unavailable.');
  markerSchema.parse(boundedJson(path.join(root, '.latentv2-root.json')));
  const physical = fs.realpathSync.native(root);
  // A saved pointer is already physical. Do not silently reinterpret an alias on a later launch.
  if (path.relative(physical, path.resolve(root)) !== '') throw new Error('The saved studio path is no longer its original physical location.');
  noLinkedAncestors(physical);
  return physical;
}

/** The portable wrapper's location persists; its extracted Electron directory does not. */
export function createStartupPaths({ isPackaged, defaultRoot, env }: Options) {
  // Explicit test/user overrides never read, create or repin a portable pointer.
  if (env.LATENT_DATA_ROOT) return createPaths(env.LATENT_DATA_ROOT);
  if (!isPackaged || (!env.PORTABLE_EXECUTABLE_FILE && !env.PORTABLE_EXECUTABLE_DIR)) return createPaths(defaultRoot);
  const executable = env.PORTABLE_EXECUTABLE_FILE;
  const folder = env.PORTABLE_EXECUTABLE_DIR || (executable && path.dirname(executable));
  if (!folder || !path.isAbsolute(folder) || (executable && (!path.isAbsolute(executable) || path.relative(folder, path.dirname(executable)) !== ''))) throw new Error('The portable launcher location is invalid or inconsistent.');
  noLinkedAncestors(folder);
  if (!fs.lstatSync(folder).isDirectory()) throw new Error('The portable launcher folder is unavailable.');
  const pointerFile = path.join(fs.realpathSync.native(folder), PORTABLE_STUDIO_FILENAME);
  try {
    let existing = false;
    try { fs.lstatSync(pointerFile); existing = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) {
      const pointer = pointerSchema.parse(boundedJson(pointerFile));
      return createPaths(markedRoot(pointer.root));
    }
    noLinkedAncestors(defaultRoot);
    // Validate an existing marker before createPaths can add anything to that root.
    if (fs.existsSync(path.join(defaultRoot, '.latentv2-root.json'))) markerSchema.parse(boundedJson(path.join(defaultRoot, '.latentv2-root.json')));
    createPaths(defaultRoot);
    const root = markedRoot(fs.realpathSync.native(defaultRoot));
    fs.writeFileSync(pointerFile, `${JSON.stringify({ schema: 1, appId: 'studio.latent.v2', root }, null, 2)}\n`, { flag: 'wx' });
    return createPaths(root);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot open the portable studio using ${pointerFile}. ${reason} Restore the saved studio location or correct this pointer to an existing marked Latent v2 studio. An explicit LATENT_DATA_ROOT opens a separate location without changing the pointer. No existing pointer has been overwritten.`);
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { assistantHash } from './assistant-download';
import type { ReviewedRuntimeSet } from '../shared/runtime-update-types';
export interface UpdateTreeManifest { files: Array<{ path: string; bytes: number; sha256: string }>; sha256: string; }
const safeRelative = (value: string) => value.length <= 512 && !/[\\:\x00-\x1f]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
export async function safeUpdatePath(root: string, filename: string, missing = true): Promise<string> {
  root = path.resolve(root); filename = path.resolve(filename); const relative = path.relative(root, filename);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Runtime update path escaped its private directory.');
  for (let current = filename; ; current = path.dirname(current)) { try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Runtime updates cannot use symbolic links or junctions.'); } catch (error) { if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } if (current === root) break; }
  return filename;
}
export const updateExists = async (filename: string) => { try { await fs.lstat(filename); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
export async function readUpdateJson<T>(root: string, filename: string): Promise<T | undefined> {
  await safeUpdatePath(root, filename); if (!await updateExists(filename)) return undefined; const stat = await fs.stat(filename); if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || stat.nlink !== 1) throw new Error('Runtime update metadata must be a bounded independent file.'); return JSON.parse(await fs.readFile(filename, 'utf8')) as T;
}
export async function writeUpdateJson(root: string, filename: string, value: unknown): Promise<void> {
  await safeUpdatePath(root, filename); await fs.mkdir(path.dirname(filename), { recursive: true }); const temporary = `${filename}.${randomUUID()}.tmp`; const file = await fs.open(temporary, 'wx');
  try { const json = JSON.stringify(value, null, 2); if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error('Runtime update metadata exceeded its size bound.'); await file.writeFile(json); await file.sync(); } finally { await file.close(); }
  await fs.rename(temporary, filename);
}
function manifest(files: UpdateTreeManifest['files']): UpdateTreeManifest {
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0); return { files, sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
export function reviewedArchiveManifest(archive: string, set: ReviewedRuntimeSet): UpdateTreeManifest {
  const prefix = `ComfyUI-${set.backend.commit}/`; const files: UpdateTreeManifest['files'] = []; const seen = new Set<string>(); let size = 0;
  for (const entry of new AdmZip(archive).getEntries()) {
    const name = entry.entryName.replaceAll('\\', '/'); if (!name.startsWith(prefix) || ((entry.attr >>> 16) & 0xf000) === 0xa000) throw new Error('The reviewed source archive has an invalid root or link.');
    const relative = name.slice(prefix.length).replace(/\/$/, ''); if (!relative) continue; if (!safeRelative(relative)) throw new Error('The reviewed source archive contains an unsafe path.'); if (entry.isDirectory) continue;
    if (relative.toLowerCase() === '.latent-source.json' || seen.has(relative.toLowerCase())) throw new Error('The source archive contains colliding Windows filenames.'); seen.add(relative.toLowerCase()); const bytes = entry.getData(); size += bytes.length;
    if (files.length >= 30000 || bytes.length > 64 * 1024 * 1024 || size > 512 * 1024 * 1024) throw new Error('The source archive exceeds the reviewed runtime bounds.'); files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const sourceMarker = JSON.stringify({ commit: set.backend.commit, sha256: set.backend.archiveSha256 }); files.push({ path: '.latent-source.json', bytes: Buffer.byteLength(sourceMarker), sha256: createHash('sha256').update(sourceMarker).digest('hex') }); return manifest(files);
}
export async function inspectUpdateTree(root: string, signal?: AbortSignal): Promise<UpdateTreeManifest> {
  await safeUpdatePath(root, root, false); const files: UpdateTreeManifest['files'] = []; let total = 0;
  async function walk(folder: string, depth: number) {
    if (depth > 32) throw new Error('Runtime source nesting exceeds its limit.');
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      signal?.throwIfAborted(); const filename = path.join(folder, entry.name); await safeUpdatePath(root, filename, false);
      if (entry.name === '__pycache__' || /\.py[co]$/i.test(entry.name)) continue;
      const relative = path.relative(root, filename).replaceAll('\\', '/'); if (!safeRelative(relative)) throw new Error('Runtime source contains an unsafe filename.');
      if (entry.isDirectory()) await walk(filename, depth + 1);
      else if (entry.isFile()) { const stat = await fs.stat(filename); total += stat.size; if (stat.nlink !== 1 || stat.size > 64 * 1024 * 1024 || total > 512 * 1024 * 1024 || files.length >= 30000) throw new Error('Runtime source exceeds its reviewed file bounds or contains linked files.'); files.push({ path: relative, bytes: stat.size, sha256: await assistantHash(filename, signal) }); }
      else throw new Error('Runtime source contains a non-regular entry.');
    }
  }
  await walk(root, 0); return manifest(files);
}
export function assertUpdateTree(actual: UpdateTreeManifest, expected: UpdateTreeManifest, description: string) {
  if (actual.sha256 !== expected.sha256 || JSON.stringify(actual.files) !== JSON.stringify(expected.files)) throw new Error(`${description} differs from its reviewed file set. Its existing files were preserved; review custom changes before updating.`);
}
export async function inspectReviewedCustomNodes(directory: string, set: ReviewedRuntimeSet, signal?: AbortSignal): Promise<UpdateTreeManifest> {
  if (!await updateExists(directory)) return manifest([]); const actual = await inspectUpdateTree(directory, signal); const expected: UpdateTreeManifest['files'] = [];
  const names = new Set((await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.name !== '__pycache__').map(entry => entry.name));
  for (const name of names) { const node = set.optionalCustomNodes.find(item => item.directory === name); if (!node) throw new Error(`Unreviewed custom node “${name}” is preserved. Review or move it outside the managed custom-node directory before updating.`); expected.push(...node.files.map(file => ({ path: `${name}/${file.filename}`, bytes: file.bytes, sha256: file.sha256 }))); }
  assertUpdateTree(actual, manifest(expected), 'Custom-node source'); return actual;
}
export async function copyUpdateTree(from: string, to: string, tree: UpdateTreeManifest, signal?: AbortSignal) {
  await fs.mkdir(to, { recursive: true });
  for (const entry of tree.files) { signal?.throwIfAborted(); if (!safeRelative(entry.path)) throw new Error('Invalid runtime source manifest path.'); const source = await safeUpdatePath(from, path.join(from, entry.path), false); const destination = await safeUpdatePath(to, path.join(to, entry.path)); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL); }
  assertUpdateTree(await inspectUpdateTree(to, signal), tree, 'Staged source');
}

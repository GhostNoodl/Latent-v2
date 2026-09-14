import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppPaths } from '../shared/types';

export type StorageKind = 'models' | 'outputs';
export function within(root: string, target: string) { const relative = path.relative(path.resolve(root), path.resolve(target)); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
function rejectLinks(target: string) {
  for (let current = path.resolve(target); ; current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Storage destinations cannot contain symbolic links or junctions.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (path.dirname(current) === current) break;
  }
}
export function readStorageLocations(root: string): Partial<Record<StorageKind, string>> {
  const filename = path.join(root, 'storage-locations.json');
  if (!fs.existsSync(filename)) return {};
  rejectLinks(filename);
  if (fs.statSync(filename).size > 8192) throw new Error('Storage location configuration is too large.');
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (value.schema !== 1 || Object.keys(value).some(key => !['schema','models','outputs'].includes(key))) throw new Error('Invalid storage location configuration.');
  const result: Partial<Record<StorageKind, string>> = {};
  for (const kind of ['models','outputs'] as const) if (value[kind] !== undefined) {
    const target = value[kind];
    if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0') || within(target, root) || within(root, target)) throw new Error('An alternate storage directory must be separate from the studio.');
    rejectLinks(target);
    const marker = JSON.parse(fs.readFileSync(path.join(target, '.latent-storage.json'), 'utf8'));
    if (marker.schema !== 1 || marker.kind !== kind || path.resolve(marker.studio) !== path.resolve(root)) throw new Error('Storage directory ownership does not match this studio.');
    result[kind] = path.resolve(target);
  }
  if (result.models && result.outputs && (within(result.models,result.outputs) || within(result.outputs,result.models))) throw new Error('Model and output locations must be separate.');
  return result;
}
/** Main-owned paths plus the explicit on-disk destination registration define the write boundary. */
export function storageBoundary(paths: AppPaths, target: string): string {
  if (within(paths.root, target)) return path.resolve(paths.root);
  const configured = readStorageLocations(paths.root);
  for (const kind of ['models','outputs'] as const) if (configured[kind] === path.resolve(paths[kind]) && within(paths[kind],target)) return path.resolve(paths[kind]);
  throw new Error('This path is outside the studio private paths and registered storage destinations.');
}
async function hash(filename: string) { const digest = createHash('sha256'); for await (const chunk of fs.createReadStream(filename)) digest.update(chunk); return digest.digest('hex'); }

/** Called only while the studio is idle and stopped. Copies are verified; originals are never deleted. */
export async function copyStorageLocation(paths: AppPaths, kind: StorageKind, destination: string): Promise<void> {
  if (!['models','outputs'].includes(kind) || !path.isAbsolute(destination)) throw new Error('Choose an absolute storage destination.');
  const target = path.resolve(destination), source = paths[kind];
  rejectLinks(target);
  if (within(paths.root,target) || within(target,paths.root) || ['models','outputs'].some(key => within(paths[key as StorageKind],target) || within(target,paths[key as StorageKind]))) throw new Error('Choose a separate empty folder outside existing studio storage.');
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error('Choose an empty destination folder.');
  const files: Array<{ relative: string; bytes: number }> = [];
  function visit(directory: string) { rejectLinks(directory); for (const entry of fs.readdirSync(directory,{withFileTypes:true})) { const filename=path.join(directory,entry.name); if (entry.isSymbolicLink()) throw new Error('Storage contains a link; originals were preserved.'); if(entry.isDirectory())visit(filename); else if(entry.isFile() && entry.name !== '.latent-storage.json') files.push({relative:path.relative(source,filename),bytes:fs.statSync(filename).size}); else if(!entry.isFile())throw new Error('Unsupported storage entry.'); } }
  visit(source); fs.mkdirSync(target,{recursive:true}); rejectLinks(target);
  const space = fs.statfsSync(target); if (space.bavail * space.bsize < files.reduce((sum,item)=>sum+item.bytes,0) + 64*1024*1024) throw new Error('Not enough free space to copy and verify this storage.');
  for (const file of files) {
    const from=path.join(source,file.relative), to=path.join(target,file.relative); rejectLinks(from); rejectLinks(to); await fs.promises.mkdir(path.dirname(to),{recursive:true});
    await fs.promises.copyFile(from,to,fs.constants.COPYFILE_EXCL);
    if (fs.statSync(from).size !== file.bytes || await hash(from) !== await hash(to)) throw new Error('A file changed during copying. The original location is still active.');
  }
  fs.writeFileSync(path.join(target,'.latent-storage.json'),JSON.stringify({schema:1,studio:paths.root,kind}),{flag:'wx'});
  const configured=readStorageLocations(paths.root); const filename=path.join(paths.root,'storage-locations.json'), temporary=filename+'.'+randomUUID()+'.tmp';
  fs.writeFileSync(temporary,JSON.stringify({schema:1,...configured,[kind]:target}),{flag:'wx'});
  await fs.promises.rename(temporary,filename);
}

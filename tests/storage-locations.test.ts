import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaths } from '../src/main/paths';
import { copyStorageLocation, storageBoundary } from '../src/main/storage-locations';
import { validateRuntimePaths } from '../src/main/runtime-config';
const roots: string[] = [];
function fixture() { const base=fs.mkdtempSync(path.join(os.tmpdir(),'latent-storage-')); roots.push(base);return {base,paths:createPaths(path.join(base,'studio'))}; }
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
describe('optional storage destinations',()=>{
  it.each(['models','outputs'] as const)('copies %s and reopens from its registered destination while preserving originals',async kind=>{
    const {base,paths}=fixture();const source=path.join(paths[kind],'example.bin');fs.writeFileSync(source,'retained fixture');
    const destination=path.join(base,kind);await copyStorageLocation(paths,kind,destination);
    const reopened=createPaths(paths.root);expect(reopened[kind]).toBe(destination);expect(fs.readFileSync(source,'utf8')).toBe('retained fixture');expect(fs.readFileSync(path.join(destination,'example.bin'),'utf8')).toBe('retained fixture');
    expect(()=>validateRuntimePaths(reopened)).not.toThrow();expect(storageBoundary(reopened,path.join(destination,'nested','file'))).toBe(destination);
    expect(()=>storageBoundary(reopened,path.join(base,'unregistered','file'))).toThrow();
  });
  it('rejects occupied and overlapping locations before modifying the active configuration',async()=>{
    const {base,paths}=fixture();const target=path.join(base,'occupied');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'keep'),'original');
    await expect(copyStorageLocation(paths,'models',target)).rejects.toThrow('empty');await expect(copyStorageLocation(paths,'outputs',paths.models)).rejects.toThrow('separate');
    expect(fs.existsSync(path.join(paths.root,'storage-locations.json'))).toBe(false);expect(fs.readFileSync(path.join(target,'keep'),'utf8')).toBe('original');
  });
  it('does not authorize arbitrary external AppPaths without a matching registry',()=>{
    const {base,paths}=fixture();expect(()=>validateRuntimePaths({...paths,models:path.join(base,'other')})).toThrow();
  });
});

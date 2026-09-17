import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPaths } from '../src/main/paths';
import { StudioStore } from '../src/main/store';
import { ModelService } from '../src/main/models';
import { ModelLocationService } from '../src/main/model-locations';
import { availableModelFilename, cleanModelFilename } from '../src/shared/model-names';
const fixtures: Array<{root:string;store:StudioStore}> = [];
afterEach(async()=>{for(const f of fixtures.splice(0)){f.store.close();await fs.rm(f.root,{recursive:true,force:true});}});
async function fixture() {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'latent-model-files-')),paths=createPaths(root),store=new StudioStore(paths.database);
 fixtures.push({root,store});
 const name='civitai_1_2_3_Example-v2-fp16.safetensors';
 const header=Buffer.from(JSON.stringify({weight:{dtype:'F32',shape:[1],data_offsets:[0,4]}})),length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(header.length));
 const original=path.join(paths.models,'loras',name);await fs.writeFile(original,Buffer.concat([length,header,Buffer.alloc(4)]));
 const models=new ModelService(paths,store,()=>{}),locations=new ModelLocationService(paths,store,models,{assertChangesAllowed:()=>{}});
 await locations.initialize();await models.refresh();
 const asset=models.assets.find(a=>a.filename===name)!;expect(asset.status).toBe('ready');
 return {root,paths,store,models,locations,asset,original};
}
it('cleans IDs while retaining model version and precision, and avoids case-insensitive collisions',()=>{
 expect(cleanModelFilename('civitai_1_2_3_Example-v2-fp16.safetensors')).toBe('Example-v2-fp16.safetensors');
 expect(cleanModelFilename('CON.safetensors')).toBe('model-CON.safetensors');
 expect(availableModelFilename('Example.safetensors','a'.repeat(64),['EXAMPLE.safetensors'])).toBe('Example-aaaaaaaa.safetensors');
});
it('renames without changing identity, hides deliberately removed entries and recognizes restored files',async()=>{
 const f=await fixture(),filename=cleanModelFilename(f.asset.filename);
 await f.locations.moveModel({modelId:f.asset.id,expectedSha256:f.asset.sha256!,destinationFolder:'',filename});await f.models.refresh();
 expect(f.models.assets.find(a=>a.id===f.asset.id)?.filename).toBe(filename);
 expect(f.locations.scanBindings()[0].aliases).toContain(f.asset.filename);
 const recycled=path.join(f.root,'fixture-recycled.safetensors');
 await f.locations.deleteModel({modelId:f.asset.id,expectedSha256:f.asset.sha256!},p=>fs.rename(p,recycled));await f.models.refresh();
 expect(f.models.assets.find(a=>a.id===f.asset.id)).toBeUndefined();
 await fs.rename(recycled,path.join(f.paths.models,'loras',filename));await f.models.refresh();
 expect(f.models.assets.find(a=>a.id===f.asset.id)?.status).toBe('ready');
});
it('preserves files and registry when the recycle operation fails',async()=>{
 const f=await fixture();
 await expect(f.locations.deleteModel({modelId:f.asset.id,expectedSha256:f.asset.sha256!},async()=>{throw Error('Recycle unavailable');})).rejects.toThrow('Recycle unavailable');
 await f.models.refresh();expect(f.models.assets.find(a=>a.id===f.asset.id)?.status).toBe('ready');expect(f.locations.scanBindings()).toHaveLength(0);
});
it('refuses changed bytes and occupied destinations',async()=>{
 const f=await fixture();const occupied=path.join(f.paths.models,'loras','occupied.safetensors');await fs.copyFile(f.original,occupied);
 await expect(f.locations.moveModel({modelId:f.asset.id,expectedSha256:f.asset.sha256!,destinationFolder:'',filename:'occupied.safetensors'})).rejects.toThrow('already exists');
 await fs.appendFile(f.original,'changed');let recycled=false;
 await expect(f.locations.deleteModel({modelId:f.asset.id,expectedSha256:f.asset.sha256!},async()=>{recycled=true;})).rejects.toThrow();expect(recycled).toBe(false);
 expect(await fs.stat(occupied)).toBeTruthy();
});

it('imports NoobAI as an Illustrious-family SDXL derivative despite a generic architecture header',async()=>{
 const f=await fixture();const file=path.join(f.root,'NoobAI-XL-v1.safetensors');
 const header=Buffer.from(JSON.stringify({__metadata__:{'modelspec.architecture':'stable-diffusion-xl-v1-base'},weight:{dtype:'F32',shape:[1],data_offsets:[0,4]}})),length=Buffer.alloc(8);length.writeBigUInt64LE(BigInt(header.length));
 await fs.writeFile(file,Buffer.concat([length,header,Buffer.alloc(4)]));
 await f.models.importFiles([file],'checkpoint');
 expect(f.models.assets.find(a=>a.filename==='NoobAI-XL-v1.safetensors')).toMatchObject({family:'illustrious',status:'ready'});
});

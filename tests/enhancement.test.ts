import { expect, it } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import { buildWorkflow } from '../src/shared/workflow';
import { buildEnhancementWorkflow, enhancementIssue, enhancementSize, prepareEnhancement, validateEnhancementSource } from '../src/shared/enhancement';
import type { GenerationRecord, ModelAsset } from '../src/shared/types';
import type { SourceImageAsset } from '../src/shared/source-types';
const checkpoint:ModelAsset={id:'checkpoint:example.safetensors',name:'Example',filename:'example.safetensors',kind:'checkpoint',family:'illustrious',bytes:100,sha256:'b'.repeat(64),triggers:[],status:'ready'};
const parent={id:'a'.repeat(32),width:1024,height:1024,checkpoint,loras:[],resolvedPrompt:'watercolor, a garden',draft:{...DEFAULT_DRAFT,checkpointId:checkpoint.id,prompt:'__subject__',negativePrompt:'low quality',dynamicPrompts:{enabled:true}},actualSeed:'4',jobId:'original',createdAt:'2026-09-14T00:00:00Z',filename:'original.png',imageUrl:'latent-asset://output/'+ 'a'.repeat(32),workflow:{},workflowVersion:'sdxl-txt2img@1',backendVersion:'test',appVersion:'test',durationMs:1} as GenerationRecord;
const source={id:'src_00000000-0000-0000-0000-000000000001',originGenerationId:parent.id,normalized:{sha256:'c'.repeat(64),width:1024,height:1024}} as SourceImageAsset;
const prepared=()=>prepareEnhancement(parent,source,DEFAULT_DRAFT,1.5,.3);
it('prepares a linked, editable recipe without mutating the original or rerolling its prompt',()=>{
 const before=JSON.stringify(parent),draft=prepared();expect(draft).toMatchObject({width:1536,height:1536,prompt:'watercolor, a garden',variationOfRecordId:parent.id,enhance:{parentRecordId:parent.id},autoTriggers:false,batchSize:1});expect(draft.dynamicPrompts).toBeUndefined();expect(draft.assetHashes?.[checkpoint.id]).toBe(checkpoint.sha256);expect(JSON.stringify(parent)).toBe(before);
});
it('encodes original pixels before latent upscale with one sampler and one save',()=>{
 const draft=prepared(),base=buildWorkflow(draft,[checkpoint],'42','enhance-test');const original=JSON.stringify(base);const graph=buildEnhancementWorkflow(base,draft,'sources/example.png');
 expect(JSON.stringify(base)).toBe(original);expect(Object.values(graph).filter(n=>n.class_type==='SaveImage')).toHaveLength(1);expect(Object.values(graph).filter(n=>n.class_type==='KSampler')).toHaveLength(1);expect(Object.values(graph).some(n=>n.class_type==='ImageScale')).toBe(false);
 const pixels=graph['4'].inputs.pixels as [string,number];expect(graph[pixels[0]].class_type).toBe('LoadImage');const latent=graph['5'].inputs.latent_image as [string,number];expect(graph[latent[0]]).toMatchObject({class_type:'LatentUpscale',inputs:{samples:['4',0],width:1536,height:1536}});expect(graph['5'].inputs.denoise).toBe(.3);
});
it('refuses mismatched parents, source bytes and conflicting workflows',()=>{
 const d=prepared();expect(()=>validateEnhancementSource(d,{...source,originGenerationId:'d'.repeat(32)},[parent])).toThrow('parent');expect(()=>validateEnhancementSource(d,{...source,normalized:{...source.normalized,sha256:'f'.repeat(64)}},[parent])).toThrow('parent');expect(enhancementIssue({...d,batchSize:2})).toContain('one image');expect(enhancementIssue({...d,imageInput:{...d.imageInput!,denoise:0}})).toContain('above zero');expect(()=>buildEnhancementWorkflow(buildWorkflow(d,[checkpoint],'42','test'),d,'../outside.png')).toThrow('safe relative');
});
it('caps output sizes, permits same-size refinement, and rejects unsupported source dimensions',()=>{
 expect(enhancementSize(1024,1024,1)).toEqual({width:1024,height:1024});expect(enhancementSize(1024,1792,2)).toEqual({width:1216,height:2048});expect(()=>enhancementSize(4096,4096,1)).toThrow('2048');
});
it('uses current model choices explicitly when the saved image has no checkpoint',()=>{
 const current={...DEFAULT_DRAFT,checkpointId:checkpoint.id,assetHashes:{[checkpoint.id]:checkpoint.sha256!}};
 const d=prepareEnhancement({...parent,checkpoint:undefined},source,current,1,.2);expect(d.checkpointId).toBe(checkpoint.id);expect(d.assetHashes).toEqual(current.assetHashes);
});

it('leaves Enhance on source removal or workflow changes, preserving ordinary edits and explicit recipe restores',async()=>{
 const {reconcileEnhancementChange}=await import('../src/shared/enhancement');const prior=prepared();
 for(const patch of [{imageInput:undefined},{hiresFix:{width:2048}},{upscale:{mode:'resize'}},{imageInput:{...prior.imageInput!,mode:'inpaint'}},{imageInput:{...prior.imageInput!,sourceId:'different'}}] as Partial<typeof prior>[]){const next={...prior,...reconcileEnhancementChange(prior,patch)};expect(next.enhance).toBeUndefined();expect(next.variationOfRecordId).toBeUndefined();expect(next.prompt).toBe(prior.prompt);expect(next.checkpointId).toBe(prior.checkpointId);}
 expect(reconcileEnhancementChange(prior,{prompt:'edited'})).toEqual({prompt:'edited'});
 expect(reconcileEnhancementChange(prior,{imageInput:{...prior.imageInput!,denoise:.4}}).enhance).toBeUndefined();
 expect(Object.hasOwn(reconcileEnhancementChange(prior,{imageInput:{...prior.imageInput!,denoise:.4}}),'enhance')).toBe(false);
 expect(reconcileEnhancementChange(prior,prior)).toBe(prior);
});

it('one-click refinement uses standard sampling and saved seed without changing legacy replay',async()=>{
 const {prepareOneClickEnhancement,enhancementActionLabel}=await import('../src/shared/enhancement');
 const current={...DEFAULT_DRAFT,autoFace:{profile:'illustrated' as const,strength:.45,classic:true}};
 const before=JSON.stringify(current),d=prepareOneClickEnhancement(parent,source,current);
 expect(d).toMatchObject({width:1536,height:1536,steps:20,sampler:'euler',scheduler:'simple',seed:'4',enhance:{standard:true},autoFace:{classic:true,cfg:7,applyLoras:false}});
 const graph=buildEnhancementWorkflow(buildWorkflow(d,[checkpoint],'4','one-click'),d,'sources/example.png');
 expect(Object.values(graph).some(n=>n.class_type==='LatentUpscale')).toBe(false);
 const pixels=graph['4'].inputs.pixels as [string,number];
 expect(graph[pixels[0]]).toMatchObject({class_type:'ImageScale',inputs:{upscale_method:'lanczos',width:1536,height:1536}});
 expect(graph['5'].inputs.denoise).toBe(.3);
 const legacy={...d,enhance:{parentRecordId:parent.id,standard:true}};
 expect(Object.values(buildEnhancementWorkflow(buildWorkflow(legacy,[checkpoint],'4','legacy-standard'),legacy,'sources/example.png')).find(n=>n.class_type==='LatentUpscale')?.inputs.upscale_method).toBe('nearest-exact');
 expect(Object.values(buildEnhancementWorkflow(buildWorkflow(prepared(),[checkpoint],'42','old'),prepared(),'sources/example.png')).find(n=>n.class_type==='LatentUpscale')?.inputs.upscale_method).toBe('bislerp');
 expect(JSON.stringify(current)).toBe(before);expect(enhancementActionLabel(parent)).toBe('Upscale & refine');expect(enhancementActionLabel({width:2048,height:2048})).toBe('Refine image');
});

it('keeps model sampling overrides when enhancing a saved image',()=>{
 const modelSampling={prediction:'v_prediction' as const,zeroTerminalSnr:true};
 expect(prepareEnhancement({...parent,draft:{...parent.draft,modelSampling}},source,DEFAULT_DRAFT,1.5,.3).modelSampling).toEqual(modelSampling);
});

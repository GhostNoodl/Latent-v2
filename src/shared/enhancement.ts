import type { ComfyWorkflow, GenerationDraft, GenerationRecord } from './types';
import type { SourceImageAsset } from './source-types';
import { DEFAULT_DRAFT } from './defaults';
import { draftSchema } from './validation';
import { augmentImageWorkflow } from './image-workflow';
export function enhancementSize(width:number,height:number,scale:number) {
 if(!Number.isFinite(scale)||scale<1||scale>2||!Number.isInteger(width)||!Number.isInteger(height)||Math.min(width,height)<256||Math.max(width,height)>2048)throw Error('Enhance currently supports source images between 256 and 2048 pixels on each side.');
 const factor=Math.min(scale,2048/width,2048/height);
 return {width:Math.min(2048,Math.ceil(width*factor/64)*64),height:Math.min(2048,Math.ceil(height*factor/64)*64)};
}
export function enhancementIssue(draft:GenerationDraft):string|undefined {
 if(!draft.enhance)return;
 if(!draft.imageInput||draft.imageInput.mode!=='img2img'||draft.imageInput.denoise<=0)return 'Enhance requires its source image and a refinement strength above zero.';
 if(draft.batchSize!==1||draft.hiresFix||draft.upscale||draft.controlNet||draft.qwenEdit||draft.faceDetailer||draft.ipAdapter||draft.regionalPrompts?.settings.enabled||draft.imageInput.crop||draft.imageInput.maskId)return 'Enhance uses one image and one refinement pass. Turn off other image workflows.';
 if(draft.variationOfRecordId!==draft.enhance.parentRecordId)return 'The enhancement must remain linked to its original image.';
}
export function validateEnhancementSource(draft:GenerationDraft,source:SourceImageAsset,records:GenerationRecord[]) {
 const issue=enhancementIssue(draft);if(issue)throw Error(issue);
 const parent=records.find(r=>r.id===draft.enhance?.parentRecordId);
 if(!parent||source.originGenerationId!==parent.id||source.id!==draft.imageInput?.sourceId||source.normalized.sha256!==draft.imageInput.sourceSha256)throw Error('The enhancement source does not match its saved parent image. Start Enhance from that image again.');
 if(source.normalized.width!==parent.width||source.normalized.height!==parent.height)throw Error('The enhancement source dimensions changed. Import the original again.');
 enhancementSize(parent.width,parent.height,1);
 if(draft.width<parent.width||draft.height<parent.height)throw Error('Enhance cannot shrink the original. Choose its size or a larger size.');
}
export function prepareEnhancement(record:GenerationRecord,source:SourceImageAsset,current:GenerationDraft,scale:number,denoise:number):GenerationDraft {
 const size=enhancementSize(record.width,record.height,scale);
 const original=record.checkpoint?record.draft:current;
 const selected=record.checkpoint?record.loras.map(l=>({modelId:l.id,weight:l.weight,clipWeight:l.clipWeight})):structuredClone(current.loras);
 const hashes=record.checkpoint?Object.fromEntries([record.checkpoint,...record.loras].filter(a=>a.sha256).map(a=>[a.id,a.sha256!])):structuredClone(current.assetHashes);
 const result=draftSchema.parse({...DEFAULT_DRAFT,...size,family:original.family,checkpointId:record.checkpoint?.id??current.checkpointId,loras:selected,assetHashes:hashes,prompt:record.resolvedPrompt,negativePrompt:record.dynamicPromptRecipe?.negative.resolved??record.draft.negativePrompt,autoTriggers:false,triggerWords:Object.fromEntries(selected.map(l=>[l.modelId,[]])),steps:18,cfg:original.cfg,sampler:original.sampler,scheduler:original.scheduler,seed:'random',batchSize:1,enhance:{parentRecordId:record.id},variationOfRecordId:record.id,imageInput:{mode:'img2img',sourceId:source.id,sourceSha256:source.normalized.sha256,denoise,resize:'stretch'}});
 validateEnhancementSource(result,source,[record]);return result;
}
/** New recipes resize pixels before encoding; preserve latent scaling for historic recipes. */
export function buildEnhancementWorkflow(workflow:ComfyWorkflow,draft:GenerationDraft,sourceFilename:string):ComfyWorkflow {
 const issue=enhancementIssue(draft);if(!draft.enhance||issue)throw Error(issue??'Missing enhancement recipe.');
 const result=augmentImageWorkflow(workflow,draft,{mode:'img2img',sourceFilename,denoise:draft.imageInput!.denoise,resize:'stretch'});
 if(draft.enhance.method==='image')return result;
 const scaled=(result['4'].inputs.pixels as [string,number])[0];
 result['4'].inputs.pixels=result[scaled].inputs.image;delete result[scaled];
 const node=String(Math.max(...Object.keys(result).map(Number))+1);
 result[node]={class_type:'LatentUpscale',inputs:{samples:['4',0],upscale_method:draft.enhance.standard?'nearest-exact':'bislerp',width:draft.width,height:draft.height,crop:'disabled'}};
 result['5'].inputs.latent_image=[node,0];return result;
}

/** Editing a source/workflow deliberately leaves Enhance; saved recipes are not rewritten. */
export function reconcileEnhancementChange(previous:GenerationDraft, change:Partial<GenerationDraft>):Partial<GenerationDraft> {
 if(!previous.enhance || Object.hasOwn(change,'enhance'))return change;
 const input=change.imageInput;
 const sourceChanged=Object.hasOwn(change,'imageInput') && (!input || input.mode!=='img2img' || input.sourceId!==previous.imageInput?.sourceId || input.sourceSha256!==previous.imageInput?.sourceSha256);
 if(!sourceChanged&&!change.hiresFix&&!change.upscale&&!change.qwenEdit&&!change.faceDetailer)return change;
 return {...change,enhance:undefined,variationOfRecordId:undefined};
}

/** One-click authoring is separate from historical recipe replay. */
export function prepareOneClickEnhancement(record:GenerationRecord,source:SourceImageAsset,current:GenerationDraft):GenerationDraft {
 const next=prepareEnhancement(record,source,current,1.5,.3);
 return draftSchema.parse({...next,steps:20,sampler:'euler',scheduler:'simple',seed:record.actualSeed,enhance:{...next.enhance!,standard:true,method:'image'},imageInput:{...next.imageInput!,denoise:.3},autoFace:current.autoFace?{...current.autoFace,classic:true,steps:current.autoFace.steps??20,cfg:current.autoFace.cfg??7,sampler:current.autoFace.sampler??'euler',scheduler:current.autoFace.scheduler??'normal',applyLoras:current.autoFace.applyLoras??false}:undefined});
}
export function enhancementActionLabel(record:Pick<GenerationRecord,'width'|'height'>):string {
 return Math.max(record.width,record.height)>=2048?'Refine image':'Upscale & refine';
}

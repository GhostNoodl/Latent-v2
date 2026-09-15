import { DEFAULT_DRAFT } from '../shared/defaults';
import { draftSchema } from '../shared/validation';
import { isVideoJob, type GenerationDraft, type GenerationJob, type GenerationRecord, type StudioJob } from '../shared/types';
import type { FaceDetectionReceipt, FaceDetectionRequest } from '../shared/face-detailer-types';
import type { SourceImageAsset } from '../shared/source-types';

type Dependencies = {
 jobs(): StudioJob[]; records(): GenerationRecord[]; save(job: GenerationJob): void;
 ready(): boolean; stopped(): boolean;
 source(record: GenerationRecord): Promise<SourceImageAsset>;
 detect(request: FaceDetectionRequest): Promise<FaceDetectionReceipt>;
 enqueue(draft: GenerationDraft): Promise<GenerationJob>;
};
export function automaticFaceDraft(record: GenerationRecord, detection: FaceDetectionReceipt): GenerationDraft {
 const settings=record.draft.autoFace;
 if(!settings||!record.checkpoint||detection.source.originGenerationId!==record.id||detection.source.width!==record.width||detection.source.height!==record.height) throw Error('The face refinement source does not match its saved image.');
 return draftSchema.parse({...DEFAULT_DRAFT,family:record.draft.family,checkpointId:record.checkpoint.id,
  loras:record.loras.map(l=>({modelId:l.id,weight:l.weight,clipWeight:l.clipWeight})),assetHashes:Object.fromEntries([record.checkpoint,...record.loras].filter(a=>a.sha256).map(a=>[a.id,a.sha256])),
  prompt:record.resolvedPrompt,negativePrompt:record.dynamicPromptRecipe?.negative.resolved??record.draft.negativePrompt,
  autoTriggers:false,triggerWords:Object.fromEntries(record.loras.map(l=>[l.id,[]])),width:512,height:512,steps:20,cfg:record.draft.cfg,sampler:record.draft.sampler,scheduler:record.draft.scheduler,
  seed:record.actualSeed,autoFaceParentRecordId:record.id,variationOfRecordId:record.id,
  faceDetailer:{request:{detectionId:detection.id,faceIds:detection.faces.map(f=>f.id),denoise:settings.strength,contextPadding:32,seed:record.actualSeed}}});
}
/** Called serially by the queue. Durable child lineage repairs a crash between acceptance and parent bookkeeping. */
export async function processAutomaticFace(deps:Dependencies):Promise<void> {
 const jobs=deps.jobs();
 for(const parent of jobs) {
  if(isVideoJob(parent)||parent.status!=='completed'||!parent.draft.autoFace||parent.autoFaceFinished||parent.draft.faceDetailer||parent.draft.autoFaceParentRecordId)continue;
  const records=deps.records().filter(r=>r.jobId===parent.id&&parent.outputIds.includes(r.id)&&(!parent.draft.hiresFix||r.outputRole==='final'));
  if(!records.length){parent.autoFaceFinished=true;deps.save(parent);continue;}
  for(const record of records) {
   if(parent.autoFaceResults?.[record.id])continue;
   const save=(result:NonNullable<GenerationJob['autoFaceResults']>[string])=>{parent.autoFaceResults={...parent.autoFaceResults,[record.id]:result};parent.autoFaceFinished=records.every(r=>Boolean(parent.autoFaceResults?.[r.id]));deps.save(parent);};
   const existing=jobs.find(j=>!isVideoJob(j)&&j.draft.autoFaceParentRecordId===record.id);
   if(existing){save({state:'queued',jobId:existing.id});continue;}
   if(!deps.ready()||deps.stopped())return;
   try {
    const source=await deps.source(record);if(deps.stopped()||!deps.ready())return;
    const detection=await deps.detect({sourceId:source.id,sourceSha256:source.normalized.sha256,profile:parent.draft.autoFace.profile,maxFaces:4,confidence:parent.draft.autoFace.profile==='illustrated'?.5:.7,expansion:.15,feather:12});
    if(deps.stopped())return;
    if(detection.source.id!==source.id||detection.source.sha256!==source.normalized.sha256||detection.source.originGenerationId!==record.id)throw Error('Face detection returned a different source.');
    if(!detection.faces.length){save({state:'skipped',message:'No face found; original kept.'});return;}
    const child=await deps.enqueue(automaticFaceDraft(record,detection));save({state:'queued',jobId:child.id});
   } catch(error) {
    if(deps.stopped())return;
    save({state:'failed',message:`Face refinement could not start; original kept. ${error instanceof Error?error.message:String(error)}`});
   }
   return;
  }
 }
}

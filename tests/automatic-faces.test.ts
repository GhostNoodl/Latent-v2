import { expect, it, vi } from 'vitest';
import { automaticFaceDraft, processAutomaticFace } from '../src/main/automatic-faces';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import type { GenerationDraft, GenerationJob, GenerationRecord, StudioJob } from '../src/shared/types';
import type { FaceDetectionReceipt } from '../src/shared/face-detailer-types';
import type { SourceImageAsset } from '../src/shared/source-types';
import { queueJobPresentation } from '../src/renderer/queue-view';
const id='a'.repeat(32),faceId='11111111-1111-4111-8111-111111111111';
function fixture(){
 const parent={id:'parent',status:'completed',outputIds:[id],draft:{...DEFAULT_DRAFT,autoFace:{profile:'anime',strength:.3}}} as GenerationJob;
 const record={id,jobId:parent.id,width:1024,height:1024,draft:structuredClone(parent.draft),actualSeed:'42',resolvedPrompt:'a garden',checkpoint:{id:'checkpoint:example.safetensors',sha256:'b'.repeat(64)},loras:[]} as unknown as GenerationRecord;
 const source={id:'src_11111111-1111-4111-8111-111111111111',originGenerationId:id,normalized:{sha256:'c'.repeat(64),width:1024,height:1024}} as SourceImageAsset;
 const detection={id:faceId,source:{id:source.id,sha256:source.normalized.sha256,width:1024,height:1024,originGenerationId:id},faces:[{id:faceId}]} as FaceDetectionReceipt;
 const jobs:StudioJob[]=[parent],records=[record];
 const deps={jobs:()=>jobs,records:()=>records,save:vi.fn(),ready:()=>true,stopped:()=>false,source:vi.fn(async(_record:GenerationRecord)=>source),detect:vi.fn(async()=>detection),enqueue:vi.fn(async(draft:GenerationDraft)=>{const child={id:'child',status:'queued',draft} as GenerationJob;jobs.push(child);return child;})};
 return {parent,record,detection,deps,jobs,records};
}
it('creates one linked face follow-up without changing the saved image or rerolling its prompt',async()=>{
 const f=fixture(),before=JSON.stringify(f.record);await processAutomaticFace(f.deps);await processAutomaticFace(f.deps);
 expect(f.deps.enqueue).toHaveBeenCalledTimes(1);const draft=f.deps.enqueue.mock.calls[0][0];expect(draft).toMatchObject({width:512,height:512,prompt:'a garden',autoTriggers:false,seed:'42',autoFaceParentRecordId:id,variationOfRecordId:id,faceDetailer:{request:{denoise:.3,faceIds:[faceId]}}});expect(draft.autoFace).toBeUndefined();expect(JSON.stringify(f.record)).toBe(before);expect(f.parent.status).toBe('completed');
});
it('waits for completion and processes only final hires outputs, once per batch image',async()=>{
 const f=fixture();f.parent.status='running';await processAutomaticFace(f.deps);expect(f.deps.detect).not.toHaveBeenCalled();f.parent.status='completed';f.parent.draft.hiresFix={width:1536,height:1536} as GenerationDraft['hiresFix'];
 f.record.outputRole='base';
 const first={...f.record,id:'d'.repeat(32),outputRole:'final' as const},second={...f.record,id:'e'.repeat(32),outputRole:'final' as const};f.records.push(first,second);f.parent.outputIds.push(first.id,second.id);
 f.deps.source.mockImplementation(async record=>({id:'src_11111111-1111-4111-8111-111111111111',originGenerationId:record.id,normalized:{sha256:'c'.repeat(64),width:1024,height:1024}} as SourceImageAsset));
 f.deps.detect.mockImplementation(async()=>({...f.detection,source:{...f.detection.source,originGenerationId:f.deps.source.mock.calls.at(-1)![0].id}}));
 await processAutomaticFace(f.deps);await processAutomaticFace(f.deps);await processAutomaticFace(f.deps);expect(f.deps.enqueue).toHaveBeenCalledTimes(2);expect(f.deps.source.mock.calls.map(([r])=>r.id)).toEqual([first.id,second.id]);

});
it('repairs an interrupted receipt from durable child lineage without duplicating even a cancelled child',async()=>{
 const f=fixture();await processAutomaticFace(f.deps);delete f.parent.autoFaceResults;delete f.parent.autoFaceFinished;f.jobs[1].status='cancelled';await processAutomaticFace(f.deps);expect(f.deps.enqueue).toHaveBeenCalledTimes(1);expect((f.parent as GenerationJob).autoFaceResults?.[id].jobId).toBe('child');
});
it('keeps the original and records no-face once',async()=>{
 const f=fixture();f.detection.faces=[];await processAutomaticFace(f.deps);await processAutomaticFace(f.deps);expect(f.deps.enqueue).not.toHaveBeenCalled();expect(f.deps.detect).toHaveBeenCalledTimes(1);expect(f.parent.autoFaceResults?.[id].state).toBe('skipped');expect(queueJobPresentation(f.parent).summary).toContain('No face found');expect(f.parent.outputIds).toEqual([id]);
});
it('records a preparation failure without retry loops or failing the parent generation',async()=>{
 const f=fixture();f.deps.detect.mockRejectedValue(Error('Detector unavailable'));await processAutomaticFace(f.deps);await processAutomaticFace(f.deps);expect(f.parent.status).toBe('completed');expect(f.parent.autoFaceResults?.[id].state).toBe('failed');expect(f.deps.detect).toHaveBeenCalledTimes(1);expect(queueJobPresentation(f.parent).summary).toContain('needs attention');expect(queueJobPresentation(f.parent).phase).toContain('Detector unavailable');
});
it('defers busy detection and leaves shutdown-interrupted work available for restart',async()=>{
 const f=fixture();f.deps.ready=()=>false;await processAutomaticFace(f.deps);expect(f.deps.source).not.toHaveBeenCalled();f.deps.ready=()=>true;
 f.deps.detect.mockImplementation(async()=>{f.deps.stopped=()=>true;return f.detection;});await processAutomaticFace(f.deps);expect(f.deps.enqueue).not.toHaveBeenCalled();expect(f.parent.autoFaceResults).toBeUndefined();f.deps.stopped=()=>false;f.deps.detect.mockResolvedValue(f.detection);await processAutomaticFace(f.deps);expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
});
it('rejects mismatched detection identity before accepting a follow-up',async()=>{
 const f=fixture();f.detection.source.sha256='f'.repeat(64);await processAutomaticFace(f.deps);expect(f.deps.enqueue).not.toHaveBeenCalled();expect(f.parent.autoFaceResults?.[id].state).toBe('failed');
});
it('strips hires, enhancement and variation engines from the child and pins model identity',()=>{
 const f=fixture();f.record.draft={...f.record.draft,hiresFix:{width:1536,height:1536} as GenerationDraft['hiresFix'],enhance:{parentRecordId:id},dynamicPrompts:{enabled:true}};
 const child=automaticFaceDraft(f.record,f.detection);expect(child.hiresFix).toBeUndefined();expect(child.enhance).toBeUndefined();expect(child.dynamicPrompts).toBeUndefined();expect(child.assetHashes?.[f.record.checkpoint!.id]).toBe('b'.repeat(64));
});

it('marks removed outputs finished without repeatedly scanning or queueing them',async()=>{const f=fixture();f.records.length=0;await processAutomaticFace(f.deps);expect(f.parent.autoFaceFinished).toBe(true);expect(f.deps.enqueue).not.toHaveBeenCalled();await processAutomaticFace(f.deps);expect(f.deps.save).toHaveBeenCalledTimes(1);});

it('uses the original-detector threshold for automatic illustrated faces',async()=>{
 const f=fixture();f.parent.draft.autoFace!.profile='illustrated';f.record.draft.autoFace!.profile='illustrated';
 await processAutomaticFace(f.deps);expect(f.deps.detect).toHaveBeenCalledWith(expect.objectContaining({profile:'illustrated',confidence:.5}));expect(f.deps.enqueue).toHaveBeenCalledTimes(1);
});

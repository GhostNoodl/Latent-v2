import { expect, it } from 'vitest';
import { withPausedModelEngine } from '../src/main/model-maintenance';
it('stops an idle running engine, changes files, refreshes and restarts in order',async()=>{
 const steps:string[]=[];
 await withPausedModelEngine({status:()=>({state:'ready'}),stop:async()=>{steps.push('stop');}},async()=>{steps.push('change');},async()=>{steps.push('refresh');},async()=>{steps.push('restart');},()=>{steps.push('error');});
 expect(steps).toEqual(['stop','change','refresh','restart']);
});
it('keeps a previously stopped engine stopped',async()=>{
 const steps:string[]=[];
 await withPausedModelEngine({status:()=>({state:'stopped'}),stop:async()=>{steps.push('stop');}},async()=>{steps.push('change');},async()=>{steps.push('refresh');},async()=>{steps.push('restart');},()=>{});
 expect(steps).toEqual(['change','refresh']);
});
it('refreshes after a rejected change and reports restart failure without hiding the original error',async()=>{
 const steps:string[]=[];
 await expect(withPausedModelEngine({status:()=>({state:'ready'}),stop:async()=>{}},async()=>{throw Error('Collision');},async()=>{steps.push('refresh');},async()=>{throw Error('Start failed');},()=>{steps.push('restart error');})).rejects.toThrow('Collision');
 expect(steps).toEqual(['refresh','restart error']);
});
it('does not touch model files when stopping the engine fails',async()=>{
 let touched=false;
 await expect(withPausedModelEngine({status:()=>({state:'ready'}),stop:async()=>{throw Error('Stop failed');}},async()=>{touched=true;},async()=>{},async()=>{},()=>{})).rejects.toThrow('Stop failed');expect(touched).toBe(false);
});

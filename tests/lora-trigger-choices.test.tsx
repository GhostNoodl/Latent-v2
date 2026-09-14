// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { LoraTriggerChoices } from '../src/renderer/LoraTriggerChoices';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import { reconcileVisibleTriggers } from '../src/shared/visible-triggers';
import type { GenerationDraft } from '../src/shared/types';
it('selects optional triggers into visible prompt text and removes only selected additions',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 function Fixture(){const [draft,setDraft]=useState<GenerationDraft>({...DEFAULT_DRAFT,prompt:'a garden',loras:[{modelId:'lora',weight:1,clipWeight:1}]});return <><LoraTriggerChoices words={['watercolor','soft light']} selected={draft.triggerWords?.lora??[]} onChange={words=>setDraft(d=>reconcileVisibleTriggers(d,{...d,triggerWords:{lora:words}}))}/><output>{draft.prompt}</output><button onClick={()=>setDraft(d=>reconcileVisibleTriggers(d,{...d,loras:[]}))}>Remove LoRA</button></>;}
 try{
  await act(async()=>root.render(<Fixture/>));expect(host.querySelector('output')?.textContent).toBe('a garden');
  await act(async()=>(host.querySelector('input') as HTMLInputElement).click());expect(host.querySelector('output')?.textContent).toBe('watercolor, a garden');
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Select all')!.click());expect(host.querySelector('output')?.textContent).toContain('soft light');
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Remove LoRA')!.click());expect(host.querySelector('output')?.textContent).toBe('a garden');
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

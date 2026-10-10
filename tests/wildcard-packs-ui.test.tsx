// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect,it,vi } from 'vitest';
import { DynamicPrompts } from '../src/renderer/DynamicPrompts';
import { createWildcardSnapshot } from '../src/shared/dynamic-prompt-recipe';
it('stages packs in the real editor, requires explicit save, and warns on discarding unsaved additions',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',webcrypto);const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 const existing={starter_species:['my own species']};const snapshot=await createWildcardSnapshot(existing);const save=vi.fn(async(entries:Record<string,string[]>)=>createWildcardSnapshot(entries));
 const button=(text:string)=>[...document.querySelectorAll('button')].find(b=>b.textContent?.trim()===text)!;
 try {await act(async()=>root.render(<DynamicPrompts draft={{prompt:'',negativePrompt:''}} wildcards={snapshot} onChange={()=>{}} onReroll={()=>{}} onSaveWildcards={save}/>));
 await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent?.startsWith('Saved lists'))!.click());await act(async()=>button('Add species').click());expect(save).not.toHaveBeenCalled();expect(document.querySelector('select')!.value).toBe('starter_species_2');expect(document.querySelector('textarea')!.value).toContain('wolf');
 await act(async()=>button('Cancel').click());expect(document.body.textContent).toContain('Unsaved wildcard changes');await act(async()=>button('Keep editing').click());await act(async()=>button('Save wildcard lists').click());expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0][0].starter_species).toEqual(existing.starter_species);expect(save.mock.calls[0][0].starter_species_2).toContain('rabbit');
 }finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

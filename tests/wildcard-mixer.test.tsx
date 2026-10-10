// @vitest-environment jsdom
import {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {WildcardMixer} from '../src/renderer/WildcardMixer';
import {activeWildcardNames,mixWildcardPrompt} from '../src/shared/wildcard-mixer';
import {createWildcardSnapshot,prepareDynamicPromptDraft} from '../src/shared/dynamic-prompt-recipe';

it('adds and removes top-level references without changing nested or escaped text',()=>{
 const prompt='portrait, __species__, {__species__|wolf}, \\__species\\__';
 expect(activeWildcardNames(prompt)).toEqual(new Set(['species']));
 expect(mixWildcardPrompt(prompt,new Set(['lighting']),new Set(['species','lighting']))).toBe('portrait, {__species__|wolf}, \\__species\\__, __lighting__');
 expect(mixWildcardPrompt('__a__, __b__, __c__',new Set(),new Set(['a','b','c']))).toBe('');
 expect(mixWildcardPrompt('portrait, __species__',new Set(['species']),new Set(['species']))).toBe('portrait, __species__');
});

it('applies selected preset choices, preserves custom lists, and resolves the resulting prompt',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const saved=await createWildcardSnapshot({personal:['custom','custom']});
 const onSave=vi.fn(createWildcardSnapshot),onApply=vi.fn(),onClose=vi.fn();
 const click=async(el:Element)=>act(async()=>{(el as HTMLElement).click();});
 try {
  await act(async()=>root.render(<WildcardMixer prompt="portrait" wildcards={saved} onSave={onSave} onApply={onApply} onClose={onClose}/>));
  await click(host.querySelector('[aria-label="Enable Species"]')!);
  await click([...host.querySelectorAll('button')].find(b=>b.textContent==='Deselect shown')!);
  await click([...host.querySelectorAll('.wildcard-choice-grid label')].find(b=>b.textContent==='wolf')!.querySelector('input')!);
  await click([...host.querySelectorAll('button')].find(b=>b.textContent==='Apply to prompt')!);
  expect(onSave.mock.calls[0][0].starter_species).toEqual(['wolf']);
  expect(onSave.mock.calls[0][0].personal).toEqual(['custom','custom']);
  await act(async()=>{await vi.waitFor(()=>expect(onApply).toHaveBeenCalledWith('portrait, __starter_species__'));});
  const result=await prepareDynamicPromptDraft({prompt:onApply.mock.calls[0][0],negativePrompt:'',dynamicPrompts:{enabled:true}},'1',await createWildcardSnapshot(onSave.mock.calls[0][0]));
  expect(result.prompt).toBe('portrait, wolf');expect(onClose).toHaveBeenCalledOnce();
 }finally {await act(async()=>root.unmount());host.remove();}
});

it('keeps the prompt unchanged when saving fails and permits retry',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const saved=await createWildcardSnapshot({starter_species:['wolf']});
 const onSave=vi.fn().mockRejectedValueOnce(Error('Disk unavailable')).mockResolvedValue(saved),onApply=vi.fn();
 try{
  await act(async()=>root.render(<WildcardMixer prompt="__starter_species__" wildcards={saved} onSave={onSave} onApply={onApply} onClose={()=>{}}/>));
  const button=()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Apply to prompt')!;
  await act(async()=>button().click());expect(onApply).not.toHaveBeenCalled();expect(host.textContent).toContain('Disk unavailable');
  await act(async()=>button().click());expect(onApply).toHaveBeenCalledOnce();
 }finally {await act(async()=>root.unmount());host.remove();}
});
it('cancels without saving and rejects enabled categories with no choices',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const saved=await createWildcardSnapshot({starter_species:['wolf']});
 const onSave=vi.fn(),onApply=vi.fn(),onClose=vi.fn();
 const click=async(text:string)=>act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!.click());
 try{
  await act(async()=>root.render(<WildcardMixer prompt="__starter_species__" wildcards={saved} onSave={onSave} onApply={onApply} onClose={onClose}/>));
  await click('Deselect shown');await click('Apply to prompt');
  expect(host.textContent).toContain('Select at least one choice for Species');
  expect(onSave).not.toHaveBeenCalled();expect(onApply).not.toHaveBeenCalled();
  await click('Cancel');expect(onClose).toHaveBeenCalledOnce();expect(onSave).not.toHaveBeenCalled();
 }finally{await act(async()=>root.unmount());host.remove();}
});

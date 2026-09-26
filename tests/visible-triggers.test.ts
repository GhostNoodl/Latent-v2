import { expect, it } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import { reconcileVisibleTriggers } from '../src/shared/visible-triggers';
import { applyTriggerResolutionChange, restoreTriggerResolution } from '../src/shared/trigger-resolution';
import { resolvePrompt } from '../src/shared/workflow';
import { draftSchema } from '../src/shared/validation';
import { prepareDynamicPromptDraft, createWildcardSnapshot } from '../src/shared/dynamic-prompt-recipe';
import type { GenerationDraft, ModelAsset } from '../src/shared/types';
const selected=(modelId:string)=>({modelId,weight:1,clipWeight:1});
const initial=():GenerationDraft=>({...DEFAULT_DRAFT,prompt:'a garden',loras:[selected('a'),selected('b')]});
const change=(d:GenerationDraft,patch:Partial<GenerationDraft>)=>reconcileVisibleTriggers(d,applyTriggerResolutionChange(d,patch));
it('only inserts selected words, and generation sends the visible text exactly once',()=>{
 const d=change(initial(),{triggerWords:{a:['watercolor']}});
 expect(d.prompt).toBe('watercolor, a garden');expect(resolvePrompt(d,[{id:'a',triggers:['unselected']} as ModelAsset])).toBe(d.prompt);expect(draftSchema.parse(d).promptTriggerSpans).toHaveLength(1);
 expect(change(d,{loras:[]}).prompt).toBe('a garden');
});
it('keeps a shared trigger until its last selected owner is removed',()=>{
 let d=change(initial(),{triggerWords:{a:['style'],b:['style']}});d=change(d,{loras:[selected('b')]});expect(d.prompt).toBe('style, a garden');expect(change(d,{loras:[]}).prompt).toBe('a garden');
});
it('never claims a trigger that was already manually present',()=>{
 let d={...initial(),prompt:'(watercolor), a garden'};d=change(d,{triggerWords:{a:['watercolor']}});expect(d.promptTriggerSpans).toHaveLength(0);expect(change(d,{loras:[]}).prompt).toBe('(watercolor), a garden');
});
it('preserves manually edited trigger text and does not resurrect it on unrelated trigger changes',()=>{
 let d=change(initial(),{triggerWords:{a:['soft lighting']}});d=change(d,{prompt:'dramatic lighting, a garden'});d=change(d,{triggerWords:{a:['soft lighting'],b:['watercolor']}});expect(d.prompt).toBe('watercolor, dramatic lighting, a garden');expect(change(d,{loras:[]}).prompt).toBe('dramatic lighting, a garden');
});
it('releases ownership when typing at the end of a word',()=>{
 let d=change({...initial(),prompt:''},{triggerWords:{a:['cat']}});d=change(d,{prompt:'cats'});expect(change(d,{loras:[]}).prompt).toBe('cats');
});
it('keeps unrelated manual edits while removing an unchanged inserted prefix',()=>{
 let d=change(initial(),{triggerWords:{a:['style']}});d=change(d,{prompt:'style, a forest'});expect(change(d,{loras:[]}).prompt).toBe('a forest');
});
it('removes multiple owned additions without leftover punctuation',()=>{
 let d=change({...initial(),prompt:''},{triggerWords:{a:['one','two'],b:['three']}});d=change(d,{triggerWords:{a:['one']}});expect(d.prompt).toBe('one');expect(change(d,{loras:[]}).prompt).toBe('');
});
it('toggles selected additions without removing unowned prompt text',()=>{
 let d=change(initial(),{triggerWords:{a:['style']}});d=change(d,{autoTriggers:false});expect(d.prompt).toBe('a garden');expect(change(d,{autoTriggers:true}).prompt).toBe('style, a garden');
});
it('escapes trigger syntax in variations without adding a second hidden prefix',async()=>{
 const d=change({...initial(),dynamicPrompts:{enabled:true}},{triggerWords:{a:['__literal__','{red|blue}']}});
 const prepared=await prepareDynamicPromptDraft(d,'1',await createWildcardSnapshot({}));
 expect(prepared.prompt).toBe('__literal__, {red|blue}, a garden');expect(resolvePrompt({...d,prompt:prepared.prompt},[])).toBe(prepared.prompt);
});
it('preserves old recipes and resolver semantics across unrelated edits',()=>{
 const old=restoreTriggerResolution({...initial(),triggerResolutionVersion:undefined,triggerWords:{a:['style']}});
 expect(change(old,{steps:20}).triggerResolutionVersion).toBe('legacy@1');expect(resolvePrompt(old,[])).toBe('style, a garden');
 const modern=change(initial(),{prompt:'new prompt'});expect(modern.triggerResolutionVersion).toBe('visible@3');
});

it('rebases an unchanged trigger after an unrelated manual prefix',()=>{
 let d=change(initial(),{triggerWords:{a:['style']}});d=change(d,{prompt:'bright, '+d.prompt});expect(change(d,{loras:[]}).prompt).toBe('bright, a garden');
});
it('reports prompt capacity instead of silently selecting an absent trigger',()=>{
 expect(()=>change({...initial(),prompt:'x'.repeat(16000)},{triggerWords:{a:['style']}})).toThrow('not enough room');
});
it('adopts visible choices when adding the first LoRA to an older empty selection',()=>{
 const old={...initial(),loras:[],triggerResolutionVersion:'legacy@1' as const};expect(change(old,{loras:[selected('a')]}).triggerResolutionVersion).toBe('visible@3');
});

it('treats an adjective typed onto an inserted trigger as a manual edit',()=>{
 let d=change(initial(),{triggerWords:{a:['watercolor']}});d=change(d,{prompt:'bold watercolor, a garden'});expect(change(d,{loras:[]}).prompt).toBe('bold watercolor, a garden');
});

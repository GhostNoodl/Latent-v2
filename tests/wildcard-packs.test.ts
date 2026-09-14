import { expect,it } from 'vitest';
import { WILDCARD_PACKS,cleanPackEntries,stageWildcardPack } from '../src/shared/wildcard-packs';
import { createWildcardSnapshot,prepareDynamicPromptDraft } from '../src/shared/dynamic-prompt-recipe';
it('bundles valid, unique, literal choices with source references',async()=>{
 const entries=Object.fromEntries(WILDCARD_PACKS.map(p=>['starter_'+p.id,[...p.entries]]));const snapshot=await createWildcardSnapshot(entries);
 expect(Object.keys(snapshot.entries)).toHaveLength(13);expect(Object.values(entries).flat()).toHaveLength(817);
 for(const pack of WILDCARD_PACKS){expect(pack.source.url).toMatch(/^https:\/\//);expect(pack.entries.length).toBe(new Set(pack.entries).size);expect(pack.entries.every(s=>!/[{}|\\]/.test(s))).toBe(true);}
 const result=await prepareDynamicPromptDraft({prompt:'__starter_species__, __starter_locations__, __starter_outfits__, __starter_poses__',negativePrompt:'',dynamicPrompts:{enabled:true}},'42',snapshot);
 expect(result.prompt).not.toContain('__');expect(result.recipe?.positive.choices).toHaveLength(4);
});
it('cleans bundled aliases and duplicate spellings without empty choices',()=>{
 expect(cleanPackEntries([' Bunny ','rabbit','RED_FOX','red fox',''],{bunny:'rabbit'})).toEqual(['rabbit','red fox']);
});
it('preserves occupied and weighted user lists, creates a named copy, and reuses an unchanged import',()=>{
 const existing={starter_species:['custom','custom'],personal:['handwritten']},before=JSON.stringify(existing);
 const first=stageWildcardPack(existing,'species');expect(first.name).toBe('starter_species_2');expect(first.entries.starter_species).toEqual(['custom','custom']);expect(JSON.stringify(existing)).toBe(before);
 const again=stageWildcardPack(first.entries,'species');expect(again.added).toBe(false);expect(again.name).toBe(first.name);expect(again.entries).toEqual(first.entries);
 first.entries[first.name].push('my edit');const third=stageWildcardPack(first.entries,'species');expect(third.name).toBe('starter_species_3');expect(third.entries[first.name]).toContain('my edit');
});
it('rejects unknown packs and keeps saved recipe snapshots independent of later list edits',async()=>{
 expect(()=>stageWildcardPack({},'missing')).toThrow('available');const staged=stageWildcardPack({},'species');const snapshot=await createWildcardSnapshot(staged.entries);const before=JSON.stringify(snapshot);staged.entries[staged.name].push('new choice');expect(JSON.stringify(snapshot)).toBe(before);
});

it('keeps the full expanded catalog within the dictionary budget and rejects overflow without changing existing text',()=>{
 let entries:Record<string,string[]>={};for(const pack of WILDCARD_PACKS)entries=stageWildcardPack(entries,pack.id).entries;expect(Object.values(entries).flat()).toHaveLength(817);
 const crowded={personal:Array.from({length:1000},(_,i)=>'choice '+i)},before=JSON.stringify(crowded);expect(()=>stageWildcardPack(crowded,'species')).toThrow('1024-choice limit');expect(JSON.stringify(crowded)).toBe(before);
});
it('keeps an older starter copy intact when adding its expanded replacement',()=>{const old={starter_species:['fox','wolf','domestic dog','domestic cat','rabbit']};const next=stageWildcardPack(old,'species');expect(next.name).toBe('starter_species_2');expect(next.entries.starter_species).toEqual(old.starter_species);expect(next.entries[next.name]).toContain('red panda');});

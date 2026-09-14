// @vitest-environment jsdom
import { act, useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRAFT, DEFAULT_SETTINGS } from '../src/shared/defaults';
import { draftSchema, settingsSchema } from '../src/shared/validation';
import { followHiresScale } from '../src/shared/advanced-image-workflow';
import type { HiresFixSettings } from '../src/shared/advanced-image-types';
import { SizePresets } from '../src/renderer/SizePresets';
import { useDismissiblePanel } from '../src/renderer/useDismissiblePanel';
const hires: HiresFixSettings = { method:'latent', workflowVersion:'sdxl-hires-latent@1', width:1536, height:1536, steps:16, cfg:4, sampler:'euler', scheduler:'normal', denoise:0.35, seed:'1' };
describe('0.2 authoring preferences', () => {
 it('restores old settings and accepts new accents and user sizes', () => {
   const old = {...DEFAULT_SETTINGS}; delete old.sizePresets;
   expect(settingsSchema.parse(old).accent).toBe('iris');
   expect(settingsSchema.parse({...old, accent:'amber', sizePresets:[{name:'My portrait',width:768,height:1344}]}).sizePresets).toHaveLength(1);
   expect(settingsSchema.safeParse({...old,sizePresets:[{name:'same',width:512,height:512},{name:'SAME',width:512,height:768}]}).success).toBe(false);
   expect(settingsSchema.safeParse({...old,sizePresets:[{name:'bad',width:513,height:768}]}).success).toBe(false);
 });
 it('updates linked hires dimensions without rewriting fixed historic recipes', () => {
   expect(followHiresScale(hires,768,1344)).toBe(hires);
   const linked=followHiresScale({...hires,scaleFactor:1.5},768,1344);
   expect(linked).toMatchObject({width:1152,height:2016,scaleFactor:1.5,workflowVersion:undefined});
   expect(draftSchema.parse({...DEFAULT_DRAFT,hiresFix:linked}).hiresFix?.scaleFactor).toBe(1.5);
   expect(followHiresScale({...hires,scaleFactor:2},0,1024).width).toBe(1536);
 });
});
it('closes activity on outside click and Escape without breaking its toggle',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 function Panel(){const [open,setOpen]=useState(false);useDismissiblePanel(open,useCallback(()=>setOpen(false),[]),'.toggle,.panel');return <><button className="toggle" onClick={()=>setOpen(!open)}>Toggle</button>{open&&<section className="panel"><button>Inside</button></section>}<button className="outside">Outside</button></>;}
 const click=async(selector:string)=>act(async()=>{const el=host.querySelector(selector)!;el.dispatchEvent(new Event('pointerdown',{bubbles:true}));(el as HTMLElement).click();});
 try{await act(async()=>root.render(<Panel/>));await click('.toggle');expect(host.querySelector('.panel')).not.toBeNull();await click('.panel button');expect(host.querySelector('.panel')).not.toBeNull();await click('.toggle');expect(host.querySelector('.panel')).toBeNull();await click('.toggle');await click('.outside');expect(host.querySelector('.panel')).toBeNull();await click('.toggle');await act(async()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));expect(host.querySelector('.panel')).toBeNull();}finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});
it('keeps edited size presets available when saving fails and can retry',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);const save=vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValueOnce(undefined),choose=vi.fn();
 const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===text)!;
 try{await act(async()=>root.render(<SizePresets sizes={[{name:'Personal',width:768,height:1344}]} width={1024} height={1024} onChoose={choose} onSave={save}/>));await act(async()=>button('Personal').click());expect(choose).toHaveBeenCalledWith({name:'Personal',width:768,height:1344});await act(async()=>button('Edit sizes').click());await act(async()=>button('Save sizes').click());expect(host.querySelector('[role="alert"]')?.textContent).toContain('try again');expect(host.querySelector('input')?.value).toBe('Personal');await act(async()=>button('Save sizes').click());expect(host.querySelector('[role="dialog"]')).toBeNull();expect(save).toHaveBeenCalledTimes(2);}finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

// @vitest-environment jsdom
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Models } from '../src/renderer/Models';
import { MODEL_DRAG_TYPE } from '../src/renderer/ModelFolders';
vi.mock('../src/renderer/ModelLocationsUI',()=>({ModelLocationsUI:()=>null}));
vi.mock('../src/renderer/Collections',()=>({CollectionMembershipButton:()=>null}));
it.each([false,true])('organizes cards using virtual folders; add failure=%s preserves source membership',async fail=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);window.latent={} as any;
 let state:any={schemaVersion:1,collections:[{id:'source',kind:'model',name:'Source',memberIds:['m']},{id:'target',kind:'model',name:'Target',memberIds:[]}]};
 const actions:any={create:vi.fn(async(_kind,name)=>{state={...state,collections:[...state.collections,{id:'new',kind:'model',name,memberIds:[]}]};return structuredClone(state);}),rename:vi.fn(),remove:vi.fn(),addMembers:vi.fn(async(id,ids)=>{if(fail)throw Error('Unable to add');state={...state,collections:state.collections.map((c:any)=>c.id===id?{...c,memberIds:[...c.memberIds,...ids]}:c)};return structuredClone(state);}),removeMembers:vi.fn(async(id,ids)=>{state={...state,collections:state.collections.map((c:any)=>c.id===id?{...c,memberIds:c.memberIds.filter((m:string)=>!ids.includes(m))}:c)};return structuredClone(state);})};
 const snapshot:any={models:[{id:'m',name:'Model',filename:'model.safetensors',family:'sdxl',kind:'checkpoint',status:'ready',bytes:100,triggers:[]}],settings:{civitaiDisplayMetadata:false},history:[],paths:{models:'models'}};
 function Harness(){const [collections,setCollections]=useState(state);return <Models snapshot={snapshot} receive={()=>{}} run={async(_k,task)=>{await task();return true;}} busy={{}} onUse={()=>{}} collections={collections} collectionActions={actions} onCollectionChange={setCollections}/>;}
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const folder=(name:string)=>[...host.querySelectorAll<HTMLButtonElement>('.folder-target')].find(b=>b.textContent?.includes(name))!;
 try{
 await act(async()=>root.render(<Harness/>));await act(async()=>folder('Source').click());
 expect(host.querySelector('.model-card')?.getAttribute('draggable')).toBe('true');
 const drop=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(drop,'dataTransfer',{value:{getData:(type:string)=>type===MODEL_DRAG_TYPE?'m':''}});
 await act(async()=>folder('Target').dispatchEvent(drop));
 expect(actions.addMembers).toHaveBeenCalledWith('target',['m']);
 if(fail){expect(actions.removeMembers).not.toHaveBeenCalled();expect(state.collections[0].memberIds).toEqual(['m']);expect(host.textContent).toContain('Unable to add');}
 else{expect(actions.removeMembers).toHaveBeenCalledWith('source',['m']);expect(state.collections[0].memberIds).toEqual([]);expect(state.collections[1].memberIds).toEqual(['m']);await act(async()=>folder('Target').click());expect(host.querySelector('.model-card')).not.toBeNull();}
 const create=[...host.querySelectorAll('button')].find(b=>b.textContent==='New folder')!;await act(async()=>create.click());
 expect(host.querySelector('.model-folders .modal-backdrop')).toBeNull();
 const input=host.querySelector<HTMLInputElement>('.modal input')!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,'Styles');input.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>host.querySelector('.modal form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(actions.create).toHaveBeenCalledWith('model','Styles');expect(folder('Styles').getAttribute('aria-pressed')).toBe('true');
 }finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

// @vitest-environment jsdom
import {act} from 'react';import {createRoot} from 'react-dom/client';import {it,expect,vi} from 'vitest';
import {SetupHub} from '../src/renderer/SetupHub';import type {AppSnapshot} from '../src/shared/types';
it('requires review before setup, blocks failed preflight, and retries explicitly',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const scroll=vi.fn();Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:scroll});const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const snapshot={backend:{state:'not-installed',message:'Engine missing'},models:[],qwenEdit:{baseReady:false,message:'Editing missing'},video:{canGenerate:false,message:'Video missing'},downloads:[]} as unknown as AppSnapshot;
 const preflight={capability:'engine',checkedAt:'fixture',blockers:['Update driver'],warnings:[],storage:{package:{minimumDownloadBytes:0},destinations:[],volumes:[]}};
 const run=vi.fn(async()=>{});Object.defineProperty(window,'latent',{configurable:true,value:{getSetupPreflight:vi.fn(async()=>preflight),runGuidedSetup:run,getSnapshot:vi.fn(async()=>snapshot)}});
 const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===label)!;
 try{await act(async()=>root.render(<SetupHub snapshot={snapshot} receive={()=>{}} onClose={()=>{}} onModels={()=>{}} onSettings={()=>{}} onCreate={()=>{}} onEdit={()=>{}} onVideo={()=>{}}/>));
 expect(run).not.toHaveBeenCalled();await act(async()=>button('Check setup').click());expect(button('Install missing components').disabled).toBe(true);expect(document.activeElement).toBe(host.querySelector('[aria-label="Setup review"]'));expect(scroll).toHaveBeenCalled();
 preflight.blockers=[];await act(async()=>button('Check again').click());expect(run).not.toHaveBeenCalled();await act(async()=>button('Install missing components').click());expect(run).toHaveBeenCalledExactlyOnceWith('engine');
 }finally{await act(async()=>root.unmount());host.remove();delete (HTMLElement.prototype as unknown as {scrollIntoView?:unknown}).scrollIntoView;vi.unstubAllGlobals();}
});

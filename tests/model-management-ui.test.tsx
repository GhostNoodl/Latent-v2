// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalModelMetadata } from '../src/renderer/LocalModelMetadata';
import { SetupProgress } from '../src/renderer/SetupProgress';
import type { AppSnapshot, LatentAPI, ModelAsset } from '../src/shared/types';
const model:ModelAsset={id:'lora:civitai_1_2_3_Model-v2.safetensors',filename:'civitai_1_2_3_Model-v2.safetensors',name:'Model',kind:'lora',family:'sdxl',bytes:100,sha256:'a'.repeat(64),triggers:[],status:'ready'};
let unmount:()=>Promise<void>;
afterEach(async()=>{await unmount?.();vi.unstubAllGlobals();});
async function mount(node:React.ReactNode){vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);await act(async()=>root.render(node));unmount=async()=>{await act(async()=>root.unmount());host.remove();};return host;}
it('requires confirmation and retains an actionable error when recycling fails',async()=>{
 const remove=vi.fn().mockRejectedValue(Error('Recycle unavailable'));
 window.latent={deleteModel:remove} as unknown as LatentAPI;
 const host=await mount(<LocalModelMetadata model={model} onClose={()=>{}}/>);
 const click=async(text:string)=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent===text)!;await act(async()=>b.click());};
 await click('Move to Recycle Bin…');expect(remove).not.toHaveBeenCalled();await click('Confirm removal');expect(remove).toHaveBeenCalledWith({modelId:model.id,expectedSha256:model.sha256});expect(document.body.textContent).toContain('Recycle unavailable');expect(host).toBeTruthy();
});
it('shows byte counts and keeps unknown-size downloads indeterminate',async()=>{
 const snapshot={downloads:[{id:'test',name:'Illustrious-XL-v1.1.safetensors',state:'downloading',receivedBytes:1024}]} as AppSnapshot;
 await mount(<SetupProgress snapshot={snapshot} capability="images"/>);expect(document.querySelector('progress')?.hasAttribute('value')).toBe(false);expect(document.body.textContent).toContain('1.0 KiB');
});
it('identifies the active setup component and clamps progress',async()=>{
 const snapshot={backend:{message:'Installing engine',installProgress:130,setupDownload:{filename:'engine.zip',receivedBytes:100,totalBytes:100,phase:'verifying'}}} as AppSnapshot;
 await mount(<SetupProgress snapshot={snapshot} capability="engine"/>);expect(document.querySelector('progress')?.value).toBe(100);expect(document.body.textContent).toContain('Overall setup estimate');expect(document.body.textContent).toContain('engine.zip');
});

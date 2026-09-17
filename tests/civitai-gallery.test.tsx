// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CivitaiGallery } from '../src/renderer/CivitaiGallery';
import { civitaiCompatibilityLabel, civitaiPreferredVersion } from '../src/shared/civitai-discovery';
import type { CivitaiModel, CivitaiVersion } from '../src/shared/civitai-types';
let dispose:()=>Promise<void>;
afterEach(async()=>{await dispose?.();vi.unstubAllGlobals();});
async function mount(images=3){
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 const previews=Array.from({length:images},(_,i)=>({url:`https://image.civitai.com/example/${i}.png`,width:512,height:512}));
 await act(async()=>root.render(<CivitaiGallery previews={previews} name="Fixture model"/>));
 dispose=async()=>{await act(async()=>root.unmount());host.remove();};return host;
}
async function click(label:string){const button=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent===label)!;expect(button).toBeTruthy();await act(async()=>button.click());}
it('navigates previews, wraps and opens the selected image in a larger view',async()=>{
 const host=await mount();await click('Next creator image');expect(host.querySelector('.civitai-gallery-stage img')?.getAttribute('src')).toContain('/1.png');
 await click('Show creator image 3');await click('Next creator image');expect(host.querySelector('.civitai-gallery-stage img')?.getAttribute('src')).toContain('/0.png');
 await click('Larger view');expect(document.querySelector('.expanded img')?.getAttribute('src')).toContain('/0.png');
});
it('keeps a failed image recoverable and lets users navigate to another preview',async()=>{
 const host=await mount();await act(async()=>host.querySelector('.civitai-gallery-stage img')!.dispatchEvent(new Event('error')));
 expect(host.textContent).toContain('This image couldn’t load');await click('Next creator image');expect(host.querySelector('.civitai-gallery-stage img')?.getAttribute('src')).toContain('/1.png');
 await click('Previous creator image');await click('Retry image');expect(host.querySelector('.civitai-gallery-stage img')).toBeTruthy();
});
it('has a clear empty state',async()=>{expect((await mount(0)).textContent).toContain('No creator images');});
it('does not label discovery-only families as supported, including mixed-version listings',()=>{
 const supported={family:'sdxl',baseModel:'SDXL 1.0',baseModelType:'Standard'} as CivitaiVersion;
 const unsupported={family:'unknown',baseModel:'Flux.1 D',baseModelType:'Standard'} as CivitaiVersion;
 const model={kind:'checkpoint',versions:[unsupported]} as CivitaiModel;
 expect(civitaiCompatibilityLabel(model)).toBe('Needs another workflow');
 expect(civitaiCompatibilityLabel({...model,versions:[unsupported,supported]})).toBe('Some versions support Create');
 expect(civitaiCompatibilityLabel({...model,versions:[supported]})).toBe('Create supported');
 expect(civitaiPreferredVersion({...model,versions:[supported,unsupported]},'Flux.1 D')).toBe(unsupported);
 expect(civitaiPreferredVersion({...model,versions:[unsupported,supported]},undefined,true)).toBe(supported);
});

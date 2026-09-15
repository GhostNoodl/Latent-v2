// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect,it,vi } from 'vitest';
import { AutomaticFaceControls } from '../src/renderer/AutomaticFaceControls';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import type { FaceDetailerStatus } from '../src/shared/face-detailer-types';
it('requires installed detection, exposes opt-in settings and can turn off again',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div'),root=createRoot(host);document.body.append(host);
 function Fixture({state}:{state:FaceDetailerStatus['state']}){const [draft,setDraft]=useState(DEFAULT_DRAFT);return <AutomaticFaceControls run={async(_key,task)=>{await task();return true;}} draft={draft} status={{state} as FaceDetailerStatus} onChange={c=>setDraft(d=>({...d,...c}))}/>;}
 try {await act(async()=>root.render(<Fixture state="not-installed"/>));expect(host.querySelector('input')!.disabled).toBe(true);expect(host.textContent).toContain('Set up / update face detector');await act(async()=>root.render(<Fixture state="ready"/>));await act(async()=>host.querySelector('input')!.click());expect(host.querySelector('select')!.value).toBe('illustrated');expect(host.querySelector('input[type=range]')!.getAttribute('value')).toBe('0.3');await act(async()=>host.querySelector('input')!.click());expect(host.querySelector('select')).toBeNull();}
 finally {await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

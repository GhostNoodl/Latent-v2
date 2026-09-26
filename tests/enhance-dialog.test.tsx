// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { EnhanceDialog } from '../src/renderer/EnhanceDialog';
import type { GenerationRecord } from '../src/shared/types';
it('prepares only on request and preserves a recoverable import failure',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);const root=createRoot(host),prepare=vi.fn().mockRejectedValue(Error('Source unavailable'));
 try{await act(async()=>root.render(<EnhanceDialog record={{width:1024,height:1024} as GenerationRecord} onClose={()=>{}} onPrepare={prepare}/>));expect(prepare).not.toHaveBeenCalled();expect(host.textContent).toContain('1536');await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Prepare enhancement')!.click());expect(prepare).toHaveBeenCalledWith(1.5,.3);expect(host.textContent).toContain('Source unavailable');expect(host.querySelector('select')?.disabled).toBe(false);}
 finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

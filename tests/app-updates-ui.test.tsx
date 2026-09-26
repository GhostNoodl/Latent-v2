// @vitest-environment jsdom
import { act } from 'react';import{createRoot}from'react-dom/client';import{expect,it,vi}from'vitest';
import{AppUpdates}from'../src/renderer/AppUpdates';import{DEFAULT_APP_UPDATE_SETTINGS,type AppUpdateStatus}from'../src/shared/app-update-types';
it('requires an explicit install action and exposes postponement while requested',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div'),root=createRoot(host);document.body.append(host);const install=vi.fn(),cancel=vi.fn();const status:AppUpdateStatus={currentVersion:'0.1.1',supported:true,state:'ready',settings:DEFAULT_APP_UPDATE_SETTINGS,message:'Update ready',installRequested:false};
 const render=()=>root.render(<AppUpdates status={status} busy={false} onSettings={()=>{}} onCheck={()=>{}} onDownload={()=>{}} onInstall={install} onCancel={cancel}/>);
 try{await act(async()=>render());expect(install).not.toHaveBeenCalled();await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Save, close and install')!.click());expect(install).toHaveBeenCalledTimes(1);status.installRequested=true;await act(async()=>render());await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='Postpone installation')!.click());expect(cancel).toHaveBeenCalledTimes(1);}finally{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();}
});

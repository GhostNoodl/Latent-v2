import { useState } from 'react';
import type { AppSnapshot, ModelAsset } from '../shared/types';
import { cleanModelFilename } from '../shared/model-names';
import { Modal, Notice, bytes } from './ui';
export function LocalModelMetadata({model,onClose,onUpdated}:{model:ModelAsset;onClose():void;onUpdated?(snapshot:AppSnapshot):void}) {
 const [current,setCurrent]=useState(model),[busy,setBusy]=useState(false),[error,setError]=useState(''),[confirmDelete,setConfirmDelete]=useState(false);
 const external=current.id.startsWith('external:');
 const filename=current.filename.split('/').at(-1)!;
 const cleaned=cleanModelFilename(filename);
 async function perform(action:()=>Promise<AppSnapshot>,close=false) {
   if(busy)return;setBusy(true);setError('');
   try {const snapshot=await action();setCurrent(snapshot.models.find(item=>item.id===model.id)??current);onUpdated?.(snapshot);if(close)onClose();}
   catch(cause){setError(cause instanceof Error?cause.message:'The model could not be updated.');}
   finally{setBusy(false);}
 }
 const data=current.civitai;
 return <Modal title="Model details" onClose={()=>{if(!busy)onClose();}}>
   <div className="button-row"><button disabled={busy||current.status!=='ready'} onClick={()=>void perform(()=>window.latent.fetchModelCivitaiMetadata(model.id))}>{data?'Refresh Civitai metadata':'Fetch Civitai metadata'}</button>{data&&<button disabled={busy} onClick={()=>void window.latent.openCivitaiModel(data.modelId,data.versionId)}>Open creator’s page</button>}</div>
   {busy&&<p role="status">Updating model…</p>}{error&&<Notice error>{error}</Notice>}
   {data?<><h3>{data.modelName}</h3><p>{data.versionName} · {data.baseModel}{data.creator&&` · by ${data.creator}`}</p>{data.description&&<p className="civitai-description">{data.description}</p>}{!!data.trainedWords?.length&&<p>Creator’s trigger words: {data.trainedWords.join(', ')}</p>}</>:<p>Find matching creator information using this file’s checksum.</p>}
   <h3>Model file</h3><p className="inline-path">{current.filename}</p><p className="muted small">{bytes(current.bytes)} · Saved images and recipes are preserved when you rename or remove a model. An idle engine restarts automatically after file changes.</p>
   {external?<p>This folder is read-only. Manage its files outside Latent, or disconnect it in Model folders.</p>:<>
     {cleaned!==filename&&current.status==='ready'&&<><p>Clean filename: <strong>{cleaned}</strong></p><button disabled={busy||!current.sha256} onClick={()=>void perform(async()=>{await window.latent.moveModel({modelId:current.id,expectedSha256:current.sha256!,destinationFolder:current.filename.split('/').slice(0,-1).join('/'),filename:cleaned});return window.latent.getSnapshot();})}>Clean filename</button></>}
     {!confirmDelete?<p><button disabled={busy||!current.sha256} onClick={()=>setConfirmDelete(true)}>{current.status==='missing'?'Remove missing entry':'Move to Recycle Bin…'}</button></p>:<section aria-label="Confirm model removal"><p>{current.status==='missing'?'Remove this missing model from the library?':'Move this model file to the Windows Recycle Bin?'} You will need to restore or download it again to generate with its recipes.</p><div className="button-row"><button disabled={busy} onClick={()=>void perform(()=>window.latent.deleteModel({modelId:current.id,expectedSha256:current.sha256!}),true)}>Confirm removal</button><button disabled={busy} onClick={()=>setConfirmDelete(false)}>Keep model</button></div></section>}
   </>}
 </Modal>;
}

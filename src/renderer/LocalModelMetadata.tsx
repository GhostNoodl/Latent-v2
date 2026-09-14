import { useState } from 'react';
import type { AppSnapshot, ModelAsset } from '../shared/types';
import { Modal, Notice } from './ui';
export function LocalModelMetadata({model,onClose,onUpdated}:{model:ModelAsset;onClose():void;onUpdated?(snapshot:AppSnapshot):void}) {
 const [current,setCurrent]=useState(model),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function fetchMetadata(){if(busy)return;setBusy(true);setError('');try{const snapshot=await window.latent.fetchModelCivitaiMetadata(model.id);setCurrent(snapshot.models.find(item=>item.id===model.id)??model);onUpdated?.(snapshot);}catch(cause){setError(cause instanceof Error?cause.message:'Metadata could not be fetched.');}finally{setBusy(false);}}
 const data=current.civitai;
 return <Modal title={`Civitai · ${current.name}`} onClose={onClose}><div className="button-row"><button disabled={busy||model.status!=='ready'} onClick={()=>void fetchMetadata()}>{busy?'Fetching…':data?'Refresh Civitai metadata':'Fetch Civitai metadata'}</button>{data&&<button onClick={()=>void window.latent.openCivitaiModel(data.modelId,data.versionId)}>Open creator’s page</button>}</div>{error&&<Notice error>{error}</Notice>}{data?<><h3>{data.modelName}</h3><p>{data.versionName} · {data.baseModel}{data.creator&&` · by ${data.creator}`}</p>{data.description&&<p className="civitai-description">{data.description}</p>}{!!data.trainedWords?.length&&<p>Creator’s trigger words: {data.trainedWords.join(', ')}</p>}<p className="muted small">Creator information is stored separately from your family and trigger settings.</p></>:<p>Find the matching Civitai version using this file’s checksum. Your model file stays on your computer.</p>}</Modal>;
}

import type { AppSnapshot } from '../shared/types';
import type { SetupCapability } from '../shared/setup';
import { bytes } from './ui';
const labels: Record<string,string> = {diffusion:'Generation model',encoder:'Text encoder',vae:'Image decoder',videoVae:'Video decoder',audioVae:'Audio decoder',turbo:'Speed adapter',lightning:'Speed adapter'};
export function SetupProgress({snapshot:s,capability}:{snapshot:AppSnapshot;capability:SetupCapability}) {
 let message='', component='', progress:number|undefined, overall=false, detail='';
 if(capability==='engine') {
   message=s.backend.message;progress=s.backend.installProgress;overall=true;
   const d=s.backend.setupDownload;
   if(d){component=d.filename;detail=`${d.phase==='verifying'?'Checking download':'Downloaded'} · ${bytes(d.receivedBytes)}${d.totalBytes?' / '+bytes(d.totalBytes):''}`;}
 } else if(capability==='edit') {
   overall=true;
   message=s.qwenEdit.message;component=labels[s.qwenEdit.activeRole??'']??'';progress=s.qwenEdit.installProgress;
 } else if(capability==='video') {
   overall=true;
   message=s.video.assets?.message??'Preparing video tools…';component=labels[s.video.assets?.activeRole??'']??'';progress=s.video.assets?.progress;
 } else {
   const d=s.downloads.find(d=>d.name==='Illustrious-XL-v1.1.safetensors'&&['downloading','verifying'].includes(d.state));
   message=d?.state==='verifying'?'Checking the downloaded model…':'Downloading starter model…';component=d?.name??'Illustrious XL 1.1';
   if(d){detail=`${bytes(d.receivedBytes)}${d.totalBytes?' / '+bytes(d.totalBytes):''}`;if(d.state==='downloading'&&d.totalBytes)progress=100*d.receivedBytes/d.totalBytes;}
 }
 const value=progress!==undefined&&Number.isFinite(progress)?Math.max(0,Math.min(100,progress)):undefined;
 return <section aria-label="Setup progress"><p role="status">{message}</p>{component&&<p className="inline-path">{component}</p>}<progress aria-label={overall?'Overall setup estimate':'Component progress'} max={100} value={value}/><p className="small">{value===undefined?'Working…':`${overall?'Overall setup estimate · ':''}${Math.round(value)}%`}{detail&&` · ${detail}`}</p></section>;
}

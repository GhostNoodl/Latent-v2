import type { GenerationDraft } from '../shared/types';
import type { FaceDetailerStatus } from '../shared/face-detailer-types';
import { useRef, useState } from 'react';
import { Field, type RunAction } from './ui';
export function AutomaticFaceControls({draft,status,onChange,run}:{draft:GenerationDraft;status:FaceDetailerStatus;run:RunAction;onChange(change:Partial<GenerationDraft>):void}) {
 const pending=useRef(false); const [starting,setStarting]=useState(false);
 async function setup() {
  if(pending.current) return; pending.current=true; setStarting(true);
  try { await run('face-setup',()=>window.latent.setupFaceDetailer(status.state==='error')); }
  finally { pending.current=false; setStarting(false); }
 }
 const ready=['ready','detecting'].includes(status.state), value=draft.autoFace;
 const compatible=!draft.faceDetailer&&!draft.autoFaceParentRecordId&&!draft.upscale&&!draft.qwenEdit;
 return <section aria-label="Automatic face refinement"><label className="checkbox-label"><input type="checkbox" checked={!!value} disabled={!value&&(!ready||!compatible)} onChange={e=>onChange({autoFace:e.target.checked?{profile:'illustrated',strength:.3}:undefined})}/>Automatically refine faces</label>
 {!ready&&<div aria-live="polite">
  <p className="muted small">{status.state==='installing' ? 'Setting up face detection...' : 'Face detection needs setup or an update.'}</p>
  {status.state==='installing' ? <><progress value={status.installProgress ?? 0} max={100} aria-label="Face detector installation progress"/><button type="button" onClick={()=>{void run('face-cancel-setup',()=>window.latent.cancelFaceDetailerSetup());}}>Cancel setup</button></> : <button type="button" className="soft-button" disabled={starting} onClick={()=>{void setup();}}>{starting ? 'Setting up...' : status.state==='error' ? 'Retry face detector setup' : 'Set up / update face detector'}</button>}
  {status.state==='error'&&<p className="inline-error" role="alert">{status.message}</p>}
 </div>}
 {value&&<><p className="muted small">Runs after generation and hires. Saves separate face edits; your original stays safe if no face is found. Detection can miss stylized or animal faces.</p>
 <Field label="Face style"><select value={value.profile} onChange={e=>onChange({autoFace:{...value,profile:e.target.value as 'illustrated'|'anime'|'photographic'}})}><option value="illustrated">Illustration / furry</option><option value="anime">Anime / illustration</option><option value="photographic">Photographic</option></select></Field>
 <Field label={`Face refinement strength · ${Math.round(value.strength*100)}%`} hint="Lower preserves more of the face."><input type="range" min={.05} max={.8} step={.05} value={value.strength} onChange={e=>onChange({autoFace:{...value,strength:Number(e.target.value)}})}/></Field></>}
 </section>;
}

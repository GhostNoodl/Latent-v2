import type { GenerationDraft } from '../shared/types';
import type { FaceDetailerStatus } from '../shared/face-detailer-types';
import { Field } from './ui';
export function AutomaticFaceControls({draft,status,onChange}:{draft:GenerationDraft;status:FaceDetailerStatus;onChange(change:Partial<GenerationDraft>):void}) {
 const ready=['ready','detecting'].includes(status.state), value=draft.autoFace;
 const compatible=!draft.faceDetailer&&!draft.autoFaceParentRecordId&&!draft.upscale&&!draft.qwenEdit;
 return <section aria-label="Automatic face refinement"><label className="checkbox-label"><input type="checkbox" checked={!!value} disabled={!value&&(!ready||!compatible)} onChange={e=>onChange({autoFace:e.target.checked?{profile:'anime',strength:.3}:undefined})}/>Automatically refine faces</label>
 {!ready&&<p className="muted small">Set up face refinement in Settings to enable this option.</p>}
 {value&&<><p className="muted small">Runs after generation and hires. Saves separate face edits; your original stays safe if no face is found. Detection can miss stylized or animal faces.</p>
 <Field label="Face style"><select value={value.profile} onChange={e=>onChange({autoFace:{...value,profile:e.target.value as 'anime'|'photographic'}})}><option value="anime">Anime / illustration</option><option value="photographic">Photographic</option></select></Field>
 <Field label={`Face refinement strength · ${Math.round(value.strength*100)}%`} hint="Lower preserves more of the face."><input type="range" min={.05} max={.8} step={.05} value={value.strength} onChange={e=>onChange({autoFace:{...value,strength:Number(e.target.value)}})}/></Field></>}
 </section>;
}

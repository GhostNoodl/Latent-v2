import { useRef } from 'react';
import { WILDCARD_PACKS } from '../shared/wildcard-packs';
export function WildcardPacks({disabled,onAdd}:{disabled:boolean;onAdd(id:string):void}) {
 const catalog=useRef<HTMLDetailsElement>(null);
 return <details ref={catalog} className="wildcard-starter-packs"><summary>Starter packs · species, scenes, clothing and poses</summary>
 <p className="muted small">Add an editable copy, then save your lists below. Existing lists stay intact. Use one wildcard per category; choices are independent.</p>
 {WILDCARD_PACKS.map(pack=><details key={pack.id}><summary>{pack.name} · {pack.entries.length} choices</summary><p className="small">{pack.description}</p><p className="small">{pack.entries.join(' · ')}</p><p className="muted small">Source: {pack.source.label} · reviewed {pack.reviewed}</p><button type="button" disabled={disabled} onClick={()=>{onAdd(pack.id);if(catalog.current)catalog.current.open=false;}}>Add {pack.name.toLowerCase()}</button></details>)}
 </details>;
}

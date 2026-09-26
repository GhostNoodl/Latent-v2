import { useRef, useState } from 'react';
import { WILDCARD_PACKS } from '../shared/wildcard-packs';
export function WildcardPacks({disabled,onAdd}:{disabled:boolean;onAdd(id:string):void}) {
 const catalog=useRef<HTMLDetailsElement>(null);
 const [search,setSearch]=useState('');const query=search.trim().toLowerCase().replace(/_/g,' ');
 const visible=WILDCARD_PACKS.filter(pack=>[pack.name,pack.description,...pack.entries].some(text=>text.toLowerCase().includes(query)));
 return <details ref={catalog} className="wildcard-starter-packs"><summary>Starter packs · {WILDCARD_PACKS.length} categories · {WILDCARD_PACKS.reduce((count,pack)=>count+pack.entries.length,0)} choices</summary>
 <p className="muted small">Add an editable copy, then save your lists below. Existing lists stay intact. Use one wildcard per category; choices are independent.</p>
 <label className="field"><span>Find a pack or choice</span><input type="search" value={search} disabled={disabled} placeholder="Species, clothing, red panda…" onChange={e=>setSearch(e.target.value)}/></label>
 {!visible.length&&<p className="muted small">No matching packs. Try another word.</p>}
 {visible.map(pack=><details key={pack.id}><summary>{pack.name} · {pack.entries.length} choices</summary><p className="small">{pack.description}</p><p className="small pack-entries">{pack.entries.join(' · ')}</p><p className="muted small">Source: {pack.source.label} · reviewed {pack.reviewed}</p><button type="button" disabled={disabled} onClick={()=>{onAdd(pack.id);if(catalog.current)catalog.current.open=false;}}>Add {pack.name.toLowerCase()}</button></details>)}
 </details>;
}

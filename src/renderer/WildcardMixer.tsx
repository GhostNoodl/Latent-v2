import { useRef, useState } from 'react';
import { WILDCARD_PACKS, cleanSpeciesPreset } from '../shared/wildcard-packs';
import { activeWildcardNames, mixWildcardPrompt } from '../shared/wildcard-mixer';
import { createWildcardSnapshot, type WildcardSnapshot } from '../shared/dynamic-prompt-recipe';
import { Modal, Notice } from './ui';

export function WildcardMixer({ prompt, wildcards, onSave, onApply, onClose }: {
  prompt: string; wildcards: WildcardSnapshot;
  onSave(entries: Record<string,string[]>): Promise<WildcardSnapshot>;
  onApply(prompt: string): void; onClose(): void;
}) {
  const [savedEntries] = useState(()=>cleanSpeciesPreset(wildcards.entries));
  const [categories] = useState(() => {
    const presets = WILDCARD_PACKS.map(pack => ({name:`starter_${pack.id}`, title:pack.name, description:pack.description, defaults:[...pack.entries]}));
    return [...presets, ...Object.keys(savedEntries).filter(name=>!presets.some(p=>p.name===name)).sort().map(name=>({name,title:name,description:'Your saved wildcard list',defaults:savedEntries[name]}))];
  });
  const [choices,setChoices] = useState<Record<string,string[]>>(()=>Object.fromEntries(categories.map(c=>[c.name,[...(savedEntries[c.name] ?? c.defaults)]])));
  const [enabled,setEnabled] = useState(()=>activeWildcardNames(prompt));
  const [selected,setSelected] = useState(categories[0].name);
  const [query,setQuery] = useState('');
  const [error,setError] = useState('');
  const [saving,setSaving] = useState(false);
  const busy=useRef(false);
  const changed=useRef(new Set<string>());
  const category=categories.find(c=>c.name===selected)!;
  const available=[...new Set([...category.defaults,...(savedEntries[selected]??[])])];
  const visible=available.filter(value=>value.replaceAll('_',' ').toLowerCase().includes(query.replaceAll('_',' ').toLowerCase()));
  function update(values:string[]) { changed.current.add(selected);setChoices(previous=>({...previous,[selected]:values})); }
  async function apply() {
    if(busy.current)return;
    busy.current=true;setSaving(true);setError('');
    try {
      const entries=structuredClone(savedEntries);
      for(const c of categories) if(enabled.has(c.name)||changed.current.has(c.name)) {
        if(!choices[c.name].length) {
          if(enabled.has(c.name))throw Error(`Select at least one choice for ${c.title}, or turn that category off.`);
          continue;
        }
        entries[c.name]=choices[c.name];
      }
      const next=mixWildcardPrompt(prompt,enabled,new Set(categories.map(c=>c.name)));
      await createWildcardSnapshot(entries);
      await onSave(entries);
      onApply(next);onClose();
    } catch(e) {setError(e instanceof Error?e.message:String(e));}
    finally {busy.current=false;setSaving(false);}
  }
  return <Modal title="Mix wildcards" onClose={()=>{if(!busy.current)onClose();}}>
    <div className="wildcard-mixer">
      <p>Enable categories for your positive prompt. Each generation picks one checked choice from each enabled category.</p>
      <div className="wildcard-mixer-layout">
        <nav aria-label="Wildcard categories">{categories.map(c=><div className="wildcard-category" key={c.name}>
          <input type="checkbox" aria-label={`Enable ${c.title}`} checked={enabled.has(c.name)} disabled={saving} onChange={e=>setEnabled(previous=>{const next=new Set(previous);if(e.target.checked)next.add(c.name);else next.delete(c.name);return next;})}/>
          <button type="button" aria-pressed={selected===c.name} disabled={saving} onClick={()=>{setSelected(c.name);setQuery('');}}><strong>{c.title}</strong><small>{choices[c.name].length} choices{enabled.has(c.name)?' · On':''}</small></button>
        </div>)}</nav>
        <section className="wildcard-choice-panel"><h3>{category.title}</h3><p>{category.description}</p><code>__{category.name}__</code>
          <input type="search" aria-label="Search wildcard choices" placeholder="Find a choice…" value={query} disabled={saving} onChange={e=>setQuery(e.target.value)}/>
          <div className="button-row"><button type="button" disabled={saving} onClick={()=>update([...choices[selected],...visible.filter(v=>!choices[selected].includes(v))])}>Select shown</button><button type="button" disabled={saving} onClick={()=>update(choices[selected].filter(v=>!visible.includes(v)))}>Deselect shown</button><span>{choices[selected].length} selected</span></div>
          <div className="wildcard-choice-grid">{visible.map(value=><label key={value} title={value}><input type="checkbox" checked={choices[selected].includes(value)} disabled={saving} onChange={e=>update(e.target.checked?[...choices[selected],value]:choices[selected].filter(v=>v!==value))}/><span>{value.replaceAll('_',' ')}</span></label>)}{!visible.length&&<p>No matching choices.</p>}</div>
        </section>
      </div>
      {error&&<Notice error>{error}</Notice>}
      <p className="muted small">Apply saves your choices and updates the prompt. This also clears any frozen variations. Custom text and nested wildcard expressions stay intact.</p>
      <div className="button-row"><button type="button" className="primary" disabled={saving} onClick={()=>void apply()}>{saving?'Saving…':'Apply to prompt'}</button><button type="button" disabled={saving} onClick={onClose}>Cancel</button></div>
    </div>
  </Modal>;
}

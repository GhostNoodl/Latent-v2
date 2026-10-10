import { Modal } from './ui';
import { wildcardCatalog } from '../shared/dynamic-prompt-recipe';
import { activeWildcardNames, mixWildcardPrompt } from '../shared/wildcard-mixer';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { insertTag, tagToken, type TagSource, type TagSuggestion } from '../shared/tag-autocomplete';
import { findTags } from './tag-search';
import './tag-prompt.css';

const preferenceKey = 'latent.tag-source';
const listeners = new Set<() => void>();
let source: TagSource = 'both';
try { const saved = localStorage.getItem(preferenceKey); if (saved && ['both', 'e621', 'danbooru', 'off'].includes(saved)) source = saved as TagSource; } catch { /* Private browser storage can be unavailable. */ }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function setSource(value: TagSource) { source = value; try { localStorage.setItem(preferenceKey, value); } catch {} for (const listener of listeners) listener(); }

export function TagPrompt({ value, onChange, wildcards, wildcardSelections, onWildcardSelections, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onChange: (value: string) => void; wildcards?: Record<string,string[]>; wildcardSelections?: Record<string,string[]>; onWildcardSelections?: (value:Record<string,string[]>)=>void }) {
  const selectedSource = useSyncExternalStore(subscribe, () => source);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [composing, setComposing] = useState(false);
  const [results, setResults] = useState<TagSuggestion[]>([]);
  const [active, setActive] = useState(0);
  const [error, setError] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 300, height: 290 });
  const catalog = wildcards ? wildcardCatalog(wildcards) : {};
  const [editing,setEditing]=useState<string>();
  const [choiceQuery,setChoiceQuery]=useState('');
  const [chosen,setChosen]=useState<string[]>([]);
  const wildcardMatch = wildcards && selection.start===selection.end ? /(?<!\\)__([A-Za-z0-9_./-]*)$/.exec(value.slice(0,selection.start)) : null;
  const wildcardQuery = focused && !dismissed && !composing && wildcardMatch && !wildcardMatch[1].endsWith('__') ? wildcardMatch[1] : undefined;
  let activeWildcards:string[]=[];try{activeWildcards=[...activeWildcardNames(value)];}catch{}
  const wildcardValues=(name:string)=>wildcardSelections?.[name]??wildcardSelections?.[name.replace(/^starter_/,'')]??catalog[name]??catalog[name.replace(/^starter_/,'')]??[];
  function acceptWildcard(name:string) {
    if(!wildcardMatch)return;
    const start=selection.start-wildcardMatch[0].length;
    const tail=value.slice(selection.start).replace(/^[A-Za-z0-9_./-]*__/,'');
    const next=value.slice(0,start)+'__'+name+'__'+tail;
    if(props.maxLength&&next.length>props.maxLength)return;
    onChange(next);setDismissed(true);
    requestAnimationFrame(()=>{const caret=start+name.length+4;textarea.current?.focus();textarea.current?.setSelectionRange(caret,caret);syncSelection();});
  }
  const token = tagToken(value, selection.start, selection.end);
  const query = focused && !dismissed && !composing && selectedSource !== 'off' && wildcardQuery===undefined ? token?.query : undefined;
  useEffect(() => {
    let current = true; setResults([]); setActive(0); setError(false);
    if (!query) return;
    findTags(query, selectedSource).then(items => { if (current) setResults(items); }).catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [query, selectedSource, value, selection.start, selection.end]);
  const wildcardResults = wildcardQuery===undefined ? [] : Object.keys(catalog).filter(name=>name.includes(wildcardQuery) && (!name.startsWith('starter_') || wildcardQuery.startsWith('starter_') || !catalog[name.slice(8)])).slice(0,12).map(name=>({name,count:wildcardValues(name).length,sources:['wildcard']}));
  const suggestions:TagSuggestion[] = wildcardQuery===undefined ? results : wildcardResults;
  const open = Boolean((query||wildcardQuery!==undefined) && suggestions.length);
  useEffect(()=>{setActive(0);},[wildcardQuery]);
  const chosenIndex=Math.min(active,Math.max(0,suggestions.length-1));

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = textarea.current!.parentElement!.getBoundingClientRect();
      const width = Math.min(rect.width, window.innerWidth - 16);
      const below = window.innerHeight - rect.bottom - 12;
      const above = below < 180 && rect.top > below;
      const height = Math.min(290, Math.max(90, above ? rect.top - 12 : below));
      setPosition({ top: above ? rect.top - height - 4 : rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), width, height });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open]);
  function syncSelection() { const element = textarea.current; if (element) setSelection({ start: element.selectionStart, end: element.selectionEnd }); }
  function accept(item: TagSuggestion) {
    if(wildcardQuery!==undefined){acceptWildcard(item.name);return;}
    const element = textarea.current; if (!element) return;
    const current = tagToken(value, element.selectionStart, element.selectionEnd); if (!current) return;
    const next = insertTag(value, current, item.name);
    if (props.maxLength && next.value.length > props.maxLength) return;
    onChange(next.value); setDismissed(true); setResults([]);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(next.caret, next.caret); syncSelection(); });
  }
  return <div className="tag-prompt">
    <textarea {...props} ref={textarea} value={value} aria-autocomplete="list" aria-controls={open ? id : undefined} aria-expanded={open} aria-activedescendant={open ? `${id}-${active}` : undefined}
      onFocus={() => { setFocused(true); if(selectedSource!=='off')void findTags('',selectedSource).catch(()=>{}); syncSelection(); }} onBlur={() => { setFocused(false); setResults([]); }}
      onSelect={syncSelection} onClick={() => { setDismissed(false); syncSelection(); }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => { setComposing(false); syncSelection(); }}
      onChange={event => { setDismissed(false); onChange(event.target.value); syncSelection(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing) return;
        if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(true); return; }
        if (open && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = (active + (event.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length; setActive(next); document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' }); return; }
          if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); accept(suggestions[chosenIndex]); return; }
        }
        props.onKeyDown?.(event);
      }} />
    {wildcards && !!activeWildcards.length && <div className="wildcard-active-chips">{activeWildcards.map(name=><span key={name}><button type="button" onClick={()=>{setEditing(name);setChosen([...wildcardValues(name)]);setChoiceQuery('');}}>{name.replace(/^starter_/,'')} · {wildcardValues(name).length} choices</button><button type="button" aria-label={'Remove '+name} onClick={()=>onChange(mixWildcardPrompt(value,new Set(),new Set([name])))}>×</button></span>)}</div>}
    {editing && onWildcardSelections && <Modal title={'Choices for '+editing.replace(/^starter_/,'')} onClose={()=>setEditing(undefined)}><p>Pick the choices this prompt can use. Each generation selects one.</p><input aria-label="Find wildcard choice" placeholder="Search choices…" value={choiceQuery} onChange={e=>setChoiceQuery(e.target.value)}/><div className="button-row"><button type="button" onClick={()=>setChosen([...(catalog[editing]??catalog[editing.replace(/^starter_/,'')]??[])])}>Select all</button><button type="button" onClick={()=>setChosen([])}>Deselect all</button><span>{chosen.length} selected</span></div><div className="wildcard-choice-grid">{[...new Set([...(catalog[editing]??catalog[editing.replace(/^starter_/,'')]??[]),...wildcardValues(editing)])].filter(v=>v.replaceAll('_',' ').includes(choiceQuery.toLowerCase().replaceAll('_',' '))).map(v=><label key={v}><input type="checkbox" checked={chosen.includes(v)} onChange={e=>setChosen(previous=>e.target.checked?[...previous,v]:previous.filter(x=>x!==v))}/>{v.replaceAll('_',' ')}</label>)}</div><button type="button" className="primary" disabled={!chosen.length} onClick={()=>{onWildcardSelections({...wildcardSelections,[editing]:chosen});setEditing(undefined);}}>Use selected choices</button><button type="button" onClick={()=>setEditing(undefined)}>Cancel</button></Modal>}
    <div className="tag-prompt-tools"><label>Tags <select aria-label="Tag autocomplete source" value={selectedSource} onChange={event => setSource(event.target.value as TagSource)}><option value="both">e621 + Danbooru</option><option value="e621">e621</option><option value="danbooru">Danbooru</option><option value="off">Off</option></select></label>{error && <span role="status">Tag lookup unavailable; you can still type.</span>}</div>
    {open && createPortal(<div className="tag-suggestions" style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.height }}><div className="tag-suggestions-hint">↑↓ choose · Tab / Enter insert · Esc close</div><ul id={id} role="listbox" aria-label="Tag suggestions" style={{ maxHeight: position.height - 30 }}>{suggestions.map((item, index) => <li id={`${id}-${index}`} key={item.name} role="option" aria-selected={index === active} onMouseDown={event => event.preventDefault()} onClick={() => accept(item)}><span><strong>{wildcardQuery!==undefined?'__'+item.name+'__':item.name.replaceAll('_',' ')}</strong>{item.alias && <small>Alias: {item.alias.replaceAll('_',' ')}</small>}</span><small>{item.sources.join(' · ')} · {Intl.NumberFormat('en', { notation: 'compact' }).format(item.count)}</small></li>)}</ul></div>, textarea.current?.closest('.studio') ?? document.body)}
  </div>;
}

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

export function TagPrompt({ value, onChange, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onChange: (value: string) => void }) {
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
  const token = tagToken(value, selection.start, selection.end);
  const query = focused && !dismissed && !composing && selectedSource !== 'off' ? token?.query : undefined;
  useEffect(() => {
    let current = true; setResults([]); setActive(0); setError(false);
    if (!query) return;
    const timer = setTimeout(() => { findTags(query, selectedSource).then(items => { if (current) setResults(items); }).catch(() => { if (current) setError(true); }); }, 100);
    return () => { current = false; clearTimeout(timer); };
  }, [query, selectedSource, value, selection.start, selection.end]);
  const open = Boolean(query && results.length);
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
    const element = textarea.current; if (!element) return;
    const current = tagToken(value, element.selectionStart, element.selectionEnd); if (!current) return;
    const next = insertTag(value, current, item.name);
    if (props.maxLength && next.value.length > props.maxLength) return;
    onChange(next.value); setDismissed(true); setResults([]);
    requestAnimationFrame(() => { element.focus(); element.setSelectionRange(next.caret, next.caret); syncSelection(); });
  }
  return <div className="tag-prompt">
    <textarea {...props} ref={textarea} value={value} aria-autocomplete="list" aria-controls={open ? id : undefined} aria-expanded={open} aria-activedescendant={open ? `${id}-${active}` : undefined}
      onFocus={() => { setFocused(true); syncSelection(); }} onBlur={() => { setFocused(false); setResults([]); }}
      onSelect={syncSelection} onClick={() => { setDismissed(false); syncSelection(); }}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => { setComposing(false); syncSelection(); }}
      onChange={event => { setDismissed(false); onChange(event.target.value); syncSelection(); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing) return;
        if (open && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(true); return; }
        if (open && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = (active + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length; setActive(next); document.getElementById(`${id}-${next}`)?.scrollIntoView({ block: 'nearest' }); return; }
          if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); accept(results[active]); return; }
        }
        props.onKeyDown?.(event);
      }} />
    <div className="tag-prompt-tools"><label>Tags <select aria-label="Tag autocomplete source" value={selectedSource} onChange={event => setSource(event.target.value as TagSource)}><option value="both">e621 + Danbooru</option><option value="e621">e621</option><option value="danbooru">Danbooru</option><option value="off">Off</option></select></label>{error && <span role="status">Tag lookup unavailable; you can still type.</span>}</div>
    {open && createPortal(<div className="tag-suggestions" style={{ top: position.top, left: position.left, width: position.width, maxHeight: position.height }}><div className="tag-suggestions-hint">↑↓ choose · Tab / Enter insert · Esc close</div><ul id={id} role="listbox" aria-label="Tag suggestions" style={{ maxHeight: position.height - 30 }}>{results.map((item, index) => <li id={`${id}-${index}`} key={item.name} role="option" aria-selected={index === active} onMouseDown={event => event.preventDefault()} onClick={() => accept(item)}><span><strong>{item.name}</strong>{item.alias && <small>Alias: {item.alias}</small>}</span><small>{item.sources.join(' · ')} · {Intl.NumberFormat('en', { notation: 'compact' }).format(item.count)}</small></li>)}</ul></div>, textarea.current?.closest('.studio') ?? document.body)}
  </div>;
}

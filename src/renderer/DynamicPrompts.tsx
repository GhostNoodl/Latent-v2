import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Dices, Eye, LockKeyhole, Plus, Save, Trash2 } from 'lucide-react';
import { createWildcardSnapshot, prepareDynamicPromptDraft, type DynamicPromptAuthoring, type DynamicPromptDraft, type PreparedDynamicPrompt, type WildcardSnapshot } from '../shared/dynamic-prompt-recipe';
import { Busy, Field, Modal, Notice, Toggle } from './ui';
import './dynamic-prompts.css';

export interface DynamicPromptsProps {
  draft: DynamicPromptDraft & { seed?: string };
  wildcards: WildcardSnapshot;
  /** A concrete seed already allocated by the composer, when Random is in use. */
  previewSeed?: string;
  onChange(value: DynamicPromptAuthoring): void;
  /** Clear the freeze and allocate a new seed to request a new variation. */
  onReroll(): void;
  onSaveWildcards(entries: Record<string, string[]>): Promise<WildcardSnapshot>;
}
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function DynamicPrompts({ draft, wildcards, previewSeed, onChange, onReroll, onSaveWildcards }: DynamicPromptsProps) {
  const enabled = draft.dynamicPrompts?.enabled ?? false;
  const frozen = draft.dynamicPrompts?.frozen;
  const concreteSeed = previewSeed ?? (draft.seed !== 'random' ? draft.seed : undefined);
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<PreparedDynamicPrompt>();
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [entries, setEntries] = useState<Record<string, string[]>>({});
  const [selectedTag, setSelectedTag] = useState(''); const [newTag, setNewTag] = useState('');
  const [entryText, setEntryText] = useState(''); const [editorError, setEditorError] = useState(''); const [saving, setSaving] = useState(false);
  const serial = useRef(0);
  const alive = useRef(true); const savingRef = useRef(false); const closingRef = useRef(false);
  const [closing, setClosing] = useState(false); const [closeWarning, setCloseWarning] = useState(false);
  const baseline = useRef(''); const dirty = useRef(false);
  const pendingSave = useRef<Promise<boolean> | undefined>(undefined);
  dirty.current = editorOpen && (JSON.stringify(currentEntries()) !== baseline.current || Boolean(newTag));
  useEffect(() => {
    alive.current = true;
    const before = window.latent?.onBeforeClose?.(async () => {
      closingRef.current = true; setClosing(true);
      await pendingSave.current;
      if (dirty.current) {
        closingRef.current = false; setClosing(false); setCloseWarning(true);
        throw new Error('The wildcard editor has unsaved changes. Save or discard its lists before closing the studio.');
      }
    });
    const cancelled = window.latent?.onCloseCancelled?.(() => { closingRef.current = false; setClosing(false); });
    return () => { alive.current = false; before?.(); cancelled?.(); };
  }, []);
  const cannotEdit = () => !alive.current || savingRef.current || closingRef.current;
  useEffect(() => {
    const current = ++serial.current;
    setPreview(undefined); setPreviewError(''); setPreviewBusy(false);
    if (!enabled || !showPreview || (!frozen && !concreteSeed)) return;
    const timer = setTimeout(() => {
      setPreviewBusy(true);
      void prepareDynamicPromptDraft(draft, concreteSeed ?? frozen!.resolutionSeed, wildcards)
        .then(result => { if (current === serial.current) setPreview(result); })
        .catch(error => { if (current === serial.current) setPreviewError(errorText(error)); })
        .finally(() => { if (current === serial.current) setPreviewBusy(false); });
    }, 180);
    return () => { clearTimeout(timer); serial.current++; };
  }, [enabled, frozen, draft.prompt, draft.negativePrompt, concreteSeed, wildcards.revision, showPreview]);
  function openEditor() {
    if (cannotEdit()) return;
    const copy = structuredClone(wildcards.entries); const first = Object.keys(copy).sort()[0] ?? '';
    baseline.current = JSON.stringify(copy); setCloseWarning(false);
    setEntries(copy); setSelectedTag(first); setEntryText(first ? copy[first].join('\n') : ''); setNewTag(''); setEditorError(''); setEditorOpen(true);
  }
  function currentEntries() {
    return selectedTag ? { ...entries, [selectedTag]: entryText.split(/\r?\n/).filter(line => line.length > 0) } : { ...entries };
  }
  function selectTag(tag: string) { if (cannotEdit()) return; const next = currentEntries(); setEntries(next); setSelectedTag(tag); setEntryText(next[tag]?.join('\n') ?? ''); setEditorError(''); }
  function addTag() {
    if (cannotEdit()) return;
    const tag = newTag.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(tag)) { setEditorError('Use 1–128 letters, digits, underscores, dots, slashes or hyphens, starting with a letter or digit.'); return; }
    const next = currentEntries(); if (Object.hasOwn(next, tag)) { setEditorError('That wildcard name already exists. Select it to edit its entries.'); return; }
    next[tag] = []; setEntries(next); setSelectedTag(tag); setEntryText(''); setNewTag(''); setEditorError('');
  }
  function deleteTag() {
    if (cannotEdit()) return;
    const next = currentEntries(); delete next[selectedTag]; const first = Object.keys(next).sort()[0] ?? '';
    setEntries(next); setSelectedTag(first); setEntryText(next[first]?.join('\n') ?? ''); setEditorError('');
  }
  function requestClose() {
    if (cannotEdit()) return;
    if (dirty.current) setCloseWarning(true); else setEditorOpen(false);
  }
  function discard() {
    if (cannotEdit()) return;
    dirty.current = false; setCloseWarning(false); setEditorOpen(false);
  }
  async function save() {
    if (cannotEdit()) return;
    if (newTag.trim()) { setEditorError('Add the new wildcard name before saving, or clear its name field.'); return; }
    savingRef.current = true; setSaving(true); setEditorError('');
    const next = currentEntries();
    const work = (async () => {
      try {
        await createWildcardSnapshot(next);
        if (!alive.current) return false;
        await onSaveWildcards(next);
        if (alive.current) { dirty.current = false; baseline.current = JSON.stringify(next); setCloseWarning(false); setEditorOpen(false); }
        return true;
      } catch (error) { if (alive.current) setEditorError(errorText(error)); return false; }
      finally { savingRef.current = false; if (alive.current) setSaving(false); }
    })();
    pendingSave.current = work;
    try { await work; } finally { if (pendingSave.current === work) pendingSave.current = undefined; }
  }

  return <section className={`dynamic-prompts ${enabled ? 'enabled' : ''}`} aria-label="Prompt variations">
    <div className="dynamic-heading"><Toggle label="Prompt variations" checked={enabled} onChange={value => { if (!closingRef.current) onChange({ enabled: value }); }} /><button type="button" className="text-button" disabled={saving || closing} onClick={openEditor}><BookOpen size={13} />Wildcards <span className="badge">{Object.keys(wildcards.entries).length}</span></button></div>
    {enabled ? <>
      <p className="muted small">Use <code>{'{sunny|misty}'}</code> for a choice or <code>__weather__</code> for a named wildcard. Escape literal braces with <code>\{'{'}</code> and <code>\{'}'}</code>.</p>
      {frozen && <Notice><div className="dynamic-frozen"><LockKeyhole size={15} /><div><strong>Saved variations are frozen</strong><p>These exact words will be reused, even if the image seed or your wildcard list changes. Editing either prompt clears the freeze.</p><button type="button" className="text-button" disabled={closing} onClick={() => { if (!closingRef.current) onReroll(); }}><Dices size={13} />Regenerate variations</button></div></div></Notice>}
      <div className="dynamic-actions"><button type="button" className="text-button" aria-expanded={showPreview} onClick={() => setShowPreview(!showPreview)}><Eye size={14} />{showPreview ? 'Hide expanded prompts' : 'Preview expanded prompts'}</button>{frozen && <span className="muted small">Saved choice seed {frozen.resolutionSeed}</span>}</div>
      {showPreview && !concreteSeed && !frozen && <p className="muted small">Random resolves choices once when the job is queued. Choose a fixed image seed to preview its exact expanded text.</p>}
      {showPreview && previewBusy && <p className="dynamic-loading"><Busy active />Resolving variations…</p>}
      {showPreview && previewError && <Notice error>{previewError}</Notice>}
      {showPreview && preview && <div className="dynamic-preview"><div><h4>Expanded positive prompt</h4><pre>{preview.prompt || '(empty)'}</pre></div><div><h4>Expanded negative prompt</h4><pre>{preview.negativePrompt || '(empty)'}</pre></div><details><summary>Choice trace · {preview.recipe!.positive.choices.length + preview.recipe!.negative.choices.length} selections</summary>{(['positive', 'negative'] as const).map(side => <div key={side}><h4>{side === 'positive' ? 'Positive' : 'Negative'}</h4>{preview.recipe![side].choices.length ? <ol>{preview.recipe![side].choices.map((choice, index) => <li key={index}><strong>{choice.kind === 'wildcard' ? `__${choice.tag}__` : 'Inline choice'}</strong> · option {choice.selectedIndex + 1}<code>{choice.resolvedValue || '(empty)'}</code><small>{choice.source}:{choice.start}–{choice.end}</small></li>)}</ol> : <p className="muted small">No choices in this prompt.</p>}</div>)}</details><p className="muted small"><Check size={12} />{preview.reusedFrozen ? 'Exact saved expansion.' : `Uses image seed ${concreteSeed}.`} Choices and the wildcard snapshot are saved with generated images.</p></div>}
    </> : <p className="muted small">Off: prompts are sent literally, including braces and double underscores.</p>}
    <div className="wildcard-catalog" aria-label="Available wildcards">{Object.keys(wildcards.entries).length ? Object.keys(wildcards.entries).sort().map(name => <button type="button" key={name} title={wildcards.entries[name].slice(0, 4).join(', ')} onClick={() => { if (!closingRef.current) { openEditor(); } }}><code>__{name}__</code><small> {wildcards.entries[name].length} entries</small></button>) : <p className="muted small">No wildcards saved yet. Open Wildcards to create reusable lists such as __weather__.</p>}</div>
    {editorOpen && <Modal title="Named wildcards" onClose={requestClose}><div className="wildcard-editor"><p className="muted small">Keep reusable lists here, then reference them as <code>__name__</code>. Saved image recipes retain the list they originally used.</p><div className="wildcard-add"><Field label="New wildcard name"><input value={newTag} maxLength={128} onChange={event => { if (!cannotEdit()) setNewTag(event.target.value); }} placeholder="weather" disabled={saving || closing} /></Field><button type="button" onClick={addTag} disabled={saving || closing || !newTag.trim()}><Plus size={15} />Add</button></div>{Object.keys(entries).length > 0 ? <><Field label="Wildcard"><select value={selectedTag} disabled={saving || closing} onChange={event => selectTag(event.target.value)}>{Object.keys(entries).sort().map(tag => <option value={tag} key={tag}>{`__${tag}__`}</option>)}</select></Field><Field label="Entries · one per line" hint="Entries may use choices or another wildcard. Empty lines are ignored; use {|} for an empty option."><textarea rows={9} maxLength={262144} value={entryText} onChange={event => { if (!cannotEdit()) setEntryText(event.target.value); }} disabled={saving || closing} placeholder={'sunny afternoon\n{misty|rainy} morning\nmoonlit night'} /></Field><button className="text-button" type="button" onClick={deleteTag} disabled={saving || closing}><Trash2 size={13} />Remove this wildcard</button></> : <p className="muted small">No named wildcards yet. Add a name and a few entries to begin.</p>}{editorError && <Notice error>{editorError}</Notice>}{closeWarning && <Notice><strong>Unsaved wildcard changes</strong><p>Save your lists, keep editing, or discard these edits.</p><div className="button-row"><button type="button" disabled={saving || closing} onClick={() => setCloseWarning(false)}>Keep editing</button><button type="button" disabled={saving || closing} onClick={discard}>Discard changes</button></div></Notice>}<p className="muted small">Wildcard lists are saved explicitly. Prompt-memory switches apply to the compositor, while saved wildcard lists and image recipes remain available.</p><div className="button-row"><button type="button" className="primary" disabled={saving || closing} onClick={() => void save()}><Busy active={saving} />{!saving && <Save size={15} />}Save wildcard lists</button><button type="button" disabled={saving || closing} onClick={requestClose}>Cancel</button></div></div></Modal>}
  </section>;
}

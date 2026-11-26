import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Download, FileUp, FolderUp, Package, Plus, Save, Search, Trash2 } from 'lucide-react';
import { WildcardPacks } from './WildcardPacks';
import { cleanSpeciesPreset, stageWildcardPack } from '../shared/wildcard-packs';
import { createWildcardSnapshot, type WildcardSnapshot } from '../shared/dynamic-prompt-recipe';
import { isWildcardName, isWildcardNote } from '../shared/dynamic-prompts';
import { mergeWildcardImports, parseWildcardFile, type WildcardImport } from '../shared/wildcard-import';
import { Busy, Modal, Notice } from './ui';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const plural = (count: number, word: string) => `${count.toLocaleString('en-US')} ${word}${count === 1 ? '' : 's'}`;
const choiceCount = (lines: readonly string[]) => lines.filter(line => !isWildcardNote(line)).length;

/** Reads dropped files and folders in the window (folder names become part of the list names). */
async function readDropped(event: DragEvent): Promise<WildcardImport> {
  const files: { path: string; file: File }[] = [];
  type Entry = FileSystemEntry & Partial<FileSystemFileEntry & FileSystemDirectoryEntry>;
  async function walk(entry: Entry, prefix: string, depth: number) {
    if (depth > 8 || files.length > 5000) return;
    if (entry.isFile && entry.file)
      files.push({ path: prefix + entry.name, file: await new Promise<File>((ok, fail) => entry.file!(ok, fail)) });
    else if (entry.isDirectory && entry.createReader) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
        if (!batch.length) break;
        for (const child of batch) await walk(child as Entry, `${prefix}${entry.name}/`, depth + 1);
      }
    }
  }
  const items = [...event.dataTransfer.items];
  const entries = items.map(item => item.webkitGetAsEntry?.() as Entry | null);
  if (entries.some(Boolean)) {
    for (const entry of entries) if (entry) await walk(entry, '', 0);
  } else for (const file of event.dataTransfer.files) files.push({ path: file.name, file });
  const results: WildcardImport[] = [];
  for (const { path, file } of files) {
    if (!/\.(txt|ya?ml|json)$/i.test(path)) continue;
    if (file.size > 8 * 1024 * 1024) results.push({ lists: {}, skipped: [path] });
    else results.push(parseWildcardFile(path, await file.text()));
  }
  return mergeWildcardImports(results);
}

export function WildcardListsEditor({
  wildcards,
  onSave,
  onClose,
}: {
  wildcards: WildcardSnapshot;
  onSave(entries: Record<string, string[]>): Promise<WildcardSnapshot>;
  onClose(): void;
}) {
  const [entries, setEntries] = useState<Record<string, string[]>>(() => cleanSpeciesPreset(wildcards.entries));
  const [selected, setSelected] = useState(() => Object.keys(wildcards.entries).sort()[0] ?? '');
  const [text, setText] = useState(() => entries[selected]?.join('\n') ?? '');
  const [filter, setFilter] = useState('');
  const [newName, setNewName] = useState('');
  const [packsOpen, setPacksOpen] = useState(() => !Object.keys(wildcards.entries).length);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closeWarning, setCloseWarning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const baseline = useRef(JSON.stringify(cleanSpeciesPreset(wildcards.entries)));
  const alive = useRef(true);
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const pendingSave = useRef<Promise<boolean> | undefined>(undefined);
  const dirty = useRef(false);
  const current = () =>
    selected && Object.hasOwn(entries, selected)
      ? { ...entries, [selected]: text.split(/\r?\n/).filter(line => line.length > 0) }
      : { ...entries };
  dirty.current = JSON.stringify(current()) !== baseline.current || Boolean(newName.trim());
  const locked = saving || closing || busy;
  useEffect(() => {
    alive.current = true;
    const before = window.latent?.onBeforeClose?.(async () => {
      closingRef.current = true;
      setClosing(true);
      await pendingSave.current;
      if (dirty.current) {
        closingRef.current = false;
        setClosing(false);
        setCloseWarning(true);
        throw new Error('Your wildcard lists have changes that aren’t saved. Save or discard them before closing.');
      }
    });
    const cancelled = window.latent?.onCloseCancelled?.(() => {
      closingRef.current = false;
      setClosing(false);
    });
    return () => {
      alive.current = false;
      before?.();
      cancelled?.();
    };
  }, []);

  function show(next: Record<string, string[]>, name: string) {
    setEntries(next);
    setSelected(name);
    setText(next[name]?.join('\n') ?? '');
    setPacksOpen(false);
    setError('');
  }
  function addList() {
    const name = newName.trim().replace(/\s+/g, '_');
    if (!isWildcardName(name)) {
      setError('List names use letters, numbers, _ . - and / for folders, and start with a letter or number.');
      return;
    }
    const next = current();
    if (Object.hasOwn(next, name)) {
      show(next, name);
      setNewName('');
      return;
    }
    next[name] = [];
    setNewName('');
    show(next, name);
  }
  function addPack(id: string) {
    try {
      const staged = stageWildcardPack(current(), id);
      show(staged.entries, staged.name);
      setNote(
        staged.added
          ? `Added __${staged.name}__. Press Save to keep it.`
          : `You already have this pack as __${staged.name}__.`,
      );
    } catch (problem) {
      setError(errorText(problem));
    }
  }
  function remove() {
    const next = current();
    delete next[selected];
    show(next, Object.keys(next).sort()[0] ?? '');
  }
  function merge(result: WildcardImport) {
    const next = current();
    let added = 0;
    let updated = 0;
    for (const [name, lines] of Object.entries(result.lists)) {
      if (Object.hasOwn(next, name)) updated++;
      else added++;
      next[name] = lines;
    }
    const first = Object.keys(result.lists).sort()[0];
    if (first) show(next, first);
    const parts = [added && `added ${plural(added, 'list')}`, updated && `updated ${plural(updated, 'list')}`].filter(
      Boolean,
    );
    const skipped = result.skipped.length ? ` Skipped ${plural(result.skipped.length, 'file')} that had no lists.` : '';
    setNote(
      parts.length
        ? `${parts.join(', ').replace(/^./, c => c.toUpperCase())}. Press Save to keep them.${skipped}`
        : `Nothing to add.${skipped}`,
    );
  }
  async function importFrom(folder: boolean) {
    if (locked) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.latent.importWildcards(folder);
      if (result && alive.current) merge(result);
    } catch (problem) {
      if (alive.current) setError(errorText(problem));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function exportAll() {
    if (locked) return;
    setBusy(true);
    setError('');
    try {
      const result = await window.latent.exportWildcards(current());
      if (result && alive.current) setNote(`Saved ${plural(result.files, 'file')} in ${result.folder}.`);
    } catch (problem) {
      if (alive.current) setError(errorText(problem));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (locked) return;
    setBusy(true);
    try {
      merge(await readDropped(event));
    } catch (problem) {
      setError(errorText(problem));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function requestClose() {
    if (locked) return;
    if (dirty.current) setCloseWarning(true);
    else onClose();
  }
  async function save() {
    if (locked) return;
    if (newName.trim()) {
      setError('Press Add for the new list name first, or clear it.');
      return;
    }
    const next = current();
    const empty = Object.keys(next).find(name => !choiceCount(next[name]));
    if (empty) {
      show(next, empty);
      setError(`__${empty}__ is empty. Add a line or remove the list.`);
      return;
    }
    setSaving(true);
    setError('');
    const work = (async () => {
      try {
        await createWildcardSnapshot(next);
        if (!alive.current) return false;
        await onSave(next);
        dirty.current = false;
        baseline.current = JSON.stringify(next);
        if (alive.current) onClose();
        return true;
      } catch (problem) {
        if (alive.current) setError(errorText(problem));
        return false;
      } finally {
        if (alive.current) setSaving(false);
      }
    })();
    pendingSave.current = work;
    try {
      await work;
    } finally {
      if (pendingSave.current === work) pendingSave.current = undefined;
    }
  }

  const all = current();
  const names = Object.keys(all).sort();
  const query = filter.trim().toLowerCase();
  const shown = query ? names.filter(name => name.toLowerCase().includes(query)) : names;
  const totalLines = Object.values(all).reduce((sum, lines) => sum + lines.length, 0);
  const selectedLines = selected && Object.hasOwn(all, selected) ? all[selected] : undefined;

  return (
    <Modal title="Wildcard lists" onClose={requestClose}>
      <div
        className={`wildcard-lists ${dragging ? 'dragging' : ''}`}
        onDragOver={event => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={event => {
          if (event.currentTarget === event.target) setDragging(false);
        }}
        onDrop={event => void drop(event)}
      >
        <div className="wildcard-lists-tools">
          <button type="button" aria-pressed={packsOpen} disabled={locked} onClick={() => setPacksOpen(!packsOpen)}>
            <Package size={14} />
            Starter packs
          </button>
          <button type="button" disabled={locked} onClick={() => void importFrom(false)}>
            <FileUp size={14} />
            Import files
          </button>
          <button type="button" disabled={locked} onClick={() => void importFrom(true)}>
            <FolderUp size={14} />
            Import folder
          </button>
          <button type="button" disabled={locked || !names.length} onClick={() => void exportAll()}>
            <Download size={14} />
            Export
          </button>
          <span className="muted small">
            {plural(names.length, 'list')} · {plural(totalLines, 'line')}
          </span>
        </div>
        <div className="wildcard-lists-body">
          <nav className="wildcard-lists-nav" aria-label="Your lists">
            <label className="wildcard-lists-search">
              <Search size={13} />
              <input
                type="search"
                aria-label="Find a list"
                placeholder="Find a list"
                value={filter}
                onChange={event => setFilter(event.target.value)}
              />
            </label>
            <div className="wildcard-lists-names">
              {shown.map(name => (
                <button
                  type="button"
                  key={name}
                  aria-pressed={name === selected && !packsOpen}
                  disabled={locked}
                  onClick={() => show(current(), name)}
                >
                  <code>{name}</code>
                  <small>{choiceCount(all[name]).toLocaleString('en-US')}</small>
                </button>
              ))}
              {!shown.length && <p className="muted small">{names.length ? 'No lists match.' : 'No lists yet.'}</p>}
            </div>
            <div className="wildcard-lists-new">
              <input
                aria-label="New list name"
                placeholder="New list, like weather"
                value={newName}
                maxLength={128}
                disabled={locked}
                onChange={event => setNewName(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addList();
                  }
                }}
              />
              <button type="button" aria-label="Add list" disabled={locked || !newName.trim()} onClick={addList}>
                <Plus size={15} />
                Add
              </button>
            </div>
          </nav>
          <div className="wildcard-lists-main">
            {packsOpen ? (
              <WildcardPacks disabled={locked} onAdd={addPack} />
            ) : selectedLines ? (
              <>
                <div className="wildcard-lists-heading">
                  <code>__{selected}__</code>
                  <span className="muted small">{plural(choiceCount(text.split(/\r?\n/)), 'choice')}</span>
                  <button type="button" className="text-button" disabled={locked} onClick={remove}>
                    <Trash2 size={13} />
                    Remove list
                  </button>
                </div>
                <textarea
                  aria-label={`Lines in ${selected}`}
                  value={text}
                  spellCheck={false}
                  disabled={locked}
                  onChange={event => setText(event.target.value)}
                  placeholder={'sunny afternoon\n{misty|rainy} morning\n# lines starting with # are notes'}
                />
                <p className="muted small">
                  One choice per line. Lines can use {'{a|b}'} and other lists. Lines starting with # are notes.
                </p>
              </>
            ) : (
              <div className="wildcard-lists-empty">
                <p>Make a list, add a starter pack, or drop .txt, .yaml or .json wildcard files here.</p>
              </div>
            )}
          </div>
        </div>
        {dragging && <div className="wildcard-lists-drop">Drop wildcard files or folders</div>}
        {note && !error && <p className="wildcard-lists-note small">{note}</p>}
        {error && <Notice error>{error}</Notice>}
        {closeWarning && (
          <Notice>
            <strong>You have changes that aren’t saved</strong>
            <div className="button-row">
              <button type="button" disabled={locked} onClick={() => setCloseWarning(false)}>
                Keep editing
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => {
                  dirty.current = false;
                  onClose();
                }}
              >
                Discard changes
              </button>
            </div>
          </Notice>
        )}
        <div className="button-row wildcard-lists-footer">
          <button type="button" className="primary" disabled={locked} onClick={() => void save()}>
            <Busy active={saving || busy} />
            {!saving && !busy && <Save size={15} />}Save
          </button>
          <button type="button" disabled={locked} onClick={requestClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

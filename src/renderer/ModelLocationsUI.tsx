import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, ChevronRight, Folder, FolderPlus, FolderInput, LoaderCircle, MoveRight, RotateCcw, Unplug } from 'lucide-react';
import type { ModelAsset, ModelKind } from '../shared/types';
import type { ModelLocationsActions, ModelLocationsSnapshot } from '../shared/model-locations';
import { bytes, Modal, Notice } from './ui';
import { actionErrorMessage } from '../shared/action-error';
import './model-locations.css';

export interface ModelLocationsUIProps {
  snapshot: ModelLocationsSnapshot;
  models: readonly ModelAsset[];
  actions: ModelLocationsActions;
  onChange: (snapshot: ModelLocationsSnapshot) => void;
}
const folderLabel = (relative: string) => relative || 'Root folder';
const parentFolder = (filename: string) => filename.includes('/') ? filename.slice(0, filename.lastIndexOf('/')) : '';

/** Deliberate physical organization, separate from logical collections. This
 * component only calls private model-folder actions; it never applies a draft.
 */
export function ModelLocationsUI({ snapshot, models, actions, onChange }: ModelLocationsUIProps) {
  const [open, setOpen] = useState(false); const [kind, setKind] = useState<ModelKind>('checkpoint');
  const [folder, setFolder] = useState(''); const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState(''); const [destination, setDestination] = useState('');
  const [error, setError] = useState(''); const [success, setSuccess] = useState(''); const [pending, setPending] = useState('');
  const [page, setPage] = useState(0); const active = useRef(false); const mounted = useRef(true); const id = useId();
  const [closing, setClosing] = useState(false); const closingRef = useRef(false);
  const pendingWork = useRef<Promise<boolean> | undefined>(undefined);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const before = window.latent?.onBeforeClose?.(async () => { closingRef.current = true; setClosing(true); await pendingWork.current; });
    const cancelled = window.latent?.onCloseCancelled?.(() => { closingRef.current = false; setClosing(false); });
    return () => { before?.(); cancelled?.(); };
  }, []);
  const folders = snapshot.folders.filter(item => item.kind === kind);
  const availableFolder = folders.some(item => item.relativePath === folder) ? folder : '';
  const availableDestination = folders.some(item => item.relativePath === destination) ? destination : '';
  const items = models.filter(model => !model.id.startsWith('external:') && model.kind === kind && parentFolder(model.filename) === availableFolder).sort((a, b) => a.name.localeCompare(b.name));
  const selected = models.find(model => model.id === selectedId && model.kind === kind);
  const destinationPath = selected ? [availableDestination, selected.filename.split('/').at(-1)].filter(Boolean).join('/') : '';
  const blocked = Boolean(closing || pending || snapshot.changeBlockedReason || snapshot.recoveryRequired || snapshot.error);
  const rootChangeBlocked = Boolean(closing || pending || snapshot.changeBlockedReason || snapshot.recoveryRequired);
  const pageSize = 20; const visiblePage = Math.min(page, Math.max(0, Math.ceil(items.length / pageSize) - 1));
  const close = () => { if (!active.current && !closingRef.current) setOpen(false); };
  async function execute(label: string, operation: () => Promise<ModelLocationsSnapshot | null>, message: string) {
    if (!mounted.current || closingRef.current || active.current) return false;
    active.current = true; setPending(label); setError(''); setSuccess('');
    const work = (async () => {
      try { const next = await operation(); if (!next || !mounted.current) return false; onChange(next); setSuccess(message); return true; }
      catch (reason) { if (mounted.current) setError(actionErrorMessage(reason)); return false; }
      finally { active.current = false; if (mounted.current) setPending(''); }
    })();
    pendingWork.current = work;
    try { return await work; } finally { if (pendingWork.current === work) pendingWork.current = undefined; }
  }
  const create = async () => {
    if (blocked || !name.trim()) return;
    if (await execute('Creating folder…', () => actions.createFolder({ kind, parent: availableFolder, name }), 'Private folder created.')) setName('');
  };
  const move = async () => {
    if (blocked || !selected?.sha256 || selected.status !== 'ready' || selected.filename === destinationPath) return;
    const model = selected;
    if (await execute('Verifying model bytes and moving the private file…', () => actions.moveModel({ modelId: model.id, destinationFolder: availableDestination, expectedSha256: model.sha256! }), `${model.name} moved. Saved recipes and collection membership still refer to the same model.`)) { setSelectedId(''); setFolder(availableDestination); setPage(0); }
  };
  return <>
    <button type="button" className="model-locations-open" onClick={() => { setError(''); setSuccess(''); setOpen(true); }}><Folder size={15} />Model folders{snapshot.recoveryRequired && <span>Recovery needed</span>}</button>
    {open && <Modal title="Model folders" onClose={close}><div className="model-locations">
      <p className="model-locations-explanation">Organize checkpoint and LoRA files inside this studio. Moving a model keeps its saved recipes, metadata, and collections connected to the same bytes.</p>
      <Notice>Stop the generation engine and finish or cancel queued jobs before changing folders or reusable-directory registrations.</Notice>
      {snapshot.changeBlockedReason && <Notice>{snapshot.changeBlockedReason}</Notice>}
      {snapshot.error && <Notice error>{snapshot.error}</Notice>}
      {error && <Notice error>{error}</Notice>}
      {success && <p className="model-locations-success" role="status">{success}</p>}
      {pending && <p className="model-locations-pending" role="status"><LoaderCircle className="spin" size={16} />{pending}<small>Large model verification may take a little while. Keep this window open.</small></p>}
      {snapshot.recoveryRequired && <section className="model-locations-recovery"><strong>A model folder operation needs attention.</strong><p>The recovery journal keeps track of an interrupted move. Recovery verifies the exact files before finishing or rolling back that operation. Unexpected or changed files are kept for review.</p><button type="button" disabled={Boolean(pending || snapshot.changeBlockedReason)} onClick={() => { void execute('Checking the interrupted move…', () => actions.recover(), 'Model folders recovered.'); }}><RotateCcw size={15} />Recover interrupted move</button></section>}
      {actions.chooseExternalRoot && <section className="model-locations-external"><div><strong>Reuse an existing directory</strong><p>Choose a checkpoint or LoRA folder explicitly. Latent reads the original model files and stores metadata here; it does not copy, move, rename, or delete files in that directory. Conflicting filenames block generation until resolved.</p></div><div className="button-row"><button type="button" disabled={rootChangeBlocked} onClick={() => { void execute('Choose and verify a read-only checkpoint directory…', () => actions.chooseExternalRoot!('checkpoint'), 'Checkpoint directory registered for read-only reuse.'); }}><FolderInput size={15} />Choose checkpoint folder</button><button type="button" disabled={rootChangeBlocked} onClick={() => { void execute('Choose and verify a read-only LoRA directory…', () => actions.chooseExternalRoot!('lora'), 'LoRA directory registered for read-only reuse.'); }}><FolderInput size={15} />Choose LoRA folder</button><button type="button" disabled={rootChangeBlocked} onClick={() => { void execute('Rechecking model directory identities…', () => actions.recover(), 'Directory checks passed.'); }}><RotateCcw size={15} />Recheck directories</button></div>
        {(snapshot.externalRoots ?? []).map(root => <article className="model-locations-external-root" key={root.id}><div><strong>{root.label} <span>{root.active ? 'Read-only' : 'Disconnected'}</span></strong><code>{root.path}</code><small>{root.kind === 'checkpoint' ? 'Checkpoints' : 'LoRAs'} · {root.modelCount} retained model identities{!root.active && ' · choose this directory again to reconnect'}</small>{root.error && <p className="model-locations-root-error">{root.error}</p>}</div>{root.active && actions.unregisterExternalRoot && <button type="button" disabled={rootChangeBlocked} onClick={() => { void execute('Disconnecting the read-only directory…', () => actions.unregisterExternalRoot!(root.id), 'Directory disconnected. Original files and saved recipe references were kept.'); }}><Unplug size={15} />Disconnect</button>}</article>)}
      </section>}
      <strong className="model-locations-private-heading">Organize private files</strong>
      <div className="model-locations-browser">
        <label htmlFor={`${id}-kind`}>Model type<select id={`${id}-kind`} value={kind} disabled={Boolean(pending)} onChange={event => { setKind(event.target.value as ModelKind); setFolder(''); setDestination(''); setSelectedId(''); setPage(0); }}><option value="checkpoint">Checkpoints</option><option value="lora">LoRAs</option></select></label>
        <label htmlFor={`${id}-folder`}>Browse folder<select id={`${id}-folder`} value={availableFolder} disabled={Boolean(pending)} onChange={event => { setFolder(event.target.value); setPage(0); }}><option value="">Root folder</option>{folders.filter(item => item.relativePath).map(item => <option key={item.relativePath} value={item.relativePath}>{item.relativePath}</option>)}</select></label>
      </div>
      <div className="model-locations-create"><label htmlFor={`${id}-name`}>New folder inside {folderLabel(availableFolder)}<input id={`${id}-name`} value={name} maxLength={120} placeholder="Portraits, styles, experiments…" disabled={blocked} onChange={event => setName(event.target.value)} onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void create(); } }} /></label><button type="button" disabled={blocked || !name.trim()} onClick={() => { void create(); }}><FolderPlus size={15} />Create folder</button></div>
      <div className="model-locations-list" aria-label="Models in this folder">{items.slice(visiblePage * pageSize, (visiblePage + 1) * pageSize).map(model => <label className={`model-locations-item ${model.id === selectedId ? 'selected' : ''}`} key={model.id}><input type="radio" name={`${id}-selected-model`} checked={model.id === selectedId} disabled={blocked || model.status !== 'ready' || !model.sha256} onChange={() => { setSelectedId(model.id); setDestination(parentFolder(model.filename)); }} /><span><strong>{model.name}</strong><small>{model.filename}</small></span><small>{model.status === 'ready' ? bytes(model.bytes) : 'Missing or changed'}</small></label>)}{!items.length && <p className="model-locations-empty">No {kind === 'checkpoint' ? 'checkpoints' : 'LoRAs'} in this folder.</p>}</div>
      <div className="model-locations-pages"><span>{items.length ? `${visiblePage * pageSize + 1}–${Math.min((visiblePage + 1) * pageSize, items.length)} of ${items.length}` : '0 models'}</span><button type="button" className="icon-button" aria-label="Previous models" disabled={!visiblePage || Boolean(pending)} onClick={() => setPage(visiblePage - 1)}><ChevronLeft size={15} /></button><button type="button" className="icon-button" aria-label="Next models" disabled={(visiblePage + 1) * pageSize >= items.length || Boolean(pending)} onClick={() => setPage(visiblePage + 1)}><ChevronRight size={15} /></button></div>
      {selected && <section className="model-locations-move"><strong>Move {selected.name}</strong><label htmlFor={`${id}-destination`}>Destination folder<select id={`${id}-destination`} value={availableDestination} disabled={blocked} onChange={event => setDestination(event.target.value)}><option value="">Root folder</option>{folders.filter(item => item.relativePath).map(item => <option key={item.relativePath} value={item.relativePath}>{item.relativePath}</option>)}</select></label><div className="model-locations-route"><span>{selected.filename}</span><ArrowRight size={15} /><span>{destinationPath}</span></div><p>The filename stays the same. An existing destination file will never be replaced.</p><button type="button" className="primary" disabled={blocked || selected.status !== 'ready' || !selected.sha256 || selected.filename === destinationPath} onClick={() => { void move(); }}><MoveRight size={15} />Move selected model</button></section>}
      <div className="model-locations-footer"><small>Collections group models without moving files. Private folders change their physical location.</small><button type="button" disabled={Boolean(pending)} onClick={close}>Done</button></div>
    </div></Modal>}
  </>;
}

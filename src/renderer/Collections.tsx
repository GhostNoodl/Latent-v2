import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, FolderHeart, List, LoaderCircle, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { COLLECTION_LIMITS, type CollectionActions, type CollectionKind, type CollectionSnapshot } from '../shared/collections-types';
import { Modal, Notice } from './ui';
import './collections.css';

export interface CollectionItem { id: string; label: string; unavailable?: boolean; }
interface CollectionComponentProps {
  snapshot: CollectionSnapshot;
  kind: CollectionKind;
  actions: CollectionActions;
  onChange: (snapshot: CollectionSnapshot) => void;
}
export interface CollectionToolbarProps extends CollectionComponentProps {
  selectedId?: string;
  onSelect: (id: string | undefined) => void;
  /** Full inventory for this kind, before search/type/collection filtering. */
  items?: readonly CollectionItem[];
  /** Inspection only; implementations must not apply a generation recipe. */
  onOpenItem?: (id: string) => void;
}
export interface CollectionMembershipButtonProps extends CollectionComponentProps { memberId: string; memberLabel: string; }

function useCollectionMutation(onChange: CollectionComponentProps['onChange']) {
  const [pending, setPending] = useState(false); const [error, setError] = useState('');
  const active = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function execute(task: () => Promise<CollectionSnapshot>) {
    if (!mounted.current || active.current) return false;
    active.current = true; setPending(true); setError('');
    try { const snapshot = await task(); if (!mounted.current) return false; onChange(snapshot); return true; }
    catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)); return false; }
    finally { active.current = false; if (mounted.current) setPending(false); }
  }
  return { execute, pending, error, clearError: () => setError('') };
}

export function CollectionToolbar({ snapshot, kind, selectedId, onSelect, actions, onChange, items, onOpenItem }: CollectionToolbarProps) {
  const [open, setOpen] = useState(false); const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string }>();
  const [expanded, setExpanded] = useState<string>(); const [memberPage, setMemberPage] = useState(0);
  const { execute, pending, error, clearError } = useCollectionMutation(onChange);
  const selectId = useId(); const nameId = useId();
  const collections = snapshot.collections.filter(collection => collection.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
  const knownItems = useMemo(() => new Map(items?.map(item => [item.id, item])), [items]);
  const selectedExists = !selectedId || collections.some(collection => collection.id === selectedId);
  useEffect(() => { if (selectedId && !selectedExists) onSelect(undefined); }, [selectedId, selectedExists, onSelect]);
  const expandedCollection = collections.find(collection => collection.id === expanded);
  const pageSize = 25;
  const page = Math.min(memberPage, Math.max(0, Math.ceil((expandedCollection?.memberIds.length ?? 0) / pageSize) - 1));
  const missing = (ids: string[]) => items ? ids.filter(id => !knownItems.has(id) || knownItems.get(id)?.unavailable).length : undefined;
  const create = async () => { if (newName.trim() && await execute(() => actions.create(kind, newName))) setNewName(''); };
  const rename = async () => { if (editing?.name.trim() && await execute(() => actions.rename(editing.id, editing.name))) setEditing(undefined); };
  const singular = kind === 'model' ? 'model' : 'image';

  return <div className="collection-toolbar">
    <label htmlFor={selectId}>Collection</label><select id={selectId} value={selectedExists ? selectedId ?? '' : ''} onChange={event => onSelect(event.target.value || undefined)}><option value="">All {singular}s</option>{collections.map(collection => <option key={collection.id} value={collection.id}>{collection.name} ({collection.memberIds.length})</option>)}</select><button type="button" onClick={() => { clearError(); setOpen(true); }}><FolderHeart size={15} />Manage collections</button>
    {open && <Modal title={`${kind === 'model' ? 'Model' : 'Image'} collections`} onClose={() => setOpen(false)}>
      <div className="collection-manager">
        <p className="collection-explanation">Keep {singular}s in named groups. Removing a collection or membership keeps its images, models, and saved recipes.</p>
        {error && <Notice error>{error}</Notice>}
        <div className="collection-create"><label htmlFor={nameId}>New collection</label><div><input id={nameId} value={newName} maxLength={COLLECTION_LIMITS.nameCharacters} disabled={pending || collections.length >= COLLECTION_LIMITS.perKind} placeholder={kind === 'model' ? 'Portrait tools, favorite styles…' : 'Favorites, character studies…'} onChange={event => setNewName(event.target.value)} onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void create(); } }} /><button type="button" className="primary" disabled={pending || !newName.trim() || collections.length >= COLLECTION_LIMITS.perKind} onClick={() => { void create(); }}><Plus size={15} />Create</button></div></div>
        {collections.length >= COLLECTION_LIMITS.perKind && <Notice>You have reached 100 {singular} collections. Rename an existing collection or remove a group you no longer need.</Notice>}
        {pending && <p className="collection-pending" role="status"><LoaderCircle className="spin" size={14} />Saving collection changes…</p>}
        {collections.length ? <div className="collection-list" aria-label="Saved collections">{collections.map(collection => <article className="collection-row" key={collection.id}>
          {editing?.id === collection.id ? <div className="collection-rename"><input aria-label={`New name for ${collection.name}`} value={editing.name} maxLength={COLLECTION_LIMITS.nameCharacters} disabled={pending} autoFocus onChange={event => setEditing({ id: collection.id, name: event.target.value })} onKeyDown={event => { if (!event.nativeEvent.isComposing && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void rename(); } }} /><button type="button" disabled={pending || !editing.name.trim()} aria-label="Save collection name" onClick={() => { void rename(); }}><Save size={15} /></button><button type="button" disabled={pending} aria-label="Cancel rename" onClick={() => setEditing(undefined)}><X size={15} /></button></div> : <><div className="collection-description"><strong>{collection.name}</strong><small>{collection.memberIds.length} {collection.memberIds.length === 1 ? singular : `${singular}s`}{missing(collection.memberIds) ? ` · ${missing(collection.memberIds)} unavailable` : ''}</small></div><div className="button-row"><button type="button" disabled={pending} aria-label={`View items in ${collection.name}`} aria-expanded={expanded === collection.id} onClick={() => { setExpanded(expanded === collection.id ? undefined : collection.id); setMemberPage(0); }}><List size={14} />Items</button><button type="button" disabled={pending} aria-label={`Rename ${collection.name}`} onClick={() => setEditing({ id: collection.id, name: collection.name })}><Pencil size={14} /></button><button type="button" disabled={pending} aria-label={`Remove collection ${collection.name}; keep its files`} title="Remove collection; keep its files" onClick={() => { void execute(() => actions.remove(collection.id)); }}><Trash2 size={14} />Remove group</button></div></>}
        </article>)}</div> : <p className="collection-empty">Create a collection, then use an item’s Collections button to add it.</p>}
        {expandedCollection && <section className="collection-members" aria-label={`Items in ${expandedCollection.name}`}><div className="collection-members-heading"><strong>{expandedCollection.name}</strong><span>{expandedCollection.memberIds.length ? `${page * pageSize + 1}–${Math.min((page + 1) * pageSize, expandedCollection.memberIds.length)} of ${expandedCollection.memberIds.length}` : 'Empty collection'}</span><button type="button" className="icon-button" disabled={!page} aria-label="Previous collection items" onClick={() => setMemberPage(page - 1)}><ChevronLeft size={14} /></button><button type="button" className="icon-button" disabled={(page + 1) * pageSize >= expandedCollection.memberIds.length} aria-label="Next collection items" onClick={() => setMemberPage(page + 1)}><ChevronRight size={14} /></button></div><div className="collection-member-list">{expandedCollection.memberIds.slice(page * pageSize, (page + 1) * pageSize).map(id => { const item = knownItems.get(id); const unavailable = Boolean(items && (!item || item.unavailable)); return <div className="collection-member" key={id}><div><strong>{item?.label ?? id}</strong>{unavailable && <small>Unavailable in the current studio inventory. Membership is kept for recovery.</small>}</div><div className="button-row">{onOpenItem && !unavailable && <button type="button" disabled={pending} onClick={() => { setOpen(false); onOpenItem(id); }}>View</button>}<button type="button" disabled={pending} aria-label={`Remove ${item?.label ?? id} from ${expandedCollection.name}; keep its file`} onClick={() => { void execute(() => actions.removeMembers(expandedCollection.id, [id])); }}>Remove from group</button></div></div>; })}</div>{!expandedCollection.memberIds.length && <p className="collection-empty">Add {singular}s using their Collections buttons.</p>}</section>}
        <div className="collection-footer"><small>Collections organize references inside this studio.</small><button type="button" onClick={() => setOpen(false)}>Done</button></div>
      </div>
    </Modal>}
  </div>;
}

export function CollectionMembershipButton(props: CollectionMembershipButtonProps) {
  const [open, setOpen] = useState(false);
  const assigned = props.snapshot.collections.filter(collection => collection.kind === props.kind && collection.memberIds.includes(props.memberId));
  return <>
    <button type="button" className="collection-membership-button" onClick={() => setOpen(true)} aria-label={`Collections for ${props.memberLabel}`} title={assigned.length ? assigned.map(collection => collection.name).join(', ') : 'Add this item to a collection'}><FolderHeart size={14} />Collections{assigned.length > 0 && <span>{assigned.length}</span>}</button>
    {open && <CollectionMembershipDialog {...props} onClose={() => setOpen(false)} />}
  </>;
}

export function CollectionMembershipDialog({ snapshot, kind, memberId, memberLabel, actions, onChange, onClose }: CollectionMembershipButtonProps & { onClose: () => void }) {
  const { execute, pending, error } = useCollectionMutation(onChange);
  const collections = snapshot.collections.filter(collection => collection.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
  return <Modal title="Choose collections" onClose={onClose}><div className="collection-manager"><p className="collection-item-label">{memberLabel}</p><p className="collection-explanation">Check a group to add this item; uncheck it to remove the membership. Its files and saved recipe are kept.</p>{error && <Notice error>{error}</Notice>}{pending && <p className="collection-pending" role="status"><LoaderCircle className="spin" size={14} />Saving membership…</p>}{collections.length ? <div className="collection-membership-list">{collections.map(collection => <label key={collection.id}><input type="checkbox" checked={collection.memberIds.includes(memberId)} disabled={pending} onChange={event => { const add = event.target.checked; void execute(() => add ? actions.addMembers(collection.id, [memberId]) : actions.removeMembers(collection.id, [memberId])); }} /><span>{collection.name}<small>{collection.memberIds.length} {kind === 'model' ? (collection.memberIds.length === 1 ? 'model' : 'models') : (collection.memberIds.length === 1 ? 'image' : 'images')}</small></span></label>)}</div> : <p className="collection-empty">Create a group with Manage collections in the library, then return here to add this item.</p>}<div className="collection-footer"><small>Membership changes are saved locally.</small><button type="button" onClick={onClose}>Done</button></div></div></Modal>;
}

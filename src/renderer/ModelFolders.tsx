import { useState } from 'react';
import { Folder, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import type { StudioCollection } from '../shared/collections-types';
import { Modal } from './ui';

export const MODEL_DRAG_TYPE = 'application/x-latent-model';
export function ModelFolders({ folders, selectedId, count, total, pending, error, onSelect, onCreate, onRename, onRemove, onDropModel }: {
  folders: StudioCollection[]; selectedId?: string; count(id: string): number; total: number; pending: boolean; error?: string;
  onSelect(id?: string): void; onCreate(name: string): Promise<boolean>; onRename(id: string, name: string): Promise<boolean>;
  onRemove(id: string): Promise<boolean>; onDropModel(modelId: string, folderId: string): void;
}) {
  const [editor, setEditor] = useState<{ id?: string; name: string }>();
  const [removing, setRemoving] = useState<StudioCollection>();
  const [over, setOver] = useState<string>();
  return <><aside className="model-folders" aria-label="Model folders">
    <div className="label-row"><h2>Folders</h2><button type="button" disabled={pending} onClick={() => setEditor({ name: '' })}><FolderPlus size={14}/>New folder</button></div>
    <button className="folder-target" aria-pressed={!selectedId} disabled={pending} onClick={() => onSelect()}>All models <span>{total}</span></button>
    {folders.map(folder => <div className="folder-row" key={folder.id}>
      <button className={`folder-target${over === folder.id ? ' drag-over' : ''}`} aria-pressed={selectedId === folder.id} disabled={pending}
        onClick={() => onSelect(folder.id)}
        onDragOver={event => { if (!pending && event.dataTransfer.types.includes(MODEL_DRAG_TYPE)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setOver(folder.id); } }}
        onDragLeave={() => setOver(undefined)} onDrop={event => { event.preventDefault(); setOver(undefined); if (!pending) onDropModel(event.dataTransfer.getData(MODEL_DRAG_TYPE), folder.id); }}>
        <Folder size={15}/><span className="folder-name" title={folder.name}>{folder.name}</span><span>{count(folder.id)}</span>
      </button>
      <button className="icon-button" aria-label={`Rename folder ${folder.name}`} disabled={pending} onClick={() => setEditor({ id: folder.id, name: folder.name })}><Pencil size={13}/></button>
      <button className="icon-button" aria-label={`Remove folder ${folder.name}`} disabled={pending} onClick={() => setRemoving(folder)}><Trash2 size={13}/></button>
    </div>)}
    <p className="muted small">Drag a card here to organize it. Moving from a folder removes it from that folder. Files stay on disk.</p>
    </aside>
    {editor && <Modal title={editor.id ? 'Rename folder' : 'New folder'} onClose={() => { if (!pending) setEditor(undefined); }}>
      <>{error && <p role="alert">{error}</p>}<form onSubmit={event => { event.preventDefault(); const current = editor; void (async () => { if (await (current.id ? onRename(current.id, current.name) : onCreate(current.name))) setEditor(undefined); })(); }}>
        <label>Folder name<input autoFocus required maxLength={80} disabled={pending} value={editor.name} onChange={event => setEditor({ ...editor, name: event.target.value })}/></label>
        <button type="submit" disabled={pending || !editor.name.trim()}>{editor.id ? 'Save name' : 'Create folder'}</button>
      </form></>
    </Modal>}
    {removing && <Modal title="Remove folder" onClose={() => { if (!pending) setRemoving(undefined); }}><p>Remove “{removing.name}”? Its models remain in All models and any other folders. No files are deleted.</p><button disabled={pending} onClick={() => { const id = removing.id; void onRemove(id).then(ok => { if (ok) setRemoving(undefined); }); }}>Remove folder</button></Modal>}
  </>;
}

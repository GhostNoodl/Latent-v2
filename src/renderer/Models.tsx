import { ModelFolders, MODEL_DRAG_TYPE } from './ModelFolders';
import { LocalModelMetadata } from './LocalModelMetadata';
import { ModelArtwork, modelDisplayName } from './ModelPicker';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Boxes, Check, Download, ExternalLink, FileInput, Pencil, RefreshCw, Save, Search, X } from 'lucide-react';
import type { AppSnapshot, ModelAsset, ModelDownloadRequest, ModelKind } from '../shared/types';
import type { CollectionActions, CollectionSnapshot } from '../shared/collections-types';
import { Busy, Field, Modal, Notice, bytes, type RunAction } from './ui';
import { ModelLocationsUI } from './ModelLocationsUI';
import { CollectionMembershipButton } from './Collections';

// Keep effect ownership stable even if the context bridge returns a new proxy on access.

export function Models({ snapshot, receive, run, busy, onUse, collections, collectionActions, onCollectionChange }: { snapshot: AppSnapshot; receive: (snapshot: AppSnapshot) => void; run: RunAction; busy: Record<string, boolean>; onUse: (model: ModelAsset) => void; collections?: CollectionSnapshot; collectionActions?: CollectionActions; onCollectionChange?: (snapshot: CollectionSnapshot) => void }) {
  const [contextModel, setContextModel] = useState<ModelAsset>();
  const [folderPending, setFolderPending] = useState(false);
  const [folderError, setFolderError] = useState('');
  const folderActive = useRef(false);
  const [kind, setKind] = useState<ModelKind>('checkpoint');
  const [query, setQuery] = useState('');
  const [collectionId, setCollectionId] = useState<string>();
  const [editing, setEditing] = useState<ModelAsset>();
  const [editedFamily, setEditedFamily] = useState<ModelAsset['family']>('unknown');
  const [editedTriggers, setEditedTriggers] = useState('');
  const [metadataSaving, setMetadataSaving] = useState(false);
  const editorRevision = useRef(0), savingMetadata = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; editorRevision.current++; }; }, []);
  const search = query.toLowerCase();
  const collection = collections?.collections.find(item => item.kind === 'model' && item.id === collectionId);
  const members = collection ? new Set(collection.memberIds) : undefined;
  const models = snapshot.models.filter(model => (!members || members.has(model.id)) && model.kind === kind && `${modelDisplayName(model, snapshot.settings.civitaiDisplayMetadata !== false)} ${model.name} ${model.filename} ${model.family} ${model.triggers.join(' ')}`.toLowerCase().includes(search));
  const folders = (collections?.collections ?? []).filter(item => item.kind === 'model').sort((a,b) => a.name.localeCompare(b.name));
  useEffect(() => { if (collectionId && !collections?.collections.some(item => item.id === collectionId)) setCollectionId(undefined); }, [collectionId, collections]);
  async function folderMutation(task: () => Promise<void>): Promise<boolean> {
    if (folderActive.current || !collectionActions || !onCollectionChange) return false;
    folderActive.current = true; setFolderPending(true); setFolderError('');
    try { await task(); return true; } catch (error) { setFolderError(error instanceof Error ? error.message : String(error)); return false; }
    finally { folderActive.current = false; setFolderPending(false); }
  }
  async function moveToFolder(modelId: string, destination: string) {
    if (!snapshot.models.some(model => model.id === modelId) || !folders.some(folder => folder.id === destination) || destination === collectionId) return;
    const source = collectionId;
    await folderMutation(async () => {
      // Add first: if removing the old membership fails, the model remains in both folders.
      onCollectionChange!(await collectionActions!.addMembers(destination, [modelId]));
      if (source) onCollectionChange!(await collectionActions!.removeMembers(source, [modelId]));
    });
  }
  const familyName = (family: ModelAsset['family']) => family === 'unknown' ? 'Family not tagged' : family === 'sdxl' ? 'SDXL' : 'Illustrious';
  function edit(model: ModelAsset) { editorRevision.current++; setEditing(model); setEditedFamily(model.family); setEditedTriggers(model.triggers.join(', ')); }
  function closeEditor() { editorRevision.current++; setEditing(undefined); }
  async function saveMetadata() {
    if (!editing || savingMetadata.current || busy['edit-model']) return;
    const revision = editorRevision.current, modelId = editing.id;
    const patch = { family: editedFamily, triggers: editedTriggers.split(',').map(value => value.trim()).filter(Boolean) };
    savingMetadata.current = true; setMetadataSaving(true);
    try {
      await run('edit-model', async () => {
        const result = await window.latent.updateModel(modelId, patch);
        if (!mounted.current) return;
        receive(result);
        // The saved snapshot belongs in the library; only its unchanged editor may close.
        if (editorRevision.current === revision) closeEditor();
      }, 'Model details saved.');
    } finally { savingMetadata.current = false; if (mounted.current) setMetadataSaving(false); }
  }


  return <div className="page-content models-content">
    <div className="models-toolbar">
      <div className="family"><button aria-pressed={kind === 'checkpoint'} onClick={() => setKind('checkpoint')}>Checkpoints</button><button aria-pressed={kind === 'lora'} onClick={() => setKind('lora')}>LoRAs</button></div>
      <div className="button-row">
        <ModelLocationsUI snapshot={snapshot.modelLocations} models={snapshot.models} actions={{ createFolder: window.latent.createModelFolder, moveModel: window.latent.moveModel, recover: window.latent.recoverModelLocations, chooseExternalRoot: window.latent.chooseExternalModelRoot, unregisterExternalRoot: window.latent.unregisterExternalModelRoot }} onChange={() => { void run('refresh-locations', async () => receive(await window.latent.getSnapshot())); }} />
        
        <button disabled={busy['refresh-models']} onClick={() => void run('refresh-models', async () => receive(await window.latent.refreshModels()), 'Model library refreshed.')}><RefreshCw size={15} />Refresh</button>
        
        <button className="primary" disabled={busy.import} onClick={() => void run('import', async () => receive(await window.latent.importModels(kind)))}><Busy active={busy.import} />{!busy.import && <FileInput size={16} />}Import {kind === 'checkpoint' ? 'checkpoint' : 'LoRA'}</button>
      </div>
    </div>
    <Notice>Your models stay in this studio. Import a copy, browse Discover, or add files to <span className="inline-path">{snapshot.paths.models}</span> and refresh.</Notice>
    <label className="search-field"><Search size={17} /><input aria-label="Search models" value={query} onChange={event => setQuery(event.target.value)} placeholder={`Find a ${kind === 'checkpoint' ? 'checkpoint' : 'LoRA'}…`} /></label>

    {folderError && <Notice error>{folderError}</Notice>}
    <div className="model-folder-layout">
    {collections && collectionActions && onCollectionChange && <ModelFolders error={folderError} folders={folders} selectedId={collectionId} pending={folderPending} total={snapshot.models.filter(model=>model.kind===kind).length} count={id=>snapshot.models.filter(model=>model.kind===kind && folders.find(folder=>folder.id===id)?.memberIds.includes(model.id)).length} onSelect={setCollectionId}
      onCreate={name=>folderMutation(async()=>{ const result=await collectionActions.create('model',name); onCollectionChange(result); setCollectionId(result.collections.find(folder=>folder.kind==='model' && !collections.collections.some(old=>old.id===folder.id))?.id); })}
      onRename={(id,name)=>folderMutation(async()=>onCollectionChange(await collectionActions.rename(id,name)))}
      onRemove={id=>folderMutation(async()=>{onCollectionChange(await collectionActions.remove(id));if(collectionId===id)setCollectionId(undefined);})}
      onDropModel={(modelId,id)=>{void moveToFolder(modelId,id);}} />}
    <div className="model-folder-content">
    <div className="section-heading" style={{ marginBottom: 14 }}><h2>{collection ? collection.name : 'In your studio'}</h2><span className="muted small">{models.length} {kind === 'checkpoint' ? 'checkpoints' : 'LoRAs'}</span></div>
    {models.length ? <div className="model-grid">{models.map(model => <article className="model-card" key={model.id} draggable={Boolean(collectionActions) && !folderPending} onDragStart={event=>{ if ((event.target as HTMLElement).closest('button,input,select,summary,a')) { event.preventDefault(); return; } event.dataTransfer.setData(MODEL_DRAG_TYPE,model.id); event.dataTransfer.effectAllowed='move'; }} tabIndex={0} onContextMenu={event=>{event.preventDefault();setContextModel(model);}} onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();setContextModel(model);}}}>
      <ModelArtwork model={model} showCivitai={snapshot.settings.civitaiDisplayMetadata !== false} history={snapshot.history} /><div className="model-description"><h3>{modelDisplayName(model, snapshot.settings.civitaiDisplayMetadata !== false)}</h3>{snapshot.settings.civitaiDisplayMetadata !== false && model.civitai && <p className="muted small">{model.civitai.versionName}{model.civitai.creator && ` · by ${model.civitai.creator}`}</p>}<div className="model-badges"><span className="badge">{familyName(model.family)}</span><span>{bytes(model.bytes)}</span>{model.status === 'missing' && <span className="inline-error">File missing</span>}</div>{model.triggers.length > 0 && <p className="trigger-preview">Prompt prefixes: {model.triggers.join(', ')}</p>}{collectionActions && <div className="model-folder-actions"><select aria-label={`Move ${model.name} to folder`} value="" disabled={folderPending || !folders.some(folder=>folder.id!==collectionId)} onChange={event=>{void moveToFolder(model.id,event.target.value);}}><option value="">{collectionId ? 'Move to folder…' : 'Add to folder…'}</option>{folders.filter(folder=>folder.id!==collectionId).map(folder=><option key={folder.id} value={folder.id}>{folder.name}</option>)}</select>{collectionId && <button type="button" disabled={folderPending} aria-label={`Remove ${model.name} from folder`} onClick={()=>{void folderMutation(async()=>onCollectionChange!(await collectionActions.removeMembers(collectionId,[model.id])));}}>Remove from folder</button>}</div>}<details className="model-management"><summary>Manage</summary><p className="model-filename">{model.filename}</p><button className="text-button" onClick={()=>setContextModel(model)}>Details / manage file</button><button className="text-button" onClick={() => edit(model)}><Pencil size={12} />Edit family / triggers</button>{collections && collectionActions && onCollectionChange && <CollectionMembershipButton snapshot={collections} kind="model" memberId={model.id} memberLabel={model.name} actions={collectionActions} onChange={onCollectionChange} />}
        {model.sourceUrl && <div className="button-row"><a className="text-button" href={model.sourceUrl} target="_blank" rel="noreferrer">Model source <ExternalLink size={11} /></a>{model.licenseUrl && <a className="text-button" href={model.licenseUrl} target="_blank" rel="noreferrer">License <ExternalLink size={11} /></a>}</div>}
      </details></div><button disabled={model.status !== 'ready'} onClick={() => onUse(model)}>Use<ArrowRight size={15} /></button>
    </article>)}</div> : <div className="page-empty"><span className="seed-mark"><Boxes size={28} /></span><h2>{query || collection ? 'No installed matches' : `No ${kind === 'checkpoint' ? 'checkpoints' : 'LoRAs'} installed yet`}</h2><p>{collection ? 'No models match this collection, type, and search. Try the other model type or choose All models.' : query ? 'Try another model name or clear your search.' : 'Import a model from your computer or find one in Discover.'}</p>{!query && !collection && <button disabled={busy.import} onClick={() => void run('import', async () => receive(await window.latent.importModels(kind)))}><FileInput size={16} />Import from your computer</button>}</div>}

    </div></div>
    {contextModel && <LocalModelMetadata model={contextModel} onClose={()=>setContextModel(undefined)} onUpdated={receive} />}
    {editing && <Modal title={`Edit ${editing.name}`} onClose={closeEditor}>
      <form onSubmit={event => { event.preventDefault(); void saveMetadata(); }}>
        <Field label="Model family" hint="Use the family listed by the model's creator."><select autoFocus value={editedFamily} onChange={event => { editorRevision.current++; setEditedFamily(event.target.value as ModelAsset['family']); }}><option value="unknown">Not tagged</option><option value="illustrious">Illustrious</option><option value="sdxl">SDXL</option></select></Field>
        {editing.kind === 'lora' && <Field label="Trigger words" hint="Separate words or phrases with commas. These are added at generation time when automatic triggers are enabled."><textarea rows={3} value={editedTriggers} onChange={event => { editorRevision.current++; setEditedTriggers(event.target.value); }} /></Field>}
        <button className="primary" disabled={metadataSaving || busy['edit-model']}><Busy active={metadataSaving || busy['edit-model']} />{!metadataSaving && !busy['edit-model'] && <Save size={15} />}Save details</button>
      </form>
    </Modal>}
  </div>;
}

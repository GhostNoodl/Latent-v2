import { isLoraFamilyCompatible } from '../shared/types';
import { cleanModelStem } from '../shared/model-names';
import { useEffect, useState } from 'react';
import { Boxes, Image, Layers, Folder } from 'lucide-react';
import type { AppSnapshot, ModelAsset } from '../shared/types';
import { LocalModelMetadata } from './LocalModelMetadata';
import { Modal } from './ui';

export const modelDisplayName = (model: ModelAsset, showCivitai = true) => (showCivitai ? model.civitai?.modelName?.trim() : '') || cleanModelStem(model.name);

export function ModelArtwork({ model, history = [], showCivitai = true }: { model: ModelAsset; showCivitai?: boolean; history: AppSnapshot['history'] }) {
  const example = history.find(record => model.kind === 'checkpoint' ? record.checkpoint?.id === model.id : record.loras.some(lora => lora.id === model.id));
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => { setFailed([]); }, [model.id, model.civitai?.fetchedAt, model.civitai?.previewUrl]);
  const remote = showCivitai && model.civitai?.previewUrl && /^https:\/\/(image|imagecache)\.civitai\.com\//.test(model.civitai.previewUrl) ? model.civitai.previewUrl : undefined;
  if (remote && !failed.includes(remote)) return <img className="model-artwork" src={remote} referrerPolicy="no-referrer" alt={`${model.name} creator preview`} loading="lazy" onError={() => setFailed(previous => [...previous, remote])} />;
  return example && !failed.includes(example.imageUrl) ? <img className="model-artwork" src={example.imageUrl} alt={`Generated example using ${model.name}`} loading="lazy" onError={() => setFailed(previous => [...previous, example.imageUrl])} /> : <span className="model-artwork placeholder" aria-label="No preview yet">{model.kind === 'lora' ? <Layers /> : <Image />}</span>;
}

export function ModelPicker({ snapshot, kind, selectedIds, family, onChoose, onClose, onUpdated }: { snapshot: AppSnapshot; onUpdated?(snapshot: AppSnapshot): void; kind: 'checkpoint' | 'lora'; selectedIds: string[]; family?: string; onChoose: (model: ModelAsset) => void; onClose: () => void }) {
  const [contextModel, setContextModel] = useState<ModelAsset>();
  const [query, setQuery] = useState('');
  const [collection, setCollection] = useState('');
  const collections = snapshot.collections.collections.filter(item => item.kind === 'model').sort((a,b)=>a.name.localeCompare(b.name));
  useEffect(()=>{if(collection && !snapshot.collections.collections.some(item=>item.kind==='model' && item.id===collection))setCollection('');},[collection,snapshot.collections]);
  const inventory = snapshot.models.filter(model=>model.kind===kind);
  const count = (ids?: string[]) => inventory.filter(model=>!ids || ids.includes(model.id)).length;
  const members = collections.find(item => item.id === collection)?.memberIds;
  const models = snapshot.models.filter(model => model.kind === kind && (!members || members.includes(model.id)) && `${modelDisplayName(model, snapshot.settings.civitaiDisplayMetadata !== false)} ${model.name} ${model.family} ${model.triggers.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <Modal title={kind === 'checkpoint' ? 'Choose a checkpoint' : 'Add a LoRA'} onClose={onClose}>
    <div className="model-picker-layout">
    <nav className="picker-folders" aria-label="Model folders"><h4>Folders</h4><button type="button" className="folder-target" aria-pressed={!collection} onClick={()=>setCollection('')}><span>All {kind==='lora'?'LoRAs':'checkpoints'}</span><span>{count()}</span></button>{collections.map(item=><button key={item.id} type="button" className="folder-target" aria-pressed={collection===item.id} onClick={()=>setCollection(item.id)}><Folder size={15}/><span className="folder-name" title={item.name}>{item.name}</span><span>{count(item.memberIds)}</span></button>)}</nav>
    <div className="model-picker-results"><div className="picker-filters"><input autoFocus aria-label="Search model cards" placeholder="Name, family or trigger…" value={query} onChange={event => setQuery(event.target.value)} /></div>
    <div className="visual-model-grid">{models.map(model => <button type="button" className="visual-model-card" key={model.id} onContextMenu={event=>{event.preventDefault();setContextModel(model);}} onKeyDown={event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();setContextModel(model);}}} aria-pressed={selectedIds.includes(model.id)} disabled={model.status !== 'ready' || kind === 'lora' && (!isLoraFamilyCompatible(model.family, family) || selectedIds.includes(model.id))} onClick={() => onChoose(model)}>
      <ModelArtwork model={model} showCivitai={snapshot.settings.civitaiDisplayMetadata !== false} history={snapshot.history} /><strong>{modelDisplayName(model, snapshot.settings.civitaiDisplayMetadata !== false)}</strong><small><Boxes size={12} /> {model.family} · {(model.bytes / 1e9).toFixed(1)} GB</small><small>{model.status !== 'ready' ? 'Missing file' : kind === 'lora' && !isLoraFamilyCompatible(model.family, family) ? 'Different checkpoint family' : model.triggers.slice(0, 3).join(', ') || (model.kind === 'lora' ? 'LoRA' : 'Checkpoint')}</small>
    </button>)}</div>{!models.length && <p>No matches in this folder. Try another folder or clear your search.</p>}
    </div></div>
    {contextModel && <LocalModelMetadata onUpdated={onUpdated} model={contextModel} onClose={()=>setContextModel(undefined)} />}
  </Modal>;
}

import { useState } from 'react';
import { SIZE_PRESETS } from '../shared/defaults';
import { settingsSchema } from '../shared/validation';
import type { AppSettings } from '../shared/types';
import { Field, Modal } from './ui';
type Size = { name: string; width: number; height: number };
export function SizePresets({ sizes = SIZE_PRESETS, width, height, onChoose, onSave }: { sizes?: Size[]; width: number; height: number; onChoose(size: Size): void; onSave(sizes: NonNullable<AppSettings['sizePresets']>): Promise<void> }) {
  const [editing, setEditing] = useState<Size[]>(), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const change = (index: number, value: Partial<Size>) => setEditing(previous => previous?.map((size, i) => i === index ? {...size, ...value} : size));
  const save = async () => {
    const parsed = settingsSchema.shape.sizePresets.safeParse(editing);
    if (!parsed.success || !parsed.data) { setError('Use unique names, 1–16 presets, and dimensions from 256–2048 in multiples of 8.'); return; }
    setSaving(true); setError('');
    try { await onSave(parsed.data); setEditing(undefined); } catch { setError('Could not save the size presets. Your changes are still here; try again.'); } finally { setSaving(false); }
  };
  return <section className="image-size-section"><div className="label-row"><h2>Image size</h2><button type="button" className="text-button" onClick={() => { setEditing(sizes.map(size => ({...size}))); setError(''); }}>Edit sizes</button></div>
    <div className="size-presets">{sizes.map(size => <button type="button" key={size.name} title={`${size.width} × ${size.height}`} aria-pressed={width === size.width && height === size.height} onClick={() => onChoose(size)}><span className="shape" style={{width: size.width >= size.height ? 17 : 12, height: size.height >= size.width ? 17 : 12}}/>{size.name}</button>)}</div><p className="dimensions">{width} × {height}</p>
    {editing && <Modal title="Image size presets" onClose={() => { if (!saving) setEditing(undefined); }}><p>Choose the sizes shown in Create. Editing this list does not change the current image size.</p><fieldset disabled={saving} className="size-preset-editor">
      {editing.map((size, i) => <div className="size-preset-row" key={i}><Field label={`Name ${i + 1}`}><input maxLength={30} value={size.name} onChange={e => change(i, {name: e.target.value})}/></Field><Field label={`Width ${i + 1}`}><input type="number" min={256} max={2048} step={8} value={size.width || ''} onChange={e => change(i, {width: Number(e.target.value)})}/></Field><Field label={`Height ${i + 1}`}><input type="number" min={256} max={2048} step={8} value={size.height || ''} onChange={e => change(i, {height: Number(e.target.value)})}/></Field><button type="button" disabled={editing.length <= 1} aria-label={`Remove size ${i + 1}`} onClick={() => setEditing(editing.filter((_, index) => index !== i))}>Remove</button></div>)}
      <div className="button-row"><button type="button" disabled={editing.length >= 16} onClick={() => setEditing([...editing, {name: '', width: 1024, height: 1024}])}>Add size</button><button type="button" onClick={() => setEditing(SIZE_PRESETS.map(size => ({...size})))}>Restore defaults</button><button type="button" className="primary" onClick={() => void save()}>{saving ? 'Saving…' : 'Save sizes'}</button></div></fieldset>{error && <p role="alert">{error}</p>}</Modal>}
  </section>;
}

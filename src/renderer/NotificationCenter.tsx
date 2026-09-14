import { useState } from 'react';
import { Bell, X } from 'lucide-react';
import type { AppSnapshot } from '../shared/types';
import { ModelTransfers, type ModelTransferControls } from './ModelTransfers';
import { queueClearKey } from './queue-view';
const transferActions: ModelTransferControls = { getModelTransferRecovery: () => window.latent.getModelTransferRecovery(), retryModelTransfer: request => window.latent.retryModelTransfer(request), cancelModelTransfer: id => window.latent.cancelModelTransfer(id) };
export function NotificationCenter({ open, onOpenChange: setOpen, snapshot, refresh, onQueue }: { open: boolean; onOpenChange(open: boolean): void; snapshot: AppSnapshot; refresh(): Promise<void>; onQueue(): void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const hidden = new Set(snapshot.dismissedActivity?.notifications ?? []);
  const downloads = snapshot.downloads.filter(item => ['downloading','verifying'].includes(item.state));
  const items = [
    ...(snapshot.settings.notifyError ? [{name:'Engine',value:snapshot.backend},{name:'Runtime update',value:snapshot.runtimeUpdates},{name:'Video setup',value:snapshot.video.assets}].filter(item=>item.value?.state==='error').map(item=>({key:`alert:${item.name}:${item.value?.message.slice(0,180)}`,title:`${item.name} needs attention`,detail:item.value?.message || '',at:new Date().toISOString(),job:false})) : []),
    ...(snapshot.notifications ?? []).filter(item => snapshot.settings[item.preference]).map(item => ({ key:`notice:${item.id}`, title:item.title, detail:item.body, at:item.at, job:false })),
    ...snapshot.jobs.filter(job => job.status === 'completed' ? snapshot.settings.notifyGeneration : job.status === 'failed' && snapshot.settings.notifyError).map(job => ({key:`job:${queueClearKey(job)}`,title:job.status === 'failed' ? 'Generation needs attention' : job.kind === 'video' ? 'Video ready' : 'Image ready',detail:job.error || 'Saved to your history.',at:job.updatedAt,job:true})),
  ].filter(item => !hidden.has(item.key)).sort((a,b)=>b.at.localeCompare(a.at));
  async function clear(keys: string[] | null) { if(busy)return; setBusy(true);setError('');try {await window.latent.dismissActivity('notifications',keys);await refresh();}catch(cause){setError(cause instanceof Error?cause.message:'Could not clear notifications.');}finally{setBusy(false);} }
  return <><button type="button" className="notification-button" aria-label="Notifications" aria-expanded={open} onClick={() => setOpen(!open)}><Bell size={17} />{downloads.length > 0 && <span>{downloads.length}</span>}</button>{open && <section className="notification-center" aria-label="Notification center">
    <div className="section-heading"><h2>Notifications</h2><button aria-label="Close notifications" onClick={() => setOpen(false)}><X size={16} /></button></div>
    <div className="button-row"><button disabled={busy || !items.length} onClick={() => void clear(items.map(item=>item.key))}>Clear all</button>{hidden.size > 0 && <button disabled={busy} onClick={() => void clear(null)}>Show cleared</button>}</div>
    {error && <p role="alert">{error}</p>}
    {downloads.map(item=><article className="notification-item" key={item.id}><strong>{item.name}</strong><small>{item.state === 'verifying' ? 'Checking download…' : 'Downloading…'}</small><progress value={item.receivedBytes} max={item.totalBytes || 1} /></article>)}
    {items.slice(0,8).map(item=><article className="notification-item" key={item.key}><div className="label-row"><strong>{item.title}</strong><button disabled={busy} aria-label="Dismiss notification" onClick={()=>void clear([item.key])}><X size={13}/></button></div><small>{new Date(item.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</small><details><summary>Details</summary><p>{item.detail}</p>{item.job && <button onClick={()=>{onQueue();setOpen(false);}}>Open queue</button>}</details></article>)}
    {!items.length && !downloads.length && <p>All caught up.</p>}{items.length>8 && <p className="muted small">{items.length-8} older notifications. Clear these to see earlier items.</p>}
    <details><summary>Manage downloads</summary><ModelTransfers downloads={snapshot.downloads} actions={transferActions} onChange={refresh} /></details>
  </section>}</>;
}

import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { DownloadStatus } from '../shared/types';
import type { ModelTransferRecord, ModelTransferRecovery, ModelTransferRetryRequest } from '../shared/model-transfer-types';
import { Busy, Field, Notice, bytes } from './ui';
import { actionErrorMessage } from '../shared/action-error';

export interface ModelTransferControls {
  getModelTransferRecovery(): Promise<ModelTransferRecovery>;
  retryModelTransfer(request: ModelTransferRetryRequest): Promise<void>;
  cancelModelTransfer(id: string): Promise<void>;
}
export function ModelTransferRow({ download, saved, pending = false, cancelling = false, error, onRetry, onCancel }: {
  download: DownloadStatus; saved?: ModelTransferRecord; pending?: boolean; cancelling?: boolean; error?: string;
  onRetry: (request: ModelTransferRetryRequest) => void; onCancel: (id: string) => void;
}) {
  const [freshSource, setFreshSource] = useState(false); const [url, setUrl] = useState('');
  const active = ['downloading', 'verifying'].includes(download.state);
  const label = active ? download.state : pending ? 'Checking source…' : saved?.state === 'interrupted' ? 'Interrupted' : download.state;
  const canRetry = !active && !pending && ['failed', 'cancelled'].includes(download.state);
  const fresh = saved?.source.kind === 'refresh-required';
  const missingFreshIdentity = fresh && !saved?.request.sha256;
  return <article className="download-item" style={{ alignItems: 'start', flexWrap: 'wrap' }} aria-label={`Transfer ${download.name}`}>
    <div style={{ minWidth: 0, flex: '1 1 360px' }}><strong>{download.name}</strong><p>{label} · {bytes(download.receivedBytes)}{download.totalBytes ? ` / ${bytes(download.totalBytes)}` : ''}{saved ? ` · Attempt ${saved.attempt}` : ''}</p>
      {download.destinationDirectory && <p className="small muted" style={{ overflowWrap: 'anywhere' }}>Destination: {download.destinationDirectory}</p>}
      {saved && <p className="small muted">{saved.request.kind === 'checkpoint' ? 'Checkpoint' : 'LoRA'} · {saved.request.family === 'sdxl' ? 'SDXL' : 'Illustrious'} · {saved.source.origin}</p>}
      {saved?.source.kind === 'civitai' && <p className="small muted">Retry checks the current Civitai file and access again. Manage your optional key in Discover → Civitai settings.</p>}
      {saved?.source.kind === 'civitai' && saved.request.civitai && <p className="small muted">{saved.request.civitai.modelName} · {saved.request.civitai.versionName} · File {saved.request.civitai.fileId}</p>}
      {active && <progress aria-label={`${download.name} download progress`} value={download.totalBytes ? download.receivedBytes : undefined} max={download.totalBytes || undefined} />}
      {saved?.state === 'interrupted' && !active && !pending && <p className="small muted">Stopped before completion. Retry checks the preserved partial before continuing.</p>}
      {(error || download.error) && !active && !pending && <Notice error>{error || download.error}</Notice>}
      {error && (active || pending) && <Notice error>{error}</Notice>}
      {saved?.request.sha256 && <details><summary>File identity</summary><p className="small muted" style={{ overflowWrap: 'anywhere' }}>SHA-256: {saved.request.sha256}</p>{saved.request.provenance && <p className="small muted">{saved.request.provenance.repository} · {saved.request.provenance.licenseName}</p>}</details>}
      {canRetry && !saved && <p className="small muted">This older request has no saved source. Use Download from URL or select its catalog entry again; existing partial files stay preserved.</p>}
      {canRetry && missingFreshIdentity && <p className="small muted">This expiring link has no saved expected checksum. Use Download from URL to review a new request; the original partial stays preserved.</p>}
      {freshSource && fresh && (canRetry || pending || active) && <form style={{ marginTop: 12 }} onSubmit={event => { event.preventDefault(); const freshUrl = url.trim(); setUrl(''); onRetry({ id: download.id, url: freshUrl }); }}>
        <Field label="Fresh URL for the same file" hint="The original link may expire. Filename, family and checksum stay fixed."><input autoFocus required type="url" pattern="https://.*" maxLength={4000} autoComplete="off" spellCheck={false} value={url} disabled={pending || active} onChange={event => setUrl(event.target.value)} placeholder="https://…" /></Field>
        <div className="button-row"><button type="submit" disabled={pending || active || !url.trim()}><RefreshCw size={14} />Retry with fresh URL</button><button type="button" disabled={pending || active} onClick={() => { setFreshSource(false); setUrl(''); }}>Close</button></div>
      </form>}
    </div>
    <div className="button-row">
      {(active || pending) && <button type="button" disabled={cancelling} onClick={() => onCancel(download.id)}><Busy active={cancelling} />{!cancelling && <X size={15} />}Cancel</button>}
      {canRetry && saved && !freshSource && !missingFreshIdentity && <button type="button" onClick={() => fresh ? setFreshSource(true) : onRetry({ id: download.id })}><RefreshCw size={15} />{fresh ? 'Refresh source' : 'Retry / Resume'}</button>}
      {pending && !active && <Busy active />}
    </div>
  </article>;
}

export function ModelTransfers({ downloads, actions, onChange }: { downloads: DownloadStatus[]; actions: ModelTransferControls; onChange: () => Promise<void> }) {
  const [recovery, setRecovery] = useState<ModelTransferRecovery>({ transfers: [], warnings: [] });
  const [loading, setLoading] = useState(false); const [loadError, setLoadError] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({}); const [pending, setPending] = useState<Record<string, boolean>>({}); const [cancelling, setCancelling] = useState<Record<string, boolean>>({});
  const [revision, setRevision] = useState(0); const requestNumber = useRef(0); const alive = useRef(true); const ownPending = useRef(new Set<string>());
  useEffect(() => { alive.current = true; return () => { alive.current = false; requestNumber.current++; }; }, []);
  const signature = downloads.map(item => `${item.id}:${item.state}`).join('|');
  useEffect(() => {
    const request = ++requestNumber.current; setLoading(true);
    void actions.getModelTransferRecovery().then(value => { if (alive.current && request === requestNumber.current) { setRecovery(value); setLoadError(''); } }, error => { if (alive.current && request === requestNumber.current) setLoadError(actionErrorMessage(error)); }).finally(() => { if (alive.current && request === requestNumber.current) setLoading(false); });
  }, [actions.getModelTransferRecovery, signature, revision]);
  const preparing = new Set([...(recovery.preparing ?? []), ...Object.keys(pending).filter(id => pending[id])]);
  const preparingKey = [...preparing].sort().join('|');
  useEffect(() => { if (!preparingKey) return; const timer = setInterval(() => setRevision(value => value + 1), 1000); return () => clearInterval(timer); }, [preparingKey]);
  async function retry(request: ModelTransferRetryRequest) {
    if (ownPending.current.has(request.id)) return; ownPending.current.add(request.id); setPending(value => ({ ...value, [request.id]: true })); setErrors(value => ({ ...value, [request.id]: '' }));
    try { await actions.retryModelTransfer(request); await onChange(); }
    catch (error) { if (alive.current) setErrors(value => ({ ...value, [request.id]: actionErrorMessage(error) })); }
    finally { ownPending.current.delete(request.id); if (alive.current) { setPending(value => ({ ...value, [request.id]: false })); setRevision(value => value + 1); } }
  }
  async function cancel(id: string) {
    setCancelling(value => ({ ...value, [id]: true })); setErrors(value => ({ ...value, [id]: '' }));
    try { await actions.cancelModelTransfer(id); await onChange(); }
    catch (error) { if (alive.current) setErrors(value => ({ ...value, [id]: actionErrorMessage(error) })); }
    finally { if (alive.current) { setCancelling(value => ({ ...value, [id]: false })); setRevision(value => value + 1); } }
  }
  if (!downloads.length && !recovery.warnings.length && !loadError) return null;
  return <section className="download-list" style={{ marginBottom: 22 }} aria-label="Model transfers">
    <div className="section-heading"><h3>Downloads</h3><div className="button-row"><span className="muted small">{downloads.filter(item => ['downloading', 'verifying'].includes(item.state) || preparing.has(item.id)).length} active</span><button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}><Busy active={loading} />{!loading && <RefreshCw size={14} />}Refresh transfers</button></div></div>
    {loadError && <Notice error>{loadError}</Notice>}{recovery.warnings.map((warning, index) => <Notice error key={`${index}:${warning}`}>{warning}</Notice>)}
    {downloads.map(download => <ModelTransferRow key={download.id} download={download} saved={recovery.transfers.find(item => item.id === download.id)} pending={preparing.has(download.id)} cancelling={cancelling[download.id]} error={errors[download.id]} onRetry={request => { void retry(request); }} onCancel={id => { void cancel(id); }} />)}
  </section>;
}

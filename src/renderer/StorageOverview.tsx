import { useRef, useState } from 'react';
import { FolderOpen, HardDrive, RefreshCw } from 'lucide-react';
import type { StorageOverviewSnapshot } from '../shared/storage-types';
import { bytes, Notice, type RunAction } from './ui';
import './storage-overview.css';

export interface StorageOverviewProps {
  refresh: () => Promise<StorageOverviewSnapshot>;
  reveal: (destinationId: string) => Promise<void>;
  run: RunAction;
  initialSnapshot?: StorageOverviewSnapshot;
}
export function StorageOverview({ refresh, reveal, run, initialSnapshot }: StorageOverviewProps) {
  const [snapshot, setSnapshot] = useState(initialSnapshot); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const pending = useRef(false);
  async function update() {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    try { await run('storage-refresh', async () => { try { setSnapshot(await refresh()); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); throw reason; } }); }
    finally { pending.current = false; setBusy(false); }
  }
  const findDestination = (id?: string) => snapshot?.destinations.find(destination => destination.id === id);
  function open(id: string) { void run(`storage-reveal-${id}`, () => reveal(id)); }
  return <section className="storage-overview" aria-label="Private studio storage">
    <div className="section-heading"><h3><HardDrive size={17} />Studio storage</h3><button type="button" disabled={busy} onClick={() => { void update(); }}><RefreshCw size={14} className={busy ? 'spin' : ''} />{busy ? 'Measuring…' : 'Refresh storage'}</button></div>
    <p className="storage-help">Private studio folders only. External model libraries are excluded. Refresh measures file sizes without loading models or checking their full hashes. Package progress and transfers below are snapshots from that measurement; refresh to update them.</p>
    {error && <Notice error>{error}</Notice>}
    {!snapshot && !error && <Notice>Refresh to see available disk space, saved files, partial downloads, and reviewed package destinations.</Notice>}
    {snapshot && <>
      <p className="storage-help">Measured {new Date(snapshot.measuredAt).toLocaleString()} · {snapshot.scannedEntries.toLocaleString()} entries · {snapshot.complete ? 'scan complete' : 'partial scan; folder sizes are lower bounds'}.</p>
      <div className="storage-volumes">{snapshot.volumes.map(volume => <div className="storage-volume" key={volume.id}><strong>{volume.path}</strong><span>{volume.availableBytes === undefined ? 'Available space unknown' : `${bytes(volume.availableBytes)} available`}{volume.totalBytes === undefined ? '' : ` of ${bytes(volume.totalBytes)}`}</span><small>{bytes(volume.uniqueLogicalBytes)} in measured unique studio files</small><small>{bytes(volume.minimumDownloadBytes)} minimum absent payload across the listed packages, counting shared assets once</small>{volume.availableBytes !== undefined && volume.minimumDownloadBytes > volume.availableBytes && <p className="inline-error">The absent package payloads exceed currently available space. Choose the workflows you need; extra setup space is also required.</p>}{volume.error && <p className="inline-error">{volume.error}</p>}</div>)}</div>
      {!snapshot.volumes.length && <Notice error>Available disk space could not be measured.</Notice>}
      {snapshot.warnings.length > 0 && <Notice>{snapshot.warnings.map(warning => <p key={warning}>{warning}</p>)}</Notice>}
      <div className="storage-counts" aria-label="Measured private files">
        <div><strong>{bytes(snapshot.totals.savedBytes)}</strong><span>Saved files</span></div><div><strong>{bytes(snapshot.totals.cacheBytes)}</strong><span>Cache files</span></div><div><strong>{bytes(snapshot.totals.resumablePartialBytes)}</strong><span>Resume candidates</span></div><div><strong>{bytes(snapshot.totals.otherPartialBytes)}</strong><span>Other partial files</span></div><div><strong>{bytes(snapshot.totals.stagingBytes)}</strong><span>Staging / retained files</span></div>
      </div>
      <p className="storage-help">These are logical file sizes, not allocated disk usage. Folder categories count files at each location; the unique-file total counts hard links once. Sparse files, compression and other programs can change actual disk usage. Resume candidates still depend on the server accepting the saved range.</p>
      <details className="storage-folders"><summary>Private folder destinations</summary><div className="storage-folder-list">{snapshot.areas.map(area => { const destination = findDestination(area.destinationId); return <div className="storage-folder" key={area.id}><div><strong>{area.label}</strong><span>{bytes(area.savedBytes + area.cacheBytes + area.resumablePartialBytes + area.otherPartialBytes + area.stagingBytes)} · {area.fileCount.toLocaleString()} files</span><code>{destination?.path ?? 'Destination unavailable'}</code></div><button type="button" className="icon-button" disabled={!destination} aria-label={`Open ${area.label}`} title="Open the nearest existing private folder" onClick={() => open(area.destinationId)}><FolderOpen size={16} /></button></div>; })}</div></details>
      <div className="storage-packages"><h4>Reviewed workflow packages</h4><p className="storage-help">A matching file size is only a reuse candidate. The owning setup service verifies identity and decides readiness. Minimum absent payload excludes unmeasured extraction, dependencies and temporary headroom; it is not an installation-space guarantee. Ready workflows may already have extracted files whose download archive is no longer cached.</p>
        {snapshot.packages.map(item => <details className="storage-package" key={item.id}><summary><span><strong>{item.name}</strong><small>{item.state.replaceAll('-', ' ')}</small></span><span>{item.knownPayloadBytes ? `${bytes(item.minimumDownloadBytes)} minimum absent` : 'Required size unknown'}</span></summary><div className="storage-package-body"><p className="storage-help">{item.message}</p>{item.progress !== undefined && <progress aria-label={`${item.name} setup progress`} max={100} value={Math.max(0, Math.min(100, item.progress))} />}<dl className="storage-package-numbers"><div><dt>Known payload</dt><dd>{bytes(item.knownPayloadBytes)}</dd></div><div><dt>Present candidates</dt><dd>{bytes(item.presentCandidateBytes)}</dd></div><div><dt>Resume candidates</dt><dd>{bytes(item.resumableBytes)}</dd></div><div><dt>Minimum absent</dt><dd>{bytes(item.minimumDownloadBytes)}</dd></div></dl>{item.dependencies.length > 0 && <p className="storage-help">Needs: {item.dependencies.join('; ')}.</p>}{item.unknownRequirements.map(note => <p className="storage-help" key={note}>{note}</p>)}{item.warnings.map(warning => <p className="inline-error" key={warning}>{warning}</p>)}{item.destinationIds.map(id => { const destination = findDestination(id); return destination && <div className="storage-package-destination" key={id}><code>{destination.path}</code><button type="button" className="icon-button" aria-label={`Open ${item.name} destination`} title="Open the nearest existing private folder" onClick={() => open(id)}><FolderOpen size={15} /></button></div>; })}</div></details>)}
      </div>
      {snapshot.transfers.length > 0 && <div className="storage-transfers"><h4>Model transfers</h4>{snapshot.transfers.map(transfer => <div className="storage-transfer" key={transfer.id}><strong>{transfer.name}</strong><span>{transfer.state} · {bytes(transfer.receivedBytes)}{transfer.totalBytes === undefined ? ' / total unknown' : ` / ${bytes(transfer.totalBytes)} · ${bytes(transfer.remainingBytes ?? 0)} remaining`}</span>{transfer.destinationId ? <button type="button" onClick={() => open(transfer.destinationId!)}><FolderOpen size={14} />Open destination</button> : <small>Exact destination is unavailable or ambiguous in the current transfer record.</small>}{transfer.error && <p className="inline-error">{transfer.error}</p>}</div>)}</div>}
    </>}
  </section>;
}

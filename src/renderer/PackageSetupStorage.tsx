import { useEffect, useRef, useState } from 'react';
import type { PackageStorageSnapshot } from '../shared/storage-types';
import { actionErrorMessage } from '../shared/action-error';
import { bytes, Notice } from './ui';

export function PackageSetupStorage({ packageId }: { packageId: string }) {
  const [open, setOpen] = useState(false), [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<PackageStorageSnapshot>();
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current; setSnapshot(undefined); setError('');
    if (!open) { setLoading(false); return; }
    setLoading(true);
    void window.latent.getPackageStorage(packageId).then(value => {
      if (current === generation.current) setSnapshot(value);
    }, reason => { if (current === generation.current) setError(actionErrorMessage(reason)); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [packageId, open, revision]);
  const item = snapshot?.package;
  return <details className="package-setup-storage" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Setup storage and dependencies</summary>
    {open && <section aria-label="Workflow setup storage">
      <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading ? 'Checking setup storage…' : 'Refresh setup storage'}</button>
      {error && <Notice error>{error}</Notice>}
      {item && <>
        <p className="small"><strong>{item.name}</strong> · Measured {new Date(snapshot.measuredAt).toLocaleTimeString()}</p>
        {item.knownPayloadBytes === 0 && item.unknownRequirements.length > 0 ? <p className="small">Download size is not yet known. Review the requirements below before setup.</p> : <p className="small">Known payload: {bytes(item.knownPayloadBytes)}. Present candidates: {bytes(item.presentCandidateBytes)}. Resume candidates: {bytes(item.resumableBytes)}. Minimum remaining download: {bytes(item.minimumDownloadBytes)}.</p>}
        <p className="small muted">File sizes identify reuse candidates; setup verifies their identity. Minimum remaining download excludes extraction, retained files and additional dependencies. It is not the total space needed to install.</p>
        {item.dependencies.length > 0 && <p className="small">Requires: {item.dependencies.join('; ')}.</p>}
        {item.unknownRequirements.map(note => <p className="small muted" key={note}>{note}</p>)}
        {!snapshot.volumes.length && <Notice>Available space unknown. Check folder access and refresh.</Notice>}
        {snapshot.volumes.map(volume => <p className="small" key={volume.id}>{volume.path}: {volume.availableBytes === undefined ? 'Available space unknown' : `${bytes(volume.availableBytes)} available`}{volume.availableBytes !== undefined && volume.minimumDownloadBytes > volume.availableBytes && <span className="inline-error"> · Remaining payload alone exceeds available space.</span>}</p>)}
        {snapshot.destinations.map(destination => <p className="small" key={destination.id}><span className="inline-path">{destination.path}</span></p>)}
        {[...snapshot.warnings, ...item.warnings].map((warning, index) => <Notice key={index}>{warning}</Notice>)}
      </>}
    </section>}
  </details>;
}

import { useEffect, useRef, useState } from 'react';
import type { ModelKind } from '../shared/types';
import type { DownloadStorageSnapshot } from '../shared/storage-types';
import { MODEL_DOWNLOAD_RESERVE_BYTES } from '../shared/model-download-space';
import { actionErrorMessage } from '../shared/action-error';
import { bytes, Notice } from './ui';

export function DownloadStorage({ kind, requiredBytes, estimated = false, refresh }: { kind: ModelKind; requiredBytes?: number; estimated?: boolean; refresh: () => Promise<DownloadStorageSnapshot> }) {
  const [snapshot, setSnapshot] = useState<DownloadStorageSnapshot>();
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [revision, setRevision] = useState(0); const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true); setError(''); setSnapshot(undefined);
    void Promise.resolve().then(refresh).then(value => {
      if (current === generation.current) setSnapshot(value);
    }, reason => { if (current === generation.current) setError(actionErrorMessage(reason)); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [refresh, revision]);
  const destination = snapshot?.destinations.find(item => item.id === snapshot.modelDownloadDestinations?.[kind]);
  const volume = snapshot?.volumes.find(item => item.id === destination?.volumeId);
  const required = requiredBytes === undefined ? undefined : requiredBytes + MODEL_DOWNLOAD_RESERVE_BYTES;
  return <section aria-label="Download storage" className="settings-card">
    <div className="section-heading"><h3>Download storage</h3><button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading ? 'Checking space…' : 'Refresh available space'}</button></div>
    <p>Destination: <span className="inline-path">{destination?.path ?? (loading ? 'Checking…' : 'Unavailable; refresh to check the destination.')}</span></p>
    <p>{volume?.availableBytes === undefined ? 'Available space unknown.' : `${bytes(volume.availableBytes)} available`}{snapshot && ` · Measured ${new Date(snapshot.measuredAt).toLocaleString()}`}</p>
    <p>{requiredBytes === undefined ? 'File size is unknown until the publisher supplies it when the download starts.' : `${estimated ? 'Estimated complete file' : 'Complete file'}: ${bytes(requiredBytes)}.`} The downloader requires {bytes(MODEL_DOWNLOAD_RESERVE_BYTES)} of additional free space.</p>
    {required !== undefined && volume?.availableBytes !== undefined && required > volume.availableBytes && <Notice error>The complete file plus required free space exceeds the available space. An eligible partial download may reduce the remaining transfer size.</Notice>}
    <p className="small muted">Available space can change. The downloader checks again before writing; this measurement does not reserve disk space.</p>
    {error && <Notice error>{error}</Notice>}
    {volume?.error && <Notice error>{volume.error}</Notice>}
  </section>;
}

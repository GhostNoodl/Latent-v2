import { useEffect, useRef, useState } from 'react';
import type { PackageStorageSnapshot } from '../shared/storage-types';
import { actionErrorMessage } from '../shared/action-error';
import { bytes, Notice } from './ui';

export function PackageSetupStorage({ packageId }: { packageId: string }) {
  const [open, setOpen] = useState(false),
    [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<PackageStorageSnapshot>();
  const [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setSnapshot(undefined);
    setError('');
    if (!open) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void window.latent
      .getPackageStorage(packageId)
      .then(
        value => {
          if (current === generation.current) setSnapshot(value);
        },
        reason => {
          if (current === generation.current) setError(actionErrorMessage(reason));
        },
      )
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [packageId, open, revision]);
  const item = snapshot?.package;
  return (
    <details className="package-setup-storage" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Download size and requirements</summary>
      {open && (
        <section aria-label="Workflow setup storage">
          <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>
            {loading ? 'Checking…' : 'Check again'}
          </button>
          {error && <Notice error>{error}</Notice>}
          {item && (
            <>
              <p className="small">
                <strong>{item.name}</strong> · Checked {new Date(snapshot.measuredAt).toLocaleTimeString()}
              </p>
              {item.knownPayloadBytes === 0 && item.unknownRequirements.length > 0 ? (
                <p className="small">The download size isn't known yet. See what it needs below.</p>
              ) : (
                <p className="small">
                  Total download: {bytes(item.knownPayloadBytes)}. Already on your PC:{' '}
                  {bytes(item.presentCandidateBytes)}. Partly downloaded: {bytes(item.resumableBytes)}. Still to
                  download: at least {bytes(item.minimumDownloadBytes)}.
                </p>
              )}
              <p className="small muted">
                Files already on your PC get checked before they're reused. Unpacking needs extra room, so leave some
                space beyond the download size.
              </p>
              {item.dependencies.length > 0 && <p className="small">Needs: {item.dependencies.join('; ')}.</p>}
              {item.unknownRequirements.map(note => (
                <p className="small muted" key={note}>
                  {note}
                </p>
              ))}
              {!snapshot.volumes.length && <Notice>Available space unknown. Check folder access and refresh.</Notice>}
              {snapshot.volumes.map(volume => (
                <p className="small" key={volume.id}>
                  {volume.path}:{' '}
                  {volume.availableBytes === undefined
                    ? 'Available space unknown'
                    : `${bytes(volume.availableBytes)} available`}
                  {volume.availableBytes !== undefined && volume.minimumDownloadBytes > volume.availableBytes && (
                    <span className="inline-error"> · Remaining payload alone exceeds available space.</span>
                  )}
                </p>
              ))}
              {snapshot.destinations.map(destination => (
                <p className="small" key={destination.id}>
                  <span className="inline-path">{destination.path}</span>
                </p>
              ))}
              {[...snapshot.warnings, ...item.warnings].map((warning, index) => (
                <Notice key={index}>{warning}</Notice>
              ))}
            </>
          )}
        </section>
      )}
    </details>
  );
}

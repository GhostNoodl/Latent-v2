import { PackageSetupStorage } from './PackageSetupStorage';
import type { VideoAssetsStatus } from '../shared/video-assets';
import { VIDEO_ASSET_DIRECTORIES, videoProfileReady } from '../shared/video-assets';
import { videoProfileAssets } from '../shared/video-plan';
import type { VideoDraft } from '../shared/video-types';
import { bytes, Notice } from './ui';

const roleLabels = {
  diffusion: 'Video model',
  encoder: 'Prompt reader',
  videoVae: 'Picture decoder',
  audioVae: 'Sound decoder',
  turbo: 'Turbo add-on',
};
const profileLabel = (profile: VideoDraft['profile']) =>
  profile === 'fused4' ? 'Fast (4 steps)' : profile === 'turbo8' ? 'Better (8 steps)' : 'Best (20 steps)';
export interface VideoAssetSetupProps {
  status?: VideoAssetsStatus;
  profile: VideoDraft['profile'];
  busy?: boolean;
  cancelBusy?: boolean;
  onSetup(profile: VideoDraft['profile']): void;
  onVerify(profile: VideoDraft['profile']): void;
  onCancel(): void;
}

/** Get or check the files one quality needs. Showing this never downloads anything by itself. */
export function VideoAssetSetup({
  status,
  profile,
  busy = false,
  cancelBusy = false,
  onSetup,
  onVerify,
  onCancel,
}: VideoAssetSetupProps) {
  const operating = status?.state === 'installing' || status?.state === 'verifying';
  const ready = videoProfileReady(status, profile);
  const assets = videoProfileAssets(profile);
  const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const progress =
    status?.progress !== undefined && Number.isFinite(status.progress)
      ? Math.max(0, Math.min(100, status.progress))
      : undefined;
  return (
    <section className="vp-setup" aria-label="Video files">
      <h2>{ready ? `${profileLabel(profile)} is ready` : `Get the files for ${profileLabel(profile)}`}</h2>
      {!ready && (
        <p>
          About {bytes(total)} to download once. Fast is the quickest way to start; Better and Best need their own
          files.
        </p>
      )}
      {!status && <Notice>Can’t check the video files right now. Restart Latent to try again.</Notice>}
      {status?.message && !operating && ['error', 'partial', 'cancelled'].includes(status.state) && (
        <Notice error={status.state === 'error'}>{status.message}</Notice>
      )}
      {status?.warnings.map((warning, index) => (
        <Notice key={index}>{warning}</Notice>
      ))}
      {operating && (
        <div role="status" className="vp-setup-progress">
          <p>
            {status.message}
            {progress === undefined ? '' : ` ${Math.round(progress)}%`}
          </p>
          <progress aria-label="Video file progress" max={100} value={progress} />
        </div>
      )}
      <PackageSetupStorage packageId={`video-${profile}`} />
      <div className="button-row">
        {operating ? (
          <button type="button" disabled={cancelBusy} onClick={onCancel}>
            {cancelBusy ? 'Stopping…' : 'Stop'}
          </button>
        ) : (
          <>
            {!ready && (
              <button
                type="button"
                className="primary"
                disabled={busy || status?.canAcquire !== true}
                onClick={() => onSetup(profile)}
              >
                {status?.state === 'partial' || status?.state === 'cancelled' ? 'Finish download' : 'Download'}
              </button>
            )}
            <button
              type="button"
              disabled={busy || (status?.canVerify ?? status?.canAcquire) !== true}
              onClick={() => onVerify(profile)}
            >
              {ready ? 'Check files again' : 'I already have them'}
            </button>
          </>
        )}
      </div>
      <details>
        <summary>Where the files go</summary>
        <ul className="vp-setup-files">
          {assets.map(asset => (
            <li key={asset.role}>
              <strong>{roleLabels[asset.role]}</strong> · {bytes(asset.bytes)}
              <span className="inline-path">
                models/{VIDEO_ASSET_DIRECTORIES[asset.role]}/minimax-h3/{asset.filename.split('/').at(-1)}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

import { PackageSetupStorage } from './PackageSetupStorage';
import type { VideoAssetsStatus } from '../shared/video-assets';
import { VIDEO_ASSET_DIRECTORIES, videoProfileReady } from '../shared/video-assets';
import { videoProfileAssets } from '../shared/video-plan';
import type { VideoDraft } from '../shared/video-types';
import { Notice } from './ui';

const stateLabels: Record<VideoAssetsStatus['state'], string> = {
  'not-installed': 'Not installed', partial: 'Partially present', installed: 'Files installed',
  installing: 'Installing files', verifying: 'Verifying files', cancelled: 'Setup cancelled', error: 'Setup needs attention',
};
const roleLabels = { diffusion: 'Video model', encoder: 'Text encoder', videoVae: 'Video decoder', audioVae: 'Audio decoder', turbo: 'Turbo adapter' };
const profileLabel = (profile: VideoDraft['profile']) => profile === 'fused4' ? 'Fused turbo 4-step' : profile === 'turbo8' ? 'Turbo 8-step' : 'Base';
export interface VideoAssetSetupProps {
  status?: VideoAssetsStatus; profile?: VideoDraft['profile']; busy?: boolean; cancelBusy?: boolean;
  onSetup(profile: VideoDraft['profile']): void; onVerify(profile: VideoDraft['profile']): void; onCancel(): void;
}

/** Displays main's authority and observations. Rendering never acquires or verifies assets. */
export function VideoAssetSetup({ status, profile = 'base', busy = false, cancelBusy = false, onSetup, onVerify, onCancel }: VideoAssetSetupProps) {
  const operating = status?.state === 'installing' || status?.state === 'verifying';
  const enabled = status?.canAcquire === true && !busy && !cancelBusy && !operating;
  const verifyEnabled = (status?.canVerify ?? status?.canAcquire) === true && !busy && !cancelBusy && !operating;
  const progress = status?.progress !== undefined && Number.isFinite(status.progress) ? Math.max(0, Math.min(100, status.progress)) : undefined;
  const ready = videoProfileReady(status, profile);
  const setupLabel = ready ? 'Check / restore selected files' : status?.state === 'error' ? 'Retry asset setup' : status?.state === 'partial' || status?.state === 'cancelled' ? 'Resume asset setup' : 'Set up video assets';
  return <section className="settings-card" aria-label="Video asset setup">
    <div className="section-heading"><h2>Files for this profile</h2><span role="status">{status ? stateLabels[status.state] : 'Status unavailable'}</span></div>
    <p>Selected draft profile: <strong>{profileLabel(profile)}</strong></p>
    {!status && <Notice>Video asset status is unavailable. Reopen the studio when status is available; setup and verification remain disabled.</Notice>}
    {status?.message && <Notice error={status.state === 'error'}>{status.message}</Notice>}
    {status && !status.canAcquire && <Notice>{status.canVerify ? 'Use files supplied separately. Verification checks their exact identity without downloading model weights.' : 'Local file verification is unavailable for this configuration.'}</Notice>}
    {status?.canVerify && <details><summary>Required local files</summary>
      <p>Place these exact files under this studio’s models folder. Verification checks each file’s SHA-256; renamed alternatives are not interchangeable.</p>
      <ul>{videoProfileAssets(profile).map(asset => <li key={asset.role}><strong>{roleLabels[asset.role]}</strong><p className="inline-path">{VIDEO_ASSET_DIRECTORIES[asset.role]}/minimax-h3/{asset.filename.split('/').at(-1)}</p></li>)}</ul>
    </details>}
    <p className={videoProfileReady(status, profile) ? 'profile-ready' : 'profile-missing'}>{videoProfileReady(status, profile) ? `${profileLabel(profile)}: all required files are present.` : `${profileLabel(profile)}: download or verify the required files below.`}</p>
    <p className="muted small">Other profiles use different model files. You only need the profile you choose.</p>
    {operating && <div role="status"><p>{status.state === 'installing' ? 'Installing' : 'Verifying'} {profileLabel(status.profile ?? profile)} files{status.activeRole ? ` · ${roleLabels[status.activeRole]}` : ''}{progress === undefined ? '' : ` · ${Math.round(progress)}%`}</p><progress aria-label="Video asset operation progress" max={100} value={progress} /></div>}
    {status && status.warnings.length > 0 && <Notice><ul>{status.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></Notice>}
    <p>Asset checks verify files only. Experimental generation also checks the private engine before submission; performance depends on the selected settings and available memory.</p>
    <PackageSetupStorage packageId={`video-${profile}`} />
    <div className="button-row">
      <button type="button" disabled={!enabled} onClick={() => onSetup(profile)}>{setupLabel}</button>
      <button type="button" disabled={!verifyEnabled} onClick={() => onVerify(profile)}>Verify saved video assets</button>
      {operating && <button type="button" disabled={cancelBusy} onClick={onCancel}>{cancelBusy ? 'Cancelling setup…' : status?.state === 'verifying' ? 'Cancel asset verification' : 'Cancel asset setup'}</button>}
    </div>
  </section>;
}

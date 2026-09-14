import type { VideoAssetIdentity, VideoDraft } from './video-types';
import type { VideoAssetBinding } from './video-workflow';

export const VIDEO_ASSET_DIRECTORIES = { diffusion: 'diffusion_models', encoder: 'text_encoders', videoVae: 'vae', audioVae: 'vae', turbo: 'video-loras' } as const;

/** Main-owned operation policy. Local-files-only permits no acquisition and asserts no legal authorization. */
export interface VideoAcquisitionAuthorization {
  schema: 1; recordId: string; licenseUrl: string; resolvedAt: string; scope: 'acquisition-and-use' | 'local-files-only';
}
export interface VideoAssetReceipt {
  asset: VideoAssetIdentity; binding: VideoAssetBinding; verifiedAt: string; authorizationRecordId: string;
}
export interface VideoAssetBundle {
  schema: 1; profile: VideoDraft['profile']; assets: VideoAssetReceipt[]; authorizationRecordId: string;
  /** Asset verification alone does not verify runtime compatibility or GPU support. */
  runtimeVerified: false;
}
export interface VideoAssetsStatus {
  state: 'not-installed' | 'partial' | 'installed' | 'installing' | 'verifying' | 'cancelled' | 'error';
  canAcquire: boolean; canVerify?: boolean; canGenerate: false; basePresent: boolean; turboPresent: boolean; fusedPresent?: boolean;
  installedRoles: VideoAssetIdentity['role'][]; message: string; warnings: string[];
  profile?: VideoDraft['profile']; activeRole?: VideoAssetIdentity['role']; progress?: number;
}

export function videoProfileReady(status: VideoAssetsStatus | undefined, profile: VideoDraft['profile']): boolean {
  return !!status && (profile === 'fused4' ? status.fusedPresent === true : profile === 'turbo8' ? status.turboPresent : status.basePresent);
}

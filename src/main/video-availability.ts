import type { VideoAvailability } from '../shared/video-types';
import type { VideoAssetsStatus } from '../shared/video-assets';
import type { BackendStatus } from '../shared/types';
import { validateVideoRuntime } from './video-preflight';

/** Cheap readiness hint only; queue preflight verifies the full files and live node schemas. */
export function localVideoAvailability(availability: VideoAvailability, assets: VideoAssetsStatus, state: BackendStatus['state'], identity: unknown): VideoAvailability {
  const base = { ...availability, assets, canAcquire: assets.canAcquire, canGenerate: false };
  if (!assets.basePresent && !assets.fusedPresent) return { ...base, phase: 'assets-missing', message: assets.canAcquire ? 'Choose a video profile below and download its required files to enable generation.' : 'Supply and verify the local H3 model files to enable video generation.' };
  if (state !== 'ready') return { ...base, phase: 'runtime-unavailable', message: 'Start the private engine to use the verified local H3 files.' };
  try { validateVideoRuntime(identity); }
  catch (error) { return { ...base, phase: 'runtime-unavailable', message: error instanceof Error ? error.message : String(error) }; }
  return { ...base, phase: 'experimental-ready', canGenerate: true, message: 'Local H3 files are present. Each job verifies its files and runtime before submission. Speed varies with your profile, resolution and clip length.' };
}

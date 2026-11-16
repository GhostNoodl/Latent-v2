import type { VideoAvailability } from '../shared/video-types';
import type { VideoAssetsStatus } from '../shared/video-assets';
import type { BackendStatus } from '../shared/types';
import type { VideoExtrasStatus } from '../shared/video-extras';

/** Quick hint for the page; each job checks files and the engine again before it runs. */
export function localVideoAvailability(
  availability: VideoAvailability,
  assets: VideoAssetsStatus,
  state: BackendStatus['state'],
  extra: { bigCard: boolean; solInstalled: boolean; extras?: VideoExtrasStatus },
): VideoAvailability {
  const base = { ...availability, ...extra, assets, canAcquire: assets.canAcquire, canGenerate: false };
  if (!assets.basePresent && !assets.fusedPresent)
    return { ...base, phase: 'assets-missing', message: 'Get the video files to start making clips.' };
  if (state !== 'ready') return { ...base, phase: 'runtime-unavailable', message: 'Start the engine to make clips.' };
  return { ...base, phase: 'ready', canGenerate: true, message: 'Ready.' };
}

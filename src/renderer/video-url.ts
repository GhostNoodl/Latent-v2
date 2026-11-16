import type { VideoDraft, VideoHistoryRecord } from '../shared/video-types';
import { resolveVideoDuration, VIDEO_STEPS } from '../shared/video-plan';

/** Only Latent's own clip links, built from the record ID. */
export function safeVideoHistoryUrl(record: VideoHistoryRecord) {
  if (!/^[a-f0-9]{32}$/.test(record.id)) return undefined;
  try {
    const url = new URL(record.mediaUrl);
    return url.protocol === 'latent-asset:' &&
      url.hostname === 'video' &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === `/${record.id}` &&
      !url.search &&
      !url.hash
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function work(draft: Pick<VideoDraft, 'width' | 'height' | 'requestedDurationSeconds' | 'profile'>) {
  const { frames } = resolveVideoDuration(draft.requestedDurationSeconds);
  return draft.width * draft.height * frames * VIDEO_STEPS[draft.profile];
}

/** Guess how long a clip takes from how long earlier clips took here. Undefined until there is one. */
export function estimateVideoMs(draft: VideoDraft, records: readonly VideoHistoryRecord[]): number | undefined {
  try {
    work(draft);
  } catch {
    return undefined;
  }
  const timed = records.filter(
    record => record.elapsedMs && record.plan && record.plan.draft.speed?.attention === draft.speed.attention,
  );
  const sameProfile = timed.filter(record => record.plan!.draft.profile === draft.profile);
  const pool = (sameProfile.length ? sameProfile : timed).slice(0, 5);
  if (!pool.length) return undefined;
  const rates = pool.map(record => record.elapsedMs! / work(record.plan!.draft)).sort((a, b) => a - b);
  return rates[Math.floor(rates.length / 2)] * work(draft);
}

export function formatDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${String(rest).padStart(2, '0')} s` : `${minutes} min`;
}

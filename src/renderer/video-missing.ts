import type { SageAttentionStatus } from '../shared/types';
import { videoProfileReady } from '../shared/video-assets';
import { VIDEO_EXTRAS, videoExtrasFor, type VideoExtraId } from '../shared/video-extras';
import type { VideoAvailability, VideoDraft } from '../shared/video-types';

export type VideoMissingItem =
  | { kind: 'files'; label: string }
  | { kind: 'extra'; id: VideoExtraId; label: string }
  | { kind: 'sage'; label: string }
  | { kind: 'sol'; label: string };

const QUALITY_NAMES = { fused4: 'Fast', turbo8: 'Better', base: 'Best' } as const;

/** Everything this clip's settings need that isn't on the PC yet, in the order it gets installed. */
export function videoMissing(
  draft: VideoDraft,
  status: VideoAvailability,
  sage?: SageAttentionStatus['state'],
): VideoMissingItem[] {
  const items: VideoMissingItem[] = [];
  if (!videoProfileReady(status.assets, draft.profile))
    items.push({ kind: 'files', label: `${QUALITY_NAMES[draft.profile]} video files` });
  const extras = status.extras;
  if (extras)
    for (const id of videoExtrasFor(draft.finishing))
      if (!extras.installed[id]) items.push({ kind: 'extra', id, label: VIDEO_EXTRAS[id].label.toLowerCase() });
  if (draft.speed.attention !== 'normal' && (sage === 'missing' || sage === 'error'))
    items.push({ kind: 'sage', label: 'SageAttention' });
  if (draft.speed.attention === 'sage-sol' && !status.solInstalled) items.push({ kind: 'sol', label: 'Sol' });
  return items;
}

/** "the upscaler, SageAttention and Sol" */
export function listMissing(items: readonly VideoMissingItem[]) {
  const names = items.map(item => item.label);
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

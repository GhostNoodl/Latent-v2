import { describe, expect, it } from 'vitest';
import { DEFAULT_VIDEO_DRAFT } from '../src/shared/video-plan';
import { listMissing, videoMissing } from '../src/renderer/video-missing';
import type { VideoAvailability, VideoDraft } from '../src/shared/video-types';

const status = (patch: Partial<VideoAvailability> = {}) =>
  ({
    phase: 'ready',
    canAcquire: true,
    canGenerate: true,
    message: 'Ready.',
    licenseUrl: '',
    baseBytes: 0,
    withTurboBytes: 0,
    solInstalled: true,
    extras: { installed: { rife: true, film: true, seedvr2: true } },
    assets: undefined,
    ...patch,
  }) as VideoAvailability;
const draft = (patch: Partial<VideoDraft> = {}) =>
  ({ ...structuredClone(DEFAULT_VIDEO_DRAFT), ...patch }) as VideoDraft;

describe('what a clip still needs', () => {
  it('lists files, finishing models, Sage and Sol in install order', () => {
    const items = videoMissing(
      draft({
        profile: 'base',
        speed: { ...DEFAULT_VIDEO_DRAFT.speed, attention: 'sage-sol' },
        finishing: { smooth: 'rife', upscale: '1080p' },
      }),
      status({ solInstalled: false, extras: { installed: { rife: true, film: false, seedvr2: false } } }),
      'missing',
    );
    expect(items.map(item => item.kind)).toEqual(['files', 'extra', 'sage', 'sol']);
    expect(listMissing(items)).toBe('Best video files, upscaler, SageAttention and Sol');
  });
  it('asks for nothing Normal attention does not use', () => {
    const items = videoMissing(
      draft({
        speed: { ...DEFAULT_VIDEO_DRAFT.speed, attention: 'normal' },
        finishing: { smooth: 'off', upscale: 'off' },
      }),
      status({ solInstalled: false }),
      'missing',
    );
    expect(items.filter(item => item.kind !== 'files')).toEqual([]);
  });
});

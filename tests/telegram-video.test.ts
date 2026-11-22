import { expect, it } from 'vitest';
import {
  applyVideoSetting,
  sizeForPicture,
  splitVideoFlags,
  videoBase,
  videoDraftFor,
} from '../src/main/telegram-video';
import { DEFAULT_VIDEO_DRAFT, videoDraftSchema } from '../src/shared/video-plan';

const SHA = 'a'.repeat(64);
const SOURCE = 'src_11111111-1111-1111-1111-111111111111';

it('starts from the Video page setup, without its frames, and falls back when it is half typed', () => {
  const studio = {
    ...DEFAULT_VIDEO_DRAFT,
    mode: 'img2vid',
    prompt: 'kept in the studio',
    profile: 'base',
    firstFrame: { sourceId: SOURCE, sha256: SHA },
  };
  const base = videoBase(studio);
  expect(base).toMatchObject({ mode: 'txt2vid', prompt: '', profile: 'base' });
  expect(base.firstFrame).toBeUndefined();
  expect(videoBase({ ...DEFAULT_VIDEO_DRAFT, width: 17 })).toEqual(DEFAULT_VIDEO_DRAFT);
  expect(videoBase(undefined)).toEqual(DEFAULT_VIDEO_DRAFT);
});

it('animates a picture in a size that keeps its shape', () => {
  expect(sizeForPicture(1600, 900)).toEqual({ width: 832, height: 480 });
  expect(sizeForPicture(800, 1200)).toEqual({ width: 480, height: 832 });
  expect(sizeForPicture(1000, 1000)).toEqual({ width: 768, height: 768 });
  const draft = videoDraftFor(DEFAULT_VIDEO_DRAFT, {}, 'she smiles', {
    sourceId: SOURCE,
    sha256: SHA,
    width: 800,
    height: 1200,
  });
  expect(draft).toMatchObject({ mode: 'img2vid', width: 480, height: 832, firstFrame: { sourceId: SOURCE } });
  expect(videoDraftSchema.safeParse(draft).success).toBe(true);
});

it('checks video settings', () => {
  expect(applyVideoSetting({}, 'quality', 'best').overrides.profile).toBe('base');
  expect(applyVideoSetting({}, 'length', '8s').overrides.seconds).toBe(8);
  expect(() => applyVideoSetting({}, 'length', '30')).toThrow(/5 to 15/);
  expect(applyVideoSetting({}, 'size', 'square').overrides).toEqual({ width: 768, height: 768 });
  expect(() => applyVideoSetting({}, 'size', '1344x1344')).toThrow(/too big/);
  expect(applyVideoSetting({ seed: '4' }, 'seed', 'random').overrides.seed).toBeUndefined();
  expect(splitVideoFlags('waves --length 8 --quality fast')).toEqual({
    prompt: 'waves',
    flags: [
      { key: 'length', args: '8' },
      { key: 'quality', args: 'fast' },
    ],
  });
});

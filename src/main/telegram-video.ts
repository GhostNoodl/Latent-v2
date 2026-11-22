import { DEFAULT_VIDEO_DRAFT, videoDraftSchema, VIDEO_STEPS } from '../shared/video-plan';
import { videoProfileReady, type VideoAssetsStatus } from '../shared/video-assets';
import type { VideoDraft, VideoSourceReference } from '../shared/video-types';

/** Per-chat video choices layered over the Video page's open setup. */
export interface TelegramVideoOverrides {
  profile?: VideoDraft['profile'];
  seconds?: number;
  width?: number;
  height?: number;
  seed?: string;
}
export const VIDEO_KEYS = ['quality', 'length', 'size', 'seed'] as const;
export type VideoKey = (typeof VIDEO_KEYS)[number];
export const isVideoKey = (value: string): value is VideoKey => (VIDEO_KEYS as readonly string[]).includes(value);

/** The Video page's sizes (all within what H3 is made for). */
export const VIDEO_SIZES = [
  { name: 'Wide', width: 832, height: 480 },
  { name: 'Wide large', width: 1024, height: 576 },
  { name: 'Wide largest', width: 1344, height: 768 },
  { name: 'Tall', width: 480, height: 832 },
  { name: 'Tall large', width: 576, height: 1024 },
  { name: 'Tall largest', width: 768, height: 1344 },
  { name: 'Square', width: 768, height: 768 },
  { name: 'Square largest', width: 960, height: 960 },
] as const;
export const VIDEO_LENGTHS = [5, 6, 8, 10, 12, 15];
export const VIDEO_QUALITY: { profile: VideoDraft['profile']; name: string }[] = [
  { profile: 'fused4', name: 'Fast' },
  { profile: 'turbo8', name: 'Better' },
  { profile: 'base', name: 'Best' },
];
export const qualityName = (profile: VideoDraft['profile']) =>
  VIDEO_QUALITY.find(item => item.profile === profile)?.name ?? profile;

/**
 * The Video page's open setup as a plain text-to-video starting point. Frames picked in the
 * studio stay there; a half-typed setup falls back to the usual defaults.
 */
export function videoBase(studio: unknown): VideoDraft {
  const candidate =
    studio && typeof studio === 'object'
      ? { ...(studio as VideoDraft), mode: 'txt2vid', prompt: '', firstFrame: undefined, lastFrame: undefined }
      : undefined;
  if (candidate) {
    delete candidate.firstFrame;
    delete candidate.lastFrame;
  }
  const parsed = videoDraftSchema.safeParse(candidate);
  return structuredClone(parsed.success ? (parsed.data as VideoDraft) : (DEFAULT_VIDEO_DRAFT as VideoDraft));
}

/** Picks the Video page size closest in shape to a picture, for animating it. */
export function sizeForPicture(width: number, height: number) {
  const ratio = width / height;
  const size = ratio > 1.2 ? VIDEO_SIZES[0] : ratio < 1 / 1.2 ? VIDEO_SIZES[3] : VIDEO_SIZES[6];
  return { width: size.width, height: size.height };
}

export function videoDraftFor(
  studio: unknown,
  overrides: TelegramVideoOverrides,
  prompt: string,
  firstFrame?: VideoSourceReference & { width: number; height: number },
): VideoDraft {
  const base = videoBase(studio);
  // Without a size of its own, an animated picture keeps its shape.
  const size =
    overrides.width && overrides.height
      ? { width: overrides.width, height: overrides.height }
      : firstFrame
        ? sizeForPicture(firstFrame.width, firstFrame.height)
        : { width: base.width, height: base.height };
  const draft: VideoDraft = {
    ...base,
    ...size,
    prompt,
    profile: overrides.profile ?? base.profile,
    requestedDurationSeconds: overrides.seconds ?? base.requestedDurationSeconds,
    // Remote clips stay random unless the chat pins a seed.
    seed: overrides.seed ?? 'random',
    mode: firstFrame ? 'img2vid' : 'txt2vid',
    resize: 'center-crop',
  };
  if (firstFrame) draft.firstFrame = { sourceId: firstFrame.sourceId, sha256: firstFrame.sha256 };
  return draft;
}

function pickName<T extends { name: string }>(items: readonly T[], query: string, what: string): T {
  const value = query.trim().toLowerCase();
  if (/^\d+$/.test(value)) {
    const item = items[Number(value) - 1];
    if (!item) throw new Error(`There is no ${what} number ${value}.`);
    return item;
  }
  const exact = items.find(item => item.name.toLowerCase() === value);
  if (exact) return exact;
  const matches = items.filter(item => item.name.toLowerCase().startsWith(value));
  if (matches.length >= 1) return matches[0];
  throw new Error(`No ${what} called "${query.trim()}".`);
}

export function applyVideoSetting(
  overrides: TelegramVideoOverrides,
  key: VideoKey,
  rawArgs: string,
): { overrides: TelegramVideoOverrides; message: string } {
  const args = rawArgs.trim();
  const next = structuredClone(overrides);
  let message: string;
  switch (key) {
    case 'quality': {
      const value = args.toLowerCase();
      const quality =
        VIDEO_QUALITY.find(item => item.profile === value) ?? pickName(VIDEO_QUALITY, value || '?', 'quality');
      next.profile = quality.profile;
      message = `Video quality: ${quality.name} (${VIDEO_STEPS[quality.profile]} steps).`;
      break;
    }
    case 'length': {
      const seconds = Number(args.replace(/s(ec(ond)?s?)?$/i, '').trim());
      if (!args || !Number.isFinite(seconds) || seconds < 5 || seconds > 15)
        throw new Error('Clips can be 5 to 15 seconds long. Like --length 8.');
      next.seconds = Math.round(seconds * 2) / 2;
      message = `Clips are ${next.seconds} seconds long now.`;
      break;
    }
    case 'size': {
      const dims = /^(\d{2,4})\s*[x×*:]\s*(\d{2,4})$/i.exec(args);
      let size: { width: number; height: number };
      if (dims) {
        size = { width: Number(dims[1]), height: Number(dims[2]) };
        if (size.width % 32 || size.height % 32 || Math.min(size.width, size.height) < 256)
          throw new Error('Video sides need to be multiples of 32, at least 256. Like 832x480.');
      } else {
        if (!args) throw new Error('Use wide, tall, square, or a size like 832x480.');
        const picked = pickName(VIDEO_SIZES, args, 'size');
        size = { width: picked.width, height: picked.height };
      }
      const checked = videoDraftSchema.safeParse({ ...DEFAULT_VIDEO_DRAFT, ...size });
      if (!checked.success) throw new Error(checked.error.issues[0].message);
      next.width = size.width;
      next.height = size.height;
      message = `Video size: ${size.width}×${size.height}.`;
      break;
    }
    case 'seed':
      if (!args || args.toLowerCase() === 'random') delete next.seed;
      else if (/^(0|[1-9]\d{0,15})$/.test(args) && BigInt(args) <= BigInt(Number.MAX_SAFE_INTEGER)) next.seed = args;
      else throw new Error('Use a whole number seed, or random.');
      message = next.seed ? `Video seed fixed at ${next.seed}.` : 'Video seeds are random again.';
      break;
  }
  return { overrides: next, message };
}

/** Splits `a wave crashing --length 8 --quality better` into the prompt and one-off video settings. */
export function splitVideoFlags(text: string): { prompt: string; flags: { key: VideoKey; args: string }[] } {
  const pattern = new RegExp(`(?:^|\\s)--(${VIDEO_KEYS.join('|')})(?=\\s|$)`, 'gi');
  const marks = [...text.matchAll(pattern)];
  if (!marks.length) return { prompt: text.trim(), flags: [] };
  const flags = marks.map((mark, index) => ({
    key: mark[1].toLowerCase() as VideoKey,
    args: text.slice(mark.index! + mark[0].length, marks[index + 1]?.index ?? text.length).trim(),
  }));
  return { prompt: text.slice(0, marks[0].index).trim(), flags };
}

/** Why a quality can't run yet, if its files are missing. */
export function qualityMissing(assets: VideoAssetsStatus | undefined, profile: VideoDraft['profile']) {
  return videoProfileReady(assets, profile)
    ? undefined
    : `${qualityName(profile)} isn't set up yet. Get its files on the studio's Video page, or pick another quality.`;
}

export function describeVideo(studio: unknown, overrides: TelegramVideoOverrides, assets?: VideoAssetsStatus) {
  const draft = videoDraftFor(studio, overrides, '');
  const ready = VIDEO_QUALITY.filter(item => videoProfileReady(assets, item.profile)).map(item => item.name);
  return [
    `Quality: ${qualityName(draft.profile)} (${VIDEO_STEPS[draft.profile]} steps)`,
    `Length: ${draft.requestedDurationSeconds} seconds`,
    `Size: ${draft.width}×${draft.height}`,
    `Seed: ${draft.seed}`,
    assets ? `Set up on this PC: ${ready.length ? ready.join(', ') : 'none yet'}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

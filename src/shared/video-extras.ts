/**
 * Finishing steps that run after the clip is made: a frame smoother (24 → 48 fps) and an upscaler.
 * Both use nodes that ship with the engine; only the model files are downloaded, pinned by size and hash.
 */
export type VideoExtraId = 'rife' | 'film' | 'seedvr2';
export interface VideoFinishing {
  /** Doubles the frame rate. RIFE is near-instant; FILM is slower and handles big motion a bit better. */
  smooth: 'off' | 'rife' | 'film';
  /** Short-side target for the SeedVR2 upscaler. */
  upscale: 'off' | '1080p' | '1440p';
}
export interface VideoExtraFile {
  folder: 'frame_interpolation' | 'diffusion_models' | 'vae';
  filename: string;
  bytes: number;
  sha256: string;
  url: string;
}
export interface VideoExtra {
  id: VideoExtraId;
  label: string;
  license: string;
  files: readonly VideoExtraFile[];
}
export interface VideoExtrasStatus {
  installed: Record<VideoExtraId, boolean>;
  /** The extra being downloaded right now, with progress from 0 to 1. */
  installing?: { id: VideoExtraId; progress: number };
  error?: string;
}

/** Files sit in a "latent-video" subfolder of each engine folder, so they never clash with the user's own. */
export const VIDEO_EXTRA_SUBFOLDER = 'latent-video';
const FRAMES = 'https://huggingface.co/Comfy-Org/frame_interpolation/resolve/aa7009be4d1471ea0bac91d6fe4d7e4b637cbbfc';
const SEEDVR2 = 'https://huggingface.co/Comfy-Org/SeedVR2/resolve/df48879708206a403d2a61acd55578c2e80fd233';
export const VIDEO_EXTRAS: Readonly<Record<VideoExtraId, VideoExtra>> = Object.freeze({
  rife: {
    id: 'rife',
    label: 'Quick smoother',
    license: 'MIT (RIFE), packaged by Comfy-Org',
    files: [
      {
        folder: 'frame_interpolation',
        filename: 'rife_v4.26.safetensors',
        bytes: 22674688,
        sha256: '151874592c877740e5db11522f4514df569eeafb0a0fcb2696f16e9e8d317c94',
        url: `${FRAMES}/frame_interpolation/rife_v4.26.safetensors`,
      },
    ],
  },
  film: {
    id: 'film',
    label: 'Best smoother',
    license: 'Apache-2.0 (FILM), packaged by Comfy-Org',
    files: [
      {
        folder: 'frame_interpolation',
        filename: 'film_net_fp16.safetensors',
        bytes: 68882302,
        sha256: 'f226e51375dc839d4b40e5c3d63da560dd1ea1c962364ec78f5adf2d05db05c0',
        url: `${FRAMES}/frame_interpolation/film_net_fp16.safetensors`,
      },
    ],
  },
  seedvr2: {
    id: 'seedvr2',
    label: 'Upscaler',
    license: 'Apache-2.0',
    files: [
      {
        folder: 'diffusion_models',
        filename: 'seedvr2_3b_int8_convrot.safetensors',
        bytes: 3458259704,
        sha256: 'c3dec8bcc5916843a8a858572970597462e1f2dc598d6dfd818f6cd40f53a157',
        url: `${SEEDVR2}/diffusion_models/seedvr2_3b_int8_convrot.safetensors`,
      },
      {
        folder: 'vae',
        filename: 'seedvr2_ema_vae_fp16.safetensors',
        bytes: 501324814,
        sha256: '20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1',
        url: `${SEEDVR2}/vae/seedvr2_ema_vae_fp16.safetensors`,
      },
    ],
  },
});
export const DEFAULT_VIDEO_FINISHING: Readonly<VideoFinishing> = Object.freeze({ smooth: 'rife', upscale: 'off' });

/** Engine name for an extra's file ("latent-video/<file>"). */
export function videoExtraName(file: VideoExtraFile) {
  return `${VIDEO_EXTRA_SUBFOLDER}/${file.filename}`;
}
export function videoExtraBytes(id: VideoExtraId) {
  return VIDEO_EXTRAS[id].files.reduce((sum, file) => sum + file.bytes, 0);
}
/** Which extras a finishing choice needs. */
export function videoExtrasFor(finishing: VideoFinishing): VideoExtraId[] {
  return [
    ...(finishing.upscale !== 'off' ? (['seedvr2'] as const) : []),
    ...(finishing.smooth !== 'off' ? [finishing.smooth] : []),
  ];
}
/** Upscaled size: the short side reaches the target, the shape stays, both sides even. Null when it wouldn't grow. */
export function videoUpscaleSize(width: number, height: number, target: VideoFinishing['upscale']) {
  if (target === 'off') return null;
  const short = target === '1080p' ? 1080 : 1440;
  const scale = short / Math.min(width, height);
  if (scale <= 1) return null;
  const even = (value: number) => Math.max(2, Math.round((value * scale) / 2) * 2);
  return { width: even(width), height: even(height) };
}

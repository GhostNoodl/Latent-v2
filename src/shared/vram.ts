import type { AppSettings, HardwareInfo } from './types';

/** Cards at or above this much graphics memory (24 GB class, e.g. RTX 3090/4090) can use the roomier defaults. */
export const LARGE_VRAM_MIB = 20 * 1024;
/** Enhance stays at 2048 per side on 16 GB cards (measured peak ~16 GB there). */
export const ENHANCE_MAX_SIDE = 2048;
export const ENHANCE_MAX_SIDE_LARGE = 3072;

export function hasLargeVram(hardware?: Pick<HardwareInfo, 'vramMiB'>): boolean {
  return Number.isFinite(hardware?.vramMiB) && hardware!.vramMiB! >= LARGE_VRAM_MIB;
}

/**
 * The "Use extra graphics memory" setting. It is on by default for big cards, can be turned off,
 * and never applies to smaller cards or Low VRAM / CPU modes.
 */
export function usesExtraVram(
  settings: Pick<AppSettings, 'deviceMode' | 'extraVram'>,
  hardware?: Pick<HardwareInfo, 'vramMiB'>,
): boolean {
  return settings.deviceMode === 'auto' && settings.extraVram !== false && hasLargeVram(hardware);
}

export function enhanceMaxSide(extraVram: boolean): number {
  return extraVram ? ENHANCE_MAX_SIDE_LARGE : ENHANCE_MAX_SIDE;
}

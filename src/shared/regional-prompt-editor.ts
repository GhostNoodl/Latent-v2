import { REGIONAL_PROMPT_LIMITS, type RegionalPromptRegion } from './regional-prompt-types';
export type RegionPoint = { x: number; y: number };
export type RegionCorner = 'nw' | 'ne' | 'sw' | 'se';
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const tidy = (value: number) => Math.round(value * 1e6) / 1e6;
export function moveRegionalRegion(region: RegionalPromptRegion, delta: RegionPoint): RegionalPromptRegion {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return region;
  return { ...region, x: Math.min(1 - region.width, tidy(clamp(region.x + delta.x, 0, 1 - region.width))), y: Math.min(1 - region.height, tidy(clamp(region.y + delta.y, 0, 1 - region.height))) };
}
export function rectangleFromPoints(first: RegionPoint, second: RegionPoint) {
  const minimum = REGIONAL_PROMPT_LIMITS.minExtent;
  const left = clamp(Math.min(first.x, second.x), 0, 1 - minimum); const top = clamp(Math.min(first.y, second.y), 0, 1 - minimum);
  const right = clamp(Math.max(first.x, second.x), left + minimum, 1); const bottom = clamp(Math.max(first.y, second.y), top + minimum, 1);
  const x = tidy(left); const y = tidy(top);
  return { x, y, width: Math.min(1 - x, tidy(right - left)), height: Math.min(1 - y, tidy(bottom - top)) };
}
export function resizeRegionalRegion(region: RegionalPromptRegion, corner: RegionCorner, target: RegionPoint): RegionalPromptRegion {
  const minimum = REGIONAL_PROMPT_LIMITS.minExtent; let left = region.x; let top = region.y; let right = region.x + region.width; let bottom = region.y + region.height;
  if (corner.includes('w')) left = clamp(target.x, 0, right - minimum); else right = clamp(target.x, left + minimum, 1);
  if (corner.includes('n')) top = clamp(target.y, 0, bottom - minimum); else bottom = clamp(target.y, top + minimum, 1);
  const x = tidy(left); const y = tidy(top);
  return { ...region, x, y, width: Math.min(1 - x, tidy(right - left)), height: Math.min(1 - y, tidy(bottom - top)) };
}
export function setRegionalBound(region: RegionalPromptRegion, key: 'x' | 'y' | 'width' | 'height', value: number): RegionalPromptRegion {
  if (!Number.isFinite(value)) return region;
  const bounds = { ...region }; const minimum = REGIONAL_PROMPT_LIMITS.minExtent;
  if (key === 'x') bounds.x = Math.min(1 - region.width, tidy(clamp(value, 0, 1 - region.width)));
  if (key === 'y') bounds.y = Math.min(1 - region.height, tidy(clamp(value, 0, 1 - region.height)));
  if (key === 'width') bounds.width = Math.min(1 - region.x, tidy(clamp(value, minimum, 1 - region.x)));
  if (key === 'height') bounds.height = Math.min(1 - region.y, tidy(clamp(value, minimum, 1 - region.y)));
  return bounds;
}

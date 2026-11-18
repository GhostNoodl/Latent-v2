import { QWEN_MAX_OUTPUT_PIXELS, QWEN_MAX_OUTPUT_SIDE } from './qwen-edit-types';

export interface QwenAreaRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MIN_SIDE = 384;
const MAX_ASPECT = 3;

/** Grow [start, start+length) to `want` pixels around its middle, kept inside [0, limit). */
function widen(start: number, length: number, want: number, limit: number) {
  const size = Math.min(limit, Math.max(length, want));
  const middle = start + length / 2;
  const from = Math.max(0, Math.min(limit - size, Math.round(middle - size / 2)));
  return { start: from, length: size };
}

/**
 * The part of the picture a painted-area edit works on: the painted pixels plus
 * enough surroundings for the model to match light and style, at least 384 px a
 * side, no flatter than 3:1, on an 8-pixel grid.
 */
export function qwenAreaCrop(red: Uint8Array, width: number, height: number, blend: number): QwenAreaRectangle {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 8 ||
    height < 8 ||
    width > QWEN_MAX_OUTPUT_SIDE ||
    height > QWEN_MAX_OUTPUT_SIDE ||
    width * height > QWEN_MAX_OUTPUT_PIXELS
  )
    throw new Error(`Painted edits work on pictures up to ${QWEN_MAX_OUTPUT_SIDE} pixels a side.`);
  if (!(red instanceof Uint8Array) || red.length !== width * height)
    throw new Error('The painted area does not match the picture size.');
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let index = 0; index < red.length; index++)
    if (red[index] > 0) {
      const x = index % width;
      const y = (index - x) / width;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  if (maxX < 0) throw new Error('Paint the part you want to change first.');
  const boundsWidth = maxX - minX + 1;
  const boundsHeight = maxY - minY + 1;
  const margin = Math.max(48, Math.round(Math.max(boundsWidth, boundsHeight) * 0.25)) + blend;
  let left = Math.max(0, minX - margin);
  let top = Math.max(0, minY - margin);
  let right = Math.min(width, maxX + 1 + margin);
  let bottom = Math.min(height, maxY + 1 + margin);
  let horizontal = widen(left, right - left, MIN_SIDE, width);
  let vertical = widen(top, bottom - top, MIN_SIDE, height);
  if (horizontal.length > vertical.length * MAX_ASPECT)
    vertical = widen(vertical.start, vertical.length, Math.ceil(horizontal.length / MAX_ASPECT), height);
  if (vertical.length > horizontal.length * MAX_ASPECT)
    horizontal = widen(horizontal.start, horizontal.length, Math.ceil(vertical.length / MAX_ASPECT), width);
  left = Math.floor(horizontal.start / 8) * 8;
  top = Math.floor(vertical.start / 8) * 8;
  right = Math.min(width, Math.ceil((horizontal.start + horizontal.length) / 8) * 8);
  bottom = Math.min(height, Math.ceil((vertical.start + vertical.length) / 8) * 8);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** About one megapixel with the crop's shape, in the 256–1024 / 64-pixel steps the edit models take. */
export function qwenWorkingSize(width: number, height: number) {
  // About one megapixel, but never past 1024 a side, so tall or wide shapes keep their shape.
  const scale = Math.min(Math.sqrt((1024 * 1024) / (width * height)), 1024 / Math.max(width, height));
  const fit = (value: number) => Math.max(256, Math.min(1024, Math.round((value * scale) / 64) * 64));
  return { width: fit(width), height: fit(height) };
}

/** Same as picture, kept inside the size the app saves. */
export function qwenSameSize(width: number, height: number) {
  const scale = Math.min(
    1,
    QWEN_MAX_OUTPUT_SIDE / Math.max(width, height),
    Math.sqrt(QWEN_MAX_OUTPUT_PIXELS / (width * height)),
  );
  return {
    width: Math.max(64, Math.round(width * scale)),
    height: Math.max(64, Math.round(height * scale)),
  };
}

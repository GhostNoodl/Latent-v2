import { SOURCE_IMAGE_LIMITS, type SourceMaskEdit } from '../shared/source-types';

export type MaskTransformKind = 'grow' | 'shrink' | 'feather';
export interface MaskTransformSettings { kind: MaskTransformKind; radius: number; }
export interface MaskTransformRequest { id: number; pixels: Uint8Array; width: number; height: number; settings: MaskTransformSettings; }
export type MaskTransformResponse = { id: number; pixels: Uint8Array } | { id: number; error: string };

/** Version 1: source-pixel square morphology / Gaussian feather approximation.
 * Images are immutable inputs. Only byte grayscale scratch buffers are allocated.
 * Morphology treats off-image pixels as black; feather clamps to edge pixels.
 */
export function maskTransformEdit(settings: MaskTransformSettings): SourceMaskEdit {
  return settings.kind === 'feather'
    ? { kind: 'feather', radius: settings.radius, sigma: settings.radius / 3, boundary: 'clamp', algorithmVersion: 1 }
    : { kind: settings.kind, radius: settings.radius, shape: 'square', boundary: 'black', algorithmVersion: 1 };
}

export function transformMask(pixels: Uint8Array, width: number, height: number, settings: MaskTransformSettings): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > SOURCE_IMAGE_LIMITS.maxDimension || height > SOURCE_IMAGE_LIMITS.maxDimension || width * height > SOURCE_IMAGE_LIMITS.maxPixels) throw new Error('Mask dimensions exceed the experimental input bounds.');
  if (!(pixels instanceof Uint8Array) || pixels.length !== width * height) throw new Error('Mask pixels do not match their dimensions.');
  if (!settings || !['grow', 'shrink', 'feather'].includes(settings.kind) || !Number.isInteger(settings.radius) || settings.radius < 0 || settings.radius > 64) throw new Error('Choose a whole-pixel mask radius between 0 and 64.');
  if (!settings.radius) return pixels.slice();
  if (settings.kind !== 'feather') {
    const horizontal = new Uint8Array(pixels.length);
    const result = new Uint8Array(pixels.length);
    extremaPass(pixels, horizontal, width, height, settings.radius, true, settings.kind === 'grow');
    extremaPass(horizontal, result, width, height, settings.radius, false, settings.kind === 'grow');
    return result;
  }
  let current = pixels.slice();
  let scratch = new Uint8Array(pixels.length);
  const sigma = settings.radius / 3;
  // Tiny radii use their exact truncated Gaussian to avoid a three-box kernel
  // rounding to three identity passes (which would make radius 1 do nothing).
  if (settings.radius <= 2) {
    const weights = Array.from({ length: settings.radius * 2 + 1 }, (_, i) => Math.exp(-((i - settings.radius) ** 2) / (2 * sigma * sigma)));
    const sum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
    weightedPass(current, scratch, width, height, weights, true);
    weightedPass(scratch, current, width, height, weights, false);
    return current;
  }
  // Match the variance of three odd-width box kernels to sigma². Two adjacent
  // odd widths minimize quantization error; running sums make each pass O(N).
  let lower = Math.floor(Math.sqrt(4 * sigma * sigma + 1));
  if (lower % 2 === 0) lower--;
  const upper = lower + 2;
  const lowerCount = Math.max(0, Math.min(3, Math.round((3 * upper * upper - 3 - 12 * sigma * sigma) / (upper * upper - lower * lower))));
  for (let index = 0; index < 3; index++) {
    const radius = ((index < lowerCount ? lower : upper) - 1) / 2;
    if (!radius) continue;
    boxPass(current, scratch, width, height, radius, true);
    [current, scratch] = [scratch, current];
    boxPass(current, scratch, width, height, radius, false);
    [current, scratch] = [scratch, current];
  }
  return current;
}

function extremaPass(input: Uint8Array, output: Uint8Array, width: number, height: number, radius: number, horizontal: boolean, maximum: boolean) {
  const length = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const stride = horizontal ? 1 : width;
  const indices = new Int32Array(length + radius * 2);
  const values = new Uint8Array(indices.length);
  for (let line = 0; line < lines; line++) {
    const offset = horizontal ? line * width : line;
    let head = 0; let tail = 0;
    for (let position = -radius; position < length + radius; position++) {
      const value = position < 0 || position >= length ? 0 : input[offset + position * stride];
      while (head < tail && (maximum ? values[tail - 1] <= value : values[tail - 1] >= value)) tail--;
      indices[tail] = position; values[tail++] = value;
      while (head < tail && indices[head] < position - radius * 2) head++;
      const center = position - radius;
      if (center >= 0) output[offset + center * stride] = values[head];
    }
  }
}

function boxPass(input: Uint8Array, output: Uint8Array, width: number, height: number, radius: number, horizontal: boolean) {
  const length = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const stride = horizontal ? 1 : width;
  const divisor = radius * 2 + 1;
  for (let line = 0; line < lines; line++) {
    const offset = horizontal ? line * width : line;
    let sum = input[offset] * (radius + 1);
    for (let i = 1; i <= radius; i++) sum += input[offset + Math.min(length - 1, i) * stride];
    for (let position = 0; position < length; position++) {
      output[offset + position * stride] = Math.round(sum / divisor);
      sum += input[offset + Math.min(length - 1, position + radius + 1) * stride] - input[offset + Math.max(0, position - radius) * stride];
    }
  }
}

function weightedPass(input: Uint8Array, output: Uint8Array, width: number, height: number, weights: number[], horizontal: boolean) {
  const length = horizontal ? width : height;
  const lines = horizontal ? height : width;
  const stride = horizontal ? 1 : width;
  const radius = (weights.length - 1) / 2;
  for (let line = 0; line < lines; line++) {
    const offset = horizontal ? line * width : line;
    for (let position = 0; position < length; position++) {
      let sum = 0;
      for (let kernel = -radius; kernel <= radius; kernel++) sum += input[offset + Math.max(0, Math.min(length - 1, position + kernel)) * stride] * weights[kernel + radius];
      output[offset + position * stride] = Math.round(sum);
    }
  }
}

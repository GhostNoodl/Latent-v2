/** Python's round uses ties-to-even, unlike Math.round. Match the pinned Qwen node. */
function roundEven(value: number): number {
  const floor = Math.floor(value);
  return value - floor === 0.5 ? floor + floor % 2 : Math.round(value);
}

/** TextEncodeQwenImageEditPlus, Comfy 12d5279: 1024² area, nearest eight pixels. */
export function qwenReferenceSize(width: number, height: number) {
  const scale = Math.sqrt(1024 * 1024 / (width * height));
  return { width: roundEven(width * scale / 8) * 8, height: roundEven(height * scale / 8) * 8 };
}

/** Stable native canvas: the conditioner's own normalization must not change its dimensions.
 * All advertised output sizes remain available. Smaller saved files do not reduce sampling area.
 */
export function qwenInferenceSize(width: number, height: number) {
  if (![width, height].every(value => Number.isInteger(value) && value >= 256 && value <= 1024 && value % 16 === 0)) throw new Error('Qwen saved dimensions must be 256–1024 in multiples of 16.');
  let current = { width, height };
  for (let iteration = 0; iteration < 8; iteration++) {
    const next = qwenReferenceSize(current.width, current.height);
    if (next.width === current.width && next.height === current.height) {
      if (Math.min(next.width, next.height) < 512 || Math.max(next.width, next.height) > 2048 || next.width * next.height > 1_060_000) throw new Error('The Qwen native canvas exceeds the reviewed geometry bounds.');
      return next;
    }
    current = next;
  }
  throw new Error('The Qwen native canvas did not reach stable reference dimensions.');
}

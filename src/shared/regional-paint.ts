/**
 * Painted regions: a coarse on/off grid saved with the region, scaled up and softened for the mask.
 * The grid is stored as base64 bits so a recipe stays small (about 2.7 KB per region).
 */
export const PAINT_GRID = 128;
const CELLS = PAINT_GRID * PAINT_GRID;
const BYTES = CELLS / 8;
export const PAINT_TEXT_LENGTH = Math.ceil(BYTES / 3) * 4;
export const PAINT_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type PaintCells = Uint8Array;

export const emptyPaint = (): PaintCells => new Uint8Array(CELLS);

export function encodePaint(cells: PaintCells): string {
  const bytes = new Uint8Array(BYTES);
  for (let index = 0; index < CELLS; index++) if (cells[index]) bytes[index >> 3] |= 1 << (index & 7);
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

export function decodePaint(value: string): PaintCells {
  if (value.length !== PAINT_TEXT_LENGTH || !PAINT_PATTERN.test(value)) throw new Error('The painted area is damaged.');
  const text = atob(value);
  if (text.length !== BYTES) throw new Error('The painted area is damaged.');
  const cells = emptyPaint();
  for (let index = 0; index < CELLS; index++) cells[index] = (text.charCodeAt(index >> 3) >> (index & 7)) & 1;
  return cells;
}

/** Smallest box around the painted cells, in 0–1 canvas units, or undefined when nothing is painted. */
export function paintBounds(cells: PaintCells) {
  let left = PAINT_GRID,
    top = PAINT_GRID,
    right = -1,
    bottom = -1;
  for (let y = 0; y < PAINT_GRID; y++)
    for (let x = 0; x < PAINT_GRID; x++)
      if (cells[y * PAINT_GRID + x]) {
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
  if (right < 0) return undefined;
  return {
    x: left / PAINT_GRID,
    y: top / PAINT_GRID,
    width: (right - left + 1) / PAINT_GRID,
    height: (bottom - top + 1) / PAINT_GRID,
  };
}

/**
 * One brush segment from `from` to `to` (0–1 canvas units). The radius is a share of the canvas's longer
 * side so the brush stays round on wide or tall images. Returns a new grid.
 */
export function paintStroke(
  cells: PaintCells,
  from: { x: number; y: number },
  to: { x: number; y: number },
  radius: number,
  canvas: { width: number; height: number },
  erase = false,
): PaintCells {
  const next = Uint8Array.from(cells);
  const long = Math.max(canvas.width, canvas.height);
  const r = radius * long;
  const ax = from.x * canvas.width,
    ay = from.y * canvas.height,
    bx = to.x * canvas.width,
    by = to.y * canvas.height;
  const dx = bx - ax,
    dy = by - ay,
    length = dx * dx + dy * dy;
  const cellW = canvas.width / PAINT_GRID,
    cellH = canvas.height / PAINT_GRID;
  const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / cellW)),
    x1 = Math.min(PAINT_GRID - 1, Math.floor((Math.max(ax, bx) + r) / cellW)),
    y0 = Math.max(0, Math.floor((Math.min(ay, by) - r) / cellH)),
    y1 = Math.min(PAINT_GRID - 1, Math.floor((Math.max(ay, by) + r) / cellH));
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) * cellW,
        py = (y + 0.5) * cellH;
      const t = length ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length)) : 0;
      const ex = px - (ax + t * dx),
        ey = py - (ay + t * dy);
      if (ex * ex + ey * ey <= r * r) next[y * PAINT_GRID + x] = erase ? 0 : 1;
    }
  return next;
}

/** One pass of an integer box blur along rows (`horizontal`) or columns. */
function boxBlur(source: Uint8Array, width: number, height: number, radius: number, horizontal: boolean) {
  const out = new Uint8Array(source.length);
  const lines = horizontal ? height : width,
    span = horizontal ? width : height;
  const at = (line: number, i: number) => (horizontal ? line * width + i : i * width + line);
  const size = radius * 2 + 1;
  for (let line = 0; line < lines; line++) {
    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += source[at(line, Math.min(span - 1, Math.max(0, i)))];
    for (let i = 0; i < span; i++) {
      out[at(line, i)] = Math.round(sum / size);
      sum +=
        source[at(line, Math.min(span - 1, i + radius + 1))] -
        source[at(line, Math.min(span - 1, Math.max(0, i - radius)))];
    }
  }
  return out;
}

/** Full-size u8 mask: cells scaled to the canvas, then softened by `feather` pixels (two box passes). */
export function rasterizePaint(cells: PaintCells, canvas: { width: number; height: number }, feather: number) {
  const { width, height } = canvas;
  let pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = Math.floor((y * PAINT_GRID) / height) * PAINT_GRID;
    for (let x = 0; x < width; x++) if (cells[row + Math.floor((x * PAINT_GRID) / width)]) pixels[y * width + x] = 255;
  }
  const radius = Math.max(0, Math.floor(feather / 2));
  if (radius > 0)
    for (let pass = 0; pass < 2; pass++) {
      pixels = boxBlur(pixels, width, height, radius, true);
      pixels = boxBlur(pixels, width, height, radius, false);
    }
  return pixels;
}

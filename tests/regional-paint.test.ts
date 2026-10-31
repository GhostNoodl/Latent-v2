import { describe, expect, it } from 'vitest';
import {
  PAINT_GRID,
  decodePaint,
  emptyPaint,
  encodePaint,
  paintBounds,
  paintStroke,
  rasterizePaint,
} from '../src/shared/regional-paint';
import { regionalPromptRegionSchema, type RegionalPromptRegion } from '../src/shared/regional-prompt-types';
import { rasterizeRegionalMask } from '../src/shared/regional-prompt-workflow';

const canvas = { width: 1024, height: 1024 };
const region = (change: Partial<RegionalPromptRegion> = {}): RegionalPromptRegion => ({
  id: 'r1',
  name: 'Sky',
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  positivePrompt: 'stars',
  negativePrompt: '',
  strength: 1,
  feather: 0,
  ...change,
});

describe('painted regions', () => {
  it('round-trips the painted cells', () => {
    const cells = paintStroke(emptyPaint(), { x: 0.2, y: 0.2 }, { x: 0.8, y: 0.3 }, 0.03, canvas);
    const text = encodePaint(cells);
    expect(decodePaint(text)).toEqual(cells);
    expect(() => decodePaint(text.slice(1))).toThrow('damaged');
  });
  it('paints a solid line between points and erases it again', () => {
    const line = paintStroke(emptyPaint(), { x: 0.1, y: 0.5 }, { x: 0.9, y: 0.5 }, 0.02, canvas);
    const bounds = paintBounds(line)!;
    expect(bounds.x).toBeCloseTo(0.08, 1);
    expect(bounds.x + bounds.width).toBeCloseTo(0.92, 1);
    for (let x = Math.ceil(0.1 * PAINT_GRID); x < 0.9 * PAINT_GRID; x++) expect(line[64 * PAINT_GRID + x]).toBe(1);
    const erased = paintStroke(line, { x: 0, y: 0.5 }, { x: 1, y: 0.5 }, 0.05, canvas, true);
    expect(paintBounds(erased)).toBeUndefined();
  });
  it('keeps the brush round on wide canvases', () => {
    const wide = { width: 2048, height: 1024 };
    const dot = paintBounds(paintStroke(emptyPaint(), { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, 0.05, wide))!;
    expect(dot.width * wide.width).toBeCloseTo(dot.height * wide.height, -2);
  });
  it('builds the mask from paint and softens it with feather', async () => {
    const cells = emptyPaint();
    for (let y = 0; y < PAINT_GRID; y++) cells.fill(1, y * PAINT_GRID, y * PAINT_GRID + PAINT_GRID / 2);
    const hard = rasterizePaint(cells, canvas, 0);
    expect(hard[10 * 1024 + 100]).toBe(255);
    expect(hard[10 * 1024 + 900]).toBe(0);
    const soft = rasterizePaint(cells, canvas, 32);
    expect(soft[10 * 1024 + 511]).toBeGreaterThan(0);
    expect(soft[10 * 1024 + 511]).toBeLessThan(255);
    expect(soft[10 * 1024 + 100]).toBe(255);
    const paint = encodePaint(cells);
    const checked = regionalPromptRegionSchema.parse(region({ paint, width: 0.5, feather: 32 }));
    const mask = await rasterizeRegionalMask(checked, canvas);
    expect(mask.pixels).toEqual(soft);
    expect((await rasterizeRegionalMask(checked, canvas)).rawMaskSha256).toBe(mask.rawMaskSha256);
  });
  it('refuses an empty painted area', () => {
    expect(() => regionalPromptRegionSchema.parse(region({ paint: encodePaint(emptyPaint()) }))).toThrow('Paint some');
  });
});

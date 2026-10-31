import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import { draftSchema } from '../src/shared/validation';
import { LIVE_MAX_STEPS, liveDraft, liveLeftovers, sketchSize } from '../src/renderer/LivePaint';
import { SourceImageService } from '../src/main/source-images';
import { StudioStore } from '../src/main/store';
import { createPaths, inside } from '../src/main/paths';

describe('live paint recipe', () => {
  it('runs the sketch through the current settings with fewer steps', () => {
    const draft = {
      ...structuredClone(DEFAULT_DRAFT),
      steps: 28,
      batchSize: 4,
      hiresFix: { scale: 1.5, steps: 8, denoise: 0.4 } as never,
      sweep: { id: 'sw-a', index: 0, columnLabel: 'Steps', columns: ['20'], rows: [] },
    };
    const live = liveDraft(
      draft,
      { id: 'src_x', sha256: 'a'.repeat(64) },
      { prompt: 'a fox', strength: 0.6, seed: '7' },
    );
    expect(live).toMatchObject({ prompt: 'a fox', seed: '7', batchSize: 1, steps: LIVE_MAX_STEPS });
    expect(live.imageInput).toEqual({
      mode: 'img2img',
      sourceId: 'src_x',
      sourceSha256: 'a'.repeat(64),
      denoise: 0.6,
      resize: 'center-crop',
    });
    expect(live.hiresFix).toBeUndefined();
    expect(live.sweep).toBeUndefined();
    expect(
      liveDraft(
        { ...draft, steps: 6 },
        { id: 'src_x', sha256: 'a'.repeat(64) },
        { prompt: '', strength: 2, seed: '1' },
      ),
    ).toMatchObject({ steps: 6, imageInput: { denoise: 1 } });
  });
  it('keeps recipes that pass the draft checks', () => {
    const live = liveDraft(
      structuredClone(DEFAULT_DRAFT),
      { id: 'src_00000000-0000-4000-8000-000000000000', sha256: 'a'.repeat(64) },
      { prompt: 'a fox', strength: 0.6, seed: '7' },
    );
    expect(() => draftSchema.parse(JSON.parse(JSON.stringify(live)))).not.toThrow();
  });
  it('sizes the sketch to at most 1024 on the long side', () => {
    expect(sketchSize(832, 1216)).toEqual({ width: 701, height: 1024 });
    expect(sketchSize(512, 512)).toEqual({ width: 512, height: 512 });
  });
  it('cleans up only what was not kept', () => {
    const results = [
      { recordId: 'r1', sketchId: 's1' },
      { recordId: 'r2', sketchId: 's2' },
    ];
    expect(liveLeftovers(results, ['s1', 's2', 's3'], new Set(['r2']))).toEqual({
      records: ['r1'],
      sketches: ['s1', 's3'],
    });
  });
});

describe('live sketches on disk', () => {
  let sandbox: string;
  let store: StudioStore;
  let sources: SourceImageService;
  const png = () => {
    const image = new PNG({ width: 64, height: 64 });
    image.data.fill(240);
    return new Uint8Array(PNG.sync.write(image));
  };
  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-live-tests-'));
    const paths = createPaths(path.join(sandbox, 'studio'));
    store = new StudioStore(paths.database);
    sources = new SourceImageService(paths, store);
  });
  afterEach(async () => {
    store.close();
    const resolved = path.resolve(sandbox);
    if (!inside(os.tmpdir(), resolved) || !path.basename(resolved).startsWith('latent-live-tests-'))
      throw new Error('Unsafe test cleanup.');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  it('discards its own sketches and never other sources', async () => {
    const sketch = await sources.importLiveSketch(png());
    const other = await sources.importBytes(png(), 'photo.png');
    expect(sketch.name).toBe('Live paint');
    expect(await sources.discardLiveSketches([sketch.id, other.id, 'nonsense'])).toBe(1);
    expect(sources.list().sources.map(item => item.id)).toEqual([other.id]);
    await expect(sources.resolve(sketch.id)).rejects.toThrow();
    expect((await sources.resolve(other.id)).source.id).toBe(other.id);
    expect(await sources.discardLiveSketches([sketch.id])).toBe(0);
  });
});

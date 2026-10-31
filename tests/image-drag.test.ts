import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import type { GenerationRecord } from '../src/shared/types';
import { RECORD_DRAG_TYPE, droppedImage } from '../src/renderer/image-drag';
import { SourceImageService } from '../src/main/source-images';
import { StudioStore } from '../src/main/store';
import { createPaths, inside } from '../src/main/paths';

const record = (id: string) =>
  ({ id, jobId: id, draft: structuredClone(DEFAULT_DRAFT), loras: [] }) as unknown as GenerationRecord;
const transfer = (data: Record<string, string>, files: File[] = []) => ({
  getData: (type: string) => data[type] ?? '',
  files: files as unknown as FileList,
});

describe('dropped images', () => {
  it('prefers a saved image from the studio', () => {
    const records = [record('a'), record('b')];
    const file = new File([new Uint8Array([1])], 'photo.png', { type: 'image/png' });
    expect(droppedImage(transfer({ [RECORD_DRAG_TYPE]: 'b' }, [file]), records)).toEqual({
      kind: 'record',
      record: records[1],
    });
  });
  it('takes the first image file and skips other files', () => {
    const text = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    const photo = new File([new Uint8Array([1])], 'Photo.JPG');
    expect(droppedImage(transfer({}, [text, photo]), [])).toEqual({ kind: 'file', file: photo });
    expect(droppedImage(transfer({}, [text]), [])).toBeUndefined();
  });
  it('ignores a saved image that is gone', () => {
    expect(droppedImage(transfer({ [RECORD_DRAG_TYPE]: 'gone' }), [record('a')])).toBeUndefined();
  });
});

describe('importing dropped bytes', () => {
  let sandbox: string;
  let store: StudioStore;
  let sources: SourceImageService;
  beforeEach(async () => {
    sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-drop-tests-'));
    const paths = createPaths(path.join(sandbox, 'studio'));
    store = new StudioStore(paths.database);
    sources = new SourceImageService(paths, store);
  });
  afterEach(async () => {
    store.close();
    const resolved = path.resolve(sandbox);
    if (!inside(os.tmpdir(), resolved) || !path.basename(resolved).startsWith('latent-drop-tests-'))
      throw new Error('Unsafe test cleanup.');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  it('saves a dropped PNG as a source with a clean name', async () => {
    const image = new PNG({ width: 64, height: 32 });
    image.data.fill(200);
    const source = await sources.importBytes(new Uint8Array(PNG.sync.write(image)), 'D:\\Pictures\\cat.png');
    expect(source.name).toBe('cat.png');
    expect(source.normalized).toMatchObject({ width: 64, height: 32 });
    expect(sources.list().sources.map(item => item.id)).toContain(source.id);
  });
  it('refuses empty or non-image bytes', async () => {
    await expect(sources.importBytes(new Uint8Array(), 'x.png')).rejects.toThrow('empty');
    await expect(sources.importBytes(new TextEncoder().encode('not an image'), 'x.png')).rejects.toThrow();
  });
});

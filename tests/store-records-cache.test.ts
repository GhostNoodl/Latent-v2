import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioStore } from '../src/main/store';
import type { GenerationRecord } from '../src/shared/types';

const dirs: string[] = [];
const stores: StudioStore[] = [];
function open(file?: string) {
  if (!file) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latent-records-test-'));
    dirs.push(root);
    file = path.join(root, 'studio.sqlite');
  }
  const store = new StudioStore(file);
  stores.push(store);
  return { store, file };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
const record = (id: string, jobId: string, minute: number, prompt = id) =>
  ({
    id,
    jobId,
    createdAt: `2026-10-18T10:${String(minute).padStart(2, '0')}:00.000Z`,
    prompt,
  }) as unknown as GenerationRecord;

describe('image library cache', () => {
  it('matches the database after inserts, out-of-order inserts and updates', () => {
    const { store, file } = open();
    store.records(); // Warm the cache so every write below goes through it.
    store.saveRecord(record('b', 'job1', 2));
    store.saveRecord(record('d', 'job2', 4));
    store.saveRecord(record('a', 'job1', 1));
    store.saveRecord(record('c', 'job2', 2));
    store.saveRecord({ ...record('b', 'job1', 9), prompt: 'edited' } as unknown as GenerationRecord);
    const fresh = open(file).store;
    expect(store.records()).toEqual(fresh.records());
    expect(store.records().map(item => item.id)).toEqual(['d', 'c', 'b', 'a']);
    expect(store.record('b')).toMatchObject({ prompt: 'edited' });
    expect(store.recordsForJob('job1').map(item => item.id)).toEqual(['b', 'a']);
    expect(store.recordsForJob('none')).toEqual([]);
  });

  it('bumps its revision on every write and never shares the caller’s object', () => {
    const { store } = open();
    const before = store.recordsRevision;
    const mine = record('a', 'job1', 1);
    store.records();
    store.saveRecord(mine);
    (mine as unknown as { prompt: string }).prompt = 'changed after saving';
    expect(store.recordsRevision).toBe(before + 1);
    expect(store.record('a')).toMatchObject({ prompt: 'a' });
    expect(Object.isFrozen(store.record('a'))).toBe(true);
  });

  it('hands out copies of settings and presets, refreshed after each save', () => {
    const { store } = open();
    const settings = store.settings();
    settings.theme = 'dark';
    expect(store.settings().theme).not.toBe('dark');
    store.saveSettings({ theme: 'dark' });
    expect(store.settings().theme).toBe('dark');
    const revision = store.presetsRevision;
    expect(store.presets()).toEqual([]);
    store.savePreset({ id: 'p', name: 'Mine', draft: store.draft() });
    expect(store.presets().map(preset => preset.name)).toEqual(['Mine']);
    store.deletePreset('p');
    expect(store.presets()).toEqual([]);
    expect(store.presetsRevision).toBe(revision + 2);
  });
});

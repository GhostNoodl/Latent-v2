import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MissingOutputs } from '../src/main/missing-outputs';
import type { GenerationRecord } from '../src/shared/types';

let dir: string | undefined;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = undefined;
});
const record = (id: string) => ({ id, filename: `${id}.png` }) as GenerationRecord;

it('hides images deleted from disk and shows them again once restored', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-missing-'));
  const records = [record('a'), record('b')];
  for (const item of records) await fs.writeFile(path.join(dir, item.filename), 'png');
  let changes = 0;
  const missing = new MissingOutputs(
    () => records,
    item => path.join(dir!, item.filename),
    () => changes++,
  );
  expect(await missing.refresh()).toBe(false);
  expect(missing.visible(records).map(item => item.id)).toEqual(['a', 'b']);

  await fs.rm(path.join(dir, 'a.png'));
  expect(await missing.refresh()).toBe(true);
  expect(missing.visible(records).map(item => item.id)).toEqual(['b']);
  expect(missing.has('a')).toBe(true);
  expect(await missing.refresh()).toBe(false);

  await fs.writeFile(path.join(dir, 'a.png'), 'png');
  expect(await missing.refresh()).toBe(true);
  expect(missing.visible(records).map(item => item.id)).toEqual(['a', 'b']);
  expect(changes).toBe(2);
});

it('keeps an image whose path cannot be resolved rather than hiding it', async () => {
  const records = [record('a')];
  const missing = new MissingOutputs(
    () => records,
    () => {
      throw new Error('outside the studio');
    },
    () => undefined,
  );
  expect(await missing.refresh()).toBe(false);
  expect(missing.visible(records)).toHaveLength(1);
});

it('re-checks only the files it is told about, and keeps what it already knew', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-missing-'));
  const records = [record('a'), record('b'), record('c')];
  for (const item of records) await fs.writeFile(path.join(dir, item.filename), 'png');
  const missing = new MissingOutputs(
    () => records,
    item => path.join(dir!, item.filename),
    () => undefined,
  );
  await fs.rm(path.join(dir, 'a.png'));
  await fs.rm(path.join(dir, 'b.png'));
  expect(await missing.refresh([path.join(dir, 'a.png')])).toBe(true);
  expect(missing.visible(records).map(item => item.id)).toEqual(['b', 'c']);
  const shown = missing.visible(records);
  expect(missing.visible(records)).toBe(shown);
  expect(await missing.refresh()).toBe(true);
  expect(missing.visible(records).map(item => item.id)).toEqual(['c']);
  await fs.writeFile(path.join(dir, 'b.png'), 'png');
  expect(await missing.refresh([path.join(dir, 'b.png')])).toBe(true);
  expect(missing.visible(records).map(item => item.id)).toEqual(['b', 'c']);
  expect(missing.revision).toBe(3);
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ app: {}, net: {} }));
const { pruneOldLogs } = await import('../src/main/managed-backend');

let dir: string | undefined;
afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
});

it('keeps the five newest rotated backend logs and nothing else is touched', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-logs-'));
  const rotated = [1, 2, 3, 4, 5, 6, 7].map(n => `backend-${n * 1000}.log`);
  for (const name of [...rotated, 'backend.log', 'desktop.log']) await fs.writeFile(path.join(dir, name), 'x');
  await pruneOldLogs(dir);
  expect((await fs.readdir(dir)).sort()).toEqual(
    [
      'backend-3000.log',
      'backend-4000.log',
      'backend-5000.log',
      'backend-6000.log',
      'backend-7000.log',
      'backend.log',
      'desktop.log',
    ].sort(),
  );
});

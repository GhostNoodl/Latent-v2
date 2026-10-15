import { expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDesktopLog } from '../src/main/desktop-log';

it('appends single-line entries and rotates by size, keeping a bounded history', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-log-test-'));
  try {
    const log = createDesktopLog(path.join(dir, 'logs'), { maxBytes: 200, keep: 2 });
    for (let i = 0; i < 20; i++) void log(`entry ${i}\nsecond line`);
    await log('last');
    const files = (await fs.readdir(path.join(dir, 'logs'))).sort();
    expect(files).toEqual(['desktop.1.log', 'desktop.2.log', 'desktop.log']);
    const current = await fs.readFile(path.join(dir, 'logs', 'desktop.log'), 'utf8');
    expect(current).toMatch(/ last\n$/);
    expect(current).not.toContain('\nsecond');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('never rejects when the log location is unusable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-log-test-'));
  try {
    await fs.writeFile(path.join(dir, 'blocked'), 'a file, not a folder');
    await expect(createDesktopLog(path.join(dir, 'blocked'))('message')).resolves.toBeUndefined();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

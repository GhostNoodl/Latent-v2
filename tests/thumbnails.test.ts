import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { ThumbnailCache, thumbnailSource } from '../src/main/thumbnails';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true })));
});

it('only accepts saved images and Civitai previews', () => {
  const id = 'b'.repeat(32);
  expect(thumbnailSource(`/output/${id}`)).toEqual({ kind: 'output', id });
  const url = 'https://image.civitai.com/abc/width=450/1.jpeg';
  expect(thumbnailSource(`/civitai/${Buffer.from(url).toString('base64url')}`)).toEqual({ kind: 'civitai', url });
  const other = Buffer.from('http://192.168.1.2/secret.png').toString('base64url');
  expect(thumbnailSource(`/civitai/${other}`)).toBeUndefined();
  expect(thumbnailSource('/output/../../etc')).toBeUndefined();
});

it('makes a small WebP once, then serves it from disk and memory', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-thumbs-'));
  folders.push(folder);
  const source = path.join(folder, 'big.png');
  await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#808080' } })
    .png()
    .toFile(source);
  const outputPath = vi.fn(async () => source);
  const fetchRemote = vi.fn();
  const cache = new ThumbnailCache(path.join(folder, 'thumbs'), { outputPath, fetchRemote });
  const first = await cache.get({ kind: 'output', id: 'c'.repeat(32) });
  const meta = await sharp(first).metadata();
  expect(meta.format).toBe('webp');
  expect(Math.max(meta.width!, meta.height!)).toBe(384);
  await cache.get({ kind: 'output', id: 'c'.repeat(32) });
  expect(outputPath).toHaveBeenCalledTimes(1);
  // A fresh cache (next app start) reads the stored copy without touching the original.
  const again = new ThumbnailCache(path.join(folder, 'thumbs'), { outputPath, fetchRemote });
  expect((await again.get({ kind: 'output', id: 'c'.repeat(32) })).equals(first)).toBe(true);
  expect(outputPath).toHaveBeenCalledTimes(1);
});

it('does not keep refetching a preview that failed', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-thumbs-'));
  folders.push(folder);
  const fetchRemote = vi.fn(async () => new Response('nope', { status: 404 }));
  const cache = new ThumbnailCache(folder, { outputPath: async () => '', fetchRemote });
  const source = { kind: 'civitai' as const, url: 'https://image.civitai.com/x/1.jpeg' };
  await expect(cache.get(source)).rejects.toThrow();
  await expect(cache.get(source)).rejects.toThrow();
  expect(fetchRemote).toHaveBeenCalledTimes(1);
});

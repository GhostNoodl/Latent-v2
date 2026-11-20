import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

/** Long side of a stored thumbnail. Picker cards and Library tiles show them at ~200 px, so this stays sharp on 2× screens. */
export const THUMBNAIL_SIZE = 384;
const MEMORY_ENTRIES = 400;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
/** A source that failed is not retried for a while, so a broken preview doesn't refetch on every render. */
const FAILURE_PAUSE_MS = 10 * 60 * 1000;
const CIVITAI_IMAGE = /^https:\/\/(image|imagecache)\.civitai\.com\//;

export type ThumbnailSource = { kind: 'output'; id: string } | { kind: 'civitai'; url: string };

export function isCivitaiImageUrl(url: string) {
  return CIVITAI_IMAGE.test(url);
}

/** Parses `latent-asset://thumb/<kind>/<value>` paths; anything else is refused. */
export function thumbnailSource(pathname: string): ThumbnailSource | undefined {
  const output = /^\/output\/([a-f0-9]{32})$/.exec(pathname);
  if (output) return { kind: 'output', id: output[1] };
  const civitai = /^\/civitai\/([A-Za-z0-9_-]{8,4000})$/.exec(pathname);
  if (civitai) {
    const url = Buffer.from(civitai[1], 'base64url').toString('utf8');
    if (isCivitaiImageUrl(url) && url.length <= 2000 && !/[\s<>"]/.test(url)) return { kind: 'civitai', url };
  }
  return undefined;
}

/**
 * Small WebP copies of model previews and saved images, kept on disk and in memory so
 * pickers and the Library show them right away instead of decoding full-size files.
 */
export class ThumbnailCache {
  private memory = new Map<string, Buffer>();
  private pending = new Map<string, Promise<Buffer>>();
  private failures = new Map<string, number>();
  private remoteSlots = 4;
  private remoteQueue: Array<() => void> = [];
  constructor(
    private folder: string,
    private options: {
      outputPath(id: string): Promise<string>;
      fetchRemote(url: string): Promise<Response>;
    },
  ) {}

  async get(source: ThumbnailSource): Promise<Buffer> {
    const key = source.kind === 'output' ? `output:${source.id}` : `civitai:${source.url}`;
    const hit = this.memory.get(key);
    if (hit) {
      this.memory.delete(key);
      this.memory.set(key, hit);
      return hit;
    }
    const failedAt = this.failures.get(key);
    if (failedAt && Date.now() - failedAt < FAILURE_PAUSE_MS) throw new Error('Preview unavailable');
    let job = this.pending.get(key);
    if (!job) {
      job = this.load(key, source).finally(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
    try {
      const bytes = await job;
      this.remember(key, bytes);
      this.failures.delete(key);
      return bytes;
    } catch (error) {
      this.failures.set(key, Date.now());
      throw error;
    }
  }

  /** Builds missing thumbnails in the background, a few at a time, so the first look is quick too. */
  async warm(sources: ThumbnailSource[]) {
    const queue = [...sources];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await this.get(next).catch(() => undefined);
    };
    await Promise.all([worker(), worker()]);
  }

  private remember(key: string, bytes: Buffer) {
    this.memory.delete(key);
    this.memory.set(key, bytes);
    while (this.memory.size > MEMORY_ENTRIES) this.memory.delete(this.memory.keys().next().value!);
  }

  private file(key: string) {
    return path.join(this.folder, `${createHash('sha256').update(key).digest('hex')}.webp`);
  }

  private async load(key: string, source: ThumbnailSource) {
    const file = this.file(key);
    try {
      return await fsp.readFile(file);
    } catch {
      // Not made yet.
    }
    const original =
      source.kind === 'output'
        ? await fsp.readFile(await this.options.outputPath(source.id))
        : await this.remote(source.url);
    const bytes = await sharp(original, { failOn: 'none', animated: false, limitInputPixels: 16384 * 16384 })
      .rotate()
      .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    await fsp.mkdir(this.folder, { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.part`;
    try {
      await fsp.writeFile(temporary, bytes);
      await fsp.rename(temporary, file);
    } catch {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
    return bytes;
  }

  private async remote(url: string) {
    if (this.remoteSlots > 0) this.remoteSlots--;
    else await new Promise<void>(resolve => this.remoteQueue.push(resolve));
    try {
      const response = await this.options.fetchRemote(url);
      if (!response.ok) throw new Error(`Preview download failed (${response.status})`);
      const type = response.headers.get('content-type') ?? '';
      if (type && !type.startsWith('image/') && type !== 'application/octet-stream')
        throw new Error('That preview is not a picture.');
      const length = Number(response.headers.get('content-length') ?? 0);
      if (length > MAX_SOURCE_BYTES) throw new Error('That preview is too big.');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_SOURCE_BYTES) throw new Error('That preview is too big.');
      return bytes;
    } finally {
      const next = this.remoteQueue.shift();
      if (next) next();
      else this.remoteSlots++;
    }
  }
}

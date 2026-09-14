import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface AssistantAsset { url: string; filename: string; bytes: number; sha256: string; }
interface Resume { url: string; bytes: number; sha256: string; etag?: string; }
async function requireDownloadSpace(directory: string, bytes: number) {
  const free = await fs.promises.statfs(directory);
  if (free.bavail * free.bsize < bytes + 256 * 1024 * 1024) throw new Error('Not enough free space for the local assistant asset.');
}
export async function assistantHash(filename: string, signal?: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) { signal?.throwIfAborted(); hash.update(chunk); }
  signal?.throwIfAborted(); return hash.digest('hex');
}

async function regularFile(filename: string, allowLinks = false) {
  try {
    const stat = await fs.promises.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (!allowLinks && stat.nlink !== 1)) throw new Error('Assistant asset paths must be independent regular files.');
    return stat;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export async function downloadAssistantAsset(asset: AssistantAsset, directory: string, signal: AbortSignal, progress: (received: number, total: number, verifying: boolean) => void): Promise<string> {
  try { return await downloadPinnedAsset(asset, directory, signal, progress); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOSPC') throw Object.assign(new Error('Not enough disk space to finish dependency setup. Existing assets and any partial download were retained. Free disk space, then retry setup.', { cause: error }), { code: 'ENOSPC' });
    throw error;
  }
}
async function downloadPinnedAsset(asset: AssistantAsset, directory: string, signal: AbortSignal, progress: (received: number, total: number, verifying: boolean) => void): Promise<string> {
  if (path.basename(asset.filename) !== asset.filename || ['.', '..'].includes(asset.filename) || new URL(asset.url).protocol !== 'https:' || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || !/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid pinned assistant asset.');
  await fs.promises.mkdir(directory, { recursive: true });
  const target = path.join(directory, asset.filename);
  const partial = `${target}.part`; const manifest = `${partial}.json`;
  // Recover a crash after atomic publication but before removing the owned staging link.
  const published = await regularFile(target, true);
  if (published && published.nlink !== 1) {
    const staged = await regularFile(partial, true);
    let metadata: Resume | undefined;
    if (await regularFile(manifest)) { try { metadata = JSON.parse(await fs.promises.readFile(manifest, 'utf8')); } catch { /* Refuse ambiguous ownership below. */ } }
    if (published.nlink !== 2 || !staged || staged.dev !== published.dev || staged.ino !== published.ino || metadata?.url !== asset.url || metadata?.sha256 !== asset.sha256 || metadata?.bytes !== asset.bytes || await assistantHash(target, signal) !== asset.sha256) throw new Error('Assistant asset paths must be independent regular files.');
    await fs.promises.unlink(partial); await fs.promises.unlink(manifest);
  }
  if (await regularFile(target)) {
    progress(asset.bytes, asset.bytes, true);
    if (await assistantHash(target, signal) === asset.sha256) return target;
    throw new Error(`Existing ${asset.filename} failed verification; the original was preserved.`);
  }
  let offset = (await regularFile(partial))?.size ?? 0;
  let saved: Resume | undefined;
  if (await regularFile(manifest)) { try { saved = JSON.parse(await fs.promises.readFile(manifest, 'utf8')); } catch { /* Quarantine below. */ } }
  const quarantine = async () => {
    const suffix = `.invalid-${randomUUID()}`;
    for (const filename of [partial, manifest]) if (await regularFile(filename)) await fs.promises.rename(filename, `${filename}${suffix}`);
    offset = 0; saved = undefined;
  };
  if (offset && (saved?.url !== asset.url || saved.sha256 !== asset.sha256 || saved.bytes !== asset.bytes || offset > asset.bytes)) await quarantine();
  signal.throwIfAborted();
  if (offset !== asset.bytes) {
    await requireDownloadSpace(directory, asset.bytes - offset);
    const response = await fetch(asset.url, { headers: { 'Accept-Encoding': 'identity', ...(offset ? { Range: `bytes=${offset}-`, ...(saved?.etag ? { 'If-Range': saved.etag } : {}) } : {}) }, signal });
    let responseCancelled = false;
    const cancelResponse = async () => { if (responseCancelled) return; responseCancelled = true; await response.body?.cancel(); };
    try {
      if (new URL(response.url || asset.url).protocol !== 'https:') { await cancelResponse(); throw new Error('Assistant download redirected to an insecure URL.'); }
      if (offset && response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
        if (!range || Number(range[1]) !== offset || Number(range[2]) !== asset.bytes - 1 || Number(range[3]) !== asset.bytes || (saved?.etag && response.headers.get('etag') !== saved.etag)) {
          await cancelResponse(); await quarantine(); throw new Error('The download server changed its resume response. Retry to fetch a fresh verified copy.');
        }
      } else if (offset && response.status === 200) {
        // A server ignoring Range requires the whole file in addition to the
        // preserved prefix. Reject before moving its usable resume metadata.
        try { await requireDownloadSpace(directory, asset.bytes); }
        catch (error) { await cancelResponse().catch(() => undefined); throw error; }
        await quarantine();
      }
      else if (offset && response.status === 416) { await cancelResponse(); await quarantine(); throw new Error('The saved partial file could not be resumed; retry to download a fresh copy.'); }
      if (![200, 206].includes(response.status) || !response.body || (!offset && response.status === 206)) { await cancelResponse(); throw new Error(`Assistant download failed with HTTP ${response.status}.`); }
      const encoding = response.headers.get('content-encoding');
      const length = response.headers.get('content-length');
      if ((encoding && encoding !== 'identity') || (length !== null && Number(length) !== asset.bytes - offset)) { await cancelResponse(); throw new Error('The download server returned inconsistent asset bytes.'); }
      if (!offset && await regularFile(partial)) await quarantine();
      const etag = response.headers.get('etag');
      await fs.promises.writeFile(manifest, JSON.stringify({ url: asset.url, bytes: asset.bytes, sha256: asset.sha256, etag: etag && /^"[^\r\n]+"$/.test(etag) ? etag : undefined }));
      let received = offset; let lastUpdate = 0;
      const source = Readable.fromWeb(response.body as never);
      source.on('data', (chunk: Buffer) => { received += chunk.length; if (received > asset.bytes) source.destroy(new Error('Assistant download exceeded its pinned size.')); if (Date.now() - lastUpdate > 300) { lastUpdate = Date.now(); progress(received, asset.bytes, false); } });
      await pipeline(source, fs.createWriteStream(partial, { flags: offset ? 'a' : 'wx' }), { signal });
      if (received !== asset.bytes) throw new Error('Assistant download ended before the pinned size was received.');
      } catch (error) {
      // Preparation can fail before pipeline owns the response (for example,
      // writing the resume manifest on a full disk). Release that body too.
      await cancelResponse().catch(() => undefined);
      throw error;
    }
  }
  progress(asset.bytes, asset.bytes, true);
  if (await assistantHash(partial, signal) !== asset.sha256) { await quarantine(); throw new Error('Assistant checksum mismatch. Invalid bytes were preserved outside model selection; retry setup.'); }
  signal.throwIfAborted();
  const handle = await fs.promises.open(partial, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
  // No overwrite, and the published filename appears only after full hash verification.
  await fs.promises.link(partial, target); await fs.promises.unlink(partial); await fs.promises.unlink(manifest);
  return target;
}

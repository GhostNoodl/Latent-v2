import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { VideoMediaInfo, VideoPlan } from '../shared/video-types';
export const VIDEO_MEDIA_LIMITS = Object.freeze({ maxBytes: 512 * 1024 * 1024, maxFrames: 400, maxSeconds: 17, maxPixels: 768 * 1344, maxDimension: 2048, timeoutMs: 45000 });
const audioSchema = z.object({ codec: z.literal('aac'), channels: z.number().int().min(1).max(2), sampleRate: z.number().int().min(8000).max(96000), durationSeconds: z.number().finite().min(0).max(17.25) }).strict();
const workerInfoSchema = z.object({ schema: z.literal(1), mimeType: z.literal('video/mp4'), width: z.number().int().positive().max(2048), height: z.number().int().positive().max(2048), frames: z.number().int().positive().max(400), fps: z.object({ numerator: z.number().int().positive().max(1000000), denominator: z.number().int().positive().max(1000000) }).strict(), durationSeconds: z.number().finite().positive().max(17), videoCodec: z.literal('h264'), pixelFormat: z.string().min(1).max(32), audio: z.array(audioSchema).max(1), inspection: z.object({ tool: z.literal('PyAV'), version: z.string().min(1).max(32), decodedFrames: z.number().int().positive().max(400), complete: z.literal(true) }).strict() }).strict().superRefine((value, ctx) => { if (value.width * value.height > VIDEO_MEDIA_LIMITS.maxPixels || value.inspection.decodedFrames !== value.frames || Math.abs(value.durationSeconds - value.frames * value.fps.denominator / value.fps.numerator) > 0.001) ctx.addIssue({ code: 'custom', message: 'Inconsistent video dimensions, duration or decoded frame count.' }); });
export function packagedVideoInspectorPath(options: { isPackaged: boolean; resourcesPath: string; dirname: string }) { return options.isPackaged ? path.join(options.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'resources', 'video-inspector.py') : path.join(options.dirname, 'resources', 'video-inspector.py'); }
async function containedFile(root: string, filename: string) {
  root = path.resolve(root); filename = path.resolve(filename); const relative = path.relative(root, filename);
  if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('The video path is outside its owned media root.');
  for (let current = filename; ; current = path.dirname(current)) { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Video files cannot be reached through symlinks or junctions.'); if (current === root) break; }
  return filename;
}
export interface VerifiedVideoFile { root: string; filename: string; sha256: string; bytes: number; }
async function openVerifiedVideo(file: VerifiedVideoFile, signal?: AbortSignal) {
  signal?.throwIfAborted(); if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > VIDEO_MEDIA_LIMITS.maxBytes) throw new Error('A bounded frozen video SHA-256 identity is required.');
  const filename = await containedFile(file.root, file.filename); if (!filename.toLowerCase().endsWith('.mp4')) throw new Error('Only local MP4 outputs are supported.');
  const handle = await fs.open(filename, 'r');
  try {
    const before = await handle.stat(); if (!before.isFile() || before.nlink !== 1 || before.size !== file.bytes) throw new Error('The video file identity or size changed.');
    const digest = createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
    while (position < before.size) { signal?.throwIfAborted(); const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position), position); if (!result.bytesRead) throw new Error('The video file ended while verifying it.'); digest.update(buffer.subarray(0, result.bytesRead)); position += result.bytesRead; }
    const after = await handle.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || digest.digest('hex') !== file.sha256) throw new Error('The video file no longer matches its recorded SHA-256 identity.');
    return { handle, filename, size: before.size, stat: after };
  } catch (error) { await handle.close(); throw error; }
}
export class VideoMediaInspector {
  private active = new Set<AbortController>();
  private pending = new Set<Promise<VideoMediaInfo>>();
  private disposed = false;
  constructor(private readonly options: { python: string; workerPath: string }) {}
  inspect(file: VerifiedVideoFile, externalSignal?: AbortSignal): Promise<VideoMediaInfo> {
    if (this.disposed) return Promise.reject(new Error('Video inspection service is closed.'));
    if (this.pending.size) return Promise.reject(new Error('A video inspection is already in progress.'));
    const work = this.inspectInternal(file, externalSignal); this.pending.add(work); void work.then(() => this.pending.delete(work), () => this.pending.delete(work)); return work;
  }
  private async inspectInternal(file: VerifiedVideoFile, externalSignal?: AbortSignal): Promise<VideoMediaInfo> {
    const controller = new AbortController(); const abort = () => controller.abort(externalSignal?.reason); externalSignal?.addEventListener('abort', abort, { once: true }); if (externalSignal?.aborted) abort(); this.active.add(controller);
    try {
      const verified = await openVerifiedVideo(file, controller.signal); await verified.handle.close();
      const output = await this.run(verified.filename, controller.signal); const parsed = workerInfoSchema.parse(output); const reverified = await openVerifiedVideo(file, controller.signal); await reverified.handle.close();
      return { ...parsed, bytes: file.bytes, sha256: file.sha256 };
    } finally { this.active.delete(controller); externalSignal?.removeEventListener('abort', abort); }
  }
  cancel() { for (const controller of this.active) controller.abort(new Error('Video inspection cancelled.')); }
  async dispose() { this.disposed = true; this.cancel(); await Promise.allSettled([...this.pending]); }
  private run(filename: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, PYTHONNOUSERSITE: '1', PYTHONUTF8: '1', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' }; delete env.PYTHONPATH; delete env.PYTHONHOME;
      const child = spawn(this.options.python, ['-I', '-B', this.options.workerPath], { windowsHide: true, cwd: path.dirname(this.options.workerPath), env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = ''; let failure: Error | undefined; const fail = (error: Error) => { failure ??= error; child.kill(); };
      const abort = () => fail(new Error('Video inspection cancelled.')); signal.addEventListener('abort', abort, { once: true }); const timer = setTimeout(() => fail(new Error('Video inspection exceeded its 45-second CPU bound.')), VIDEO_MEDIA_LIMITS.timeoutMs);
      child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 32768) fail(new Error('Video inspection response exceeded its bound.')); }); child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', code => { cleanup(); if (failure) return reject(failure); try { const message = JSON.parse(stdout); if (code !== 0 || message.ok !== true) throw new Error(message.error ?? `Video inspection exited ${code}. ${stderr}`); resolve(message.media); } catch (error) { reject(error); } });
      child.stdin.on('error', () => { /* Exit/close reports the owned process failure. */ }); child.stdin.end(JSON.stringify({ filename }) + '\n'); if (signal.aborted) abort();
    });
  }
}

/** Actual decoded media must match the frozen submitted contract before a completed record is saved. */
export function assertVideoMediaMatchesPlan(media: VideoMediaInfo, plan: VideoPlan) {
  const { bytes, sha256, ...worker } = media; workerInfoSchema.parse(worker);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > VIDEO_MEDIA_LIMITS.maxBytes || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('The decoded video has no bounded file identity.');
  if (media.width !== plan.width || media.height !== plan.height || media.frames !== plan.frames || media.fps.numerator / media.fps.denominator !== 24 || Math.abs(media.durationSeconds - plan.durationSeconds) > 0.001) throw new Error('The decoded video differs from its submitted canvas, frame count, FPS or duration.');
  if (plan.encoding.audio === 'none' ? media.audio.length !== 0 : media.audio.length !== 1 || media.audio[0].channels !== 2 || media.audio[0].sampleRate !== 32000) throw new Error('The decoded video audio differs from its explicit export profile.');
}

export type ByteRange = { kind: 'full'; start: 0; end: number } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };
export function parseVideoByteRange(header: string | null, bytes: number): ByteRange {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('A positive safe media size is required.');
  if (header === null) return { kind: 'full', start: 0, end: bytes - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header); if (!match || !match[1] && !match[2] || header.length > 100) return { kind: 'unsatisfiable' };
  const size = BigInt(bytes); let start: bigint; let end: bigint;
  if (!match[1]) { const suffix = BigInt(match[2]); if (suffix === 0n) return { kind: 'unsatisfiable' }; start = suffix >= size ? 0n : size - suffix; end = size - 1n; }
  else { start = BigInt(match[1]); end = match[2] ? BigInt(match[2]) : size - 1n; if (end >= size) end = size - 1n; }
  return start >= size || start > end ? { kind: 'unsatisfiable' } : { kind: 'partial', start: Number(start), end: Number(end) };
}
/** Main must resolve an opaque record ID to this frozen file descriptor; never accept a renderer path. */
export async function videoFileResponse(file: VerifiedVideoFile, request: Pick<Request, 'method' | 'headers' | 'signal'>): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const verified = await openVerifiedVideo(file, request.signal); const ifRange = request.headers.get('If-Range'); const rangeHeader = request.method === 'HEAD' || ifRange !== null && ifRange !== `"${file.sha256}"` ? null : request.headers.get('Range'); const range = parseVideoByteRange(rangeHeader, verified.size);
  const headers = new Headers({ 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-cache', ETag: `"${file.sha256}"`, 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  if (range.kind === 'unsatisfiable') { await verified.handle.close(); headers.set('Content-Range', `bytes */${verified.size}`); return new Response(null, { status: 416, headers }); }
  headers.set('Content-Length', String(range.end - range.start + 1)); if (range.kind === 'partial') headers.set('Content-Range', `bytes ${range.start}-${range.end}/${verified.size}`);
  if (request.method === 'HEAD') { await verified.handle.close(); return new Response(null, { status: 200, headers }); }
  let position = range.start; let closed = false; let handle: FileHandle | undefined = verified.handle;
  const close = async () => { if (closed) return; closed = true; request.signal.removeEventListener('abort', abort); const owned = handle; handle = undefined; await owned?.close(); };
  const abort = () => { void close(); }; request.signal.addEventListener('abort', abort, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        request.signal.throwIfAborted(); if (!handle) throw new Error('Video stream closed.');
        const buffer = Buffer.allocUnsafe(Math.min(65536, range.end - position + 1)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) throw new Error('Video ended before its recorded range.');
        position += bytesRead; const observed = await handle.stat(); if (observed.size !== verified.stat.size || observed.mtimeMs !== verified.stat.mtimeMs || observed.ctimeMs !== verified.stat.ctimeMs) throw new Error('The saved video changed during playback.'); controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead)); if (position > range.end) { await close(); controller.close(); }
      } catch (error) { await close(); controller.error(error); }
    }, async cancel() { await close(); },
  });
  if (request.signal.aborted) abort(); return new Response(stream, { status: range.kind === 'partial' ? 206 : 200, headers });
}

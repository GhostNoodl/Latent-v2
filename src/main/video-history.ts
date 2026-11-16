import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppPaths } from '../shared/types';
import {
  parseVideoContract,
  storedVideoHistorySchema,
  type StoredVideoHistoryRecord,
  type VideoHistorySnapshot,
} from '../shared/video-history';
import { videoOutputCandidates } from '../shared/video-output';
import type { VideoDraft, VideoHistoryRecord, VideoMediaInfo, VideoWorkflowContract } from '../shared/video-types';
import {
  assertVideoMediaMatchesPlan,
  VIDEO_MEDIA_LIMITS,
  type VideoMediaInspector,
  type VerifiedVideoFile,
} from './video-media';
import { containedPath } from './paths';
import { VIDEO_PLAYBACK_FIXTURE_ID } from './video-playback-fixture';
import { canonicalRuntimeJson } from '../shared/runtime-identity';

export interface VideoHistoryStore {
  videoRecords(): unknown[];
  videoRecord(id: string): unknown | null;
  saveVideoRecord(id: string, jobId: string, createdAt: string, value: unknown): void;
}
/** Internal only. No renderer call may build this request. */
export interface FinalizeVideoRequest {
  jobId: string;
  createdAt: string;
  title: string;
  contract: VideoWorkflowContract;
  outputs: unknown;
  evidenceKind: 'generated' | 'synthetic-fixture';
  promptId?: string;
  elapsedMs?: number;
}
const finalizeSchema = z
  .object({
    jobId: z.string().regex(/^[a-f0-9]{32}$/),
    createdAt: z.string().datetime(),
    title: z.string().min(1).max(160),
    contract: z.custom<VideoWorkflowContract>(),
    outputs: z.unknown(),
    evidenceKind: z.enum(['generated', 'synthetic-fixture']),
    promptId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .optional(),
    elapsedMs: z.number().int().nonnegative().optional(),
  })
  .strict();

export class VideoHistoryService {
  private active = new Set<string>();
  constructor(
    private paths: AppPaths,
    private store: VideoHistoryStore,
    private inspector: Pick<VideoMediaInspector, 'inspect'>,
  ) {}
  private parse(value: unknown): StoredVideoHistoryRecord {
    const record = storedVideoHistorySchema.parse(value);
    if (record.id === VIDEO_PLAYBACK_FIXTURE_ID) throw new Error('The playback diagnostic ID is reserved.');
    record.contract = parseVideoContract(record.contract, record.jobId);
    return record;
  }
  private record(id: string): StoredVideoHistoryRecord {
    z.string()
      .regex(/^[a-f0-9]{32}$/)
      .parse(id);
    if (id === VIDEO_PLAYBACK_FIXTURE_ID)
      throw new Error('The playback diagnostic is separate from saved video history.');
    const value = this.store.videoRecord(id);
    if (value === null) throw new Error('This saved video is unavailable.');
    let record: StoredVideoHistoryRecord;
    try {
      record = this.parse(value);
    } catch {
      throw new Error(
        'This saved video record is invalid or uses an unsupported recipe. Its original metadata was preserved.',
      );
    }
    if (record.id !== id) throw new Error('The saved video identity does not match its lookup.');
    return record;
  }
  private visible(record: StoredVideoHistoryRecord): VideoHistoryRecord {
    return {
      schema: 2,
      kind: 'video',
      id: record.id,
      jobId: record.jobId,
      createdAt: record.createdAt,
      evidenceKind: record.evidenceKind,
      title: record.title,
      media: structuredClone(record.media),
      mediaUrl: `latent-asset://video/${record.id}`,
      plan: structuredClone(record.contract.plan),
      ...(record.promptId ? { promptId: record.promptId } : {}),
      ...(record.elapsedMs !== undefined ? { elapsedMs: record.elapsedMs } : {}),
    };
  }
  private ownedPath(relativeFilename: string): string {
    const filename = containedPath(this.paths.outputs, relativeFilename);
    storageBoundary(this.paths, this.paths.outputs);
    for (let current = filename; ; current = path.dirname(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('Saved videos cannot use symbolic links or junctions.');
      if (current === path.resolve(this.paths.outputs)) break;
    }
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > VIDEO_MEDIA_LIMITS.maxBytes)
      throw new Error('The saved video is not an independent bounded MP4 file.');
    return filename;
  }
  snapshot(): VideoHistorySnapshot {
    const records: VideoHistoryRecord[] = [],
      warnings: string[] = [];
    for (const value of this.store.videoRecords()) {
      try {
        const record = this.parse(value);
        records.push(this.visible(record));
        try {
          if (fs.statSync(this.ownedPath(record.relativeFilename)).size !== record.media.bytes)
            throw new Error('size changed');
        } catch {
          warnings.push(
            `Video ${record.id}: its saved media is missing or changed. The recipe is retained; restore the original file to play it.`,
          );
        }
      } catch {
        warnings.push('A clip from an older version of Latent can’t be shown. It is still saved in your studio.');
      }
    }
    return { records, warnings };
  }
  private async measure(relativeFilename: string, signal?: AbortSignal): Promise<VerifiedVideoFile> {
    signal?.throwIfAborted();
    const filename = this.ownedPath(relativeFilename);
    const before = await fs.promises.lstat(filename);
    const handle = await fs.promises.open(filename, 'r');
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1)
        throw new Error('The saved video changed while opening.');
      const digest = createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let position = 0;
      while (position < opened.size) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
        if (!bytesRead) throw new Error('The saved video ended during verification.');
        digest.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      this.ownedPath(relativeFilename);
      const after = await handle.stat();
      const named = await fs.promises.lstat(filename);
      if (
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        after.nlink !== 1 ||
        named.dev !== opened.dev ||
        named.ino !== opened.ino
      )
        throw new Error('The saved video changed during verification.');
      return { root: this.paths.outputs, filename, bytes: after.size, sha256: digest.digest('hex') };
    } finally {
      await handle.close();
    }
  }
  /** Main-owned path/stat lookup. Playback and reveal must verify this frozen descriptor
   * with videoFileResponse, which hashes content before serving even a HEAD request. */
  async file(id: string): Promise<VerifiedVideoFile> {
    const record = this.record(id);
    try {
      const filename = this.ownedPath(record.relativeFilename);
      if (fs.statSync(filename).size !== record.media.bytes)
        throw new Error('The file differs from its saved byte length.');
      return { root: this.paths.outputs, filename, bytes: record.media.bytes, sha256: record.media.sha256 };
    } catch (error) {
      throw new Error(
        `Saved video media is missing or changed. Restore its original file; the saved recipe is retained. ${error instanceof Error ? error.message : ''}`,
      );
    }
  }
  restore(id: string): VideoDraft {
    const record = this.record(id);
    return { ...structuredClone(record.contract.plan.draft), seed: record.contract.plan.actualSeed };
  }
  /** Adopt only the backend's already published, owned MP4. Never copy, replace or delete an output.
   * A failed inspection/DB commit leaves it available for explicit finalization retry. */
  async finalize(input: FinalizeVideoRequest, signal?: AbortSignal): Promise<VideoHistoryRecord> {
    const request = finalizeSchema.parse(structuredClone(input));
    if (request.jobId === VIDEO_PLAYBACK_FIXTURE_ID) throw new Error('The playback diagnostic ID is reserved.');
    if (this.active.has(request.jobId)) throw new Error('This video is already being saved.');
    this.active.add(request.jobId);
    try {
      const contract = parseVideoContract(request.contract, request.jobId);
      const candidates = videoOutputCandidates(request.outputs, contract);
      if (candidates.length !== 1) throw new Error('The engine hasn’t finished writing the clip yet. Try again.');
      const provenance = {
        schema: 2 as const,
        kind: 'video' as const,
        id: request.jobId,
        jobId: request.jobId,
        createdAt: request.createdAt,
        title: request.title,
        evidenceKind: request.evidenceKind,
        relativeFilename: candidates[0].filename,
        contract,
        ...(request.promptId ? { promptId: request.promptId } : {}),
        ...(request.elapsedMs !== undefined ? { elapsedMs: request.elapsedMs } : {}),
      };
      const existing = this.store.videoRecord(request.jobId);
      if (existing !== null) {
        const previous = this.parse(existing);
        const { media: _media, ...priorProvenance } = previous;
        if (canonicalRuntimeJson(priorProvenance) !== canonicalRuntimeJson(provenance))
          throw new Error('Another clip already uses this ID. The original was kept.');
        return this.visible(previous);
      }
      const file = await this.measure(candidates[0].filename, signal);
      let media: VideoMediaInfo;
      try {
        media = await this.inspector.inspect(file, signal);
        assertVideoMediaMatchesPlan(media, contract.plan);
      } catch (error) {
        signal?.throwIfAborted();
        // A clip that plays but trips the checker is still the user's clip; keep it with what we know.
        console.warn(`Video ${request.jobId}: inspection failed, saving with planned details.`, error);
        media = plannedMedia(contract, file);
      }
      if (media.bytes !== file.bytes || media.sha256 !== file.sha256)
        throw new Error('The clip changed while it was being checked.');
      const record = this.parse({ ...provenance, media });
      signal?.throwIfAborted();
      this.store.saveVideoRecord(record.id, record.jobId, record.createdAt, record);
      return this.visible(record);
    } finally {
      this.active.delete(request.jobId);
    }
  }
}
function plannedMedia(contract: VideoWorkflowContract, file: VerifiedVideoFile): VideoMediaInfo {
  const plan = contract.plan;
  return {
    schema: 1,
    mimeType: 'video/mp4',
    bytes: file.bytes,
    sha256: file.sha256,
    width: plan.width,
    height: plan.height,
    frames: plan.frames,
    fps: { numerator: 24, denominator: 1 },
    durationSeconds: plan.frames / 24,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
    audio: [],
    inspection: { tool: 'PyAV', version: 'skipped', decodedFrames: plan.frames, complete: true },
  };
}

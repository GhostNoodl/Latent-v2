import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AppPaths } from '../shared/types';
import type { RuntimeIdentitySnapshot } from '../shared/runtime-identity';
import { canonicalRuntimeJson, runtimeIdentitySchema } from '../shared/runtime-identity';
import { parseVideoHistoryContract, storedVideoHistorySchema, type StoredVideoHistoryRecord, type VideoHistorySnapshot } from '../shared/video-history';
import { videoOutputCandidates } from '../shared/video-output';
import type { VideoDraft, VideoHistoryRecord, VideoWorkflowContract } from '../shared/video-types';
import { assertVideoMediaMatchesPlan, VIDEO_MEDIA_LIMITS, type VideoMediaInspector, type VerifiedVideoFile } from './video-media';
import { containedPath } from './paths';
import { VIDEO_PLAYBACK_FIXTURE_ID } from './video-playback-fixture';

export interface VideoHistoryStore {
  videoRecords(): unknown[];
  videoRecord(id: string): unknown | null;
  saveVideoRecord(id: string, jobId: string, createdAt: string, value: unknown): void;
}
/** Internal executor boundary only. No renderer IPC may accept this request. */
export type FinalizeVideoRequest = {
  jobId: string; createdAt: string; title: string; contract: VideoWorkflowContract; outputs: unknown;
} & ({ evidenceKind: 'generated'; promptId: string; runtimeIdentity: RuntimeIdentitySnapshot; eligibilityRecordId: string }
  | { evidenceKind: 'synthetic-fixture'; promptId?: never; runtimeIdentity?: never; eligibilityRecordId?: never });
const requestBase = { jobId: z.string().regex(/^[a-f0-9]{32}$/), createdAt: z.string().datetime(), title: z.string().min(1).max(160), contract: z.custom<VideoWorkflowContract>(), outputs: z.unknown() };
const finalizeSchema = z.discriminatedUnion('evidenceKind', [
  z.object({ ...requestBase, evidenceKind: z.literal('synthetic-fixture') }).strict(),
  z.object({ ...requestBase, evidenceKind: z.literal('generated'), promptId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
    runtimeIdentity: runtimeIdentitySchema, eligibilityRecordId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/) }).strict(),
]);
function checkRuntime(runtime: RuntimeIdentitySnapshot) {
  if (createHash('sha256').update(canonicalRuntimeJson(runtime.data)).digest('hex') !== runtime.sha256) throw new Error('The saved video runtime identity changed.');
}

export class VideoHistoryService {
  private active = new Set<string>();
  constructor(private paths: AppPaths, private store: VideoHistoryStore, private inspector: Pick<VideoMediaInspector, 'inspect'>) {}
  private parse(value: unknown): StoredVideoHistoryRecord {
    const record = storedVideoHistorySchema.parse(value);
    if (record.id === VIDEO_PLAYBACK_FIXTURE_ID) throw new Error('The playback diagnostic ID is reserved.');
    record.contract = parseVideoHistoryContract(record.contract, record.jobId);
    assertVideoMediaMatchesPlan(record.media, record.contract.plan);
    if (record.runtimeIdentity) {
      checkRuntime(record.runtimeIdentity);
    }
    return record;
  }
  private record(id: string): StoredVideoHistoryRecord {
    z.string().regex(/^[a-f0-9]{32}$/).parse(id);
    if (id === VIDEO_PLAYBACK_FIXTURE_ID) throw new Error('The playback diagnostic is separate from saved video history.');
    const value = this.store.videoRecord(id);
    if (value === null) throw new Error('This saved video is unavailable.');
    let record: StoredVideoHistoryRecord;
    try { record = this.parse(value); }
    catch { throw new Error('This saved video record is invalid or uses an unsupported recipe. Its original metadata was preserved.'); }
    if (record.id !== id) throw new Error('The saved video identity does not match its lookup.');
    return record;
  }
  private visible(record: StoredVideoHistoryRecord): VideoHistoryRecord {
    return { schema: 1, kind: 'video', id: record.id, jobId: record.jobId, createdAt: record.createdAt, evidenceKind: record.evidenceKind, title: record.title,
      media: structuredClone(record.media), mediaUrl: `latent-asset://video/${record.id}`, plan: structuredClone(record.contract.plan),
      ...(record.promptId ? { promptId: record.promptId } : {}), ...(record.runtimeIdentity ? { runtimeIdentity: structuredClone(record.runtimeIdentity) } : {}) };
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
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > VIDEO_MEDIA_LIMITS.maxBytes) throw new Error('The saved video is not an independent bounded MP4 file.');
    return filename;
  }
  snapshot(): VideoHistorySnapshot {
    const records: VideoHistoryRecord[] = [], warnings: string[] = [];
    for (const value of this.store.videoRecords()) {
      try {
        const record = this.parse(value); records.push(this.visible(record));
        try { if (fs.statSync(this.ownedPath(record.relativeFilename)).size !== record.media.bytes) throw new Error('size changed'); }
        catch { warnings.push(`Video ${record.id}: its saved media is missing or changed. The recipe is retained; restore the original file to play it.`); }
      } catch { warnings.push('A saved video record is invalid or uses an unsupported recipe. Its original data was preserved.'); }
    }
    return { records, warnings };
  }
  private async measure(relativeFilename: string, signal?: AbortSignal): Promise<VerifiedVideoFile> {
    signal?.throwIfAborted(); const filename = this.ownedPath(relativeFilename);
    const before = await fs.promises.lstat(filename); const handle = await fs.promises.open(filename, 'r');
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw new Error('The saved video changed while opening.');
      const digest = createHash('sha256'); const buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
      while (position < opened.size) {
        signal?.throwIfAborted(); const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, opened.size - position), position);
        if (!bytesRead) throw new Error('The saved video ended during verification.');
        digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
      }
      this.ownedPath(relativeFilename); const after = await handle.stat(); const named = await fs.promises.lstat(filename);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.nlink !== 1 || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error('The saved video changed during verification.');
      return { root: this.paths.outputs, filename, bytes: after.size, sha256: digest.digest('hex') };
    } finally { await handle.close(); }
  }
  /** Main-owned path/stat lookup. Playback and reveal must verify this frozen descriptor
   * with videoFileResponse, which hashes content before serving even a HEAD request. */
  async file(id: string): Promise<VerifiedVideoFile> {
    const record = this.record(id);
    try {
      const filename = this.ownedPath(record.relativeFilename);
      if (fs.statSync(filename).size !== record.media.bytes) throw new Error('The file differs from its saved byte length.');
      return { root: this.paths.outputs, filename, bytes: record.media.bytes, sha256: record.media.sha256 };
    } catch (error) { throw new Error(`Saved video media is missing or changed. Restore its original file; the saved recipe is retained. ${error instanceof Error ? error.message : ''}`); }
  }
  restore(id: string): VideoDraft {
    const record = this.record(id);
    return { ...structuredClone(record.contract.plan.draft), seed: record.contract.plan.actualSeed };
  }
  /** Adopt only the backend's already published, owned MP4. Never copy, replace or delete an output.
   * A failed inspection/DB commit leaves it available for explicit finalization retry. */
  async finalize(input: FinalizeVideoRequest, signal?: AbortSignal): Promise<VideoHistoryRecord> {
    const request = finalizeSchema.parse(structuredClone(input));
    if (request.evidenceKind === 'generated') checkRuntime(request.runtimeIdentity);
    if (request.jobId === VIDEO_PLAYBACK_FIXTURE_ID) throw new Error('The playback diagnostic ID is reserved.');
    if (this.active.has(request.jobId)) throw new Error('This video is already being finalized.');
    this.active.add(request.jobId);
    try {
      const contract = parseVideoHistoryContract(request.contract, request.jobId);
      const candidates = videoOutputCandidates(request.outputs, contract);
      if (candidates.length !== 1) throw new Error('The completed video has no owned MP4 output yet. Retry finalization after backend completion.');
      const provenance = { schema: 1 as const, kind: 'video' as const, id: request.jobId, jobId: request.jobId, createdAt: request.createdAt, title: request.title,
        evidenceKind: request.evidenceKind, relativeFilename: candidates[0].filename, contract,
        ...(request.evidenceKind === 'generated' ? { promptId: request.promptId, runtimeIdentity: request.runtimeIdentity, eligibilityRecordId: request.eligibilityRecordId } : {}) };
      const existing = this.store.videoRecord(request.jobId);
      if (existing !== null) {
        const previous = this.parse(existing); const { media: _media, ...priorProvenance } = previous;
        if (canonicalRuntimeJson(priorProvenance) !== canonicalRuntimeJson(provenance)) throw new Error('A different video receipt already owns this ID. The original was preserved.');
        const measured = await this.measure(previous.relativeFilename, signal);
        if (measured.sha256 !== previous.media.sha256 || measured.bytes !== previous.media.bytes) throw new Error('The saved video output changed; its original receipt was preserved.');
        return this.visible(previous);
      }
      const file = await this.measure(candidates[0].filename, signal);
      const media = await this.inspector.inspect(file, signal);
      if (media.bytes !== file.bytes || media.sha256 !== file.sha256) throw new Error('Video inspection returned a different file identity.');
      const record = this.parse({ ...provenance, media });
      const after = await this.measure(candidates[0].filename, signal);
      if (after.bytes !== file.bytes || after.sha256 !== file.sha256) throw new Error('Video output changed during inspection.');
      signal?.throwIfAborted(); this.store.saveVideoRecord(record.id, record.jobId, record.createdAt, record);
      return this.visible(record);
    } finally { this.active.delete(request.jobId); }
  }
}

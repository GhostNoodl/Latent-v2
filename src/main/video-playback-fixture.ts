import path from 'node:path';
import type { VideoHistoryRecord } from '../shared/video-types';
import { videoFileResponse, type VerifiedVideoFile } from './video-media';
const SHA = 'a45fc4d3c4c801b7a7749cc1af75965971280b17813e8de67ad03a79f4291c34';
export const VIDEO_PLAYBACK_FIXTURE_ID = SHA.slice(0, 32);
export function videoPlaybackFixtureFile(options: { isPackaged: boolean; resourcesPath: string; dirname: string }): VerifiedVideoFile {
  const root = options.isPackaged ? path.join(options.resourcesPath, 'app.asar.unpacked', 'dist-electron', 'resources') : path.join(options.dirname, 'resources');
  return { root, filename: path.join(root, 'video-playback-fixture.mp4'), sha256: SHA, bytes: 46551 };
}
/** Explicit codec diagnostic, never registered in SQLite, an image queue, or generated history. */
export async function videoPlaybackFixtureRecord(file: VerifiedVideoFile): Promise<VideoHistoryRecord> {
  if (file.bytes !== 46551 || file.sha256 !== SHA) throw new Error('The bundled playback diagnostic is missing or changed.');
  await videoFileResponse(file, { method: 'HEAD', headers: new Headers(), signal: AbortSignal.timeout(5000) });
  return { schema: 1, kind: 'video', id: VIDEO_PLAYBACK_FIXTURE_ID, jobId: 'synthetic-codec-diagnostic', createdAt: '2026-09-05T02:40:43.441Z', evidenceKind: 'synthetic-fixture', title: 'Synthetic codec fixture · no AI model used', mediaUrl: `latent-asset://video/${VIDEO_PLAYBACK_FIXTURE_ID}`, media: { schema: 1, mimeType: 'video/mp4', bytes: 46551, sha256: SHA, width: 320, height: 192, frames: 48, fps: { numerator: 24, denominator: 1 }, durationSeconds: 2, videoCodec: 'h264', pixelFormat: 'yuv420p', audio: [{ codec: 'aac', channels: 2, sampleRate: 32000, durationSeconds: 2 }], inspection: { tool: 'PyAV', version: '18.1.0', decodedFrames: 48, complete: true } } };
}

import { z } from 'zod';
import { PNG } from 'pngjs';
import { FACE_DETAILER_LIMITS, type FaceBox, type FaceDetectionRequest, type FaceLandmark } from '../shared/face-detailer-types';

const finite = z.number().finite();
const workerBox = z.object({ x: finite.min(-8192).max(8192), y: finite.min(-8192).max(8192), width: finite.positive().max(16384), height: finite.positive().max(16384) }).strict();
const workerResultSchema = z.object({
  opencv: z.literal('4.13.0'), width: z.number().int().positive().max(8192), height: z.number().int().positive().max(8192),
  frames: z.array(z.object({ width: z.number().int().positive().max(640), height: z.number().int().positive().max(640) }).strict()).min(1).max(2),
  candidates: z.array(z.object({ frame: z.number().int().min(0).max(1), box: workerBox, score: finite.min(0).max(1).optional(), landmarks: z.array(z.object({ x: finite.min(-8192).max(8192), y: finite.min(-8192).max(8192) }).strict()).length(5).optional() }).strict()).max(FACE_DETAILER_LIMITS.maxCandidates),
  candidateCount: z.number().int().min(0).max(100000), durationMs: finite.min(0).max(120000),
}).strict();
export interface MappedFace { box: FaceBox; score?: number; landmarks?: FaceLandmark[]; }
export function detectionFrames(width: number, height: number, profile: FaceDetectionRequest['profile']) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > FACE_DETAILER_LIMITS.maxPixels) throw new Error('Face refinement currently supports sources up to 4 megapixels and 8192 pixels per side.');
  const frames: Array<{ width: number; height: number }> = [];
  for (const side of profile === 'anime' ? [640] : [320, 640]) {
    const scale = Math.min(1, side / Math.max(width, height));
    const frame = { width: Math.max(1, Math.floor(width * scale + 0.5)), height: Math.max(1, Math.floor(height * scale + 0.5)) };
    if (!frames.some(other => other.width === frame.width && other.height === frame.height)) frames.push(frame);
  }
  return frames;
}
export function faceIoU(a: FaceBox, b: FaceBox) {
  const overlap = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlap / (a.width * a.height + b.width * b.height - overlap);
}
export function mapFaceDetections(value: unknown, width: number, height: number, request: FaceDetectionRequest) {
  const expectedFrames = detectionFrames(width, height, request.profile); const result = workerResultSchema.parse(value);
  if (result.width !== width || result.height !== height || JSON.stringify(result.frames) !== JSON.stringify(expectedFrames) || result.candidateCount < result.candidates.length) throw new Error('The face detector returned a different source or preprocessing layout.');
  const mapped: MappedFace[] = result.candidates.map(candidate => {
    const frame = result.frames[candidate.frame]; if (!frame) throw new Error('The face detector returned an unknown scale.');
    if (request.profile === 'anime' && (candidate.score !== undefined || candidate.landmarks) || request.profile === 'photographic' && (candidate.score === undefined || candidate.score < request.confidence || !candidate.landmarks)) throw new Error('The face detector returned incompatible profile confidence or landmarks.');
    const scaleX = width / frame.width; const scaleY = height / frame.height; const b = candidate.box;
    if (b.x >= frame.width || b.y >= frame.height || b.x + b.width <= 0 || b.y + b.height <= 0) throw new Error('The face detector returned a box outside the image.');
    const left = Math.max(0, Math.floor(b.x * scaleX)); const top = Math.max(0, Math.floor(b.y * scaleY));
    const right = Math.min(width, Math.ceil((b.x + b.width) * scaleX)); const bottom = Math.min(height, Math.ceil((b.y + b.height) * scaleY));
    return { box: { x: left, y: top, width: right - left, height: bottom - top }, ...(candidate.score !== undefined ? { score: candidate.score } : {}), ...(candidate.landmarks ? { landmarks: candidate.landmarks.map(point => ({ x: Math.max(0, Math.min(width - 1, point.x * scaleX)), y: Math.max(0, Math.min(height - 1, point.y * scaleY)) })) } : {}) };
  });
  mapped.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.box.width * b.box.height - a.box.width * a.box.height || a.box.y - b.box.y || a.box.x - b.box.x || a.box.width - b.box.width || a.box.height - b.box.height);
  const distinct: MappedFace[] = [];
  for (const face of mapped) if (!distinct.some(other => faceIoU(face.box, other.box) > 0.3)) distinct.push(face);
  const faces = distinct.slice(0, request.maxFaces);
  return { faces, frames: result.frames.map(frame => ({ ...frame, scaleX: width / frame.width, scaleY: height / frame.height })), candidateCount: result.candidateCount, omittedCount: distinct.length - faces.length + result.candidateCount - result.candidates.length, durationMs: result.durationMs };
}

/** Geometric ellipse with bounded inward feather; outside the ellipse is exactly zero. */
export function createFaceMask(width: number, height: number, box: FaceBox, expansion: number, feather: number) {
  detectionFrames(width, height, 'anime');
  if (![box.x, box.y, box.width, box.height].every(Number.isSafeInteger) || box.x < 0 || box.y < 0 || box.width < 1 || box.height < 1 || box.x + box.width > width || box.y + box.height > height || !Number.isFinite(expansion) || expansion < 0 || expansion > 0.5 || !Number.isSafeInteger(feather) || feather < 0 || feather > 32) throw new Error('Invalid face mask geometry.');
  const rx = box.width * (0.5 + expansion); const ry = box.height * (0.5 + expansion); const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;
  const left = Math.max(0, Math.floor(cx - rx)); const top = Math.max(0, Math.floor(cy - ry));
  const right = Math.min(width, Math.ceil(cx + rx)); const bottom = Math.min(height, Math.ceil(cy + ry));
  const png = new PNG({ width, height }); for (let index = 3; index < png.data.length; index += 4) png.data[index] = 255;
  let selectedPixels = 0;
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const radius = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
    if (radius >= 1) continue;
    const coverage = feather === 0 ? 1 : Math.min(1, (1 - radius) * Math.min(rx, ry) / feather);
    const value = Math.round(255 * coverage * coverage * (3 - 2 * coverage));
    if (value > 0) selectedPixels++;
    const offset = (y * width + x) * 4; png.data[offset] = png.data[offset + 1] = png.data[offset + 2] = value;
  }
  if (!selectedPixels) throw new Error('This face is too small for the selected feather. Lower feathering or use a larger source.');
  return { png: PNG.sync.write(png), geometry: { version: 'expanded-ellipse-inward-smoothstep@1' as const, expansion, feather, bounds: { x: left, y: top, width: right - left, height: bottom - top }, selectedPixels } };
}

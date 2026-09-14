import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FaceDetailerService, extractFaceWheel } from '../src/main/face-detailer';
import { createFaceMask, detectionFrames, mapFaceDetections } from '../src/main/face-detailer-geometry';
import { SourceImageService } from '../src/main/source-images';
import { StudioStore } from '../src/main/store';
import { createPaths, inside } from '../src/main/paths';
import type { FaceDetectionRequest } from '../src/shared/face-detailer-types';

let sandbox: string; let store: StudioStore; let sources: SourceImageService; let service: FaceDetailerService;
const request: FaceDetectionRequest = { sourceId: `src_${randomUUID()}`, sourceSha256: 'a'.repeat(64), profile: 'anime', maxFaces: 4, confidence: 0.7, expansion: 0.15, feather: 8 };
const box = { x: 100, y: 120, width: 80, height: 100 };
const raw = (width = 1000, height = 700, candidates: unknown[] = [{ frame: 0, box }], profile: FaceDetectionRequest['profile'] = 'anime') => ({ opencv: '4.13.0', width, height, frames: detectionFrames(width, height, profile), candidates, candidateCount: candidates.length, durationMs: 1 });
function png(width = 256, height = 128) { const image = new PNG({ width, height }); image.data.fill(128); for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255; return PNG.sync.write(image); }
async function sourceFixture() { const file = path.join(sandbox, 'source.png'); await fs.writeFile(file, png()); return sources.importFile(file); }
beforeEach(async () => { sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-face-tests-')); const paths = createPaths(path.join(sandbox, 'studio')); store = new StudioStore(paths.database); sources = new SourceImageService(paths, store); service = new FaceDetailerService(paths, store, () => {}, sources); });
afterEach(async () => { await service.dispose(); store.close(); vi.restoreAllMocks(); const resolved = path.resolve(sandbox); if (!inside(os.tmpdir(), resolved) || !path.basename(resolved).startsWith('latent-face-tests-')) throw new Error('Unsafe test cleanup.'); await fs.rm(resolved, { recursive: true, force: true }); });

describe('detector coordinates and masks', () => {
  it.runIf(process.platform === 'win32' && process.arch === 'x64')('reports setup failure even when an older installation marker is present', async () => {
    vi.spyOn(service as unknown as { installation(): unknown }, 'installation').mockReturnValue({ previous: true });
    await expect(service.setup(true)).rejects.toThrow('Install the private Comfy runtime');
    expect(service.status().state).toBe('error');
  });
  it('uses separately rounded inverse axes and merges multiscale detections deterministically', () => {
    const result = mapFaceDetections(raw(), 1000, 700, request);
    expect(result.frames).toEqual([{ width: 640, height: 448, scaleX: 1.5625, scaleY: 1.5625 }]);
    expect(result.faces[0].box).toEqual({ x: 156, y: 187, width: 126, height: 157 });
    const photographic = { ...request, profile: 'photographic' as const };
    const landmarks = Array.from({ length: 5 }, () => ({ x: 80, y: 80 }));
    const photo = mapFaceDetections(raw(1000, 701, [{ frame: 0, box: { x: 50, y: 50, width: 50, height: 50 }, score: 0.8, landmarks }, { frame: 1, box: { x: 100, y: 100, width: 100, height: 100 }, score: 0.9, landmarks }], 'photographic'), 1000, 701, photographic);
    expect(photo.faces).toHaveLength(1); expect(photo.faces[0].score).toBe(0.9); expect(photo.frames[0].scaleX).not.toBe(photo.frames[0].scaleY);
    expect(photo.omittedCount).toBe(0);
  });
  it('rejects resized-source lies, unknown scales, false anime confidence, nonfinite and outside boxes', () => {
    expect(() => mapFaceDetections({ ...raw(), width: 999 }, 1000, 700, request)).toThrow('different source');
    expect(() => mapFaceDetections(raw(1000, 700, [{ frame: 1, box }]), 1000, 700, request)).toThrow('unknown scale');
    expect(() => mapFaceDetections(raw(1000, 700, [{ frame: 0, box, score: 0.99 }]), 1000, 700, request)).toThrow('confidence');
    expect(() => mapFaceDetections(raw(1000, 700, [{ frame: 0, box: { ...box, x: Infinity } }]), 1000, 700, request)).toThrow();
    expect(() => mapFaceDetections(raw(1000, 700, [{ frame: 0, box: { ...box, x: 800 } }]), 1000, 700, request)).toThrow('outside');
  });
  it('clamps edge-crossing detections while refusing decompression-sized canvases', () => {
    expect(mapFaceDetections(raw(1000, 700, [{ frame: 0, box: { x: -10, y: -10, width: 50, height: 50 } }]), 1000, 700, request).faces[0].box).toEqual({ x: 0, y: 0, width: 63, height: 63 });
    expect(() => detectionFrames(8192, 8192, 'anime')).toThrow('4 megapixels');
    expect(() => detectionFrames(9000, 1, 'anime')).toThrow();
  });
  it('produces nonempty opaque grayscale masks with soft interiors and exact outside-zero pixels', () => {
    const hard = createFaceMask(80, 60, { x: 10, y: 10, width: 40, height: 30 }, 0.1, 0);
    const soft = createFaceMask(80, 60, { x: 10, y: 10, width: 40, height: 30 }, 0.1, 8);
    const a = PNG.sync.read(hard.png); const b = PNG.sync.read(soft.png);
    expect(soft.geometry.selectedPixels).toBeGreaterThan(0); expect(b.data.some((value, index) => index % 4 === 0 && value > 0 && value < 255)).toBe(true);
    for (let at = 0; at < a.data.length; at += 4) {
      expect(b.data[at + 3]).toBe(255); expect(b.data[at + 1]).toBe(b.data[at]); expect(b.data[at + 2]).toBe(b.data[at]);
      expect(b.data[at]).toBeLessThanOrEqual(a.data[at]); if (!a.data[at]) expect(b.data[at]).toBe(0);
    }
    expect(createFaceMask(80, 60, { x: 0, y: 0, width: 40, height: 30 }, 0.5, 8).geometry.bounds.x).toBe(0);
  });
});

describe('immutable face detection receipts', () => {
  function mockDetector(candidates: unknown[]) {
    vi.spyOn(service as any, 'verifyInstallation').mockResolvedValue('b'.repeat(64));
    return vi.spyOn(service as any, 'runWorker').mockImplementation(async (...args: unknown[]) => raw(Number(args[1]), Number(args[2]), candidates));
  }
  it('retains a genuine no-face outcome without creating a fallback mask', async () => {
    const source = await sourceFixture(); mockDetector([]);
    const receipt = await service.detect({ ...request, sourceId: source.id, sourceSha256: source.normalized.sha256 });
    expect(receipt.faces).toEqual([]); expect(sources.list().masks).toEqual([]); expect(await service.getDetection(receipt.id)).toEqual(receipt);
    await expect(service.createRefinementPlan({ detectionId: receipt.id, faceIds: [], denoise: 0.3, contextPadding: 32, seed: '1' }, [])).rejects.toThrow();
  });
  it('blocks a changed source before model invocation or mask publication', async () => {
    const source = await sourceFixture(); const worker = mockDetector([]);
    await expect(service.detect({ ...request, sourceId: source.id })).rejects.toThrow('saved identity'); expect(worker).not.toHaveBeenCalled(); expect(sources.list().masks).toEqual([]);
    await expect(service.detect({ ...request, sourceId: '../foreign' })).rejects.toThrow();
  });
  it('freezes independent masks, revalidates geometry, and derives exact ordered crop passes', async () => {
    const source = await sourceFixture(); mockDetector([{ frame: 0, box: { x: 15, y: 15, width: 60, height: 70 } }, { frame: 0, box: { x: 160, y: 20, width: 50, height: 60 } }]);
    const authored = { ...request, sourceId: source.id, sourceSha256: source.normalized.sha256 };
    const pending = service.detect(authored); authored.expansion = 0.5;
    const receipt = await pending; expect(receipt.request.expansion).toBe(0.15); expect(receipt.faces).toHaveLength(2);
    expect(receipt.faces.every(face => face.mask.parentMaskId === null)).toBe(true);
    const returned = await service.getDetection(receipt.id); returned.faces[0].box.x = 99;
    expect((await service.getDetection(receipt.id)).faces[0].box.x).toBe(15);
    const plan = await service.createRefinementPlan({ detectionId: receipt.id, faceIds: receipt.faces.map(face => face.id).reverse(), denoise: 0.35, contextPadding: 32, seed: '10' }, ['10', '11']);
    expect(plan.passes.map(pass => pass.faceId)).toEqual(receipt.faces.map(face => face.id)); expect(plan.passes.map(pass => pass.seed)).toEqual(['10', '11']);
    expect(plan.passes.every(pass => pass.crop.working.width === 512 && pass.crop.settings.mode === 'refine')).toBe(true);
    expect((await sources.resolve(source.id)).source.normalized.sha256).toBe(source.normalized.sha256);
    store.setState(`face.detection:${receipt.id}`, { ...receipt, faces: [{ ...receipt.faces[0], box: { ...receipt.faces[0].box, x: 16 } }, receipt.faces[1]] });
    await expect(service.getDetection(receipt.id)).rejects.toThrow('geometry');
  });
  it('publishes no masks for malformed detector output and rejects concurrent requests', async () => {
    const source = await sourceFixture(); const worker = mockDetector([{ frame: 0, box: { x: 500, y: 0, width: 50, height: 50 } }]);
    const input = { ...request, sourceId: source.id, sourceSha256: source.normalized.sha256 };
    await expect(service.detect(input)).rejects.toThrow('outside'); expect(sources.list().masks).toEqual([]);
    worker.mockImplementation(async (...args: unknown[]) => { await new Promise((resolve, reject) => (args[4] as AbortSignal).addEventListener('abort', () => reject(new Error('Canceled')), { once: true })); });
    const pending = service.detect(input); const caught = pending.catch(error => error);
    await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(2)); await expect(service.detect(input)).rejects.toThrow('busy');
    await service.cancelDetection(); expect(await caught).toBeInstanceOf(Error); expect(sources.list().masks).toEqual([]);
  });
});

describe('private wheel extraction', () => {
  it('keeps package bytes private, rejects case collisions and links, and never overwrites', async () => {
    const destination = path.join(sandbox, 'vendor'); await fs.mkdir(destination);
    const zip = new AdmZip(); zip.addFile('cv2/test.py', Buffer.from('original')); const file = path.join(sandbox, 'package.whl'); zip.writeZip(file);
    await extractFaceWheel(file, destination, new AbortController().signal);
    expect(await fs.readFile(path.join(destination, 'cv2/test.py'), 'utf8')).toBe('original');
    await expect(extractFaceWheel(file, destination, new AbortController().signal)).rejects.toThrow();
    const collision = new AdmZip(); collision.addFile('cv2/A.py', Buffer.from('a')); collision.addFile('cv2/a.py', Buffer.from('b')); collision.writeZip(file);
    await expect(extractFaceWheel(file, destination, new AbortController().signal)).rejects.toThrow('duplicate');
    const symlink = new AdmZip(); symlink.addFile('link.py', Buffer.from('target')); symlink.getEntries()[0].attr = (0xa000 << 16) >>> 0; symlink.writeZip(file);
    await expect(extractFaceWheel(file, destination, new AbortController().signal)).rejects.toThrow('unsafe');
  });
});

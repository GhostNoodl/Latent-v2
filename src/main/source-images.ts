import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import sharp from 'sharp';
import { PNG } from 'pngjs';
import { z } from 'zod';
import { inside } from './paths';
import type { StudioStore } from './store';
import type { AppPaths } from '../shared/types';
import { SOURCE_IMAGE_LIMITS, type SourceImageAsset, type SourceImageIdentity, type SourceImageInventory, type SourceImageMimeType, type SourceMaskAsset, type SourceMaskSaveOptions } from '../shared/source-types';

const INDEX_KEY = 'source-images:v1';
const SOURCE_ID = /^src_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MASK_ID = /^mask_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maskEditSchema = z.union([
  z.object({ kind: z.enum(['paint', 'erase', 'rectangle', 'invert', 'clear', 'fill']) }).strict(),
  z.object({ kind: z.literal('sam'), proposalMaskId: z.string().regex(MASK_ID) }).strict(),
  z.object({ kind: z.enum(['grow', 'shrink']), radius: z.number().int().min(0).max(64), shape: z.literal('square'), boundary: z.literal('black'), algorithmVersion: z.literal(1) }).strict(),
  z.object({ kind: z.literal('feather'), radius: z.number().int().min(0).max(64), sigma: z.number().min(0).max(64), boundary: z.literal('clamp'), algorithmVersion: z.literal(1) }).strict(),
]);
const maskSaveSchema = z.object({ baseMaskId: z.string().regex(MASK_ID).nullable().optional(), edits: z.array(maskEditSchema).max(256).optional() }).strict();
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_NORMALIZED_BYTES = SOURCE_IMAGE_LIMITS.maxPixels * 4 + 1024 * 1024;
const extensions: Record<SourceImageMimeType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const dimension = z.number().int().min(1).max(SOURCE_IMAGE_LIMITS.maxDimension);
const identitySchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive().max(MAX_NORMALIZED_BYTES), width: dimension, height: dimension, mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']) }).strict();
const sourceSchema = z.object({
  originGenerationId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  schemaVersion: z.literal(1), id: z.string().regex(SOURCE_ID), name: z.string().min(1).max(255), createdAt: z.iso.datetime(),
  original: identitySchema, normalized: identitySchema.extend({ mimeType: z.literal('image/png') }), normalizedStoredSeparately: z.boolean(),
  normalization: z.object({ version: z.literal(1), orientationApplied: z.number().int().min(1).max(8), colorSpace: z.literal('srgb'), metadataStripped: z.literal(true) }).strict(),
}).strict();
const maskSchema = identitySchema.extend({
  editProvenance: z.object({ version: z.literal(1), baseMaskId: z.string().regex(MASK_ID).nullable(), edits: z.array(maskEditSchema).max(256) }).strict().optional(),
  schemaVersion: z.literal(1), id: z.string().regex(MASK_ID), sourceId: z.string().regex(SOURCE_ID), sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  parentMaskId: z.string().regex(MASK_ID).nullable(), revision: z.number().int().positive(), createdAt: z.iso.datetime(), mimeType: z.literal('image/png'), channel: z.literal('red'), polarity: z.literal('white-edits'),
}).strict();
const inventorySchema = z.object({ schemaVersion: z.literal(1), sources: z.array(sourceSchema), masks: z.array(maskSchema) }).strict();

export interface DecodedSourceImage {
  mimeType: SourceImageMimeType;
  originalWidth: number;
  originalHeight: number;
  orientation: number;
  normalizedPng: Buffer;
}
/** Decoder implementations must reject corrupt data and apply EXIF orientation. */
export type SourceImageDecoder = (bytes: Buffer) => Promise<DecodedSourceImage>;
export interface ResolvedSourceImage { source: SourceImageAsset; originalPath: string; normalizedPath: string; }
export interface ResolvedSourceMask { mask: SourceMaskAsset; source: SourceImageAsset; path: string; }

function hash(bytes: Uint8Array) { return createHash('sha256').update(bytes).digest('hex'); }
function assertDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > SOURCE_IMAGE_LIMITS.maxDimension || height > SOURCE_IMAGE_LIMITS.maxDimension || width * height > SOURCE_IMAGE_LIMITS.maxPixels) {
    throw new Error('Source images are limited to 8192 pixels per side and 32 megapixels during this experimental phase.');
  }
}
function pngInflatedLength(bytes: Buffer, width: number, height: number) {
  const depth = bytes[24]; const color = bytes[25]; const interlace = bytes[28];
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  if (!depths[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) throw new Error('PNG uses an invalid pixel format.');
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  return passes.reduce((length, [x, y, stepX, stepY]) => {
    const passWidth = Math.max(0, Math.ceil((width - x) / stepX)); const passHeight = Math.max(0, Math.ceil((height - y) / stepY));
    return length + (passWidth && passHeight ? (Math.ceil(passWidth * channels[color] * depth / 8) + 1) * passHeight : 0);
  }, 0);
}
function assertAbsoluteFile(filename: string) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0') || filename.split(/[\\/]/).some(part => part === '.' || part === '..')) throw new Error('Choose an absolute image file path without traversal.');
  const remainder = filename.slice(path.parse(filename).root.length);
  if (remainder.includes(':') || filename.startsWith('\\\\?\\') || filename.startsWith('\\\\.\\')) throw new Error('Device paths and alternate data streams are not image files.');
}
/** Check every ancestor so a directory junction cannot bypass file-only checks. */
async function assertNoLinks(filename: string) {
  assertAbsoluteFile(filename);
  let cursor = path.resolve(filename);
  while (true) {
    if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Image paths cannot contain symbolic links or directory junctions.');
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
async function readBoundedFile(filename: string, maxBytes: number) {
  await assertNoLinks(filename);
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.nlink !== 1) throw new Error('Choose a regular image file, not a directory or linked file.');
  if (before.size < 1 || before.size > maxBytes) throw new Error(`The image file is empty or exceeds the ${Math.floor(maxBytes / 1024 / 1024)} MiB size limit.`);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw new Error('The image file changed while opening it. Please import it again.');
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesRead) throw new Error('The image file was truncated while reading it.');
      offset += result.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    const after = await handle.stat();
    await assertNoLinks(filename);
    const current = await fs.lstat(filename);
    if (extra.bytesRead || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || current.ino !== opened.ino || current.dev !== opened.dev) throw new Error('The image file changed while reading it. Please import it again.');
    return bytes;
  } finally { await handle.close(); }
}

/** Container checks run before invoking a decoder; dimensions are bounded before inflation. */
function inspectContainer(bytes: Buffer, maxBytes = SOURCE_IMAGE_LIMITS.maxInputBytes): SourceImageMimeType {
  if (!bytes.length || bytes.length > maxBytes) throw new Error('Image data is empty or exceeds its byte limit.');
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    let cursor = 8; let sawHeader = false; let sawEnd = false; let endedData = false; const compressed: Buffer[] = [];
    let width = 0; let height = 0; let metadataBytes = 0;
    while (cursor < bytes.length) {
      if (cursor + 12 > bytes.length) throw new Error('PNG data is truncated.');
      const length = bytes.readUInt32BE(cursor); const type = bytes.toString('ascii', cursor + 4, cursor + 8);
      if (length > bytes.length - cursor - 12) throw new Error('PNG chunk is truncated.');
      if (['iCCP', 'zTXt', 'iTXt'].includes(type)) {
        const data = bytes.subarray(cursor + 8, cursor + 8 + length);
        const keywordEnd = data.indexOf(0);
        if (keywordEnd < 1 || keywordEnd > 79) throw new Error('PNG contains malformed compressed metadata.');
        let compressedStart = keywordEnd + 2; let compressedMetadata = true;
        if (type === 'iTXt') {
          if (data[keywordEnd + 1] > 1 || data[keywordEnd + 2] !== 0) throw new Error('PNG contains invalid text compression.');
          compressedMetadata = data[keywordEnd + 1] === 1;
          const languageEnd = data.indexOf(0, keywordEnd + 3);
          const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
          if (translatedEnd < 0) throw new Error('PNG contains malformed international text.');
          compressedStart = translatedEnd + 1;
        } else if (data[keywordEnd + 1] !== 0) throw new Error('PNG contains unsupported metadata compression.');
        metadataBytes += compressedMetadata ? inflateSync(data.subarray(compressedStart), { maxOutputLength: 1024 * 1024 }).length : data.length - compressedStart;
        if (metadataBytes > 4 * 1024 * 1024) throw new Error('PNG metadata exceeds the supported size.');
      }
      if (!sawHeader) {
        if (type !== 'IHDR' || length !== 13) throw new Error('PNG has no valid image header.');
        width = bytes.readUInt32BE(cursor + 8); height = bytes.readUInt32BE(cursor + 12); assertDimensions(width, height); sawHeader = true;
      } else if (type === 'IHDR') throw new Error('PNG contains duplicate headers.');
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('Animated source images are not supported. Choose one still frame.');
      if (type === 'IDAT') {
        if (endedData) throw new Error('PNG image data must be consecutive.');
        compressed.push(bytes.subarray(cursor + 8, cursor + 8 + length));
      } else if (compressed.length) endedData = true;
      cursor += length + 12;
      if (type === 'IEND') { if (length || cursor !== bytes.length) throw new Error('PNG has an invalid ending or trailing data.'); sawEnd = true; break; }
    }
    if (!sawHeader || !sawEnd || !compressed.length) throw new Error('PNG is incomplete.');
    // pngjs has an unbounded interlaced inflate path and can ignore extra pixels.
    // Verify exactly one complete, bounded stream before its bitmap conversion.
    const expectedLength = pngInflatedLength(bytes, width, height); const stream = Buffer.concat(compressed);
    const inflated = inflateSync(stream, { maxOutputLength: expectedLength, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== expectedLength || inflated.engine.bytesWritten !== stream.length) throw new Error('PNG pixel data has an invalid length.');
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    assertDimensions(decoded.width, decoded.height);
    return 'image/png';
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) throw new Error('JPEG is truncated or has trailing data.');
    return 'image/jpeg';
  }
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('WebP is truncated or has trailing data.');
    let cursor = 12; let imageChunks = 0;
    while (cursor < bytes.length) {
      if (cursor + 8 > bytes.length) throw new Error('WebP chunk is truncated.');
      const type = bytes.toString('ascii', cursor, cursor + 4); const length = bytes.readUInt32LE(cursor + 4);
      if (length > bytes.length - cursor - 8) throw new Error('WebP chunk is truncated.');
      if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && length && (bytes[cursor + 8] & 2))) throw new Error('Animated source images are not supported. Choose one still frame.');
      if (type === 'VP8 ' || type === 'VP8L') imageChunks++;
      cursor += 8 + length + (length % 2);
    }
    if (cursor !== bytes.length || imageChunks !== 1) throw new Error('WebP must contain one complete still image.');
    return 'image/webp';
  }
  throw new Error('Choose a PNG, JPEG, or WebP still image.');
}

export const decodeSourceImage: SourceImageDecoder = async bytes => {
  const pipeline = sharp(bytes, { failOn: 'warning', limitInputPixels: SOURCE_IMAGE_LIMITS.maxPixels, unlimited: false, sequentialRead: true });
  const metadata = await pipeline.metadata();
  if (!metadata.width || !metadata.height || !['png', 'jpeg', 'webp'].includes(metadata.format ?? '')) throw new Error('The image decoder could not identify this image.');
  assertDimensions(metadata.width, metadata.height);
  if ((metadata.pages ?? 1) !== 1) throw new Error('Animated source images are not supported. Choose one still frame.');
  const normalizedPng = await pipeline.autoOrient().toColourspace('srgb').png({ compressionLevel: 6 }).toBuffer();
  return { mimeType: `image/${metadata.format}` as SourceImageMimeType, originalWidth: metadata.width, originalHeight: metadata.height, orientation: metadata.orientation ?? 1, normalizedPng };
};

export class SourceImageService {
  private readonly directory: string;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly paths: AppPaths, private readonly store: StudioStore, private readonly decoder: SourceImageDecoder = decodeSourceImage) {
    this.directory = path.join(paths.inputs, 'source-images');
    if (!inside(paths.root, paths.inputs) || path.resolve(paths.root) === path.resolve(paths.inputs)) throw new Error('Source images must be inside the private studio input directory.');
  }

  list(): SourceImageInventory {
    const result = inventorySchema.parse(this.store.getState<SourceImageInventory>(INDEX_KEY, { schemaVersion: 1, sources: [], masks: [] }));
    const sources = new Map(result.sources.map(source => [source.id, source]));
    const masks = new Map(result.masks.map(mask => [mask.id, mask]));
    if (sources.size !== result.sources.length || masks.size !== result.masks.length) throw new Error('The source image index contains duplicate identities.');
    for (const source of result.sources) {
      assertDimensions(source.original.width, source.original.height); assertDimensions(source.normalized.width, source.normalized.height);
      const swapped = source.normalization.orientationApplied >= 5;
      if (source.original.bytes > SOURCE_IMAGE_LIMITS.maxInputBytes || source.normalized.width !== (swapped ? source.original.height : source.original.width) || source.normalized.height !== (swapped ? source.original.width : source.original.height)) throw new Error('The source image index has inconsistent dimensions.');
      if (!source.normalizedStoredSeparately && (source.original.mimeType !== 'image/png' || source.original.sha256 !== source.normalized.sha256 || source.original.bytes !== source.normalized.bytes)) throw new Error('The source image index has inconsistent normalized identities.');
    }
    const revisions = new Set<string>();
    for (const mask of result.masks) {
      const source = sources.get(mask.sourceId); const parent = mask.parentMaskId ? masks.get(mask.parentMaskId) : undefined;
      const revisionKey = `${mask.sourceId}:${mask.revision}`;
      const validParent = mask.editProvenance
        ? mask.editProvenance.baseMaskId === mask.parentMaskId && (!mask.parentMaskId || !!parent && parent.sourceId === mask.sourceId && parent.revision < mask.revision)
        : mask.parentMaskId ? !!parent && parent.sourceId === mask.sourceId && parent.revision === mask.revision - 1 : mask.revision === 1;
      if (revisions.has(revisionKey) || !source || mask.sourceSha256 !== source.normalized.sha256 || mask.width !== source.normalized.width || mask.height !== source.normalized.height || !validParent) throw new Error('The source mask index has an invalid parent or image identity.');
      revisions.add(revisionKey);
    }
    return result;
  }

  importFile(absoluteFilePathFromMainDialog: string, originGenerationId?: string): Promise<SourceImageAsset> {
    return this.exclusive(async () => {
      if (originGenerationId !== undefined && !/^[a-f0-9]{32}$/.test(originGenerationId)) throw new Error('Invalid source generation identity.');
      assertAbsoluteFile(absoluteFilePathFromMainDialog);
      const original = await readBoundedFile(absoluteFilePathFromMainDialog, SOURCE_IMAGE_LIMITS.maxInputBytes);
      const mimeType = inspectContainer(original);
      const decoded = await this.decoder(Buffer.from(original));
      if (decoded.mimeType !== mimeType) throw new Error('The image decoder disagrees with the file format.');
      assertDimensions(decoded.originalWidth, decoded.originalHeight);
      if (!Number.isInteger(decoded.orientation) || decoded.orientation < 1 || decoded.orientation > 8) throw new Error('The image has an invalid orientation.');
      const normalizedPng = Buffer.from(decoded.normalizedPng);
      if (inspectContainer(normalizedPng, MAX_NORMALIZED_BYTES) !== 'image/png') throw new Error('The decoder did not produce a normalized PNG.');
      const normalizedWidth = normalizedPng.readUInt32BE(16); const normalizedHeight = normalizedPng.readUInt32BE(20);
      const swapped = decoded.orientation >= 5;
      if (normalizedWidth !== (swapped ? decoded.originalHeight : decoded.originalWidth) || normalizedHeight !== (swapped ? decoded.originalWidth : decoded.originalHeight)) throw new Error('Normalization unexpectedly changed the source dimensions.');
      const source: SourceImageAsset = {
        ...(originGenerationId ? { originGenerationId } : {}),
        schemaVersion: 1, id: `src_${randomUUID()}`, name: path.basename(absoluteFilePathFromMainDialog), createdAt: new Date().toISOString(),
        original: this.identity(original, mimeType, decoded.originalWidth, decoded.originalHeight), normalized: { ...this.identity(normalizedPng, 'image/png', normalizedWidth, normalizedHeight), mimeType: 'image/png' },
        normalizedStoredSeparately: !original.equals(normalizedPng), normalization: { version: 1, orientationApplied: decoded.orientation, colorSpace: 'srgb', metadataStripped: true },
      };
      const files: Record<string, Buffer> = { [`original.${extensions[mimeType]}`]: original };
      if (source.normalizedStoredSeparately) files['image.png'] = normalizedPng;
      const inventory = this.list(); inventory.sources.unshift(source);
      await this.publish(source.id, files, inventory);
      return structuredClone(source);
    });
  }

  async resolve(id: string): Promise<ResolvedSourceImage> {
    if (typeof id !== 'string' || !SOURCE_ID.test(id)) throw new Error('Invalid source image ID.');
    const source = this.list().sources.find(item => item.id === id);
    if (!source) throw new Error('This source image is no longer registered.');
    await this.assertManagedDirectory(false);
    const originalPath = path.join(this.directory, id, `original.${extensions[source.original.mimeType]}`);
    const normalizedPath = source.normalizedStoredSeparately ? path.join(this.directory, id, 'image.png') : originalPath;
    await this.verifyIdentity(originalPath, source.original);
    if (normalizedPath !== originalPath) await this.verifyIdentity(normalizedPath, source.normalized);
    return { source, originalPath, normalizedPath };
  }

  saveMask(sourceId: string, pngBytes: Uint8Array, options?: SourceMaskSaveOptions): Promise<SourceMaskAsset> {
    const provenance = options === undefined ? undefined : maskSaveSchema.parse(options);
    // Copy at the call boundary: a renderer/caller cannot mutate an awaiting write.
    if (!(pngBytes instanceof Uint8Array) || !pngBytes.length || pngBytes.length > SOURCE_IMAGE_LIMITS.maxInputBytes) return Promise.reject(new Error('A mask must be PNG bytes within the 64 MiB input limit.'));
    const bytes = Buffer.from(pngBytes);
    return this.exclusive(async () => {
      const { source } = await this.resolve(sourceId);
      if (inspectContainer(bytes) !== 'image/png') throw new Error('Masks must be PNG images.');
      const decoded = PNG.sync.read(bytes, { checkCRC: true });
      if (decoded.width !== source.normalized.width || decoded.height !== source.normalized.height) throw new Error('Mask dimensions must exactly match the normalized source image.');
      for (let index = 0; index < decoded.data.length; index += 4) {
        if (decoded.data[index] !== decoded.data[index + 1] || decoded.data[index] !== decoded.data[index + 2] || decoded.data[index + 3] !== 255) throw new Error('Masks must be opaque grayscale PNGs: white edits and black preserves.');
      }
      // Re-encode pixels only: EXIF or color metadata must never rotate/change a mask
      // when the backend reads its red channel in normalized source coordinates.
      const submittedImage = new PNG(); submittedImage.width = decoded.width; submittedImage.height = decoded.height; submittedImage.data = decoded.data;
      const submittedBytes = PNG.sync.write(submittedImage);
      const inventory = this.list();
      const latest = inventory.masks.filter(mask => mask.sourceId === sourceId).sort((a, b) => b.revision - a.revision)[0];
      const parent = provenance && Object.hasOwn(provenance, 'baseMaskId') ? inventory.masks.find(mask => mask.id === provenance.baseMaskId) : latest;
      if (provenance?.baseMaskId && (!parent || parent.sourceId !== sourceId || parent.sourceSha256 !== source.normalized.sha256)) throw new Error('The mask parent must belong to this exact source.');
      if (parent) await this.resolveMask(parent.id);
      for (const edit of provenance?.edits ?? []) if (edit.kind === 'sam') {
        const proposal = await this.resolveMask(edit.proposalMaskId);
        if (proposal.mask.sourceId !== sourceId || proposal.mask.sourceSha256 !== source.normalized.sha256 || !this.store.getState(`segmentation.mask:${edit.proposalMaskId}`, null)) throw new Error('The smart selection must be a saved proposal for this source.');
      }
      const mask: SourceMaskAsset = {
        ...this.identity(submittedBytes, 'image/png', decoded.width, decoded.height), schemaVersion: 1, id: `mask_${randomUUID()}`, sourceId,
        sourceSha256: source.normalized.sha256, parentMaskId: parent?.id ?? null, revision: (latest?.revision ?? 0) + 1,
        ...(provenance ? { editProvenance: { version: 1 as const, baseMaskId: parent?.id ?? null, edits: provenance.edits ?? [] } } : {}),
        createdAt: new Date().toISOString(), mimeType: 'image/png', channel: 'red', polarity: 'white-edits',
      };
      inventory.masks.push(mask);
      await this.publish(mask.id, { 'mask.png': submittedBytes }, inventory);
      return structuredClone(mask);
    });
  }

  async resolveMask(id: string): Promise<ResolvedSourceMask> {
    if (typeof id !== 'string' || !MASK_ID.test(id)) throw new Error('Invalid source mask ID.');
    const mask = this.list().masks.find(item => item.id === id);
    if (!mask) throw new Error('This source mask is no longer registered.');
    const { source } = await this.resolve(mask.sourceId);
    const filename = path.join(this.directory, mask.id, 'mask.png');
    await this.verifyIdentity(filename, mask, 'mask');
    return { mask, source, path: filename };
  }

  private identity(bytes: Buffer, mimeType: SourceImageMimeType, width: number, height: number): SourceImageIdentity { return { sha256: hash(bytes), bytes: bytes.length, mimeType, width, height }; }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(operation); this.writes = pending.catch(() => {}); return pending;
  }
  private async assertManagedDirectory(create: boolean) {
    await assertNoLinks(this.paths.inputs);
    if (create) await fs.mkdir(this.directory, { recursive: false }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    await assertNoLinks(this.directory);
    if (!(await fs.lstat(this.directory)).isDirectory() || !inside(await fs.realpath(this.paths.inputs), await fs.realpath(this.directory))) throw new Error('The source image directory is outside private studio inputs.');
  }
  private async verifyIdentity(filename: string, expected: SourceImageIdentity, kind = 'source image') {
    if (!inside(this.directory, filename)) throw new Error('The image path is outside private studio inputs.');
    const bytes = await readBoundedFile(filename, MAX_NORMALIZED_BYTES).catch((cause: unknown) => {
      if (['ENOENT', 'ENOTDIR'].includes((cause as NodeJS.ErrnoException)?.code ?? '')) {
        throw new Error(`This saved ${kind} is missing. Restore the missing studio file to reuse this recipe, or choose a new ${kind}.`, { cause });
      }
      throw cause;
    });
    if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw new Error('This source image or mask has changed on disk. Import it as a new source instead of reusing this recipe.');
    if (expected.mimeType === 'image/png' && (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.length < 33 || bytes.readUInt32BE(16) !== expected.width || bytes.readUInt32BE(20) !== expected.height)) throw new Error('The stored image dimensions disagree with its registered identity.');
  }
  private async publish(id: string, files: Record<string, Buffer>, inventory: SourceImageInventory) {
    await this.assertManagedDirectory(true);
    const pending = path.join(this.directory, `.pending-${id}`); const destination = path.join(this.directory, id);
    if (!inside(this.directory, pending) || !inside(this.directory, destination) || !(SOURCE_ID.test(id) || MASK_ID.test(id))) throw new Error('Invalid managed source identity.');
    await fs.mkdir(pending, { recursive: false });
    let published = false;
    try {
      for (const [name, bytes] of Object.entries(files)) {
        const filename = path.join(pending, name); const handle = await fs.open(filename, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      }
      await this.assertManagedDirectory(false); await assertNoLinks(pending);
      // Random immutable IDs plus an absence check prevent accidental replacement.
      if (await fs.lstat(destination).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; })) throw new Error('The source image identity already exists.');
      await fs.rename(pending, destination); published = true;
      this.store.setState(INDEX_KEY, inventorySchema.parse(inventory));
    } catch (error) {
      const cleanup = published ? destination : pending;
      // Only our known files, never a recursive delete; refuse changed directories.
      await this.assertManagedDirectory(false);
      await assertNoLinks(cleanup);
      if (!inside(this.directory, path.resolve(cleanup))) throw new Error('Refusing cleanup outside private studio inputs.');
      for (const name of Object.keys(files)) await fs.unlink(path.join(cleanup, name)).catch(cleanupError => { if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError; });
      await fs.rmdir(cleanup);
      throw error;
    }
  }
}

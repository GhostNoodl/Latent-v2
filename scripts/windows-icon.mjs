import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const ICON_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 128, 256]);
export const ICON_PATH = 'resources/latent-icon.ico';

export function validateIconPackagingConfig(pkg) {
  if (pkg.build?.win?.icon !== ICON_PATH || pkg.build?.win?.signAndEditExecutable !== true || pkg.build?.win?.signExecutable !== false || pkg.build?.forceCodeSigning !== false) {
    throw new Error('Windows branding requires the reviewed icon and resource editing, with code signing explicitly disabled.');
  }
}

export async function generateWindowsIcon(svg) {
  const frames = await Promise.all(ICON_SIZES.map(size => sharp(svg).resize(size, size).ensureAlpha().png().toBuffer()));
  const directory = Buffer.alloc(6 + frames.length * 16);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach((frame, index) => {
    const at = 6 + index * 16; const size = ICON_SIZES[index];
    directory[at] = size === 256 ? 0 : size; directory[at + 1] = directory[at];
    directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(frame.length, at + 8); directory.writeUInt32LE(offset, at + 12);
    offset += frame.length;
  });
  return Buffer.concat([directory, ...frames]);
}

export async function inspectWindowsIcon(bytes) {
  if (bytes.length < 6 || bytes.length > 1024 * 1024 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1 || bytes.readUInt16LE(4) !== ICON_SIZES.length) throw new Error('Windows icon has an invalid ICO header or frame count.');
  let offset = 6 + ICON_SIZES.length * 16;
  if (bytes.length < offset) throw new Error('Windows icon directory is truncated.');
  const frames = [];
  for (let index = 0; index < ICON_SIZES.length; index++) {
    const at = 6 + index * 16; const size = ICON_SIZES[index];
    const length = bytes.readUInt32LE(at + 8);
    if ((bytes[at] || 256) !== size || (bytes[at + 1] || 256) !== size || bytes[at + 2] !== 0 || bytes[at + 3] !== 0 || bytes.readUInt16LE(at + 4) !== 1 || bytes.readUInt16LE(at + 6) !== 32 || bytes.readUInt32LE(at + 12) !== offset || !length || offset + length > bytes.length) throw new Error('Windows icon frame dimensions, depth or byte range are invalid.');
    const frame = bytes.subarray(offset, offset + length);
    const metadata = await sharp(frame).metadata();
    const pixels = await sharp(frame).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (metadata.format !== 'png' || metadata.width !== size || metadata.height !== size || !metadata.hasAlpha || pixels.info.channels !== 4 || pixels.data.length !== size * size * 4 || pixels.data[3] !== 0 || !pixels.data.some((value, i) => i % 4 === 3 && value === 255)) throw new Error('Windows icon frame must decode at its declared dimensions with transparent corners and visible artwork.');
    frames.push({ width: size, height: size, bitsPerPixel: 32, bytes: length });
    offset += length;
  }
  if (offset !== bytes.length) throw new Error('Windows icon has unindexed trailing bytes.');
  return { path: ICON_PATH, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), frames };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const project = path.resolve(import.meta.dirname, '..');
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--generate', '--check'].includes(args[0])) throw new Error('Use node scripts/windows-icon.mjs --generate or --check.');
  const generated = await generateWindowsIcon(await fs.readFile(path.join(project, 'resources/latent-icon.svg')));
  if (args[0] === '--generate') await fs.writeFile(path.join(project, ICON_PATH), generated);
  const existing = await fs.readFile(path.join(project, ICON_PATH));
  if (!existing.equals(generated)) throw new Error('Windows icon does not match the current vector source. Regenerate it.');
  console.log(JSON.stringify(await inspectWindowsIcon(existing), null, 2));
}

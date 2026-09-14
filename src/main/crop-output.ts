import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { PNG } from 'pngjs';

/** Comfy's float alpha inversion can truncate an 8-bit sample by one on save. */
export function preserveCropPixels(result: PNG, source: PNG, mask: PNG, denoise: number) {
  if ([source, mask].some(image => image.width !== result.width || image.height !== result.height)) throw new Error('Crop preservation dimensions do not match the original source.');
  let correctedAlphaSamples = 0;
  for (let i = 0; i < result.data.length; i += 4) {
    if (Math.abs(result.data[i + 3] - source.data[i + 3]) > 1) throw new Error('The crop result changed original alpha beyond byte quantization. Its file is retained for inspection.');
    if ((denoise === 0 || mask.data[i] === 0) && [0, 1, 2].some(channel => result.data[i + channel] !== source.data[i + channel])) throw new Error('The crop result changed pixels outside its mask. Its file is retained for inspection.');
    if (result.data[i + 3] !== source.data[i + 3]) correctedAlphaSamples++;
  }
  // Validate the whole image before modifying any samples.
  if (correctedAlphaSamples) for (let i = 3; i < result.data.length; i += 4) result.data[i] = source.data[i];
  return correctedAlphaSamples;
}

function chunk(type: string, data: Buffer) {
  const bytes = Buffer.alloc(data.length + 12); bytes.writeUInt32BE(data.length); bytes.write(type, 4, 'ascii'); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4); return bytes;
}

/** Retain exact recipe text chunks while replacing only the encoded pixel data. */
export function encodePreservedCrop(original: Buffer, result: PNG, correctedAlphaSamples: number, sourceSha256: string) {
  const retained: Buffer[] = [];
  let ended = false;
  for (let offset = 8; offset < original.length;) {
    if (offset + 12 > original.length) throw new Error('Truncated crop PNG chunk.');
    const length = original.readUInt32BE(offset), end = offset + length + 12;
    if (end > original.length) throw new Error('Truncated crop PNG chunk.');
    const type = original.toString('ascii', offset + 4, offset + 8);
    if (crc32(original.subarray(offset + 4, end - 4)) !== original.readUInt32BE(end - 4)) throw new Error('Invalid crop PNG chunk checksum.');
    if (['tEXt', 'zTXt', 'iTXt'].includes(type)) retained.push(original.subarray(offset, end));
    offset = end;
    if (type === 'IEND') { if (length !== 0 || offset !== original.length) throw new Error('Invalid crop PNG ending.'); ended = true; break; }
  }
  if (!ended) throw new Error('Incomplete crop PNG.');
  const receipt = { version: 'source-alpha-byte-restoration@1', sourceSha256, correctedAlphaSamples, enginePngSha256: createHash('sha256').update(original).digest('hex') };
  retained.push(chunk('tEXt', Buffer.from(`latent_alpha_restoration\0${JSON.stringify(receipt)}`, 'utf8')));
  const encoded = PNG.sync.write(result, { colorType: 6 });
  return Buffer.concat([encoded.subarray(0, 33), ...retained, encoded.subarray(33)]);
}

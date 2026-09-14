/** Comfy binary event 4: uint32 event, uint32 JSON length, metadata JSON, image bytes. */
export function ownedGenerationPreview(bytes: Buffer, promptId: string): string | undefined {
  if (bytes.length < 9 || bytes.length > 8 * 1024 * 1024 || bytes.readUInt32BE(0) !== 4) return undefined;
  const length = bytes.readUInt32BE(4); if (!length || length > 65536 || length + 8 >= bytes.length) return undefined;
  try {
    const metadata = JSON.parse(bytes.subarray(8, 8 + length).toString('utf8'));
    if (metadata?.prompt_id !== promptId || !['image/png', 'image/jpeg'].includes(metadata.image_type)) return undefined;
    const image = bytes.subarray(8 + length);
    if (metadata.image_type === 'image/png' && (image.length < 8 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) return undefined;
    if (metadata.image_type === 'image/jpeg' && (image.length < 3 || image[0] !== 255 || image[1] !== 216 || image[2] !== 255)) return undefined;
    return `data:${metadata.image_type};base64,${image.toString('base64')}`;
  } catch { return undefined; }
}

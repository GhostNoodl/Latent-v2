/** Civitai IDs belong in metadata, not in names shown to the user. */
export function cleanModelStem(filename: string): string {
  return filename.replaceAll('\\','/').split('/').at(-1)!.replace(/\.safetensors$/i, '').replace(/^civitai_\d+_\d+_\d+_/i, '').trim();
}
export function cleanModelFilename(filename: string): string {
  let stem = cleanModelStem(filename).replace(/[^\w .()-]+/g, '_').replace(/_+/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 105).replace(/[. ]+$/g, '') || 'model';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(stem)) stem = 'model-' + stem;
  return stem + '.safetensors';
}
/** Only add a short byte identity when a readable name is already occupied. */
export function availableModelFilename(filename: string, sha256: string, occupied: readonly string[]): string {
  const clean = cleanModelFilename(filename), used = new Set(occupied.map(value => value.toLowerCase()));
  if (!used.has(clean.toLowerCase())) return clean;
  const stem = clean.slice(0, -12).slice(0, 90);
  for (let i=0; i<10000; i++) { const candidate = `${stem}-${sha256.slice(0,8)}${i ? `-${i}` : ''}.safetensors`; if (!used.has(candidate.toLowerCase())) return candidate; }
  throw new Error('Too many files share this model name. Choose another folder.');
}

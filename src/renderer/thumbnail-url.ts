const OUTPUT = /^latent-asset:\/\/output\/([a-f0-9]{32})$/;
const CIVITAI = /^https:\/\/(image|imagecache)\.civitai\.com\//;

function base64url(text: string) {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A small cached copy of a saved image or a Civitai preview, made once and kept on disk.
 * Anything else comes back unchanged.
 */
export function thumbnailUrl(src: string) {
  const output = OUTPUT.exec(src);
  if (output) return `latent-asset://thumb/output/${output[1]}`;
  if (CIVITAI.test(src) && src.length <= 2000) return `latent-asset://thumb/civitai/${base64url(src)}`;
  return src;
}

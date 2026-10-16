import { createPublicKey, verify } from 'node:crypto';
import { releaseSigningMessage } from '../shared/app-release-signing';

const RAW_KEY = /^[A-Za-z0-9+/]{43}=$/;

function publicKey(raw: string) {
  if (!RAW_KEY.test(raw)) throw Error('A configured release signing key is malformed.');
  const x = Buffer.from(raw, 'base64');
  if (x.length !== 32) throw Error('A configured release signing key is malformed.');
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: x.toString('base64url') }, format: 'jwk' });
}

/**
 * Checks a detached Ed25519 signature over the installer identity. The GitHub digest only
 * proves the bytes match what was uploaded; the signature proves who published them.
 */
export function verifyReleaseSignature(
  release: { name: string; bytes: number; sha256: string },
  signatureText: string,
  keys: readonly string[],
) {
  if (!keys.length)
    throw Error('This build has no release signing key, so in-app updates are turned off. Download updates manually.');
  const encoded = signatureText.trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(encoded)) throw Error('The release signature is malformed.');
  const signature = Buffer.from(encoded, 'base64');
  const message = Buffer.from(releaseSigningMessage(release), 'utf8');
  if (!keys.some(key => verify(null, message, publicKey(key), signature)))
    throw Error('The release signature is not from a trusted Latent v2 publisher.');
}

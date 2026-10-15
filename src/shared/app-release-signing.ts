/**
 * Ed25519 public keys (raw 32 bytes, base64) trusted to sign Latent v2 installers.
 * Generate a key pair with `node scripts/release-signing.mjs keygen <private-key-file>`
 * and paste the printed public key here. Keep the private key out of the repository.
 * More than one entry allows key rotation: the old key stays until every supported
 * version trusts the new one.
 */
export const APP_RELEASE_PUBLIC_KEYS: readonly string[] = [];

/** The exact bytes a release signature covers: the installer's identity, not its full contents. */
export function releaseSigningMessage(release: { name: string; bytes: number; sha256: string }) {
  return `Latent-v2 release\n${release.name}\n${release.bytes}\n${release.sha256}\n`;
}

export const RELEASE_SIGNATURE_SUFFIX = '.sig';
export const RELEASE_SIGNATURE_MAX_BYTES = 4096;

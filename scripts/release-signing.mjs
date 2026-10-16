// Release signing for in-app updates.
//   node scripts/release-signing.mjs keygen <private-key-file>  creates a key pair and prints the public key
//   node scripts/release-signing.mjs sign <installer.exe> <private-key-file>  writes <installer.exe>.sig
// Paste the public key into src/shared/app-release-signing.ts, then upload the .sig next to the installer.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Must stay byte-identical to releaseSigningMessage in src/shared/app-release-signing.ts. */
export function releaseSigningMessage({ name, bytes, sha256 }) {
  return `Latent-v2 release\n${name}\n${bytes}\n${sha256}\n`;
}

function outsideProject(file) {
  const relative = path.relative(project, path.resolve(file));
  if (!relative.startsWith('..') && !path.isAbsolute(relative))
    throw Error('Keep the release private key outside the repository.');
  return path.resolve(file);
}

export async function signInstaller(installer, privateKeyPem) {
  const data = await fs.readFile(installer);
  const message = releaseSigningMessage({
    name: path.basename(installer),
    bytes: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  });
  return sign(null, Buffer.from(message, 'utf8'), createPrivateKey(privateKeyPem)).toString('base64');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, first, second] = process.argv.slice(2);
  if (mode === 'keygen' && first) {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    await fs.writeFile(outsideProject(first), privateKey.export({ type: 'pkcs8', format: 'pem' }), {
      flag: 'wx',
      mode: 0o600,
    });
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
    console.log(`Private key written to ${path.resolve(first)}. Back it up somewhere safe.`);
    console.log(`Public key for APP_RELEASE_PUBLIC_KEYS: ${raw}`);
  } else if (mode === 'sign' && first && second) {
    const signature = await signInstaller(first, await fs.readFile(outsideProject(second), 'utf8'));
    await fs.writeFile(first + '.sig', signature + '\n');
    console.log(`Signature written to ${first}.sig`);
  } else throw Error('Use keygen <private-key-file> or sign <installer> <private-key-file>.');
}

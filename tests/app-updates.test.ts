import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { AppUpdateService } from '../src/main/app-updates';
import { parseAppRelease, newerVersion, APP_RELEASE_API } from '../src/shared/app-update-types';
import { releaseSigningMessage } from '../src/shared/app-release-signing';
import { releaseSigningMessage as scriptSigningMessage, signInstaller } from '../scripts/release-signing.mjs';
import { verifyReleaseSignature } from '../src/main/app-update-signature';
const bytes = Buffer.from('MZ test installer fixture - never executed');
const installerName = 'Latent-v2-0.2.0-Setup-x64-unsigned.exe';
const keyPair = () => {
  const pair = generateKeyPairSync('ed25519');
  return {
    pem: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    raw: Buffer.from(pair.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64'),
  };
};
const publisher = keyPair();
async function signatureFor(pem = publisher.pem) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-sign-test-'));
  try {
    await fs.writeFile(path.join(dir, installerName), bytes);
    return await signInstaller(path.join(dir, installerName), pem);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
const signature = await signatureFor();
const isSignature = (url: string) => url.endsWith('.sig');
function release() {
  const name = installerName;
  return {
    tag_name: 'v0.2.0',
    draft: false,
    prerelease: false,
    assets: [
      {
        name,
        size: bytes.length,
        digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
        browser_download_url: 'https://github.com/GhostNoodl/Latent-v2/releases/download/v0.2.0/' + name,
      },
      {
        name: name + '.sig',
        size: 89,
        digest: null as string | null,
        browser_download_url: 'https://github.com/GhostNoodl/Latent-v2/releases/download/v0.2.0/' + name + '.sig',
      },
    ],
  };
}
async function fixture(
  run: (service: AppUpdateService, root: string, request: ReturnType<typeof vi.fn>) => Promise<void>,
  supported = true,
  keys: readonly string[] = [publisher.raw],
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-update-test-'));
  const values = new Map<string, unknown>();
  const request = vi.fn(async (url: string, _init?: RequestInit) =>
    url === APP_RELEASE_API
      ? Response.json(release())
      : isSignature(url)
        ? new Response(signature + '\n')
        : new Response(bytes),
  );
  const service = new AppUpdateService(
    root,
    {
      getState: <T>(key: string, fallback: T) => (values.get(key) ?? fallback) as T,
      setState: (key, value) => {
        values.set(key, value);
      },
    },
    '0.1.1',
    supported,
    () => {},
    request as unknown as typeof fetch,
    keys,
  );
  try {
    await run(service, root, request);
  } finally {
    await service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
}
it('accepts only newer stable releases with exact repository, installer name, size and checksum', () => {
  const withLargeSource = release();
  withLargeSource.assets.push({ ...withLargeSource.assets[0], name: 'native-sources.zip', size: 2 * 1024 ** 3 });
  expect(parseAppRelease(withLargeSource, '0.1.1')?.version).toBe('0.2.0');
  expect(newerVersion('0.10.0', '0.2.0')).toBe(true);
  expect(parseAppRelease(release(), '0.2.0')).toBeUndefined();
  expect(() => newerVersion('0.2.0-beta', '0.1.1')).toThrow('stable');
  expect(() => parseAppRelease({ ...release(), prerelease: true }, '0.1.1')).toThrow('stable');
  const bad = release();
  bad.assets[0].browser_download_url = 'https://example.com/update.exe';
  expect(() => parseAppRelease(bad, '0.1.1')).toThrow('identity');
  bad.assets[0] = release().assets[0];
  bad.assets[0].digest = '';
  expect(() => parseAppRelease(bad, '0.1.1')).toThrow('identity');
  expect(() => parseAppRelease({ ...release(), assets: [] }, '0.1.1')).toThrow('installer');
});
it('makes no background requests by default, downloads a verified fixture, and never runs it', () =>
  fixture(async (s, root, request) => {
    await s.automatic();
    expect(request).not.toHaveBeenCalled();
    await s.check();
    expect(s.status().state).toBe('available');
    await s.download();
    expect(s.status().state).toBe('ready');
    s.requestInstall();
    const file = await s.installer();
    expect(await fs.readFile(file)).toEqual(bytes);
    expect(path.dirname(file)).toBe(path.join(root, 'app-updates'));
    expect(s.status().progress).toBe(100);
  }));
it('rejects altered cached installers before installation and allows a fresh verified download', () =>
  fixture(async (s, _root, request) => {
    await s.check();
    await s.download();
    s.requestInstall();
    const file = await s.installer();
    await fs.writeFile(file, Buffer.alloc(bytes.length));
    await expect(s.installer()).rejects.toThrow('checksum');
    expect(s.status().installRequested).toBe(false);
    await s.download();
    expect(s.status().state).toBe('ready');
    // Release feed + signature at check time, then one installer download each time.
    expect(request).toHaveBeenCalledTimes(4);
  }));
it('rejects incomplete or corrupt downloads without a ready installer or leftover partial', () =>
  fixture(async (s, root, request) => {
    await s.check();
    request.mockResolvedValue(new Response('bad'));
    await expect(s.download()).rejects.toThrow('incomplete');
    expect(s.status().state).toBe('error');
    expect(await fs.readdir(path.join(root, 'app-updates'))).toEqual([]);
    expect(() => s.requestInstall()).toThrow('verify');
  }));
it('refuses redirects outside GitHub release hosts', () =>
  fixture(async (s, _root, request) => {
    request.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://example.com/payload' } }),
    );
    await expect(s.check()).rejects.toThrow('release servers');
    expect(request).toHaveBeenCalledTimes(1);
  }));
it('distinguishes missing releases from up-to-date status', () =>
  fixture(async (s, _root, request) => {
    request.mockResolvedValue(new Response('', { status: 404 }));
    await expect(s.check()).rejects.toThrow('unavailable');
    expect(s.status().state).toBe('error');
    expect(s.status().message).not.toContain('latest stable');
  }));
it('postpones automatic installation without immediately requesting it again', () =>
  fixture(async s => {
    s.settings({ checkAutomatically: true, downloadAutomatically: true, installWhenIdle: true });
    await s.automatic();
    expect(s.status().installRequested).toBe(true);
    s.cancelInstall();
    await s.automatic();
    expect(s.status().installRequested).toBe(false);
    s.requestInstall();
    expect(s.status().installRequested).toBe(true);
    s.settings({ checkAutomatically: false });
    expect(s.status().settings).toEqual({
      checkAutomatically: false,
      downloadAutomatically: false,
      installWhenIdle: false,
    });
  }));
it('honors preferences revoked during an in-flight automatic check', () =>
  fixture(async (s, _root, request) => {
    s.settings({ checkAutomatically: true, downloadAutomatically: true, installWhenIdle: true });
    request.mockImplementation(async (url: string) => {
      s.settings({ checkAutomatically: false });
      return isSignature(url) ? new Response(signature) : Response.json(release());
    });
    await s.automatic();
    expect(request).toHaveBeenCalledTimes(2);
    expect(s.status().state).toBe('available');
    expect(s.status().installRequested).toBe(false);
  }));
it('keeps development and portable copies read-only for installation', () =>
  fixture(async (s, _root, request) => {
    s.settings({ checkAutomatically: true, downloadAutomatically: true, installWhenIdle: true });
    await s.automatic();
    expect(request).not.toHaveBeenCalled();
    await s.check();
    await expect(s.download()).rejects.toThrow('installed Windows');
    expect(() => s.requestInstall()).toThrow('verify');
  }, false));

it('cancels an in-flight download and leaves no executable ready', () =>
  fixture(async (s, root, request) => {
    await s.check();
    request.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const abort = () => reject(new Error('cancelled'));
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener('abort', abort, { once: true });
        }),
    );
    const downloading = s.download();
    const result = expect(downloading).rejects.toThrow();
    await s.cancel();
    await result;
    expect(s.status().state).toBe('error');
    expect(s.status().message).toContain('cancelled');
    expect(s.status().installRequested).toBe(false);
    expect(await fs.readdir(path.join(root, 'app-updates'))).toEqual([]);
  }));

it('requires a signature asset that sits next to the installer', () => {
  const unsigned = release();
  unsigned.assets.pop();
  expect(() => parseAppRelease(unsigned, '0.1.1')).toThrow('not signed');
  const moved = release();
  moved.assets[1].browser_download_url = 'https://github.com/GhostNoodl/Latent-v2/releases/download/v0.1.0/x.sig';
  expect(() => parseAppRelease(moved, '0.1.1')).toThrow('not signed');
  expect(parseAppRelease(release(), '0.1.1')?.signatureUrl).toMatch(/Setup-x64-unsigned\.exe\.sig$/);
});
it('keeps the release script and the app agreeing on the signed message', () => {
  const identity = { name: installerName, bytes: 42, sha256: 'a'.repeat(64) };
  expect(scriptSigningMessage(identity)).toBe(releaseSigningMessage(identity));
});
it('offers no release signed by an unknown key, or when no key is configured', async () => {
  const stranger = await signatureFor(keyPair().pem);
  await fixture(async (s, _root, request) => {
    request.mockImplementation(async (url: string) =>
      url === APP_RELEASE_API ? Response.json(release()) : new Response(stranger),
    );
    await expect(s.check()).rejects.toThrow('trusted Latent v2 publisher');
    expect(s.status().state).toBe('error');
    expect(s.status().release).toBeUndefined();
    await expect(s.download()).rejects.toThrow('Check for a newer release first');
  });
  await fixture(
    async s => {
      await expect(s.check()).rejects.toThrow('no release signing key');
      expect(s.status().release).toBeUndefined();
    },
    true,
    [],
  );
});
it('rejects malformed signatures and keys', () => {
  const identity = { name: installerName, bytes: bytes.length, sha256: 'b'.repeat(64) };
  expect(() => verifyReleaseSignature(identity, 'not-a-signature', [publisher.raw])).toThrow('malformed');
  expect(() => verifyReleaseSignature(identity, signature, ['short'])).toThrow('malformed');
  expect(() => verifyReleaseSignature(identity, signature, [publisher.raw])).toThrow('trusted');
});

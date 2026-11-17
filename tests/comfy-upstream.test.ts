import { describe, expect, it, vi } from 'vitest';
import { COMFY_LATEST_RELEASE_API, compareVersions, fetchLatestComfyRelease } from '../src/main/comfy-upstream';
import { checkMessage } from '../src/main/runtime-updates';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const release = {
  tag_name: 'v0.45.0',
  html_url: 'https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.45.0',
  published_at: '2026-11-10T21:42:42Z',
  draft: false,
  prerelease: false,
};

describe('compareVersions', () => {
  it('orders dotted numeric versions', () => {
    expect(compareVersions('0.45.0', '0.34.0')).toBe(1);
    expect(compareVersions('0.34.0', '0.45.2')).toBe(-1);
    expect(compareVersions('v0.45.2', '0.45.2')).toBe(0);
    expect(compareVersions('0.45.10', '0.45.9')).toBe(1);
  });
});

describe('fetchLatestComfyRelease', () => {
  it('reads the newest public release from the GitHub API', async () => {
    const request = vi.fn(async () => json(release));
    await expect(fetchLatestComfyRelease(request as unknown as typeof fetch)).resolves.toEqual({
      version: '0.45.0',
      url: 'https://github.com/Comfy-Org/ComfyUI/releases/tag/v0.45.0',
      publishedAt: '2026-11-10T21:42:42Z',
    });
    expect(request).toHaveBeenCalledWith(COMFY_LATEST_RELEASE_API, expect.objectContaining({ redirect: 'error' }));
  });
  it('rejects rate limits, odd tags and links away from GitHub', async () => {
    await expect(fetchLatestComfyRelease((async () => json({}, 403)) as unknown as typeof fetch)).rejects.toThrow(
      /limiting/,
    );
    await expect(
      fetchLatestComfyRelease((async () => json({ ...release, tag_name: 'nightly' })) as unknown as typeof fetch),
    ).rejects.toThrow(/usable/);
    await expect(
      fetchLatestComfyRelease((async () => json({ ...release, prerelease: true })) as unknown as typeof fetch),
    ).rejects.toThrow(/usable/);
    await expect(
      fetchLatestComfyRelease((async () =>
        json({ ...release, html_url: 'https://example.com/x' })) as unknown as typeof fetch),
    ).rejects.toThrow(/GitHub/);
  });
});

describe('checkMessage', () => {
  const upstream = (version: string, newer: boolean, error?: string) => ({
    version,
    url: `https://github.com/Comfy-Org/ComfyUI/releases/tag/v${version}`,
    checkedAt: '2026-11-17T03:00:00.000Z',
    newer,
    ...(error ? { error } : {}),
  });
  it('no longer claims "up to date" when ComfyUI is ahead of the app', () => {
    const message = checkMessage(undefined, '0.34.0', upstream('0.45.0', true), undefined);
    expect(message).toContain('ComfyUI 0.45.0 is out');
    expect(message).toContain('You have 0.34.0');
    expect(message).not.toMatch(/up to date/i);
  });
  it('points to App updates when a newer Latent exists', () => {
    expect(checkMessage(undefined, '0.34.0', upstream('0.45.0', true), '0.2.30')).toContain(
      'Latent 0.2.30 is available under App updates',
    );
  });
  it('offers a bundled newer engine first', () => {
    expect(checkMessage('ComfyUI 0.45.2 · newer image models', '0.34.0', upstream('0.45.0', false), undefined)).toBe(
      'ComfyUI 0.45.2 · newer image models is ready to download.',
    );
  });
  it('says up to date only when GitHub confirms it', () => {
    expect(checkMessage(undefined, '0.45.2', upstream('0.45.0', false), undefined)).toMatch(/^You're up to date/);
    expect(checkMessage(undefined, '0.45.2', upstream('0.45.0', false, 'offline'), undefined)).toMatch(
      /Couldn't reach GitHub/,
    );
    expect(checkMessage(undefined, '0.45.2', undefined, undefined)).toMatch(/Couldn't reach GitHub/);
  });
});

import { describe, expect, it } from 'vitest';
import { COMFYUI_RELEASE_API, latestComfyUIVersion } from '../src/main/comfyui-release';

const reply = (body: unknown, status = 200) =>
  (async (url: string | URL | Request) => {
    expect(String(url)).toBe(COMFYUI_RELEASE_API);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

describe('newest ComfyUI on GitHub', () => {
  it('reads the stable release version', async () => {
    expect(await latestComfyUIVersion(reply({ tag_name: 'v0.45.2', draft: false, prerelease: false }))).toBe('0.45.2');
  });
  it('ignores drafts, prereleases, odd tags and errors', async () => {
    expect(await latestComfyUIVersion(reply({ tag_name: 'v0.46.0', draft: false, prerelease: true }))).toBeUndefined();
    expect(await latestComfyUIVersion(reply({ tag_name: 'nightly', draft: false, prerelease: false }))).toBeUndefined();
    expect(await latestComfyUIVersion(reply({ message: 'rate limited' }, 403))).toBeUndefined();
    expect(
      await latestComfyUIVersion((async () => {
        throw new Error('offline');
      }) as typeof fetch),
    ).toBeUndefined();
  });
});

import { z } from 'zod';

export const COMFYUI_RELEASE_API = 'https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest';

/**
 * Newest stable ComfyUI version on GitHub, for telling the user how far behind the engine is.
 * Read-only: Latent never installs it. Returns undefined when GitHub can't be reached.
 */
export async function latestComfyUIVersion(request: typeof fetch = fetch, timeoutMs = 10_000) {
  try {
    const response = await request(COMFYUI_RELEASE_API, {
      headers: { 'User-Agent': 'Latent-v2-updater', Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const data = z
      .object({ tag_name: z.string().max(40), draft: z.boolean(), prerelease: z.boolean() })
      .safeParse(await response.json());
    if (!data.success || data.data.draft || data.data.prerelease) return undefined;
    const version = data.data.tag_name.replace(/^v/, '');
    return /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

import { z } from 'zod';

/** Public GitHub API for the newest ComfyUI release. Read only: the answer is shown, never installed. */
export const COMFY_LATEST_RELEASE_API = 'https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest';

const releaseSchema = z.object({
  tag_name: z.string().regex(/^v?\d{1,4}\.\d{1,4}\.\d{1,4}$/),
  html_url: z.string().url(),
  published_at: z.string().datetime().nullish(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

export interface ComfyRelease {
  version: string;
  url: string;
  publishedAt?: string;
}

/** Compares dotted numeric versions such as 0.34.0 and 0.45.2. Missing parts count as zero. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .replace(/^v/, '')
      .split('.')
      .map(part => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

export async function fetchLatestComfyRelease(
  request: typeof fetch,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<ComfyRelease> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await request(COMFY_LATEST_RELEASE_API, {
    headers: { 'User-Agent': 'Latent-v2-engine-check', Accept: 'application/vnd.github+json' },
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 403 || response.status === 429
        ? 'GitHub is limiting requests right now. Try again later.'
        : `GitHub answered ${response.status}.`,
    );
  }
  const text = await response.text();
  if (text.length > 1024 * 1024) throw new Error('GitHub sent an unexpectedly large answer.');
  const parsed = releaseSchema.safeParse(JSON.parse(text));
  if (!parsed.success || parsed.data.draft || parsed.data.prerelease)
    throw new Error('GitHub did not return a usable ComfyUI release.');
  const url = new URL(parsed.data.html_url);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com')
    throw new Error('The ComfyUI release link does not point to GitHub.');
  return {
    version: parsed.data.tag_name.replace(/^v/, ''),
    url: url.href,
    ...(parsed.data.published_at ? { publishedAt: parsed.data.published_at } : {}),
  };
}

import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^[A-Za-z0-9+!_.-]{1,120}$/);
const packageName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const manifest = z.object({ manifestSha256: hash, fileCount: z.number().int().min(0).max(30000), totalBytes: z.number().int().min(0).max(536870912) }).strict();

export const runtimeIdentityDataSchema = z.object({
  platform: z.string().max(30), arch: z.string().max(30),
  python: z.object({ version, implementation: z.enum(['CPython', 'PyPy']), torchVersion: version, torchCudaBuild: version.nullable(), executableSha256: hash }).strict(),
  packages: z.array(z.object({ name: packageName, version }).strict()).max(2048),
  comfy: z.object({
    observedGitCommit: z.string().regex(/^[a-f0-9]{40,64}$/).nullable(),
    observedVersion: version.nullable(), source: manifest,
    baseline: z.object({ commit: z.string().regex(/^[a-f0-9]{40}$/), archiveSha256: hash, version }).strict().nullable(),
  }).strict(),
  customNodes: z.array(z.object({ scope: z.enum(['studio', 'bundled']), name: z.string().min(1).max(256).regex(/^[^\\/\x00-\x1f]+$/), source: manifest }).strict()).max(1024),
  launch: z.object({ deviceMode: z.enum(['auto', 'lowvram', 'cpu']) }).strict(),
  inventoryPolicy: z.literal('runtime-source-v1'),
}).strict();

/** Prelaunch observation; a baseline pin is not a claim of current unmodified source. */
export const runtimeIdentitySchema = z.object({
  schema: z.literal(1), sha256: hash, observedAt: z.string().datetime(), data: runtimeIdentityDataSchema,
}).strict();
export type RuntimeIdentityData = z.infer<typeof runtimeIdentityDataSchema>;
export type RuntimeIdentitySnapshot = z.infer<typeof runtimeIdentitySchema>;

/** Shared stable ordering for content identities, independent of object insertion order. */
export function canonicalRuntimeJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalRuntimeJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalRuntimeJson(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

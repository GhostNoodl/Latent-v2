/** The last hires fix and face fix values, so switching one off and on again keeps your numbers. */
const keys = { hires: 'latent.last-hires-fix', face: 'latent.last-face-fix' } as const;

export function rememberExtra(kind: keyof typeof keys, value: object | undefined) {
  if (!value) return;
  try {
    localStorage.setItem(keys[kind], JSON.stringify(value));
  } catch {
    /* Private browser storage can be unavailable. */
  }
}

/** Saved values merged over the defaults. Only known fields are kept, and only when their type matches. */
export function recallExtra<T extends object>(kind: keyof typeof keys, defaults: T, optional: string[] = []): T {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(keys[kind]) ?? 'null');
  } catch {
    return defaults;
  }
  if (!saved || typeof saved !== 'object') return defaults;
  const base = defaults as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(saved)) {
    const known = Object.hasOwn(base, key) && base[key] !== undefined;
    if (
      known ? typeof value === typeof base[key] : optional.includes(key) && ['number', 'string'].includes(typeof value)
    )
      merged[key] = value;
  }
  return merged as T;
}

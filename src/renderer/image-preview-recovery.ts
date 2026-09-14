const listeners = new Set<(src: string) => void>();

/** A decoded retry lets other failed views retry the same saved asset. */
export function reportPreviewRecovery(src: string) {
  for (const listener of listeners) listener(src);
}

export function subscribePreviewRecovery(listener: (src: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

import { createWildcardSnapshot, EMPTY_WILDCARD_SNAPSHOT, wildcardSnapshotSchema, type WildcardSnapshot } from '../shared/dynamic-prompt-recipe';
import type { StudioStore } from './store';

/** User-authored wildcard text only; never interprets names as filesystem paths. */
export class WildcardStore {
  constructor(private store: StudioStore, private changed: () => void) {}
  snapshot(): WildcardSnapshot {
    return wildcardSnapshotSchema.parse(this.store.getState('dynamic-prompts.wildcards.v1', EMPTY_WILDCARD_SNAPSHOT));
  }
  async save(entries: Record<string, string[]>): Promise<WildcardSnapshot> {
    const snapshot = await createWildcardSnapshot(entries);
    this.store.setState('dynamic-prompts.wildcards.v1', snapshot); this.changed(); return structuredClone(snapshot);
  }
}

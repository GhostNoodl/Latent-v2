import {
  createWildcardSnapshot,
  EMPTY_WILDCARD_SNAPSHOT,
  wildcardSnapshotSchema,
  type WildcardSnapshot,
} from '../shared/dynamic-prompt-recipe';
import type { StudioStore } from './store';

const KEY = 'dynamic-prompts.wildcards.v1';
/** One parsed copy per store: lists can hold 100,000 lines and the window asks for them often. */
const cache = new WeakMap<StudioStore, WildcardSnapshot>();

/** User-authored wildcard text only; never interprets names as filesystem paths. */
export class WildcardStore {
  constructor(
    private store: StudioStore,
    private changed: () => void,
  ) {}
  /** The same object until the lists change, so the window only gets resent lists after a save. */
  snapshot(): WildcardSnapshot {
    let snapshot = cache.get(this.store);
    if (!snapshot) {
      snapshot = Object.freeze(wildcardSnapshotSchema.parse(this.store.getState(KEY, EMPTY_WILDCARD_SNAPSHOT)));
      cache.set(this.store, snapshot);
    }
    return snapshot;
  }
  async save(entries: Record<string, string[]>): Promise<WildcardSnapshot> {
    const snapshot = await createWildcardSnapshot(entries);
    this.store.setState(KEY, snapshot);
    cache.set(this.store, Object.freeze(structuredClone(snapshot)));
    this.changed();
    return structuredClone(snapshot);
  }
}

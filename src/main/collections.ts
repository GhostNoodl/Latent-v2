import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { StudioStore } from './store';
import { COLLECTION_LIMITS, type CollectionInventory, type CollectionKind, type CollectionSnapshot, type StudioCollection } from '../shared/collections-types';

const STATE_KEY = 'collections.v1';
const kindSchema = z.enum(['model', 'image']);
const collectionIdSchema = z.string().regex(/^col_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/, 'This collection ID is invalid.');
const memberIdSchema = z.string().min(1).max(500).refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'This member ID contains control characters.');
const nameSchema = z.string().trim().min(1, 'Give the collection a name.').max(COLLECTION_LIMITS.nameCharacters, 'Use a collection name up to 80 characters.').refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Use a collection name without control characters.').transform(value => value.normalize('NFC'));
const collectionSchema = z.object({ id: collectionIdSchema, kind: kindSchema, name: nameSchema, memberIds: z.array(memberIdSchema).max(COLLECTION_LIMITS.membersPerCollection), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict();
const snapshotSchema = z.object({ schemaVersion: z.literal(1), collections: z.array(collectionSchema).max(COLLECTION_LIMITS.perKind * 2) }).strict();
const changesSchema = z.array(memberIdSchema).min(1, 'Choose at least one item.').max(COLLECTION_LIMITS.membersPerChange);
const nameKey = (name: string) => name.normalize('NFKC').toLowerCase();

/** Atomic, synchronous logical collection edits on the studio's private SQLite.
 * This service never renames, moves, deletes, or opens model/output files.
 * Stale memberships remain recoverable when inventory items temporarily vanish.
 */
export class CollectionService {
  constructor(private store: StudioStore, private inventory: () => CollectionInventory, private changed: () => void = () => {}) {}

  snapshot(): CollectionSnapshot {
    return this.validateSnapshot(this.store.getState(STATE_KEY, { schemaVersion: 1, collections: [] }));
  }
  create(kind: CollectionKind, name: string): CollectionSnapshot {
    const parsedKind = kindSchema.parse(kind); const parsedName = nameSchema.parse(name); const snapshot = this.snapshot();
    if (snapshot.collections.filter(collection => collection.kind === parsedKind).length >= COLLECTION_LIMITS.perKind) throw new Error('Keep at most 100 collections for each item type.');
    this.uniqueName(snapshot, parsedKind, parsedName);
    const now = new Date().toISOString();
    snapshot.collections.push({ id: `col_${randomUUID()}`, kind: parsedKind, name: parsedName, memberIds: [], createdAt: now, updatedAt: now });
    return this.save(snapshot);
  }
  rename(id: string, name: string): CollectionSnapshot {
    const snapshot = this.snapshot(); const collection = this.collection(snapshot, id); const parsedName = nameSchema.parse(name);
    this.uniqueName(snapshot, collection.kind, parsedName, collection.id);
    if (collection.name === parsedName) return snapshot;
    collection.name = parsedName; collection.updatedAt = new Date().toISOString();
    return this.save(snapshot);
  }
  remove(id: string): CollectionSnapshot {
    const snapshot = this.snapshot(); const collection = this.collection(snapshot, id);
    snapshot.collections = snapshot.collections.filter(item => item.id !== collection.id);
    return this.save(snapshot);
  }
  addMembers(id: string, memberIds: string[]): CollectionSnapshot {
    const snapshot = this.snapshot(); const collection = this.collection(snapshot, id); const requested = [...new Set(changesSchema.parse(memberIds))];
    const inventory = this.inventory(); const available = new Set(collection.kind === 'model' ? inventory.modelIds : inventory.recordIds);
    const missing = requested.filter(memberId => !available.has(memberId));
    if (missing.length) throw new Error(`${missing.length} ${collection.kind === 'model' ? 'model' : 'image'} item${missing.length === 1 ? ' is' : 's are'} no longer in this studio. Refresh the library before adding ${missing.length === 1 ? 'it' : 'them'}.`);
    const combined = [...new Set([...collection.memberIds, ...requested])];
    if (combined.length > COLLECTION_LIMITS.membersPerCollection) throw new Error('A collection can contain up to 10,000 items.');
    if (combined.length === collection.memberIds.length) return snapshot;
    collection.memberIds = combined; collection.updatedAt = new Date().toISOString();
    return this.save(snapshot);
  }
  removeMembers(id: string, memberIds: string[]): CollectionSnapshot {
    const snapshot = this.snapshot(); const collection = this.collection(snapshot, id); const requested = new Set(changesSchema.parse(memberIds));
    const remaining = collection.memberIds.filter(memberId => !requested.has(memberId));
    if (remaining.length === collection.memberIds.length) return snapshot;
    collection.memberIds = remaining; collection.updatedAt = new Date().toISOString();
    return this.save(snapshot);
  }
  private collection(snapshot: CollectionSnapshot, id: string): StudioCollection {
    collectionIdSchema.parse(id);
    const collection = snapshot.collections.find(item => item.id === id);
    if (!collection) throw new Error('This collection no longer exists. Choose another collection.');
    return collection;
  }
  private uniqueName(snapshot: CollectionSnapshot, kind: CollectionKind, name: string, exceptId?: string) {
    if (snapshot.collections.some(collection => collection.kind === kind && collection.id !== exceptId && nameKey(collection.name) === nameKey(name))) throw new Error('A collection with this name already exists for these items.');
  }
  private validateSnapshot(input: unknown): CollectionSnapshot {
    const snapshot = snapshotSchema.parse(input);
    const ids = new Set<string>(); const names = new Set<string>(); let members = 0;
    for (const kind of ['model', 'image'] as const) if (snapshot.collections.filter(collection => collection.kind === kind).length > COLLECTION_LIMITS.perKind) throw new Error('The stored collection count exceeds its supported limit.');
    for (const collection of snapshot.collections) {
      const name = `${collection.kind}:${nameKey(collection.name)}`;
      if (ids.has(collection.id) || names.has(name) || new Set(collection.memberIds).size !== collection.memberIds.length) throw new Error('The collection index contains duplicate identities. Restore a valid studio index before editing it.');
      ids.add(collection.id); names.add(name); members += collection.memberIds.length;
    }
    if (members > COLLECTION_LIMITS.totalMemberships) throw new Error('The studio supports up to 100,000 collection memberships. Remove a membership before adding more.');
    return snapshot;
  }
  private save(snapshot: CollectionSnapshot) {
    const valid = this.validateSnapshot(snapshot);
    this.store.setState(STATE_KEY, valid); this.changed();
    return structuredClone(valid);
  }
}

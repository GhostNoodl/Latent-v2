/** Logical groups only. Collection names and IDs are never filesystem paths. */
export type CollectionKind = 'model' | 'image';
export interface StudioCollection {
  id: string;
  kind: CollectionKind;
  name: string;
  memberIds: string[];
  createdAt: string;
  updatedAt: string;
}
export interface CollectionSnapshot { schemaVersion: 1; collections: StudioCollection[]; }
export interface CollectionInventory { modelIds: readonly string[]; recordIds: readonly string[]; }
export interface CollectionActions {
  create(kind: CollectionKind, name: string): Promise<CollectionSnapshot>;
  rename(id: string, name: string): Promise<CollectionSnapshot>;
  remove(id: string): Promise<CollectionSnapshot>;
  addMembers(id: string, memberIds: string[]): Promise<CollectionSnapshot>;
  removeMembers(id: string, memberIds: string[]): Promise<CollectionSnapshot>;
}
export const COLLECTION_LIMITS = Object.freeze({ perKind: 100, nameCharacters: 80, membersPerCollection: 10_000, membersPerChange: 1_000, totalMemberships: 100_000 });

export interface StorageDestination { id: string; label: string; path: string; volumeId?: string; }
export interface StorageCounts { savedBytes: number; cacheBytes: number; resumablePartialBytes: number; otherPartialBytes: number; stagingBytes: number; fileCount: number; }
export interface StorageArea extends StorageCounts { id: string; label: string; destinationId: string; }
export interface StorageVolume {
  id: string; path: string; totalBytes?: number; availableBytes?: number; error?: string;
  /** Logical sizes, deduplicated by file identity. This is not allocated disk usage. */
  uniqueLogicalBytes: number;
  /** Deduplicated across package alternatives sharing the same asset. */
  knownPayloadBytes: number; minimumDownloadBytes: number; unverifiedPresentBytes: number;
}
export interface StoragePackage {
  id: string; name: string; state: string; message: string; progress?: number;
  destinationIds: string[]; dependencies: string[];
  knownPayloadBytes: number; presentCandidateBytes: number; resumableBytes: number;
  minimumDownloadBytes: number; unknownRequirements: string[]; warnings: string[];
}
export interface StorageTransfer {
  id: string; name: string; state: string; receivedBytes: number; totalBytes?: number; remainingBytes?: number;
  destinationId?: string; error?: string;
}
export interface StorageOverviewSnapshot {
  /** IDs of main-owned model download directories, including before any transfer exists. */
  modelDownloadDestinations?: { checkpoint: string; lora: string };
  version: 1; measuredAt: string; durationMs: number; complete: boolean;
  scannedEntries: number; skippedLinks: number; unreadableEntries: number; warnings: string[];
  totals: StorageCounts; uniqueLogicalBytes: number; destinations: StorageDestination[];
  areas: StorageArea[]; volumes: StorageVolume[]; packages: StoragePackage[]; transfers: StorageTransfer[];
}

/** Capacity only; no directory enumeration, package inspection or model hashing. */
export type DownloadStorageSnapshot = Pick<StorageOverviewSnapshot, 'measuredAt' | 'modelDownloadDestinations' | 'destinations' | 'volumes'>;
export interface PackageStorageSnapshot {
  measuredAt: string; durationMs: number; package: StoragePackage;
  destinations: StorageDestination[]; volumes: StorageVolume[]; warnings: string[];
}

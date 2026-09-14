/** Experimental import bounds, independent of supported generation dimensions. */
export const SOURCE_IMAGE_LIMITS = Object.freeze({ maxDimension: 8192, maxPixels: 32 * 1024 * 1024, maxInputBytes: 64 * 1024 * 1024 });
export type SourceImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp';
export type SourceMaskEdit =
  | { kind: 'paint' | 'erase' | 'rectangle' | 'invert' | 'clear' | 'fill' }
  | { kind: 'sam'; proposalMaskId: string }
  | { kind: 'grow' | 'shrink'; radius: number; shape: 'square'; boundary: 'black'; algorithmVersion: 1 }
  | { kind: 'feather'; radius: number; sigma: number; boundary: 'clamp'; algorithmVersion: 1 };
export interface SourceMaskSaveOptions { baseMaskId?: string | null; edits?: SourceMaskEdit[]; }
export interface SourceMaskEditProvenance { version: 1; baseMaskId: string | null; edits: SourceMaskEdit[]; }

export interface SourceImageIdentity {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  mimeType: SourceImageMimeType;
}

/** Public metadata only. Paths are resolved by the main process from immutable IDs. */
export interface SourceImageAsset {
  /** Set only by main-process import of a verified output from this studio. */
  originGenerationId?: string;
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  original: SourceImageIdentity;
  normalized: SourceImageIdentity & { mimeType: 'image/png' };
  normalizedStoredSeparately: boolean;
  normalization: { version: 1; orientationApplied: number; colorSpace: 'srgb'; metadataStripped: true };
}

/** A revision always refers to its source's normalized pixel coordinate system. */
export interface SourceMaskAsset extends SourceImageIdentity {
  editProvenance?: SourceMaskEditProvenance;
  schemaVersion: 1;
  id: string;
  sourceId: string;
  sourceSha256: string;
  parentMaskId: string | null;
  revision: number;
  createdAt: string;
  mimeType: 'image/png';
  channel: 'red';
  polarity: 'white-edits';
}

export interface SourceImageInventory {
  schemaVersion: 1;
  sources: SourceImageAsset[];
  masks: SourceMaskAsset[];
}

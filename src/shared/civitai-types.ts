import type { ModelFamily, ModelKind } from './types';
export interface CivitaiDownloadRequest { modelId: number; versionId: number; fileId: number; }
export interface CivitaiSettings { hasApiKey: boolean; }

export interface CivitaiPermissions {
  allowNoCredit: boolean | null;
  allowDerivatives: boolean | null;
  allowDifferentLicense: boolean | null;
  /** Exact declared values; null means unavailable, [] is an explicit empty list. */
  allowCommercialUse: string[] | null;
}
export interface CivitaiFile {
  id: number;
  name: string;
  type: string;
  format: string;
  fp: string;
  sizeKB: number | null;
  /** Estimate from API sizeKB * 1024; validate actual downloaded bytes later. */
  estimatedBytes: number | null;
  sha256: string | null;
  downloadUrl: string | null;
  primary: boolean;
  safeTensor: boolean;
}
export interface CivitaiPreview { url: string; width: number | null; height: number | null; }
export interface CivitaiVersion {
  id: number;
  modelId: number;
  name: string;
  description: string;
  baseModel: string;
  family: ModelFamily | 'unknown';
  baseModelType: string;
  trainedWords: string[];
  availability: string;
  status: string;
  earlyAccessEndsAt: string | null;
  /** A public declaration, not an entitlement or a successful-download claim. */
  publiclyListed: boolean;
  files: CivitaiFile[];
  previews: CivitaiPreview[];
  sourceUrl: string;
}
export interface CivitaiModel {
  id: number;
  name: string;
  description: string;
  kind: ModelKind;
  creator: string;
  tags: string[];
  sourceUrl: string;
  availability: string;
  mode: string | null;
  permissions: CivitaiPermissions;
  versions: CivitaiVersion[];
}
export interface CivitaiSearchRequest {
  includeMature?: boolean;
  query?: string;
  username?: string;
  tag?: string;
  period?: 'AllTime' | 'Year' | 'Month' | 'Week' | 'Day';
  kind?: ModelKind;
  family?: ModelFamily;
  cursor?: string;
  limit?: number;
  sort?: 'Most Downloaded' | 'Highest Rated' | 'Newest';
}
export interface CivitaiSearchPage { items: CivitaiModel[]; nextCursor: string | null; }
export interface CivitaiReadResult<T> {
  data: T;
  fetchedAt: string;
  fromCache: boolean;
  stale: boolean;
  /** Useful failure explanation when a previous successful read is shown. */
  warning?: string;
}

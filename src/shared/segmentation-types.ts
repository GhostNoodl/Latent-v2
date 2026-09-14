import type { SourceMaskAsset } from './source-types';
export interface SegmentationRequest {
  sourceId: string;
  points: Array<{ x: number; y: number; label: 0 | 1 }>;
  box?: { x: number; y: number; width: number; height: number };
}
export interface SegmentationStatus {
  state: 'not-installed' | 'installing' | 'stopped' | 'starting' | 'ready' | 'segmenting' | 'error';
  /** Publication marker/model presence; startup still verifies code and dependencies. */
  installationAvailable: boolean;
  message: string;
  model: 'SAM ViT-B';
  device: 'cpu';
  experimental: true;
  installProgress?: number;
  requestId?: string;
  logTail: string[];
}
export interface SegmentationSuggestion {
  id: string;
  createdAt: string;
  mask: SourceMaskAsset;
  request: SegmentationRequest;
  sourceSha256: string;
  model: 'SAM ViT-B';
  modelSha256: string;
  codeRevision: string;
  predictedQuality: number;
  selectedPixels: number;
  pointPromptsSatisfied: boolean;
  embeddingCacheHit: boolean;
  embeddingMs: number;
  inferenceMs: number;
  durationMs: number;
}

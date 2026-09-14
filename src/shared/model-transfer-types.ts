import type { ModelDownloadRequest } from './types';

/** Durable private metadata. Authentication headers and signed URLs are never stored. */
export interface ModelTransferRecord {
  version: 1;
  id: string;
  identity: string;
  createdAt: string;
  updatedAt: string;
  attempt: number;
  state: 'downloading' | 'verifying' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  request: Omit<ModelDownloadRequest, 'url'>;
  source: {
    kind: 'direct' | 'civitai' | 'refresh-required';
    origin: string;
    identity: string;
    /** Only query-free, fragment-free public source URLs are retained. */
    url?: string;
    usedAuthentication: boolean;
  };
  receivedBytes: number;
  totalBytes: number;
  error?: string;
}

export interface ModelTransferRecovery {
  transfers: ModelTransferRecord[];
  warnings: string[];
  preparing?: string[];
}
export interface ModelTransferRetryRequest { id: string; url?: string; }

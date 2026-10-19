import type { GenerationDraft } from './types';

export interface AssistantStatus {
  state: 'not-installed' | 'installing' | 'stopped' | 'starting' | 'ready' | 'thinking' | 'error';
  /** Installation marker and required files exist; startup still verifies their content. */
  installationAvailable: boolean;
  message: string;
  model: string;
  device: 'cpu';
  installProgress?: number;
  receivedBytes?: number;
  totalBytes?: number;
  requestId?: string;
  /** The reply as it is being written. */
  reply?: { explanation?: string; prompt?: string };
  logTail: string[];
}

export interface AssistantSuggestionRequest {
  target?: 'image' | 'video';
  videoContext?: import('./video-types').VideoDraft;
  instruction: string;
  draft: GenerationDraft;
  /** Display names of the LoRAs in the draft. */
  loraNames?: string[];
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface AssistantSuggestion {
  id: string;
  createdAt: string;
  explanation: string;
  originalDraft: GenerationDraft;
  proposedDraft: GenerationDraft;
  modelId: string;
  modelRevision: string;
  promptTokens: number;
  completionTokens?: number;
  durationMs: number;
  historyTurnsUsed: number;
  /** Trigger words, wildcards or choice groups from the prompt that the proposal left out. */
  dropped?: string[];
}

export interface AssistantConversation {
  version: 1;
  messages: Array<{
    id: string;
    role: 'user' | 'assistant';
    content: string;
    createdAt: string;
    suggestion?: AssistantSuggestion;
  }>;
  instruction: string;
  selectedSuggestionId?: string;
  appliedSuggestionId?: string;
}

import type { GenerationDraft } from './types';
import type { VideoDraft } from './video-types';

/** Where the assistant's brain runs. */
export type AssistantProviderId = 'local' | 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'custom';
export type CloudProviderId = Exclude<AssistantProviderId, 'local'>;
export type LocalAssistantModelId = 'qwen35-4b' | 'qwen35-9b' | 'qwen36-35b' | 'qwen38-27b';

/** One-click jobs. `chat` uses whatever the person typed. */
export type AssistantAction =
  'chat' | 'improve' | 'expand' | 'shorten' | 'tags' | 'sentences' | 'variations' | 'describe' | 'motion';

export interface AssistantSettings {
  provider: AssistantProviderId;
  /** Picked model per provider. */
  models: Partial<Record<CloudProviderId, string>>;
  /** Base URL for "Your own server", for example http://localhost:1234/v1. */
  customUrl: string;
  localModel: LocalAssistantModelId;
  /** auto = graphics card when there is room for it. */
  localDevice: 'auto' | 'gpu' | 'cpu';
}

export interface AssistantModelOption {
  id: string;
  name: string;
  /** Can look at pictures. Undefined means unknown. */
  vision?: boolean;
}

export interface LocalAssistantStatus {
  state: 'not-installed' | 'installing' | 'stopped' | 'starting' | 'ready' | 'error';
  message: string;
  /** Local models whose files are on disk and checked. */
  installed: LocalAssistantModelId[];
  /** The one Latent suggests for this PC. */
  recommended: LocalAssistantModelId;
  /** Still to download per model, including the server if it's missing. */
  downloadBytes?: Partial<Record<LocalAssistantModelId, number>>;
  /** An NVIDIA card was found, so models can run on it. */
  gpu?: boolean;
  /** What the running server uses. */
  device?: 'gpu' | 'cpu';
  installProgress?: number;
  receivedBytes?: number;
  totalBytes?: number;
  logTail: string[];
}

export interface AssistantStatus {
  settings: AssistantSettings;
  /** Cloud providers with a saved key. Keys never leave the main process; this is only a yes/no and the last 4 characters. */
  keys: Partial<Record<CloudProviderId, { last4: string }>>;
  /** Ready to send with the current settings. */
  ready: boolean;
  /** Why it isn't ready, in plain words. */
  reason?: string;
  /** Short label for what answers, like "Claude Opus 5.5" or "Qwen3.5 9B on your PC". */
  label: string;
  /** The current provider and model can look at pictures. */
  vision: boolean;
  local: LocalAssistantStatus;
  /** The reply that is being written right now. */
  writing?: { requestId: string; message?: string; prompt?: string };
}

export interface AssistantImageRef {
  kind: 'source' | 'output';
  id: string;
}

export interface AssistantRequest {
  /** edit = a Qwen Edit instruction for the picture on the Edit page. */
  target: 'image' | 'video' | 'edit';
  action: AssistantAction;
  /** What the person typed. Required for chat, optional extra for the others. */
  instruction?: string;
  draft: GenerationDraft;
  videoContext?: VideoDraft;
  /** Names to help the assistant: the checkpoint and LoRAs in use. */
  checkpointName?: string;
  loraNames?: string[];
  image?: AssistantImageRef;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export interface AssistantOption {
  prompt: string;
  negativePrompt: string;
  /** Trigger words, wildcards or choice groups from the prompt that this option left out. */
  dropped?: string[];
}

export interface AssistantReply {
  id: string;
  createdAt: string;
  message: string;
  options: AssistantOption[];
  /** What answered, for the small print. */
  label: string;
  durationMs: number;
}

export interface AssistantChatEntry {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  action?: AssistantAction;
  /** Picture that went with the message, for display only. */
  image?: AssistantImageRef;
  reply?: AssistantReply;
  /** Index of the option that was applied. */
  applied?: number;
}

export interface AssistantConversation {
  version: 2;
  messages: AssistantChatEntry[];
}

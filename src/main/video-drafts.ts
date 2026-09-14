import { DEFAULT_VIDEO_DRAFT, VIDEO_AVAILABILITY, planVideo, videoDraftSchema } from '../shared/video-plan';
import type { VideoDraft } from '../shared/video-types';
import type { StudioStore } from './store';
import type { SourceImageAsset } from '../shared/source-types';
type VideoStore = Pick<StudioStore, 'getState' | 'setState' | 'settings'>;
const STATE_KEY = 'video-draft@1';
/** Construction is read-only; no setup, inference, or live-state write happens without save/reset. */
export class VideoDraftService {
  constructor(private readonly store: VideoStore) {}
  status() { return structuredClone(VIDEO_AVAILABILITY); }
  draft(): VideoDraft { const draft = videoDraftSchema.parse(this.store.getState(STATE_KEY, DEFAULT_VIDEO_DRAFT)); return this.store.settings().rememberPositivePrompt ? draft : { ...draft, prompt: '' }; }
  save(input: VideoDraft) { const draft = videoDraftSchema.parse(input); const remembered = { ...draft, prompt: this.store.settings().rememberPositivePrompt ? draft.prompt : '' }; this.store.setState(STATE_KEY, remembered); return structuredClone(draft); }
  /** Main must call when the shared prompt-memory setting changes, to remove old persisted text too. */
  applyPromptMemoryPolicy() { if (!this.store.settings().rememberPositivePrompt) this.save(this.draft()); }
  reset() { const originalDraft = this.draft(); const proposedDraft = this.save(structuredClone(DEFAULT_VIDEO_DRAFT)); return { originalDraft, proposedDraft }; }
  /** Main returns an explicit restore proposal; the caller applies it with Undo and calls save if desired. */
  restore(input: VideoDraft) { return { originalDraft: this.draft(), proposedDraft: videoDraftSchema.parse(input) }; }
  async plan(input: VideoDraft, actualSeed: string, resolveSource: (id: string) => Promise<SourceImageAsset>) {
    const draft = videoDraftSchema.parse(input); const ids = [...new Set([draft.firstFrame?.sourceId, draft.lastFrame?.sourceId].filter((value): value is string => !!value))]; const sources = await Promise.all(ids.map(resolveSource)); return planVideo(draft, { actualSeed, sources });
  }
}

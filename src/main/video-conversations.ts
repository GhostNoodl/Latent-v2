import type { StudioStore } from './store';
import { videoConversationSchema, type VideoConversation } from '../shared/video-conversation';
import { VideoDraftService } from './video-drafts';
const KEY = 'video-editor-sessions@1';
export class VideoConversationService {
  constructor(private store: Pick<StudioStore, 'getState' | 'setState' | 'settings'>) {}
  get(): VideoConversation | null {
    const saved = this.store.getState<unknown>(KEY, null); if (saved === null) return null;
    return this.remembered(videoConversationSchema.parse(saved));
  }
  save(value: VideoConversation): void { this.store.setState(KEY, this.remembered(videoConversationSchema.parse(value))); }
  applyPromptMemoryPolicy(): void {
    if (this.store.settings().rememberPositivePrompt) return;
    const saved = this.get(); if (saved) this.save(saved); new VideoDraftService(this.store).applyPromptMemoryPolicy();
  }
  private remembered(value: VideoConversation): VideoConversation {
    const result = structuredClone(value); if (!this.store.settings().rememberPositivePrompt) for (const session of result.sessions) session.draft.prompt = ''; return result;
  }
}

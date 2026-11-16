import type { StudioStore } from './store';
import { videoConversationSchema, type VideoConversation } from '../shared/video-conversation';
const KEY = 'video-editor-sessions@1';
const OLD_DRAFT_KEY = 'video-draft@1';
export class VideoConversationService {
  constructor(private store: Pick<StudioStore, 'getState' | 'setState' | 'settings'>) {}
  get(): VideoConversation | null {
    const saved = this.store.getState<unknown>(KEY, null);
    if (saved === null) return null;
    const parsed = videoConversationSchema.safeParse(saved);
    // A setup saved by an older version that no longer fits starts fresh instead of blocking the page.
    return parsed.success ? this.remembered(parsed.data) : null;
  }
  save(value: VideoConversation): void {
    this.store.setState(KEY, this.remembered(videoConversationSchema.parse(value)));
  }
  applyPromptMemoryPolicy(): void {
    if (this.store.settings().rememberPositivePrompt) return;
    const saved = this.get();
    if (saved) this.save(saved);
    const old = this.store.getState<Record<string, unknown> | null>(OLD_DRAFT_KEY, null);
    if (old && typeof old === 'object' && old.prompt) this.store.setState(OLD_DRAFT_KEY, { ...old, prompt: '' });
  }
  private remembered(value: VideoConversation): VideoConversation {
    const result = structuredClone(value);
    if (!this.store.settings().rememberPositivePrompt) for (const session of result.sessions) session.draft.prompt = '';
    return result;
  }
}

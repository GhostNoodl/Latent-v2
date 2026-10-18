import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ dialog: {} }));
import { assistantSourcesHandlers, conversationKey } from '../src/main/ipc/assistant-sources';
import type { HandlerContext } from '../src/main/main';
import { StudioStore } from '../src/main/store';
const dirs: string[] = [];
const stores: StudioStore[] = [];
function handlers() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latent-conversation-test-'));
  dirs.push(root);
  const store = new StudioStore(path.join(root, 'studio.sqlite'));
  stores.push(store);
  return { store, methods: assistantSourcesHandlers({ store } as unknown as HandlerContext) };
}
const conversation = (instruction: string) => ({ version: 1 as const, instruction, messages: [] });
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe('saved assistant conversations', () => {
  it('keeps the keys older versions saved under', () => {
    expect(conversationKey('image')).toBe('assistant.conversation');
    expect(conversationKey(undefined)).toBe('assistant.conversation');
    expect(conversationKey('video')).toBe('assistant.video.conversation');
  });
  it('saves and reads each scope separately', async () => {
    const { methods } = handlers();
    await methods.saveAssistantConversation(conversation('image'), 'image');
    await methods.saveAssistantConversation(conversation('video'), 'video');
    expect((await methods.getAssistantConversation('image'))?.instruction).toBe('image');
    expect((await methods.getAssistantConversation('video'))?.instruction).toBe('video');
  });
  it('recovers conversations 0.2.2 and 0.2.3 saved under the mistyped key', async () => {
    const { store, methods } = handlers();
    store.setState('assistant.conversation', conversation('from 0.2.1'));
    store.setState('ctx.assistant.conversation', conversation('from 0.2.3'));
    store.setState('ctx.assistant.video.conversation', conversation('video from 0.2.3'));
    expect((await methods.getAssistantConversation('image'))?.instruction).toBe('from 0.2.3');
    expect((await methods.getAssistantConversation('video'))?.instruction).toBe('video from 0.2.3');
    expect(store.getState('ctx.assistant.conversation', null)).toBeNull();
    expect(store.getState('assistant.conversation', null)).toEqual(conversation('from 0.2.3'));
  });
});

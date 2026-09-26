// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QwenEditor } from '../src/renderer/QwenEditor';
import { createQwenConversationDraft } from '../src/shared/qwen-conversation';
import type { AppSnapshot, LatentAPI } from '../src/shared/types';

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => { await unmount?.(); vi.unstubAllGlobals(); });
it.each(['qwen21'] as const)('queues %s text-only transparent creation and makes Lightning require a source again', async profile => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const draft = { ...createQwenConversationDraft(), operation: 'create' as const, transparent: true, instruction: 'A wolf adventurer.', settings: { profile, width: 704, height: 1024, seed: 'random', resize: 'stretch' as const } };
  const snapshot = { history: [], jobs: [], sourceImages: { sources: [] }, settings: { showGenerationPreview: false }, backend: { state: 'ready' }, qwenEdit: { state: 'ready', qwen21Ready: true, lightning8Ready: true, message: 'Ready' }, runtimeUpdates: { state: 'idle', current: { setId: 'comfy-0-37-0-qwen21-1' } } } as unknown as AppSnapshot;
  const enqueue = vi.fn().mockResolvedValue({ id: 'new-job' });
  window.latent = { getQwenConversation: async () => ({ schemaVersion: 1, activeConversationId: draft.id, conversations: [draft] }), saveQwenConversation: vi.fn().mockResolvedValue(undefined), enqueueQwenEdit: enqueue, getSnapshot: async () => snapshot } as unknown as LatentAPI;
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  await act(async () => root.render(<QwenEditor embedded snapshot={snapshot} run={async (_key, task) => { await task(); return true; }} busy={{}} onClose={() => {}} />));
  expect(host.querySelector('[aria-label="Qwen Image Station"]')).not.toBeNull();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  expect(host.textContent).toContain('16.1 GiB');
  const generate = [...host.querySelectorAll('button')].find(b => b.textContent === 'Generate image')!;
  expect(generate.disabled).toBe(false);
  await act(async () => generate.click());
  expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ operation: 'create', transparent: true, settings: expect.objectContaining({ profile }) }));
  expect(enqueue.mock.calls[0][0].sourceId).toBeUndefined();
  const model = [...host.querySelectorAll('select')].find(select => [...select.options].some(option => option.value === 'lightning8'))!;
  await act(async () => { model.value = 'lightning8'; model.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(host.querySelector('[aria-label="Qwen task"]')).toBeNull();
  expect([...host.querySelectorAll('button')].find(b => b.textContent === 'Queue image edit')?.disabled).toBe(true);
});

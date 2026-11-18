// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { QwenEditor, buildSteps } from '../src/renderer/QwenEditor';
import { createQwenConversationDraft, type QwenConversationDraft } from '../src/shared/qwen-conversation';
import { qwenSameSize } from '../src/shared/qwen-area';
import type { AppSnapshot, GenerationRecord, LatentAPI } from '../src/shared/types';

let unmount: (() => Promise<void>) | undefined;
afterEach(async () => {
  await unmount?.();
  vi.unstubAllGlobals();
});

const sourceId = `src_${'a'.repeat(8)}-aaaa-4aaa-8aaa-${'a'.repeat(12)}`;
const baseSnapshot = (extra: Partial<AppSnapshot> = {}) =>
  ({
    history: [],
    jobs: [],
    sourceImages: {
      sources: [
        {
          id: sourceId,
          name: 'Portrait',
          normalized: { sha256: 'a'.repeat(64), width: 1600, height: 2400, bytes: 10, mimeType: 'image/png' },
        },
      ],
    },
    settings: { showGenerationPreview: false },
    backend: { state: 'ready' },
    qwenEdit: { state: 'ready', qwen21Ready: true, lightning8Ready: true, fastReady: true, message: 'Ready' },
    runtimeUpdates: { state: 'idle', current: { setId: 'comfy-0-37-0-qwen21-1' } },
    ...extra,
  }) as unknown as AppSnapshot;

async function mount(draft: QwenConversationDraft, snapshot: AppSnapshot) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  let count = 0;
  const enqueue = vi.fn().mockImplementation(async () => ({ id: `job-${++count}` }));
  window.latent = {
    getQwenConversation: async () => ({ schemaVersion: 1, activeConversationId: draft.id, conversations: [draft] }),
    saveQwenConversation: vi.fn().mockResolvedValue(undefined),
    enqueueQwenEdit: enqueue,
    getSnapshot: async () => snapshot,
  } as unknown as LatentAPI;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  unmount = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  await act(async () =>
    root.render(
      <QwenEditor
        embedded
        snapshot={snapshot}
        run={async (_key, task) => {
          await task();
          return true;
        }}
        busy={{}}
        onClose={() => {}}
      />,
    ),
  );
  const button = (text: string | RegExp) =>
    [...host.querySelectorAll('button')].find(item =>
      typeof text === 'string' ? item.textContent?.trim() === text : text.test(item.textContent ?? ''),
    )!;
  return { host, enqueue, button };
}

it('makes a transparent picture from text with Qwen Image 2.1', async () => {
  const draft = {
    ...createQwenConversationDraft(),
    operation: 'create' as const,
    transparent: true,
    instruction: 'A wolf adventurer.',
    settings: { profile: 'qwen21' as const, width: 1024, height: 1024, seed: 'random', resize: 'stretch' as const },
  };
  const { host, enqueue, button } = await mount(draft, baseSnapshot());
  expect(host.querySelector('[aria-label="Edit"]')).not.toBeNull();
  const make = button(/^Make it/);
  expect(make.disabled).toBe(false);
  await act(async () => make.click());
  expect(enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      operation: 'create',
      transparent: true,
      settings: expect.objectContaining({ profile: 'qwen21', width: 1024, height: 1024 }),
    }),
  );
  expect(enqueue.mock.calls[0][0].sourceId).toBeUndefined();
});

it('queues several tries of a whole-picture edit at the picture size', async () => {
  const draft: QwenConversationDraft = {
    ...createQwenConversationDraft(),
    source: { id: sourceId, sha256: 'a'.repeat(64) },
    instruction: '',
    settings: { profile: 'lightning8', width: 1024, height: 1024, seed: '41', resize: 'center-crop' },
  };
  const { host, enqueue, button } = await mount(draft, baseSnapshot());
  await act(async () => button('Relight').click());
  expect(host.querySelector('textarea')!.value).toMatch(/^Relight/);
  await act(async () => button(/^Tries/).click());
  await act(async () => button('3').click());
  const go = button(/^Edit · 3 tries/);
  expect(go.disabled).toBe(false);
  await act(async () => go.click());
  expect(enqueue).toHaveBeenCalledTimes(3);
  const requests = enqueue.mock.calls.map(call => call[0]);
  expect(new Set(requests.map(item => item.lineage.group)).size).toBe(1);
  expect(requests[0].lineage.group).toBeTruthy();
  expect(requests.map(item => item.settings.seed)).toEqual(['41', '42', '43']);
  expect(requests[0].output).toEqual(qwenSameSize(1600, 2400));
  expect(requests[0].settings).toMatchObject({ resize: 'stretch', width: 704, height: 1024 });
});

it('groups tries into one step and marks branches', () => {
  const record = (id: string, group: string | undefined, parent?: string) =>
    ({
      id,
      qwenEdit: { lineage: { conversationId: 'c', branchId: 'b', group, parentRecordId: parent } },
    }) as unknown as GenerationRecord;
  const steps = buildSteps([
    record('1', undefined),
    record('2a', 'g', '1'),
    record('2b', 'g', '1'),
    record('3', undefined, '2a'),
    record('4', undefined, '1'),
  ]);
  expect(steps.map(step => step.records.length)).toEqual([1, 2, 1, 1]);
  expect(steps.map(step => step.branch)).toEqual([false, false, false, true]);
  expect(steps[3].parentStep).toBe(1);
});

// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DynamicPrompts } from '../src/renderer/DynamicPrompts';
import { createWildcardSnapshot } from '../src/shared/dynamic-prompt-recipe';
it('stages packs in the real editor, requires explicit save, and warns on discarding unsaved additions', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  const existing = { starter_species: ['my own species'] };
  const snapshot = await createWildcardSnapshot(existing);
  const save = vi.fn(async (entries: Record<string, string[]>) => createWildcardSnapshot(entries));
  const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!;
  try {
    await act(async () =>
      root.render(
        <DynamicPrompts
          draft={{ prompt: '', negativePrompt: '' }}
          wildcards={snapshot}
          onChange={() => {}}
          onReroll={() => {}}
          onSaveWildcards={save}
        />,
      ),
    );
    await act(async () =>
      [...host.querySelectorAll('button')].find(b => b.textContent?.trim().startsWith('Lists'))!.click(),
    );
    await act(async () => button('Starter packs').click());
    await act(async () => button('Add species').click());
    expect(save).not.toHaveBeenCalled();
    expect(document.querySelector('.wildcard-lists-heading code')!.textContent).toBe('__starter_species_2__');
    expect(document.querySelector('textarea')!.value).toContain('wolf');
    await act(async () => button('Cancel').click());
    expect(document.body.textContent).toContain('You have changes that aren’t saved');
    await act(async () => button('Keep editing').click());
    await act(async () => button('Save').click());
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0].starter_species).toEqual(existing.starter_species);
    expect(save.mock.calls[0][0].starter_species_2).toContain('rabbit');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

it('shows examples, locks a pick and queues several images or every combination', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  const snapshot = await createWildcardSnapshot({ pets: ['cat', 'dog'] });
  const queued: unknown[][] = [];
  const changes: unknown[] = [];
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!;
  const render = (draft: Parameters<typeof DynamicPrompts>[0]['draft']) =>
    root.render(
      <DynamicPrompts
        draft={draft}
        wildcards={snapshot}
        onChange={value => changes.push(value)}
        onReroll={() => {}}
        onSaveWildcards={async entries => createWildcardSnapshot(entries)}
        onQueue={setups => queued.push(setups)}
      />,
    );
  try {
    await act(async () => render({ prompt: 'a __pets__ in {rain|snow}', negativePrompt: '', seed: '7' }));
    // The examples wait a moment for typing to settle, then hash the lists off the main thread.
    for (let tries = 0; tries < 100 && host.querySelectorAll('.dynamic-examples li').length < 3; tries++)
      await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
    for (let tries = 0; tries < 100 && !button('All 4 combinations'); tries++)
      await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
    const examples = [...host.querySelectorAll('.dynamic-examples li')].map(item => item.textContent);
    expect(examples).toHaveLength(3);
    for (const text of examples) expect(text).toMatch(/^a (cat|dog) in (rain|snow)$/);
    await act(async () => button('All 4 combinations').click());
    expect(queued[0]).toHaveLength(4);
    expect(queued[0].map(setup => (setup as { combination: number }).combination)).toEqual([0, 1, 2, 3]);
    await act(async () => button('8').click());
    expect(queued[1]).toHaveLength(8);
    const lock = host.querySelector<HTMLButtonElement>('.dynamic-lock')!;
    await act(async () => lock.click());
    expect(changes.at(-1)).toMatchObject({ enabled: true, pins: { pets: expect.stringMatching(/cat|dog/) } });
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});

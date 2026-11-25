// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { COPY_FILE_SCRIPT, copyFileToClipboard } from '../src/main/clipboard';
import { parseSettingsPatch } from '../src/shared/validation';
import {
  PromptSnippets,
  filterSnippets,
  insertSnippet,
  saveSnippet,
  snippetName,
  type PromptSnippet,
} from '../src/renderer/PromptSnippets';

describe('insertSnippet', () => {
  it('adds commas around the snippet at the cursor', () => {
    expect(insertSnippet('a cat, at night', 5, 5, 'soft light, film grain,')).toEqual({
      value: 'a cat, soft light, film grain, at night',
      caret: 'a cat, soft light, film grain'.length,
    });
  });
  it('appends to the end and fills an empty prompt', () => {
    expect(insertSnippet('a cat', 5, 5, 'soft light').value).toBe('a cat, soft light');
    expect(insertSnippet('a cat, ', 7, 7, 'soft light').value).toBe('a cat, soft light');
    expect(insertSnippet('', 0, 0, ' soft light ').value).toBe('soft light');
  });
  it('replaces selected text and keeps brackets and new lines tidy', () => {
    expect(insertSnippet('a dog, at night', 2, 5, 'cat').value).toBe('a, cat, at night');
    expect(insertSnippet('(blue', 5, 5, 'red').value).toBe('(blue, red');
    expect(insertSnippet('(', 1, 1, 'red').value).toBe('(red');
    expect(insertSnippet('one\ntwo', 4, 4, 'red').value).toBe('one\nred, two');
  });
});

describe('snippet list', () => {
  it('saves new snippets first, names them from their tags and updates in place', () => {
    const one = saveSnippet([], { name: '', text: 'masterpiece, best quality, absurdres, highres,' });
    expect(one[0]).toMatchObject({
      name: 'masterpiece, best quality, absurdres',
      text: 'masterpiece, best quality, absurdres, highres',
    });
    expect(saveSnippet(one, { name: 'x', text: '  ' })).toBe(one);
    const changed = saveSnippet(one, { id: one[0].id, name: 'Quality', text: 'best quality' });
    expect(changed).toEqual([{ id: one[0].id, name: 'Quality', text: 'best quality' }]);
    expect(parseSettingsPatch({ promptSnippets: changed })).toEqual({ promptSnippets: changed });
    expect(snippetName('a'.repeat(60))).toHaveLength(40);
  });
  it('finds snippets by name or tags', () => {
    const list: PromptSnippet[] = [
      { id: 's-1', name: 'Quality', text: 'masterpiece, best quality' },
      { id: 's-2', name: 'Night', text: 'moonlight, stars' },
    ];
    expect(filterSnippets(list, 'moon').map(s => s.id)).toEqual(['s-2']);
    expect(filterSnippets(list, 'quality best').map(s => s.id)).toEqual(['s-1']);
    expect(filterSnippets(list, '')).toBe(list);
  });
});

it('drops a snippet into the prompt at the cursor from the panel', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
    run();
    return 0;
  });
  const host = document.createElement('div');
  host.className = 'studio';
  document.body.append(host);
  const root = createRoot(host);
  const snippets: PromptSnippet[] = [{ id: 's-1', name: 'Night', text: 'moonlight, stars' }];
  function Fixture() {
    const [value, setValue] = useState('a cat, on a roof');
    return (
      <>
        <PromptSnippets targetId="p" value={value} snippets={snippets} onChange={setValue} onSave={async () => {}} />
        <textarea id="p" value={value} onChange={event => setValue(event.target.value)} />
      </>
    );
  }
  await act(async () => root.render(<Fixture />));
  const textarea = host.querySelector('textarea')!;
  textarea.setSelectionRange(5, 5);
  await act(async () => (host.querySelector('.prompt-snippets > button') as HTMLButtonElement).click());
  await act(async () => (host.querySelector('.snippet-use') as HTMLButtonElement).click());
  expect(textarea.value).toBe('a cat, moonlight, stars, on a roof');
  expect(host.querySelector('.snippets-panel')).toBeNull();
  await act(async () => root.unmount());
  host.remove();
});

describe('copy file', () => {
  it('passes the path through the environment, never the script', async () => {
    const runPowerShell = vi.fn(async () => {});
    await copyFileToClipboard('C:\\out\\a $(evil).png', { platform: 'win32', runPowerShell });
    expect(runPowerShell).toHaveBeenCalledWith(COPY_FILE_SCRIPT, { LATENT_COPY_FILE: 'C:\\out\\a $(evil).png' });
    expect(COPY_FILE_SCRIPT).not.toContain('evil');
  });
  it('fails plainly when PowerShell fails or off Windows', async () => {
    await expect(
      copyFileToClipboard('a.png', { platform: 'win32', runPowerShell: async () => Promise.reject(new Error('x')) }),
    ).rejects.toThrow('Could not copy the file');
    await expect(copyFileToClipboard('a.png', { platform: 'linux', runPowerShell: async () => {} })).rejects.toThrow(
      'only works on Windows',
    );
  });
});

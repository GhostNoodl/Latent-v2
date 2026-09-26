// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TagPrompt } from '../src/renderer/TagPrompt';
vi.mock('../src/renderer/tag-search', () => ({ findTags: vi.fn(async () => [{ name: 'blue_eyes', sources: ['e621'], count: 100 }]) }));
it('inserts with Tab, dismisses with Escape and preserves Ctrl+Enter', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { fn(0); return 0; });
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); const shortcut = vi.fn();
  function Fixture() { const [value, change] = useState('blue'); return <TagPrompt aria-label="Prompt" value={value} onChange={change} onKeyDown={shortcut} />; }
  try {
    await act(async () => root.render(<Fixture />));
    const textarea = host.querySelector('textarea')!;
    await act(async () => { textarea.setSelectionRange(4, 4); textarea.focus(); });
    await act(async () => { await new Promise(r => setTimeout(r, 150)); });
    expect(document.querySelector('[role=option]')?.textContent).toContain('blue_eyes');
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true })); });
    expect(shortcut).toHaveBeenCalledTimes(1);
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    expect(textarea.value).toBe('blue_eyes, ');
    expect(document.querySelector('[role=listbox]')).toBeNull();
    await act(async () => { textarea.setSelectionRange(4, 4); textarea.click(); });
    await act(async () => { await new Promise(r => setTimeout(r, 150)); });
    expect(document.querySelector('[role=listbox]')).not.toBeNull();
    await act(async () => { textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); });
    expect(document.querySelector('[role=listbox]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});

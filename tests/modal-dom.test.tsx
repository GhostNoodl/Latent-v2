// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Modal } from '../src/renderer/ui';
import { ErrorBoundary } from '../src/renderer/ErrorBoundary';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  return { host, root: createRoot(host) };
}
const press = (key: string, shiftKey = false) =>
  act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  });

it('closes only the innermost dialog on Escape', async () => {
  const outerClose = vi.fn();
  function Nested() {
    const [inner, setInner] = useState(true);
    return (
      <Modal title="Outer" onClose={outerClose}>
        <button type="button">Outer action</button>
        {inner && (
          <Modal title="Inner" onClose={() => setInner(false)}>
            <button type="button">Inner action</button>
          </Modal>
        )}
      </Modal>
    );
  }
  const { host, root } = mount();
  await act(async () => root.render(<Nested />));
  expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  await press('Escape');
  expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(outerClose).not.toHaveBeenCalled();
  await press('Escape');
  expect(outerClose).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it('focuses the first field and keeps Tab inside the dialog', async () => {
  const { host, root } = mount();
  await act(async () =>
    root.render(
      <Modal title="Form" onClose={() => {}}>
        <input aria-label="Name" />
        <button type="button">Save</button>
      </Modal>,
    ),
  );
  const input = host.querySelector('input')!;
  expect(document.activeElement).toBe(input);
  // jsdom has no layout, so give the focusable items a client rect.
  for (const item of host.querySelectorAll<HTMLElement>('button, input'))
    item.getClientRects = () => [{}] as unknown as DOMRectList;
  const close = host.querySelector<HTMLElement>('[aria-label="Close dialog"]')!;
  close.focus();
  await press('Tab', true);
  expect(document.activeElement).toBe(host.querySelectorAll('button')[1]);
  await act(async () => root.unmount());
});

it('contains a render failure and recovers when the view changes', async () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  function Broken(): never {
    throw new Error('Bad snapshot');
  }
  const { host, root } = mount();
  await act(async () =>
    root.render(
      <ErrorBoundary label="Models" resetKey="models">
        <Broken />
      </ErrorBoundary>,
    ),
  );
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Models hit a problem');
  expect(host.textContent).toContain('Bad snapshot');
  await act(async () =>
    root.render(
      <ErrorBoundary label="Settings" resetKey="settings">
        <p>Settings page</p>
      </ErrorBoundary>,
    ),
  );
  expect(host.textContent).toBe('Settings page');
  spy.mockRestore();
  await act(async () => root.unmount());
});

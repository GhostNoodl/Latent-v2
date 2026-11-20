// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContextMenu } from '../src/renderer/ContextMenu';
import { ImageMenu } from '../src/renderer/ImageMenu';
import { SizePicker } from '../src/renderer/SizePicker';
import { cfgInputProps } from '../src/renderer/cfg-input';
import { thumbnailUrl } from '../src/renderer/thumbnail-url';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import { imageModelSizes } from '../src/shared/image-models';
import type { GenerationRecord } from '../src/shared/types';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')];
const button = (label: string) => buttons().find(item => item.textContent === label)!;

it('lets CFG take values like 2.75 and nudges by a quarter with the arrow keys', () => {
  const changes: number[] = [];
  act(() =>
    root.render(
      <form>
        <input {...cfgInputProps(2.75, value => changes.push(value))} />
      </form>,
    ),
  );
  const input = host.querySelector('input')!;
  expect(input.getAttribute('step')).toBe('any');
  expect(input.checkValidity()).toBe(true);
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true })));
  expect(changes).toEqual([3, 1.75]);
});

it('picks sizes from the size chip panel and snaps custom sizes to steps of 64', () => {
  const chosen: Array<{ width: number; height: number }> = [];
  act(() =>
    root.render(
      <SizePicker
        width={1024}
        height={1024}
        onChoose={size => chosen.push({ width: size.width, height: size.height })}
        onPreview={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  expect(host.querySelector('button[aria-pressed="true"]')?.textContent).toContain('Square');
  act(() =>
    buttons()
      .find(item => item.textContent?.startsWith('Portrait'))!
      .click(),
  );
  const width = host.querySelector<HTMLInputElement>('input[aria-label="Width"]')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(width, '1000');
    width.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => button('Use').click());
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="Swap width and height"]')!.click());
  expect(chosen).toEqual([
    { width: 832, height: 1216 },
    { width: 1024, height: 1024 },
    { width: 1024, height: 1024 },
  ]);
});

it('shows the best sizes for a newer model, all valid for the draft', () => {
  act(() =>
    root.render(
      <SizePicker
        width={1024}
        height={1024}
        imageModel="krea2-turbo"
        onChoose={() => {}}
        onPreview={() => {}}
        onClose={() => {}}
      />,
    ),
  );
  expect(host.textContent).toContain('Best for');
  for (const size of imageModelSizes('krea2-turbo')) {
    expect(size.width % 64).toBe(0);
    expect(size.height % 64).toBe(0);
  }
});

it('groups menu actions, skips hidden ones and closes before running one', () => {
  const order: string[] = [];
  act(() =>
    root.render(
      <ContextMenu
        x={10}
        y={10}
        label="Test"
        heading={{ title: 'A picture', detail: '1024 × 1024' }}
        onClose={() => order.push('close')}
        groups={[
          [{ label: 'First', onSelect: () => order.push('first') }, false],
          [null],
          [{ label: 'Bin', danger: true, onSelect: () => {} }],
        ]}
      />,
    ),
  );
  expect(host.querySelectorAll('.context-group')).toHaveLength(2);
  expect(document.activeElement?.textContent).toBe('First');
  act(() => button('First').click());
  expect(order).toEqual(['close', 'first']);
});

it('offers edit, video, copy prompt and copy seed on a picture', () => {
  const copyText = vi.fn(async () => undefined);
  (window as unknown as { latent: unknown }).latent = { copyText };
  const record = {
    id: 'a'.repeat(32),
    imageUrl: `latent-asset://output/${'a'.repeat(32)}`,
    draft: { ...structuredClone(DEFAULT_DRAFT), prompt: 'a cat' },
    resolvedPrompt: 'a cat',
    actualSeed: '42',
    width: 1024,
    height: 1024,
    loras: [],
  } as unknown as GenerationRecord;
  const onEdit = vi.fn();
  const run = async (_key: string, task: () => Promise<unknown>) => {
    await task();
    return true;
  };
  act(() =>
    root.render(
      <ImageMenu
        record={record}
        x={0}
        y={0}
        onClose={() => {}}
        actions={{ run, onReuse: () => {}, onEdit, onVideo: () => {}, onTrash: () => {} }}
      />,
    ),
  );
  const labels = buttons().map(item => item.textContent);
  expect(labels).toEqual(
    expect.arrayContaining(['Reuse settings', 'Edit this picture', 'Make a video from it', 'Copy prompt', 'Copy seed']),
  );
  expect(host.querySelector('.context-heading img')?.getAttribute('src')).toBe(
    `latent-asset://thumb/output/${'a'.repeat(32)}`,
  );
  act(() => button('Copy seed').click());
  expect(copyText).toHaveBeenCalledWith('42');
});

it('points previews at the small cached copies', () => {
  expect(thumbnailUrl('https://image.civitai.com/x/y/width=450/1.jpeg')).toMatch(
    /^latent-asset:\/\/thumb\/civitai\/[\w-]+$/,
  );
  expect(thumbnailUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
});

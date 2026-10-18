// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { History } from '../src/renderer/History';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import { DEFAULT_IMAGE_VERSIONS, groupImageVersions, separatelyShownVersions } from '../src/shared/image-versions';
import type { GenerationRecord } from '../src/shared/types';
import { parseSettingsPatch } from '../src/shared/validation';

function record(id: string, minute: number, extra: Partial<GenerationRecord> = {}): GenerationRecord {
  return {
    id,
    jobId: id,
    createdAt: `2026-10-17T10:${String(minute).padStart(2, '0')}:00.000Z`,
    filename: `Latent_${id}_00001_.png`,
    imageUrl: `latent-asset://output/${id}`,
    draft: { ...structuredClone(DEFAULT_DRAFT), prompt: `prompt ${id}` },
    actualSeed: '1',
    resolvedPrompt: `prompt ${id}`,
    width: 512,
    height: 512,
    loras: [],
    workflow: {},
    workflowVersion: 'fixture',
    backendVersion: 'fixture',
    appVersion: 'fixture',
    durationMs: 1,
    ...extra,
  };
}
const hires = { hires: {} } as unknown as GenerationRecord['advancedImage'];
// One generation with hires fix (base + final), then an automatic two-face fix on the final.
const base = record('base', 1, { jobId: 'job1', outputRole: 'base' });
const refined = record('refined', 2, {
  jobId: 'job1',
  outputRole: 'final',
  advancedImage: hires,
  baseRecordId: 'base',
});
const face1 = record('face1', 3, {
  jobId: 'job2',
  outputRole: 'face-pass',
  facePass: { index: 0, faceId: 'a', seed: '1', parentRecordId: 'refined' },
});
// Not linked yet: the job is still finishing, so the sibling pass is its parent.
const face2 = record('face2', 4, {
  jobId: 'job2',
  outputRole: 'final',
  facePass: { index: 1, faceId: 'b', seed: '1' },
});
const other = record('other', 5);
const history = [other, face2, face1, refined, base];

describe('image version grouping', () => {
  it('folds the original, hires fix and face fix into one group led by the newest version', () => {
    const groups = groupImageVersions(history);
    expect(groups.map(group => group.lead.id)).toEqual(['other', 'face2']);
    expect(groups[1].versions.map(version => version.id)).toEqual(['base', 'refined', 'face1', 'face2']);
  });

  it('keeps chosen earlier stages as separate tiles', () => {
    const group = groupImageVersions(history)[1];
    expect(separatelyShownVersions(group, DEFAULT_IMAGE_VERSIONS)).toEqual([]);
    expect(
      separatelyShownVersions(group, { ...DEFAULT_IMAGE_VERSIONS, showOriginal: true, showFaceSteps: true }).map(
        version => version.id,
      ),
    ).toEqual(['base', 'face1']);
  });

  it('accepts the version settings as a settings patch', () => {
    const imageVersions = { group: false, showOriginal: true, showRefined: false, showFaceSteps: false };
    expect(parseSettingsPatch({ imageVersions })).toEqual({ imageVersions });
    expect(() => parseSettingsPatch({ imageVersions: { group: 'yes' } })).toThrow();
  });
});

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia ??= (() => ({ matches: false })) as unknown as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(props: Partial<Parameters<typeof History>[0]>) {
  const onCompare = vi.fn();
  const onSelect = vi.fn();
  act(() =>
    root.render(
      <History
        library
        records={history}
        onSelect={onSelect}
        onReuse={() => undefined}
        onCompare={onCompare}
        run={async () => true}
        {...props}
      />,
    ),
  );
  return { onCompare, onSelect };
}
const tiles = () => Array.from(host.querySelectorAll('.history-preview')).map(tile => tile.getAttribute('title'));

describe('grouped gallery', () => {
  it('shows one card per image with its version count, and every card when grouping is off', () => {
    render({});
    expect(tiles()).toEqual(['prompt other', 'prompt face2']);
    expect(host.querySelector('.history-versions')?.textContent).toBe('4 versions');
    render({ imageVersions: { ...DEFAULT_IMAGE_VERSIONS, group: false } });
    expect(tiles()).toHaveLength(5);
  });

  it('marks the group card as selected when a hidden version is on the canvas', () => {
    render({ selectedId: 'refined' });
    const pressed = host.querySelector('.history-preview[aria-pressed="true"]');
    expect(pressed?.getAttribute('title')).toBe('prompt face2');
  });

  it('offers the other versions and a compare with the original from the card menu', () => {
    const { onCompare, onSelect } = render({});
    const more = host.querySelectorAll<HTMLButtonElement>('.history-more')[1];
    act(() => more.click());
    const items = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const labels = items.map(item => item.textContent);
    expect(labels).toContain('View original version');
    expect(labels).toContain('View hires fix version');
    act(() => items.find(item => item.textContent === 'Compare with original')!.click());
    expect(onCompare).toHaveBeenCalledWith(face2, base);
    act(() => more.click());
    act(() =>
      Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
        .find(item => item.textContent === 'View hires fix version')!
        .click(),
    );
    expect(onSelect).toHaveBeenCalledWith(refined);
  });
});

describe('moving images to the Recycle Bin', () => {
  const trashOutputs = vi.fn(async () => undefined);
  beforeEach(() => {
    trashOutputs.mockClear();
    (window as unknown as { latent: unknown }).latent = { trashOutputs };
  });
  const run = async (_name: string, action: () => Promise<unknown>) => {
    await action();
    return true;
  };
  const menuItem = (label: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(item => item.textContent === label)!;
  const button = (label: string) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(item => item.textContent === label)!;

  it('asks first, then trashes a grouped card together with its hidden versions', async () => {
    render({ run });
    act(() => host.querySelectorAll<HTMLButtonElement>('.history-more')[1].click());
    act(() => menuItem('Move to Recycle Bin').click());
    expect(trashOutputs).not.toHaveBeenCalled();
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('its 3 other versions');
    expect(document.activeElement?.textContent).toBe('Cancel');
    await act(async () => button('Move to Recycle Bin').click());
    const [[ids]] = trashOutputs.mock.calls as unknown as [[string[]]];
    expect(ids[0]).toBe('face2');
    expect([...ids].sort()).toEqual(['base', 'face1', 'face2', 'refined']);
  });

  it('trashes only the chosen image when grouping is off, and Cancel does nothing', async () => {
    render({ run, imageVersions: { ...DEFAULT_IMAGE_VERSIONS, group: false } });
    const tile = host.querySelectorAll<HTMLButtonElement>('.history-preview')[1];
    act(() => tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
    act(() => button('Cancel').click());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    act(() => tile.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })));
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('This removes the image from your library.');
    await act(async () => button('Move to Recycle Bin').click());
    expect(trashOutputs).toHaveBeenCalledWith(['face2']);
  });
});

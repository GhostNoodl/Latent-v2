// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { Characters } from '../src/renderer/Characters';
import { regionalPromptSettingsSchema, type RegionalPromptSettings } from '../src/shared/regional-prompt-types';
import type { ModelAsset } from '../src/shared/types';

const mika = {
  id: 'lora:mika.safetensors',
  name: 'Mika v2',
  filename: 'mika.safetensors',
  kind: 'lora',
  family: 'sdxl',
  bytes: 1,
  triggers: ['mika_chan'],
  status: 'ready',
} as ModelAsset;

it('turns on with two characters, takes a LoRA per character and keeps the settings valid', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'),
    root = createRoot(host);
  document.body.append(host);
  let latest: RegionalPromptSettings | undefined;
  function Fixture() {
    const [value, setValue] = useState<RegionalPromptSettings | undefined>();
    return (
      <Characters
        value={value}
        width={1216}
        height={832}
        loras={[mika]}
        onChange={next => {
          latest = next;
          setValue(next);
        }}
      />
    );
  }
  const click = (label: string) => {
    const button = [...host.querySelectorAll('button')].find(item => item.textContent?.includes(label))!;
    act(() => button.click());
  };
  try {
    await act(async () => root.render(<Fixture />));
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => toggle.click());
    expect(latest?.regions.map(region => region.name)).toEqual(['A', 'B']);
    expect(host.querySelectorAll('.character-card')).toHaveLength(2);

    const select = host.querySelector<HTMLSelectElement>('select[aria-label="Add a LoRA to A"]')!;
    await act(async () => {
      select.value = mika.id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(latest?.regions[0].loras).toEqual([{ modelId: mika.id, weight: 0.8, clipWeight: 0.8 }]);
    click('+ mika_chan');
    expect(latest?.regions[0].positivePrompt).toBe('mika_chan');

    click('Add character');
    expect(latest?.regions).toHaveLength(3);
    click('Top and bottom');
    expect(latest?.layout).toBe('stack');
    expect(latest?.regions[0].loras?.[0].modelId).toBe(mika.id);
    click('Swap A and B');
    expect(latest?.regions[1].loras?.[0].modelId).toBe(mika.id);

    const touch = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].at(-1)!;
    await act(async () => touch.click());
    expect(latest?.touchUp).toEqual({ strength: 0.35 });
    expect(() => regionalPromptSettingsSchema.parse(latest)).not.toThrow();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

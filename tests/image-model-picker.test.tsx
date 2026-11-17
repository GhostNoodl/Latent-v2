// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ModelPicker } from '../src/renderer/ModelPicker';
import { IMAGE_MODELS, imageModelFileKey, imageModelFiles } from '../src/shared/image-models';
import { imageModelProblem } from '../src/renderer/ImageModelCards';
import { DEFAULT_DRAFT } from '../src/shared/defaults';

const snapshot = (engine: string): any => ({
  models: [],
  settings: { civitaiDisplayMetadata: false },
  history: [],
  collections: { schemaVersion: 1, collections: [] },
  backend: { state: 'ready', version: engine, logTail: [] },
  runtimeUpdates: { current: { backendVersion: engine } },
  draft: { ...DEFAULT_DRAFT, imageModel: 'anima-turbo', checkpointId: '' },
  imageModels: {
    state: 'idle',
    message: '',
    ready: ['anima-turbo'],
    readyFiles: imageModelFiles('anima-turbo').map(imageModelFileKey),
  },
});

it('switches to a downloaded newer model and offers downloads for the rest', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.latent = { cancelImageModelSetup: vi.fn() } as any;
  const onChooseImageModel = vi.fn();
  const onDownloadImageModel = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <ModelPicker
          snapshot={snapshot('0.34.0')}
          kind="checkpoint"
          selectedIds={['']}
          imageModel="anima-turbo"
          onChoose={() => {}}
          onClose={() => {}}
          onChooseImageModel={onChooseImageModel}
          onDownloadImageModel={onDownloadImageModel}
        />,
      ),
    );
    const card = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('.image-model-card')].find(b =>
        b.querySelector('strong')?.textContent?.includes(name),
      )!;
    // Opens on the newer models folder because one is in use.
    expect(card('Anima Turbo').getAttribute('aria-pressed')).toBe('true');
    expect(card('Anima Turbo').textContent).toContain('Ready');
    // Aesthetic shares the encoder and VAE, so only its own model file is left to fetch.
    const aesthetic = (IMAGE_MODELS['anima-aesthetic'].files.diffusion.bytes / 1e9).toFixed(1);
    expect(card('Anima Aesthetic').textContent).toContain(`Click to download ${aesthetic} GB`);
    expect(card('FLUX.3 Klein').textContent).toContain('engine update');
    await act(async () => card('Anima Turbo').click());
    expect(onChooseImageModel).toHaveBeenCalledWith('anima-turbo');
    await act(async () => card('MOSS-Image').click());
    expect(onDownloadImageModel).toHaveBeenCalledWith('moss-image');
    // Details show the best settings and can reset to them.
    const detailsLink =
      card('Anima Turbo').parentElement!.querySelector<HTMLButtonElement>('.image-model-details-link')!;
    await act(async () => detailsLink.click());
    const panel = document.querySelector('.image-model-details')!;
    expect(panel.textContent).toContain('8–12 steps · CFG 1');
    expect(panel.textContent).toContain('CircleStone Labs');
    const reset = [...panel.querySelectorAll('button')].find(b => b.textContent?.includes('Reset to best settings'))!;
    await act(async () => reset.click());
    expect(onChooseImageModel).toHaveBeenLastCalledWith('anima-turbo', { recommended: true });
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

it('explains what blocks a newer model in Create', () => {
  const ready = snapshot('0.45.2');
  expect(imageModelProblem(ready, 'anima-turbo')).toBe('');
  expect(imageModelProblem(ready, 'moss-image')).toMatch(/Download MOSS-Image first/);
  expect(
    imageModelProblem(
      { ...ready, draft: { ...ready.draft, loras: [{ modelId: 'x', weight: 1, clipWeight: 1 }] } },
      'anima-turbo',
    ),
  ).toMatch(/LoRAs/);
  expect(
    imageModelProblem({ ...ready, draft: { ...ready.draft, hiresFix: { width: 2048, height: 2048 } } }, 'anima-turbo'),
  ).toMatch(/text to image/);
});

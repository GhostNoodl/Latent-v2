// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/renderer/App';
import { DEFAULT_DRAFT, DEFAULT_SETTINGS } from '../src/shared/defaults';
import type { AppSnapshot, GenerationDraft, GenerationRecord, LatentAPI, ModelAsset } from '../src/shared/types';
import { VIDEO_AVAILABILITY } from '../src/shared/video-plan';
import { createWildcardSnapshot, prepareDynamicPromptDraft } from '../src/shared/dynamic-prompt-recipe';
import type { SourceImageAsset } from '../src/shared/source-types';

// Full React App with real Create/History components and controlled in-memory IPC.
// No browser/Electron window, external service, file write, image decoding or inference.
const checkpoint: ModelAsset = { id: 'checkpoint:fixture.safetensors', name: 'Fixture XL', filename: 'fixture.safetensors', kind: 'checkpoint', family: 'sdxl', status: 'ready', bytes: 100, sha256: 'a'.repeat(64), triggers: [] };
const lora: ModelAsset = { id: 'lora:fixture.safetensors', name: 'Fixture style', filename: 'fixture.safetensors', kind: 'lora', family: 'sdxl', status: 'ready', bytes: 100, sha256: 'b'.repeat(64), triggers: ['fixture_style'] };
const authored = (): GenerationDraft => ({ ...structuredClone(DEFAULT_DRAFT), family: 'sdxl', checkpointId: checkpoint.id, prompt: 'My unfinished idea', negativePrompt: 'Current negative', seed: '77', steps: 16 });
function record(id: string, prompt: string): GenerationRecord {
  const draft = { ...authored(), prompt, negativePrompt: 'Saved negative', seed: 'random', width: 832, height: 1216, steps: 29, cfg: 6, sampler: 'dpmpp_2m', scheduler: 'karras', loras: [{ modelId: lora.id, weight: 0.7, clipWeight: 0.4 }] };
  return { id, jobId: id, createdAt: '2026-09-06T00:00:00.000Z', filename: `Latent_${id}_00001_.png`, imageUrl: `latent-asset://output/${id}`, draft, actualSeed: '123456', resolvedPrompt: `fixture_style, ${prompt}`, width: 832, height: 1216, checkpoint, loras: [{ ...lora, weight: 0.7, clipWeight: 0.4 }], workflow: {}, workflowVersion: 'sdxl-txt2img@1', backendVersion: 'fixture', appVersion: 'fixture', durationMs: 10 };
}
let root: Root, host: HTMLDivElement, snapshot: AppSnapshot, api: Partial<LatentAPI>, savedDraft: GenerationDraft, savedSelection: string | null;
let snapshotReceiver: (value: AppSnapshot) => void, closeHandlers: Set<() => Promise<void>>, closeCancelledHandlers: Set<() => void>, releases: Array<() => void>;
let first: GenerationRecord, second: GenerationRecord;
const normalized = (value: unknown) => JSON.parse(JSON.stringify(value));
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); releases.push(release); return { promise, release }; }
const button = (text: string) => { const result = [...host.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent?.trim() === text); if (!result) throw new Error(`Button missing: ${text}`); return result; };
const preview = (title: string) => host.querySelector<HTMLButtonElement>(`.history-preview[title="${title}"]`)!;
async function click(value: HTMLElement) { await act(async () => { value.click(); }); }
async function prompt(text: string) { await act(async () => { const input = host.querySelector<HTMLTextAreaElement>('#prompt')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function render() { await act(async () => { root.render(<App />); }); }
async function closeAndCancel() { await act(async () => { await Promise.all([...closeHandlers].map(handler => handler())); closeCancelledHandlers.forEach(handler => handler()); }); }
beforeEach(async () => {
  releases = []; closeHandlers = new Set(); closeCancelledHandlers = new Set(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); first = record('1'.repeat(32), 'First saved idea'); second = record('2'.repeat(32), 'Second saved idea'); savedDraft = authored(); savedSelection = first.id;
  snapshot = { draft: structuredClone(savedDraft), history: [first, second], previewSelectedRecordId: savedSelection, models: [checkpoint, lora], jobs: [], settings: structuredClone(DEFAULT_SETTINGS), presets: [], downloads: [],
    backend: { state: 'ready', message: 'Fixture engine', logTail: [] }, backendActivity: { state: 'ready', message: 'Fixture idle', owned: [], foreignRunning: 0, foreignPending: 0, totalRunning: 0, totalPending: 0 },
    sourceImages: { schemaVersion: 1, sources: [], masks: [] }, wildcards: await createWildcardSnapshot({}), collections: { schemaVersion: 1, collections: [] },
    video: VIDEO_AVAILABILITY, upscaler: { state: 'not-installed', message: 'Fixture' }, controlNet: { state: 'not-installed', message: 'Fixture' }, ipAdapter: { state: 'not-installed', message: 'Fixture' },
    segmentation: { state: 'not-installed', message: 'Fixture' }, assistant: { state: 'stopped', message: 'Fixture' }, faceDetailer: { state: 'not-installed', message: 'Fixture' },
    qwenEdit: { state: 'not-installed', message: 'Fixture', baseReady: false, fastReady: false }, hardwareProfiles: { profiles: [], messages: [] }, runtimeUpdates: { state: 'idle', message: 'Fixture' }, modelLocations: { roots: [], folders: [] }, paths: {}, hardware: { os: 'test', arch: 'x64', ramBytes: 1 },
  } as unknown as AppSnapshot;
  api = { getSnapshot: vi.fn(async () => structuredClone(snapshot)), onSnapshot: handler => { snapshotReceiver = handler; return () => {}; },
    onBeforeClose: handler => { closeHandlers.add(handler); return () => { closeHandlers.delete(handler); }; }, onCloseCancelled: handler => { closeCancelledHandlers.add(handler); return () => { closeCancelledHandlers.delete(handler); }; },
    saveDraft: vi.fn(async draft => { savedDraft = structuredClone(draft); }), savePreviewSelection: vi.fn(async id => { savedSelection = id; }),
    queueGeneration: vi.fn(async (draft: GenerationDraft) => ({ id: '3'.repeat(32), draft, actualSeed: draft.seed, status: 'queued' as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), progress: 0, progressMax: 1, outputIds: [] })),
  };
  Object.defineProperty(window, 'latent', { configurable: true, value: api }); await render();
});
afterEach(async () => { await act(async () => { releases.forEach(release => release()); }); await act(async () => { root.unmount(); }); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('generation completion selection', () => {
  it('selects and remembers a newly completed image without changing its recipe', async () => {
    const completed = record('c'.repeat(32), 'New completed image');
    await act(async () => { snapshotReceiver({...snapshot,history:[completed,...snapshot.history]}); });
    expect(preview(completed.draft.prompt).getAttribute('aria-pressed')).toBe('true');
    await closeAndCancel();
    expect(savedSelection).toBe(completed.id);
    expect(savedDraft.prompt).toBe(authored().prompt);
  });
  it('does not open the queue when Generate is pressed', async () => {
    await click(button('Generate image')); 
    expect(host.querySelector('.queue-panel')).toBeNull();
    expect(api.queueGeneration).toHaveBeenCalledTimes(1);
  });
});

describe('advanced Create controls and queue contract', () => {
  const source = (width = 1024, height = 512): SourceImageAsset => ({ id: 'src_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Advanced fixture', normalized: { width, height, sha256: 'c'.repeat(64) } } as SourceImageAsset);
  async function boot(draft: GenerationDraft, reference = source()) {
    await act(async () => { root.unmount(); }); root = createRoot(host);
    snapshot = { ...snapshot, draft, sourceImages: { ...snapshot.sourceImages, sources: [reference] }, upscaler: { state: 'ready', message: 'Fixture ready' }, controlNet: { state: 'ready', message: 'Fixture ready' } };
    await render();
  }
  async function field(label: string, value: string) {
    const node = [...host.querySelectorAll('label.field')].find(item => item.querySelector('span')?.textContent === label)?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
    expect(node).toBeTruthy(); await act(async () => {
      const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value); node!.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
  }
  const resizeDraft = (reference: SourceImageAsset, mode: 'resize' | 'learned'): GenerationDraft => ({ ...authored(), checkpointId: '', imageInput: { mode: 'img2img', sourceId: reference.id, sourceSha256: reference.normalized.sha256, denoise: 0.4, resize: 'stretch' }, upscale: { mode, width: 2048, height: 1024, resize: 'stretch' } });
  it('submits edited source-only resize values without a diffusion checkpoint', async () => {
    const reference = source(); await boot(resizeDraft(reference, 'resize'), reference);
    await field('Output width', '768'); await field('Output height', '512'); await field('Fit source', 'center-crop');
    expect(api.queueGeneration).not.toHaveBeenCalled(); await click(button('Resize image'));
    expect(api.queueGeneration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ checkpointId: '', imageInput: expect.objectContaining({ sourceId: reference.id, sourceSha256: reference.normalized.sha256 }), upscale: { mode: 'resize', width: 768, height: 512, resize: 'center-crop' } }));
  });
  it.each([[1536, 1024], [2304, 256]])('rejects learned enhancement source %i by %i before queueing and permits simple resize recovery', async (width, height) => {
    const reference = source(width, height); await boot(resizeDraft(reference, 'learned'), reference);
    expect(button('Enhance image').disabled).toBe(true); expect(host.textContent).toMatch(/1 megapixel|2048/);
    await act(async () => { host.querySelector('#prompt')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); });
    expect(api.queueGeneration).not.toHaveBeenCalled(); await field('Enlargement method', 'resize'); await click(button('Resize image')); expect(api.queueGeneration).toHaveBeenCalledOnce();
  });
  it.each([[1024, 1024], [2048, 512]])('permits learned enhancement at the %i by %i source boundary', async (width, height) => {
    const reference = source(width, height); await boot(resizeDraft(reference, 'learned'), reference);
    expect(button('Enhance image').disabled).toBe(false); await click(button('Enhance image'));
    expect(api.queueGeneration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ upscale: { mode: 'learned', width: 2048, height: 1024, resize: 'stretch' }, imageInput: expect.objectContaining({ sourceId: reference.id }) }));
  });
  it('preserves a legacy hires graph until an explicit setting edit and queues the revised recipe', async () => {
    await boot({ ...authored(), hiresFix: { method: 'latent', workflowVersion: 'sdxl-hires-latent@1', width: 1536, height: 1536, steps: 20, cfg: 6, sampler: 'euler', scheduler: 'normal', denoise: 0.35, seed: '123' } });
    expect(host.textContent).toContain('original latent refinement graph'); await field('Refinement method', 'image'); await field('Refinement steps', '24');
    expect(host.textContent).not.toContain('original latent refinement graph'); await click(button('Generate and refine'));
    expect(api.queueGeneration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ hiresFix: expect.objectContaining({ method: 'image', workflowVersion: undefined, steps: 24, width: 1536, height: 1536, seed: '123' }), seed: '77' }));
  });
  it('blocks invalid Canny thresholds and resumes after an explicit correction with exact settings', async () => {
    const reference = source(); const controlNet = { kind: 'canny' as const, sourceId: reference.id, sourceSha256: reference.normalized.sha256, resize: 'stretch' as const, strength: 0, startPercent: 0.1, endPercent: 0.9, lowThreshold: 0.4, highThreshold: 0.2 };
    await boot({ ...authored(), controlNet }, reference); expect(button('Generate image').disabled).toBe(true); expect(host.textContent).toContain('Canny low threshold must be below high threshold');
    await field('High edge threshold', '0.6'); expect(api.queueGeneration).not.toHaveBeenCalled(); await click(button('Generate image'));
    expect(api.queueGeneration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ controlNet: { ...controlNet, highThreshold: 0.6 } }));
  });
});

describe('Create history, draft and asynchronous acceptance', () => {
  it('cancels an unsubmitted autosave timer when the App unmounts', async () => {
    vi.useFakeTimers();
    try {
      await prompt('Abandoned renderer edit');
      await act(async () => { root.unmount(); }); root = createRoot(host);
      await act(async () => { await vi.advanceTimersByTimeAsync(350); });
      expect(api.saveDraft).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each(['ctrlKey', 'metaKey'] as const)('waits for text composition before accepting the %s generation shortcut', async modifier => {
    const input = host.querySelector('#prompt')!;
    const composing = new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, isComposing: true, bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(composing); });
    expect(api.queueGeneration).not.toHaveBeenCalled(); expect(composing.defaultPrevented).toBe(false);
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, cancelable: true })); });
    expect(api.queueGeneration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: authored().prompt }));
  });
  it('names composer fields and keeps generation as its only submit button', async () => {
    const composer = host.querySelector<HTMLFormElement>('form.composer')!;
    const fields = [...composer.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')];
    expect(fields.length).toBeGreaterThan(10);
    const unnamed = fields.filter(field => !field.getAttribute('aria-label')?.trim() && !field.getAttribute('aria-labelledby')?.split(/\s+/).some(id => document.getElementById(id)?.textContent?.trim()) && ![...(field.labels ?? [])].some(label => label.textContent?.trim()));
    expect(unnamed.map(field => field.outerHTML)).toEqual([]);
    const submissions = [...composer.querySelectorAll<HTMLButtonElement>('button')].filter(item => item.type === 'submit'); expect(submissions).toEqual([button('Generate image')]);
    expect(host.querySelector('#negative-area')?.hasAttribute('hidden')).toBe(false); await click(host.querySelector<HTMLButtonElement>('.size-presets button')!); await click(host.querySelector<HTMLButtonElement>('[aria-label="Use random seed"]')!);
    expect(api.queueGeneration).not.toHaveBeenCalled();
  });
  it('submits the values edited through labeled ordinary controls', async () => {
    function field(label: string) { const wrapper = [...host.querySelectorAll<HTMLLabelElement>('label.field')].find(item => item.querySelector('span')?.textContent === label); const control = wrapper?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select'); if (!control) throw new Error(`Missing field ${label}`); return control; }
    for (const [label, value] of [['Width', '768'], ['Height', '1024'], ['Steps', '30'], ['Guidance (CFG)', '6.5'], ['Seed', '123'], ['Sampler', 'euler'], ['Scheduler', 'normal'], ['Images per batch', '2']]) {
      await act(async () => { const control = field(label); if (control instanceof HTMLSelectElement) { control.value = value; control.dispatchEvent(new Event('change', { bubbles: true })); } else { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(control, value); control.dispatchEvent(new Event('input', { bubbles: true })); } });
    }
    await click(button('Generate image')); expect(api.queueGeneration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ width: 768, height: 1024, steps: 30, cfg: 6.5, seed: '123', sampler: 'euler', scheduler: 'normal', batchSize: 2 }));
  });
  it('limits the generation shortcut to Create and keeps dialog keystrokes out of its composer', async () => {
    await click(button('Presets0')); const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => { dialog.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); }); expect(api.queueGeneration).not.toHaveBeenCalled();
    await click(dialog.querySelector<HTMLButtonElement>('[aria-label="Close dialog"]')!); await click(button('Library'));
    await act(async () => { host.querySelector('.studio')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); }); expect(api.queueGeneration).not.toHaveBeenCalled();
    await click(button('Create')); await act(async () => { host.querySelector('#prompt')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })); }); expect(api.queueGeneration).toHaveBeenCalledOnce();
  });
  it('previews without editing the composer and explicitly restores all ordinary values with full Undo', async () => {
    const original = normalized(savedDraft), records = structuredClone(snapshot.history); await click(preview(second.draft.prompt)); expect(host.querySelector<HTMLTextAreaElement>('#prompt')!.value).toBe(authored().prompt); expect(api.saveDraft).not.toHaveBeenCalled(); expect(savedSelection).toBe(second.id);
    await click(button('Reuse parameters')); await closeAndCancel();
    expect(normalized(savedDraft)).toEqual(normalized({ ...second.draft, seed: second.actualSeed, triggerWords: { [lora.id]: lora.triggers }, assetHashes: { [checkpoint.id]: checkpoint.sha256, [lora.id]: lora.sha256 } })); expect(api.queueGeneration).not.toHaveBeenCalled();
    await click(button('Undo restore')); await closeAndCancel(); expect(normalized(savedDraft)).toEqual(original); expect(savedSelection).toBe(second.id); expect(snapshot.history).toEqual(records);
  });
  it('submits the recipe captured at Generate while preserving later prompt edits', async () => {
    const wait = gate(); const original = api.saveDraft!; api.saveDraft = vi.fn(async draft => { await wait.promise; await original(draft); });
    await click(button('Generate image')); await prompt('My next separate idea'); await act(async () => { wait.release(); });
    expect(api.queueGeneration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: authored().prompt })); expect(host.querySelector<HTMLTextAreaElement>('#prompt')!.value).toBe('My next separate idea');
    await closeAndCancel(); expect(savedDraft.prompt).toBe('My next separate idea');
  });
  it('drains edits made during application close saving instead of acknowledging an older draft', async () => {
    await prompt('First edit'); const wait = gate(); const original = api.saveDraft!; api.saveDraft = vi.fn(async draft => { await wait.promise; await original(draft); });
    let closing!: Promise<void[]>; await act(async () => { closing = Promise.all([...closeHandlers].map(handler => handler())); }); await prompt('Latest edit while saving'); await act(async () => { wait.release(); await closing; });
    expect(savedDraft.prompt).toBe('Latest edit while saving');
  });
  it('keeps a deliberately selected history image when delayed queue acceptance completes', async () => {
    const wait = gate(); const original = api.queueGeneration!; api.queueGeneration = vi.fn(async draft => { await wait.promise; return original(draft); });
    await click(button('Generate image')); expect(api.queueGeneration).toHaveBeenCalledOnce(); await click(preview(second.draft.prompt));
    const job = await original(authored()); snapshot = { ...snapshot, jobs: [{ ...job, status: 'running', queueState: 'running', previewUrl: 'data:image/png;base64,fixture' }] };
    await act(async () => { snapshotReceiver(snapshot); wait.release(); });
    expect(button('View live preview')).toBeDefined(); expect(savedSelection).toBe(second.id); expect(preview(second.draft.prompt).getAttribute('aria-pressed')).toBe('true');
  });
  it('drains composer edits and a newer selection made while close is waiting on preview persistence', async () => {
    const firstSave = gate(), secondSave = gate(); const original = api.savePreviewSelection!;
    api.savePreviewSelection = vi.fn(async id => { await (id === second.id ? firstSave.promise : secondSave.promise); await original(id); });
    await click(preview(second.draft.prompt)); let acknowledged = false, closing!: Promise<void[]>;
    await act(async () => { closing = Promise.all([...closeHandlers].map(handler => handler())).then(result => { acknowledged = true; return result; }); });
    await prompt('Edit during preview saving'); await click(preview(first.draft.prompt)); await act(async () => { firstSave.release(); });
    expect(acknowledged).toBe(false); await act(async () => { secondSave.release(); await closing; });
    expect(savedSelection).toBe(first.id); expect(savedDraft.prompt).toBe('Edit during preview saving');
  });
  it('stops a preparing Generate across close and close-cancellation, then permits an explicit retry', async () => {
    const wait = gate(); const original = api.saveDraft!; api.saveDraft = vi.fn(async draft => { await wait.promise; await original(draft); });
    await click(button('Generate image')); let closing!: Promise<void[]>;
    await act(async () => { closing = Promise.all([...closeHandlers].map(handler => handler())); closeCancelledHandlers.forEach(handler => handler()); wait.release(); await closing; });
    expect(api.queueGeneration).not.toHaveBeenCalled(); expect(host.textContent).toContain('Generation was not submitted');
    await prompt('After cancelling the pending close'); await click(button('Generate image')); expect(api.queueGeneration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: 'After cancelling the pending close' }));
  });
  it('waits for already submitted queue acceptance before acknowledging close', async () => {
    const wait = gate(); const original = api.queueGeneration!; api.queueGeneration = vi.fn(async draft => { await wait.promise; return original(draft); });
    await click(button('Generate image')); expect(api.queueGeneration).toHaveBeenCalledOnce(); let acknowledged = false, closing!: Promise<void[]>;
    await act(async () => { closing = Promise.all([...closeHandlers].map(handler => handler())).then(result => { acknowledged = true; return result; }); });
    expect(acknowledged).toBe(false); await act(async () => { wait.release(); await closing; }); expect(acknowledged).toBe(true); expect(api.queueGeneration).toHaveBeenCalledOnce();
  });
  it('retains unsaved text on disk failure and recovers editing and generation after close fails', async () => {
    await prompt('Keep this after disk failure'); const original = api.saveDraft!; api.saveDraft = vi.fn(async () => { throw new Error('fixture disk unavailable'); });
    await act(async () => { await expect(Promise.all([...closeHandlers].map(handler => handler()))).rejects.toThrow('fixture disk unavailable'); });
    expect(savedDraft.prompt).toBe(authored().prompt); expect(host.querySelector<HTMLTextAreaElement>('#prompt')!.value).toBe('Keep this after disk failure');
    api.saveDraft = original; await prompt('Recovered idea'); await click(button('Generate image')); expect(api.queueGeneration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: 'Recovered idea' })); expect(savedDraft.prompt).toBe('Recovered idea');
  });
  it('ignores draft and selection mutations after close acknowledgement and permits them after cancellation', async () => {
    await act(async () => { await Promise.all([...closeHandlers].map(handler => handler())); });
    await prompt('Late edit'); await click(preview(second.draft.prompt)); await click(button('Generate image'));
    expect(host.querySelector<HTMLTextAreaElement>('#prompt')!.value).toBe(authored().prompt); expect(savedSelection).toBe(first.id); expect(api.queueGeneration).not.toHaveBeenCalled();
    await act(async () => { closeCancelledHandlers.forEach(handler => handler()); }); await prompt('Edit after cancelling close'); await click(preview(second.draft.prompt)); await closeAndCancel();
    expect(savedDraft.prompt).toBe('Edit after cancelling close'); expect(savedSelection).toBe(second.id);
  });
  it('preserves Undo when restore and Undo are clicked after close acknowledgement', async () => {
    await click(button('Reuse parameters')); await act(async () => { await Promise.all([...closeHandlers].map(handler => handler())); });
    await click(button('Undo restore')); await click(button('Reuse parameters'));
    expect(button('Undo restore')).toBeDefined(); expect(host.querySelector<HTMLTextAreaElement>('#prompt')!.value).toBe(first.draft.prompt);
    await act(async () => { closeCancelledHandlers.forEach(handler => handler()); }); await click(button('Undo restore')); await closeAndCancel();
    expect(normalized(savedDraft)).toEqual(normalized(authored()));
  });
  it('ignores a source import that finishes after close acknowledgement without mutating the saved draft', async () => {
    const wait = gate(); const source = { id: 'src_00000000-0000-0000-0000-000000000001', name: 'Deferred source', normalized: { sha256: 'c'.repeat(64), width: 256, height: 256 } } as SourceImageAsset;
    api.importSourceImage = vi.fn(async () => { await wait.promise; return source; });
    await click(button('Import image')); await act(async () => { await Promise.all([...closeHandlers].map(handler => handler())); });
    await act(async () => { wait.release(); }); await act(async () => { closeCancelledHandlers.forEach(handler => handler()); }); await closeAndCancel();
    expect(normalized(savedDraft)).toEqual(normalized(authored())); expect(host.querySelector('[aria-label="Return to text to image"]')).toBeNull();
  });
  it('reopens the saved composer and explicit preview independently after reuse and a later edit', async () => {
    await click(preview(second.draft.prompt)); await click(button('Reuse parameters')); await prompt('Continue this recipe later'); await click(preview(first.draft.prompt)); await closeAndCancel();
    const before = normalized(savedDraft); snapshot = { ...snapshot, draft: structuredClone(savedDraft), previewSelectedRecordId: savedSelection };
    await act(async () => { root.unmount(); }); root = createRoot(host); await render(); await closeAndCancel();
    expect(normalized(savedDraft)).toEqual(before); expect(savedDraft.seed).toBe(second.actualSeed); expect(host.querySelector<HTMLTextAreaElement>('#prompt')!.value).toBe('Continue this recipe later');
    expect(preview(first.draft.prompt).getAttribute('aria-pressed')).toBe('true'); expect(api.queueGeneration).not.toHaveBeenCalled();
  });
  it('clears optional source settings on ordinary reuse and restores the complete missing-source recipe with Undo', async () => {
    await act(async () => { root.unmount(); }); root = createRoot(host);
    const previous = { ...authored(), dynamicPrompts: { enabled: true }, variationOfRecordId: second.id, imageInput: { mode: 'inpaint' as const, sourceId: 'src_00000000-0000-0000-0000-000000000001', sourceSha256: 'c'.repeat(64), maskId: 'mask_00000000-0000-0000-0000-000000000002', maskSha256: 'd'.repeat(64), denoise: 0.35, resize: 'stretch' as const } };
    snapshot = { ...snapshot, draft: previous }; await render(); await click(button('Reuse parameters')); await closeAndCancel();
    expect(savedDraft.imageInput).toBeUndefined(); expect(savedDraft.dynamicPrompts).toBeUndefined(); expect(savedDraft.variationOfRecordId).toBeUndefined();
    await click(button('Undo restore')); await closeAndCancel(); expect(normalized(savedDraft)).toEqual(normalized(previous));
    expect(button('Generate image').disabled).toBe(true); expect(api.queueGeneration).not.toHaveBeenCalled();
  });
  it('blocks missing restored models from button and keyboard submission without substituting another model', async () => {
    snapshot = { ...snapshot, models: [lora] }; await act(async () => { snapshotReceiver(snapshot); }); await click(button('Reuse parameters'));
    expect(button('Generate image').disabled).toBe(true); await act(async () => { host.querySelector('.studio')!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', ctrlKey: true })); });
    expect(api.queueGeneration).not.toHaveBeenCalled(); expect(host.textContent).toContain('Restore the missing model files'); await closeAndCancel(); expect(savedDraft.checkpointId).toBe(checkpoint.id);
  });
  it('preserves the draft and earlier Undo when conflicting hires metadata prevents reuse or variation', async () => {
    await click(preview(second.draft.prompt)); await click(button('Reuse parameters')); await closeAndCancel();
    const before = normalized(savedDraft);
    first.draft.hiresFix = { method: 'latent', workflowVersion: 'sdxl-hires-latent@2', width: 1536, height: 1536, steps: 16, cfg: 5, sampler: 'euler', scheduler: 'normal', denoise: 0.35, seed: '42' };
    first.advancedImage = { workflowVersion: 'sdxl-hires-image@1' } as NonNullable<GenerationRecord['advancedImage']>;
    await act(async () => { snapshotReceiver({ ...snapshot }); });
    await click(preview(first.draft.prompt)); await click(button('Reuse parameters'));
    expect(host.textContent).toContain('Could not restore these parameters');
    await closeAndCancel(); expect(normalized(savedDraft)).toEqual(before);
    await act(async () => { preview(first.draft.prompt).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })); });
    await click(button('Make a variation')); await closeAndCancel();
    expect(normalized(savedDraft)).toEqual(before); expect(api.queueGeneration).not.toHaveBeenCalled();
    await click(button('Undo restore')); await closeAndCancel(); expect(normalized(savedDraft)).toEqual(normalized(authored()));
  });

  it.each(['sdxl-hires-latent@1', 'sdxl-hires-latent@2'] as const)('uses the recorded %s version when the optional advanced plan is absent', async version => {
    first.workflowVersion = version;
    first.draft.hiresFix = { method: 'latent', width: 1536, height: 1536, steps: 16, cfg: 5, sampler: 'euler', scheduler: 'normal', denoise: 0.35, seed: '42' };
    await act(async () => { snapshotReceiver({ ...snapshot }); }); await click(button('Reuse parameters')); await closeAndCancel();
    expect(savedDraft.hiresFix?.workflowVersion).toBe(version);
    expect(savedDraft.hiresFix?.seed).toBe('42'); expect(api.queueGeneration).not.toHaveBeenCalled();
  });
  it('refuses a hires recipe without a recognized recorded workflow version', async () => {
    first.draft.hiresFix = { method: 'latent', width: 1536, height: 1536, steps: 16, cfg: 5, sampler: 'euler', scheduler: 'normal', denoise: 0.35, seed: '42' };
    await act(async () => { snapshotReceiver({ ...snapshot }); }); await click(button('Reuse parameters')); await closeAndCancel();
    expect(host.textContent).toContain('Could not restore these parameters'); expect(normalized(savedDraft)).toEqual(normalized(authored())); expect(api.queueGeneration).not.toHaveBeenCalled();
  });

  it('refuses exact reuse when dynamic choices are absent instead of resolving against current wildcards', async () => {
    first.draft.dynamicPrompts = { enabled: true }; first.draft.prompt = '{red|blue} teapot';
    await act(async () => { snapshotReceiver({ ...snapshot }); }); await click(button('Reuse parameters')); await closeAndCancel();
    expect(host.textContent).toContain('The saved wildcard choices are missing'); expect(normalized(savedDraft)).toEqual(normalized(authored())); expect(api.queueGeneration).not.toHaveBeenCalled();
  });
  it('restores retained embedded dynamic choices when the separate recipe field is absent', async () => {
    first.draft = { ...first.draft, prompt: '{red|blue} teapot', dynamicPrompts: { enabled: true } };
    const prepared = await prepareDynamicPromptDraft(first.draft, '123');
    first.draft.dynamicPrompts = { enabled: true, frozen: prepared.recipe };
    await act(async () => { snapshotReceiver({ ...snapshot }); }); await click(button('Reuse parameters')); await closeAndCancel();
    expect(savedDraft.dynamicPrompts?.frozen).toEqual(prepared.recipe); expect(savedDraft.prompt).toBe('{red|blue} teapot'); expect(api.queueGeneration).not.toHaveBeenCalled();
  });

  it('keeps the earlier Undo when a saved LoRA lacks trigger metadata', async () => {
    await click(preview(second.draft.prompt)); await click(button('Reuse parameters')); await closeAndCancel(); const before = normalized(savedDraft);
    Reflect.deleteProperty(first.loras[0], 'triggers');
    await act(async () => { snapshotReceiver({ ...snapshot }); }); await click(preview(first.draft.prompt)); await click(button('Reuse parameters')); await closeAndCancel();
    expect(host.textContent).toContain('The saved LoRA trigger metadata is incomplete'); const details = host.querySelector<HTMLElement>('[aria-label="Error details"]')!; expect(details.tabIndex).toBe(0); details.focus(); expect(document.activeElement).toBe(details); expect(normalized(savedDraft)).toEqual(before);
    await click(button('Undo restore')); await closeAndCancel(); expect(normalized(savedDraft)).toEqual(normalized(authored())); expect(api.queueGeneration).not.toHaveBeenCalled();
  });

});

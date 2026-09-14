import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPaths, containedPath, inside } from '../src/main/paths';
import { StudioStore } from '../src/main/store';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
const dirs: string[] = []; const stores: StudioStore[] = [];
function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latent-store-test-')); dirs.push(root); return root; }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('private storage', () => {
  it('distinguishes a fresh composer from unversioned saved drafts and preserves recipes across reopening', () => {
    const file = path.join(fixture(), 'studio.sqlite'); let store = new StudioStore(file);
    expect(store.draft().triggerResolutionVersion).toBe('punctuation@2');
    const saved = { ...DEFAULT_DRAFT, prompt: '(c0pi1ot)' }; delete saved.triggerResolutionVersion;
    store.setState('draft', saved); store.savePreset({ id: 'old', name: 'Old recipe', draft: saved });
    const untouched = JSON.stringify(store.getState('draft', null));
    expect(store.draft().triggerResolutionVersion).toBe('legacy@1');
    expect(JSON.stringify(store.getState('draft', null))).toBe(untouched);
    store.close(); store = new StudioStore(file); stores.push(store);
    expect(store.draft()).toMatchObject({ prompt: '(c0pi1ot)', triggerResolutionVersion: 'legacy@1' });
    expect(store.presets()[0].draft).not.toHaveProperty('triggerResolutionVersion');
    store.saveDraft({ ...store.draft(), prompt: '(c0pi1ot), edited', triggerResolutionVersion: 'punctuation@2' });
    stores.pop(); store.close(); store = new StudioStore(file); stores.push(store);
    expect(store.draft().triggerResolutionVersion).toBe('punctuation@2');
    expect(store.presets()[0].draft).toEqual(saved);
  });
  it('refuses an existing unrelated directory without changing its contents', () => {
    const root = fixture(); fs.writeFileSync(path.join(root, 'existing.txt'), 'preserve me');
    expect(() => createPaths(root)).toThrow('already contains'); expect(fs.readdirSync(root)).toEqual(['existing.txt']);
  });
  it('keeps all managed directories below the declared root and rejects traversal', () => {
    const root = fixture(); const paths = createPaths(root);
    expect(Object.values(paths).every(value => inside(root, value))).toBe(true);
    expect(() => containedPath(paths.outputs, '..', 'private.txt')).toThrow('outside');
    expect(() => containedPath(root, `${root}-sibling`, 'x')).toThrow('outside');
    expect(createPaths(root)).toEqual(paths);
  });
  it('persists selected controls and positive prompt across an actual database reopen', () => {
    const root = fixture(); const file = path.join(root, 'studio.sqlite'); let store = new StudioStore(file);
    store.saveDraft({ ...DEFAULT_DRAFT, prompt: 'positive', negativePrompt: 'negative', cfg: 7, width: 832, height: 1216, seed: '1234' });
    store.close(); store = new StudioStore(file); stores.push(store);
    expect(store.draft()).toMatchObject({ prompt: 'positive', negativePrompt: '', cfg: 7, width: 832, height: 1216, seed: '1234' });
  });
  it('applies each prompt remembrance setting independently and retains preset recipes', () => {
    const store = new StudioStore(path.join(fixture(), 'studio.sqlite')); stores.push(store);
    store.saveSettings({ rememberNegativePrompt: true, rememberPositivePrompt: false });
    const draft = { ...DEFAULT_DRAFT, prompt: 'positive', negativePrompt: 'negative', seed: '99' };
    store.saveDraft(draft); store.savePreset({ id: 'one', name: 'Full recipe', draft });
    expect(store.draft()).toMatchObject({ prompt: '', negativePrompt: 'negative' });
    expect(store.presets()[0].draft).toMatchObject({ prompt: 'positive', negativePrompt: 'negative', seed: '99' });
    store.saveSettings({ rememberNegativePrompt: false }); expect(store.draft().negativePrompt).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import type { ModelAsset } from '../src/shared/types';
import { movedCopy, relinkDraft } from '../src/renderer/MissingParts';

describe('relinking moved models', () => {
  const draft = {
    ...structuredClone(DEFAULT_DRAFT),
    checkpointId: 'checkpoint:old/a.safetensors',
    loras: [{ modelId: 'lora:old/ink.safetensors', weight: 0.6, clipWeight: 0.5 }],
    assetHashes: { 'checkpoint:old/a.safetensors': 'a'.repeat(64), 'lora:old/ink.safetensors': 'b'.repeat(64) },
    triggerWords: { 'lora:old/ink.safetensors': ['ink'] },
  };
  it('moves the checkpoint id and its saved checksum', () => {
    const change = relinkDraft(draft, 'checkpoint:old/a.safetensors', 'checkpoint:a.safetensors');
    expect(change.checkpointId).toBe('checkpoint:a.safetensors');
    expect(change.assetHashes).toEqual({
      'checkpoint:a.safetensors': 'a'.repeat(64),
      'lora:old/ink.safetensors': 'b'.repeat(64),
    });
  });
  it('keeps LoRA weights and trigger choices', () => {
    const change = relinkDraft(draft, 'lora:old/ink.safetensors', 'lora:ink.safetensors');
    expect(change.checkpointId).toBeUndefined();
    expect(change.loras).toEqual([{ modelId: 'lora:ink.safetensors', weight: 0.6, clipWeight: 0.5 }]);
    expect(change.triggerWords).toEqual({ 'lora:ink.safetensors': ['ink'] });
  });
  it('only matches ready files of the same kind and checksum', () => {
    const models = [
      { id: 'lora:x', kind: 'lora', status: 'ready', sha256: 'a'.repeat(64) },
      { id: 'checkpoint:y', kind: 'checkpoint', status: 'missing', sha256: 'a'.repeat(64) },
      { id: 'checkpoint:z', kind: 'checkpoint', status: 'ready', sha256: 'a'.repeat(64) },
    ] as ModelAsset[];
    expect(movedCopy(models, 'a'.repeat(64), 'checkpoint')?.id).toBe('checkpoint:z');
    expect(movedCopy(models, undefined, 'checkpoint')).toBeUndefined();
  });
});

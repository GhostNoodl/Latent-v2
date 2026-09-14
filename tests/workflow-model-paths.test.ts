import { describe, expect, it } from 'vitest';
import { bindModelPaths, canonicalModelPaths } from '../src/shared/workflow-model-paths';
import type { ComfyWorkflow } from '../src/shared/types';

const graph: ComfyWorkflow = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'Portraits/base.safetensors' } },
  '2': { class_type: 'LoraLoader', inputs: { lora_name: 'Styles/art.safetensors', model: ['1', 0] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'literal/backslash\\prompt', clip: ['1', 1] } },
};
describe('backend model filename binding', () => {
  it('uses exact advertised Windows filenames and preserves canonical recipes for repeated preflight', () => {
    const objects = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['Portraits\\base.safetensors']] } } }, LoraLoader: { input: { required: { lora_name: ['COMBO', { options: ['Styles\\art.safetensors'] }] } } } };
    const bound = bindModelPaths(graph, objects);
    expect(bound['1'].inputs.ckpt_name).toBe('Portraits\\base.safetensors');
    expect(bound['2'].inputs.lora_name).toBe('Styles\\art.safetensors');
    expect(bound['3']).toEqual(graph['3']);
    expect(canonicalModelPaths(bound)).toEqual(graph);
    expect(bindModelPaths(bound, objects)).toEqual(bound);
    expect(graph['2'].inputs.lora_name).toBe('Styles/art.safetensors');
  });
  it('rejects absent, ambiguous and case-different filenames instead of substituting another asset', () => {
    for (const options of [[], ['Styles/other.safetensors'], ['styles/art.safetensors'], ['Styles/art.safetensors', 'Styles\\art.safetensors']]) {
      expect(() => bindModelPaths(graph, { LoraLoader: { input: { required: { lora_name: [options] } } } })).toThrow('unambiguous');
    }
  });
  it('keeps exact POSIX choices and never normalizes arbitrary enum values', () => {
    expect(bindModelPaths(graph, { LoraLoader: { input: { required: { lora_name: [['Styles/art.safetensors']] } } } })).toEqual(graph);
  });
});

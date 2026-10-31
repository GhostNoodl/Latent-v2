import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import type { GenerationRecord } from '../src/shared/types';
import { lineage, madeFromThis } from '../src/renderer/lineage';
import { libraryFacets, matchesFilters } from '../src/renderer/library-filters';
import { applyMark } from '../src/renderer/ReviewMode';

const record = (id: string, change: Partial<GenerationRecord> = {}, draft: Partial<GenerationRecord['draft']> = {}) =>
  ({
    id,
    jobId: id,
    draft: { ...structuredClone(DEFAULT_DRAFT), ...draft },
    loras: [],
    ...change,
  }) as GenerationRecord;

describe('made-from trail', () => {
  it('walks back through variations and enhancements, oldest first', () => {
    const a = record('a');
    const b = record('b', {}, { variationOfRecordId: 'a' });
    const c = record('c', {}, { enhance: { parentRecordId: 'b' } });
    const trail = lineage(c, [c, b, a]);
    expect(trail.map(step => step.record.id)).toEqual(['a', 'b', 'c']);
    expect(trail.map(step => step.how)).toEqual(['Variation', 'Enhanced', '']);
    expect(madeFromThis(a, [c, b, a]).map(item => item.id)).toEqual(['b']);
  });
  it('stops at loops and missing parents', () => {
    const a = record('a', {}, { variationOfRecordId: 'b' });
    const b = record('b', {}, { variationOfRecordId: 'a' });
    expect(lineage(a, [a, b]).map(step => step.record.id)).toEqual(['b', 'a']);
    expect(lineage(record('x', {}, { variationOfRecordId: 'gone' }), [])).toHaveLength(1);
  });
});

describe('library filters', () => {
  const model = (filename: string) => ({ filename, name: filename.replace('.safetensors', '') }) as never;
  const lora = (filename: string) => ({ filename, name: filename, weight: 1, clipWeight: 1 }) as never;
  const one = record('1', { checkpoint: model('a.safetensors'), loras: [lora('ink'), lora('ink')] });
  const two = record('2', { checkpoint: model('a.safetensors') });
  const three = record('3', { checkpoint: model('b.safetensors'), loras: [lora('film')] });
  it('counts models and LoRAs once per image, most used first', () => {
    const facets = libraryFacets([one, two, three]);
    expect(facets.models.map(item => [item.key, item.count])).toEqual([
      ['a.safetensors', 2],
      ['b.safetensors', 1],
    ]);
    expect(facets.loras.map(item => [item.key, item.count])).toEqual([
      ['film', 1],
      ['ink', 1],
    ]);
  });
  it('matches model, LoRA, no-LoRA and keepers', () => {
    const kept = new Set(['3']);
    expect(matchesFilters(one, { model: 'a.safetensors', lora: 'ink' }, kept)).toBe(true);
    expect(matchesFilters(two, { lora: 'none' }, kept)).toBe(true);
    expect(matchesFilters(one, { lora: 'none' }, kept)).toBe(false);
    expect(matchesFilters(three, { kept: true }, kept)).toBe(true);
    expect(matchesFilters(two, { kept: true }, kept)).toBe(false);
  });
});

describe('review marks', () => {
  it('marks, switches and clears with the same key', () => {
    let state = applyMark({}, 'a', 'keep');
    expect(state.marks).toEqual({ a: 'keep' });
    state = applyMark(state.marks, 'a', 'bin');
    expect(state).toEqual({ marks: { a: 'bin' }, previous: 'keep' });
    expect(applyMark(state.marks, 'a', 'bin').marks).toEqual({});
  });
});

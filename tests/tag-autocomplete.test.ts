import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { tagToken, insertTag, parseTagCsv, searchTags } from '../src/shared/tag-autocomplete';

describe('offline tag autocomplete', () => {
  it('replaces only the tag at the caret, including unfinished weighted tags', () => {
    const value = 'solo, (blue_ey:1.2), outdoors';
    const token = tagToken(value, 14)!;
    expect(token.query).toBe('blue_ey');
    expect(insertTag(value, token, 'blue_eyes').value).toBe('solo, (blue_eyes:1.2), outdoors');
    expect(insertTag('solo, blue_ey', tagToken('solo, blue_ey', 13)!, 'blue_eyes')).toEqual({ value: 'solo, blue_eyes, ', caret: 17 });
  });
  it('preserves text after a middle-of-tag caret and escapes literal parentheses', () => {
    const value = 'solo, blue_eyes, outdoors';
    expect(insertTag(value, tagToken(value, 9)!, 'brown_eyes').value).toBe('solo, brown_eyes, outdoors');
    expect(insertTag('wolf', tagToken('wolf', 4)!, 'wolf_(species)').value).toBe('wolf\\_(species), '.replace('\\_', '_').replace('(species)', '\\(species\\)'));
    const literal = 'wolf\\(species\\)';
    expect(tagToken(literal, 4)?.end).toBe(literal.length);
  });
  it('leaves selections, weights, wildcards and LoRA syntax alone', () => {
    expect(tagToken('blue', 1)).toBeUndefined();
    expect(tagToken('blue_eyes', 3, 7)).toBeUndefined();
    expect(tagToken('__weather__', 5)).toBeUndefined();
    expect(tagToken('<lora:test:1>', 8)).toBeUndefined();
    expect(tagToken('{blue|red}', 5)).toBeUndefined();
    expect(tagToken('(blue_eyes:1.2)', 13)).toBeUndefined();
  });
  it('finds aliases, ranks prefixes and merges duplicate source tags', () => {
    const entries = [...parseTagCsv('blue_eyes,0,100,"azure_eyes,blue_eye"\nblue_hair,0,50,""\nlight_blue_eyes,0,9999,""', 'danbooru'), ...parseTagCsv('blue_eyes,0,20,""', 'e621')];
    expect(searchTags(entries, 'blue', 'both').map(x => x.name)).toEqual(['blue_eyes', 'blue_hair', 'light_blue_eyes']);
    expect(searchTags(entries, 'blue', 'both')[0].sources).toEqual(['danbooru', 'e621']);
    expect(searchTags(entries, 'azure', 'both')[0].name).toBe('blue_eyes');
    expect(searchTags(entries, 'blue', 'e621')).toHaveLength(1);
    expect(searchTags(entries, 'blue', 'off')).toEqual([]);
  });
  it('ships usable, substantial e621 and Danbooru dictionaries', () => {
    for (const source of ['e621', 'danbooru'] as const) {
      const entries = parseTagCsv(readFileSync(new URL(`../src/renderer/tag-data/${source}.csv`, import.meta.url), 'utf8'), source);
      expect(entries.length).toBeGreaterThan(50000);
      expect(searchTags(entries, 'blue_eyes', source)[0].name).toBe('blue_eyes');
      expect(searchTags(entries, 'wolf', source).length).toBeGreaterThan(0);
    }
  });
});

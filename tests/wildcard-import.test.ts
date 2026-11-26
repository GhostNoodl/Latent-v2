import { expect, it } from 'vitest';
import {
  mergeWildcardImports,
  parseWildcardFile,
  parseWildcardYaml,
  wildcardExportFiles,
  wildcardNameFromPath,
} from '../src/shared/wildcard-import';
import { createWildcardSnapshot } from '../src/shared/dynamic-prompt-recipe';

it('names lists after their file path', () => {
  expect(wildcardNameFromPath('My Pack/Hair Colors.txt')).toBe('My_Pack/Hair_Colors');
  expect(wildcardNameFromPath('../../evil/../x.txt')).toBe('evil/x');
  expect(wildcardNameFromPath('???.txt')).toBe('');
});

it('reads .txt files one choice per line', () => {
  const result = parseWildcardFile('clothes/tops.txt', '﻿shirt\r\n\r\nhoodie\n# a note\n');
  expect(result.lists).toEqual({ 'clothes/tops': ['shirt', 'hoodie', '# a note'] });
});

it('reads Dynamic Prompts style YAML packs', () => {
  const yaml = [
    '# my pack',
    'clothes:',
    '  tops:',
    '    - shirt',
    '    - "hoodie, red"',
    '  shoes: [boots, sandals]',
    'colors:',
    '- red',
    "- 'dark blue' # with a comment",
    'mood: calm',
  ].join('\n');
  expect(parseWildcardYaml(yaml)).toEqual({
    clothes: { tops: ['shirt', 'hoodie, red'], shoes: ['boots', 'sandals'] },
    colors: ['red', 'dark blue'],
    mood: 'calm',
  });
  const result = parseWildcardFile('packs/mine.yaml', yaml);
  expect(result.lists).toEqual({
    'packs/clothes/tops': ['shirt', 'hoodie, red'],
    'packs/clothes/shoes': ['boots', 'sandals'],
    'packs/colors': ['red', 'dark blue'],
    'packs/mood': ['calm'],
  });
});

it('reads JSON and skips files with nothing usable', () => {
  expect(parseWildcardFile('animals.json', '["cat","dog"]').lists).toEqual({ animals: ['cat', 'dog'] });
  expect(parseWildcardFile('set.json', '{"a":{"b":["x"]}}').lists).toEqual({ 'a/b': ['x'] });
  expect(parseWildcardFile('broken.json', '{').skipped).toEqual(['broken.json']);
  expect(parseWildcardFile('notes.md', 'hi').skipped).toEqual(['notes.md']);
});

it('merges files, round-trips through export, and saves big imports', async () => {
  const merged = mergeWildcardImports([parseWildcardFile('a.txt', 'one\ntwo'), parseWildcardFile('a.txt', 'three')]);
  expect(merged.lists.a).toEqual(['one', 'two', 'three']);
  const files = wildcardExportFiles({ 'clothes/tops': ['shirt', 'hoodie'] });
  expect(files).toEqual([{ path: 'clothes/tops.txt', text: 'shirt\nhoodie\n' }]);
  const big = parseWildcardFile('big.txt', Array.from({ length: 30_000 }, (_, i) => `line ${i}`).join('\n'));
  await expect(createWildcardSnapshot(big.lists)).resolves.toMatchObject({ entries: { big: expect.any(Array) } });
});

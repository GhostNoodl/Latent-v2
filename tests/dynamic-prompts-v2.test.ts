import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  countDynamicCombinations,
  parseDynamicPrompt,
  resolveDynamicPrompt,
  DYNAMIC_PROMPT_VERSION_V1,
} from '../src/shared/dynamic-prompts';
import {
  createWildcardSnapshot,
  prepareDynamicPromptDraft,
  restoreDynamicPromptRecipe,
  countPromptCombinations,
  usesDynamicPrompts,
  type DynamicPromptRecipe,
} from '../src/shared/dynamic-prompt-recipe';

const v1Recipe = JSON.parse(fs.readFileSync('tests/fixtures/dynamic-recipe-v1.json', 'utf8')) as DynamicPromptRecipe;

describe('saved images from before the upgrade', () => {
  it('still replay exactly, with the old meaning of {2::a|b}', async () => {
    const draft = restoreDynamicPromptRecipe({ prompt: '', negativePrompt: '' }, v1Recipe);
    const prepared = await prepareDynamicPromptDraft(draft, '999');
    expect(prepared.reusedFrozen).toBe(true);
    expect(prepared.prompt).toBe(v1Recipe.positive.resolved);
    expect(prepared.prompt).toContain('2::a');
  });
  it('resolve the same as before when a prompt uses no new syntax', async () => {
    const wildcards = await createWildcardSnapshot(v1Recipe.wildcards.entries);
    const prompt = 'a {red|blue|green} fox, __weather__, __big__';
    const old = resolveDynamicPrompt(prompt, '12345:positive', wildcards.entries, {
      version: DYNAMIC_PROMPT_VERSION_V1,
    });
    const now = resolveDynamicPrompt(prompt, '12345:positive', wildcards.entries);
    expect(now.resolved).toBe(old.resolved);
    expect(now.choices).toEqual(old.choices);
  });
});

describe('new syntax', () => {
  const lists = {
    colors: ['red', 'blue', 'green', 'yellow', '# a note', '', 'purple'],
    'clothes/tops': ['shirt', 'hoodie'],
    'clothes/shoes': ['boots'],
    hair: ['${tone} hair'],
  };
  it('weights options', () => {
    let heavy = 0;
    for (let seed = 0; seed < 400; seed++)
      if (resolveDynamicPrompt('{9::cat|dog}', String(seed)).resolved === 'cat') heavy++;
    expect(heavy).toBeGreaterThan(320);
    expect(resolveDynamicPrompt('{0::never|1::always}', '1').resolved).toBe('always');
  });
  it('picks several without repeats, with a custom joiner', () => {
    const many = resolveDynamicPrompt('{3$$a|b|c|d}', '7').resolved.split(', ');
    expect(many).toHaveLength(3);
    expect(new Set(many).size).toBe(3);
    const joined = resolveDynamicPrompt('{2$$ and $$x|y}', '3').resolved;
    expect(['x and y', 'y and x']).toContain(joined);
    const ranged = resolveDynamicPrompt('{1-2$$a|b|c}', '5').resolved.split(', ');
    expect(ranged.length).toBeGreaterThanOrEqual(1);
    expect(ranged.length).toBeLessThanOrEqual(2);
  });
  it('picks several from a list and skips # notes and blank lines', () => {
    for (let seed = 0; seed < 50; seed++) {
      const picked = resolveDynamicPrompt('{2$$__colors__}', String(seed), lists).resolved.split(', ');
      expect(picked).toHaveLength(2);
      expect(new Set(picked).size).toBe(2);
      for (const value of picked) expect(['red', 'blue', 'green', 'yellow', 'purple']).toContain(value);
    }
  });
  it('reads a whole folder with *', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 60; seed++) seen.add(resolveDynamicPrompt('__clothes/*__', String(seed), lists).resolved);
    expect([...seen].sort()).toEqual(['boots', 'hoodie', 'shirt']);
    expect(() => resolveDynamicPrompt('__nothing/*__', '1', lists)).toThrow('No wildcard lists match');
  });
  it('sets and reuses variables', () => {
    const fixed = resolveDynamicPrompt('${tone=!{dark|light}}${tone} and ${tone}', '4').resolved;
    expect(['dark and dark', 'light and light']).toContain(fixed);
    expect(resolveDynamicPrompt('${tone=pale}__hair__', '1', lists).resolved).toBe('pale hair');
    expect(resolveDynamicPrompt('${missing:plain}', '1').resolved).toBe('plain');
    expect(() => resolveDynamicPrompt('${missing}', '1')).toThrow("isn't set yet");
    expect(() => resolveDynamicPrompt('${a=${a}}${a}', '1')).toThrow('refers to itself');
  });
  it('locks a pick and keeps the other picks where they were', () => {
    const free = resolveDynamicPrompt('__colors__ __clothes/tops__ {a|b|c}', '11', lists);
    const locked = resolveDynamicPrompt('__colors__ __clothes/tops__ {a|b|c}', '11', lists, {
      pins: { colors: 'gold' },
    });
    expect(locked.resolved.split(' ')[0]).toBe('gold');
    expect(locked.resolved.split(' ').slice(1)).toEqual(free.resolved.split(' ').slice(1));
  });
  it('walks every combination in order', () => {
    expect(countDynamicCombinations('{a|b} {x|y|z}', 's')).toEqual({ count: 6, capped: false });
    const all = Array.from(
      { length: 6 },
      (_, index) => resolveDynamicPrompt('{a|b} {x|y|z}', 's', {}, { combination: index }).resolved,
    );
    expect(all).toEqual(['a x', 'a y', 'a z', 'b x', 'b y', 'b z']);
    expect(countDynamicCombinations('{a|{b|c}} __clothes/*__', 's', lists).count).toBe(9);
    expect(() => resolveDynamicPrompt('{a|b}', 's', {}, { combination: 2 })).toThrow('only has 2');
  });
  it('turns on for the new syntax', () => {
    for (const prompt of ['{2$$__colors__}', '${a=b}', '__clothes/*__'])
      expect(usesDynamicPrompts({ prompt, negativePrompt: '' })).toBe(true);
    expect(() => parseDynamicPrompt('{2$$a|b')).toThrow('Unclosed choice');
  });
});

describe('big lists', () => {
  it('save only the picked lines with an image and still replay', async () => {
    const big = Array.from({ length: 20_000 }, (_, index) => `thing ${index}`);
    const wildcards = await createWildcardSnapshot({ big, small: ['a', 'b'] });
    const draft = { prompt: '__big__, {2$$__big__}, __small__', negativePrompt: '' };
    const prepared = await prepareDynamicPromptDraft(draft, '42', wildcards);
    const recipe = prepared.recipe!;
    expect(recipe.wildcards.entries).toEqual({ small: ['a', 'b'] });
    expect(recipe.wildcards.sparse!.big.count).toBe(20_000);
    expect(Object.keys(recipe.wildcards.sparse!.big.picks)).toHaveLength(3);
    expect(JSON.stringify(recipe).length).toBeLessThan(4000);
    const again = await prepareDynamicPromptDraft(restoreDynamicPromptRecipe(draft, recipe), '1');
    expect(again.prompt).toBe(prepared.prompt);
    const tampered = structuredClone(recipe);
    const picks = tampered.wildcards.sparse!.big.picks as Record<string, string>;
    picks[Object.keys(picks)[0]] = 'swapped';
    await expect(prepareDynamicPromptDraft(restoreDynamicPromptRecipe(draft, tampered), '1')).rejects.toThrow();
  });
  it('lift the old 1,024 cap', async () => {
    const lists = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`list${i}`, Array.from({ length: 1000 }, (_, j) => `w${j}`)]),
    );
    await expect(createWildcardSnapshot(lists)).resolves.toBeTruthy();
  });
  it('replays rolls, combinations and locks', async () => {
    const wildcards = await createWildcardSnapshot({ colors: ['red', 'blue', 'green'] });
    const base = { prompt: '__colors__ {a|b}', negativePrompt: '' };
    const rolled = await prepareDynamicPromptDraft(
      { ...base, dynamicPrompts: { enabled: true, roll: 3, pins: { colors: 'gold' } } },
      '5',
      wildcards,
    );
    expect(rolled.prompt.startsWith('gold ')).toBe(true);
    const combo = await prepareDynamicPromptDraft(
      { ...base, dynamicPrompts: { enabled: true, combination: 5 } },
      '5',
      wildcards,
    );
    expect(combo.prompt).toBe('green b');
    for (const prepared of [rolled, combo]) {
      const again = await prepareDynamicPromptDraft(restoreDynamicPromptRecipe(base, prepared.recipe!), '1');
      expect(again.prompt).toBe(prepared.prompt);
    }
    expect(countPromptCombinations(base, wildcards)).toEqual({ count: 6, capped: false });
  });
});

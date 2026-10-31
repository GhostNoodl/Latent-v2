import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT, DEFAULT_SETTINGS } from '../src/shared/defaults';
import type { GenerationDraft, GenerationRecord } from '../src/shared/types';
import { draftSchema, parseSettingsPatch } from '../src/shared/validation';
import { estimateDurationMs, formatSeconds, remainingSeconds } from '../src/renderer/generation-eta';
import { joinPrompt, movePiece, splitPrompt } from '../src/renderer/PromptPieces';
import { addSavedPrompt } from '../src/renderer/SavedPrompts';
import { buildSweepDrafts, parseValues, suggestedValues } from '../src/renderer/GridSweep';

const draft = (change: Partial<GenerationDraft> = {}): GenerationDraft => ({
  ...structuredClone(DEFAULT_DRAFT),
  family: 'sdxl',
  checkpointId: 'checkpoint:a.safetensors',
  width: 832,
  height: 1216,
  steps: 28,
  cfg: 6,
  ...change,
});
const record = (jobId: string, durationMs: number, change: Partial<GenerationDraft> = {}) =>
  ({ id: jobId, jobId, durationMs, draft: draft(change) }) as GenerationRecord;

describe('seconds left', () => {
  it('uses the median of similar recent images and ignores different recipes', () => {
    const history = [
      record('a', 12000),
      record('b', 14000),
      record('c', 13000),
      record('d', 90000, { hiresFix: undefined, width: 1344, height: 1344 }),
    ];
    expect(estimateDurationMs(history, draft())).toBe(13000);
    expect(estimateDurationMs(history, draft({ steps: 60 }))).toBeUndefined();
  });
  it('counts a batch once', () => {
    const history = [record('a', 30000), { ...record('a', 30000), id: 'a2' }, record('b', 10000)];
    expect(estimateDurationMs(history, draft())).toBe(30000);
  });
  it('counts down from history, then falls back to the step rate', () => {
    expect(remainingSeconds({ now: 5000, startedAt: 0, estimateMs: 13000, progress: 3, progressMax: 28 })).toBe(8);
    // History has run out: 10 steps took 10 s, 18 are left.
    expect(
      remainingSeconds({
        now: 20000,
        startedAt: 0,
        estimateMs: 13000,
        progress: 11,
        progressMax: 28,
        stepStartedAt: 10000,
      }),
    ).toBe(17);
    expect(remainingSeconds({ now: 1000, startedAt: 0, progress: 0, progressMax: 28 })).toBeUndefined();
  });
  it('formats short and long times', () => {
    expect(formatSeconds(9)).toBe('9s');
    expect(formatSeconds(75)).toBe('1m 15s');
  });
});

describe('prompt pieces', () => {
  it('splits at top-level commas only', () => {
    expect(splitPrompt('a cat, (warm light, golden hour:1.2), film photo,, ')).toEqual([
      'a cat',
      '(warm light, golden hour:1.2)',
      'film photo',
    ]);
  });
  it('moves and joins pieces', () => {
    expect(joinPrompt(movePiece(['a', 'b', 'c'], 2, 0))).toBe('c, a, b');
    expect(movePiece(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});

describe('saved prompts', () => {
  it('adds new prompts first and skips duplicates and blanks', () => {
    const one = addSavedPrompt([], ' film grain ');
    expect(one).toHaveLength(1);
    expect(one[0].text).toBe('film grain');
    expect(addSavedPrompt(one, 'film grain')).toBe(one);
    expect(addSavedPrompt(one, '   ')).toBe(one);
    expect(parseSettingsPatch({ savedPrompts: one, promptPieces: true })).toEqual({
      savedPrompts: one,
      promptPieces: true,
    });
    expect(DEFAULT_SETTINGS.savedPrompts).toBeUndefined();
  });
});

describe('compare settings grid', () => {
  it('builds one valid draft per cell with a shared seed', () => {
    const drafts = buildSweepDrafts(
      draft({ batchSize: 3, seed: 'random' }),
      { kind: 'cfg', values: ['4', '6', '8'] },
      { kind: 'steps', values: ['20', '28'] },
      { columns: 'Guidance', rows: 'Steps' },
      'sw-test1',
    );
    expect(drafts).toHaveLength(6);
    expect(new Set(drafts.map(cell => cell.seed)).size).toBe(1);
    expect(drafts.map(cell => [cell.cfg, cell.steps])).toEqual([
      [4, 20],
      [6, 20],
      [8, 20],
      [4, 28],
      [6, 28],
      [8, 28],
    ]);
    expect(drafts.every(cell => cell.batchSize === 1)).toBe(true);
    expect(drafts[4].sweep).toMatchObject({ id: 'sw-test1', index: 4, columns: ['4', '6', '8'], rows: ['20', '28'] });
    for (const cell of drafts) expect(draftSchema.safeParse(cell).success).toBe(true);
  });
  it('gives each cell its own seed when the seed is what changes', () => {
    const drafts = buildSweepDrafts(draft(), { kind: 'seed', values: ['random', 'random', '7'] }, undefined, {
      columns: 'Seed',
    });
    expect(drafts[2].seed).toBe('7');
    expect(drafts[0].seed).not.toBe('random');
  });
  it('checks typed values', () => {
    expect(parseValues('cfg', '4, 6, 40').error).toBeTruthy();
    expect(parseValues('sampler', 'euler, nope').error).toContain('nope');
    expect(parseValues('steps', '20, 28').error).toBeUndefined();
    expect(suggestedValues('cfg', draft({ cfg: 6 }))).toEqual(['4', '6', '8']);
  });
});

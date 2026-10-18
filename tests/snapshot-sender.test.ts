import { describe, expect, it } from 'vitest';
import { SnapshotSender, type LightSnapshot, type SnapshotSources } from '../src/main/snapshot-sender';
import { applySnapshotChanges } from '../src/shared/snapshot-changes';
import type { AppSnapshot, GenerationRecord, Preset, StudioJob } from '../src/shared/types';

const job = (id: string, progress = 0) => ({ id, status: 'running', progress }) as unknown as StudioJob;

function fixture() {
  const state = {
    light: { draft: { prompt: 'a' } } as unknown as LightSnapshot,
    history: [] as GenerationRecord[],
    historyRevision: 0,
    presets: [] as Preset[],
    presetsRevision: 0,
    jobs: [job('a'), job('b')],
    dirty: new Set<string>(),
    now: 0,
    calls: { history: 0, jobs: 0 },
  };
  const sources: SnapshotSources = {
    light: () => structuredClone(state.light),
    history: () => {
      state.calls.history++;
      return state.history;
    },
    historyRevision: () => String(state.historyRevision),
    presets: () => state.presets,
    presetsRevision: () => state.presetsRevision,
    jobs: {
      jobs: () => {
        state.calls.jobs++;
        return structuredClone(state.jobs);
      },
      jobOrder: () => state.jobs.map(item => item.id),
      jobSnapshot: id => structuredClone(state.jobs.find(item => item.id === id)),
      takeChangedJobIds: () => {
        const dirty = state.dirty;
        state.dirty = new Set();
        return dirty;
      },
    },
  };
  const sender = new SnapshotSender(sources, () => state.now);
  const window = sender.remember(sender.snapshot());
  state.calls = { history: 0, jobs: 0 };
  return { state, sender, window };
}

describe('snapshot pushes', () => {
  it('sends nothing, and reads no large list, when nothing changed', () => {
    const { state, sender } = fixture();
    expect(sender.patch()).toBeUndefined();
    expect(state.calls).toEqual({ history: 0, jobs: 0 });
  });

  it('sends one job for a progress tick and the window ends up with the same list', () => {
    const { state, sender, window } = fixture();
    state.jobs[1] = job('b', 5);
    state.dirty.add('b');
    const patch = sender.patch()!;
    expect(patch.jobs).toBeUndefined();
    expect(patch.jobUpdates).toEqual([job('b', 5)]);
    expect(state.calls.jobs).toBe(0);
    expect(applySnapshotChanges(window as AppSnapshot, patch).jobs).toEqual(state.jobs);
  });

  it('sends the whole job list when a job arrives', () => {
    const { state, sender } = fixture();
    state.jobs.push(job('c'));
    state.dirty.add('c');
    expect(sender.patch()?.jobs?.map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(sender.patch()).toBeUndefined();
  });

  it('catches a job that changed without being marked, on the periodic recheck', () => {
    const { state, sender } = fixture();
    state.jobs[0] = job('a', 3);
    expect(sender.patch()).toBeUndefined();
    state.now = 5000;
    expect(sender.patch()?.jobUpdates).toEqual([job('a', 3)]);
  });

  it('sends the library and presets only when their revision moves', () => {
    const { state, sender } = fixture();
    state.historyRevision++;
    expect(sender.patch()).toEqual({ history: [] });
    state.presetsRevision++;
    expect(sender.patch()).toEqual({ presets: [] });
    state.light = { draft: { prompt: 'b' } } as unknown as LightSnapshot;
    expect(sender.patch()).toEqual({ draft: { prompt: 'b' } });
    expect(state.calls.history).toBe(1);
  });
});

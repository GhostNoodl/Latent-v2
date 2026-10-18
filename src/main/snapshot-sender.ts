import type { AppSnapshot, StudioJob } from '../shared/types';
import type { SnapshotChanges } from '../shared/snapshot-changes';

/** Everything except the three lists that can grow large; those have cheaper change tracking. */
export type LightSnapshot = Omit<AppSnapshot, 'history' | 'jobs' | 'presets'>;
export interface SnapshotSources {
  light(): LightSnapshot;
  history(): AppSnapshot['history'];
  /** Changes whenever `history()` would. */
  historyRevision(): string;
  presets(): AppSnapshot['presets'];
  presetsRevision(): number;
  jobs: {
    jobs(): StudioJob[];
    jobOrder(): string[];
    jobSnapshot(id: string): StudioJob | undefined;
    takeChangedJobIds(): Set<string>;
  };
}
/** Every few seconds all jobs are compared, in case one changed without saying so. */
const JOB_RECHECK_MS = 5000;

/**
 * Works out what to push to the window: only what changed since its last copy. Small fields are
 * compared directly, the image library and presets carry revision numbers, and jobs are tracked
 * one by one, so a progress tick sends one job instead of re-reading and re-sending the studio.
 */
export class SnapshotSender {
  private fields = new Map<string, string>();
  private historyRevision = '';
  private presetsRevision = -1;
  private jobOrder = '';
  private jobs = new Map<string, string>();
  private jobsCheckedAt = 0;
  constructor(
    private readonly sources: SnapshotSources,
    private readonly now: () => number = Date.now,
  ) {}
  snapshot(): AppSnapshot {
    return {
      ...this.sources.light(),
      history: this.sources.history(),
      jobs: this.sources.jobs.jobs(),
      presets: this.sources.presets(),
    };
  }
  /** Records a full snapshot the window now holds as the new baseline. */
  remember(value: AppSnapshot): AppSnapshot {
    const { history: _history, jobs, presets: _presets, ...light } = value;
    this.fields.clear();
    for (const [key, field] of Object.entries(light)) this.fields.set(key, JSON.stringify(field));
    this.historyRevision = this.sources.historyRevision();
    this.presetsRevision = this.sources.presetsRevision();
    this.rememberJobs(jobs);
    this.sources.jobs.takeChangedJobIds();
    return value;
  }
  patch(): SnapshotChanges | undefined {
    const { sources } = this;
    const patch: SnapshotChanges = {};
    let changed = false;
    for (const [key, field] of Object.entries(sources.light())) {
      const serialized = JSON.stringify(field);
      if (this.fields.get(key) === serialized) continue;
      this.fields.set(key, serialized);
      (patch as Record<string, unknown>)[key] = field;
      changed = true;
    }
    if (this.historyRevision !== sources.historyRevision()) {
      this.historyRevision = sources.historyRevision();
      patch.history = sources.history();
      changed = true;
    }
    if (this.presetsRevision !== sources.presetsRevision()) {
      this.presetsRevision = sources.presetsRevision();
      patch.presets = sources.presets();
      changed = true;
    }
    const dirty = sources.jobs.takeChangedJobIds();
    if (sources.jobs.jobOrder().join(',') !== this.jobOrder) {
      // A job arrived, left or moved: the window gets the whole list once.
      patch.jobs = sources.jobs.jobs();
      this.rememberJobs(patch.jobs);
      return patch;
    }
    const recheck = this.now() - this.jobsCheckedAt >= JOB_RECHECK_MS;
    if (recheck) this.jobsCheckedAt = this.now();
    const candidates = recheck
      ? sources.jobs.jobs()
      : [...dirty].flatMap(id => {
          const job = sources.jobs.jobSnapshot(id);
          return job ? [job] : [];
        });
    const updates: StudioJob[] = [];
    for (const job of candidates) {
      const serialized = JSON.stringify(job);
      if (this.jobs.get(job.id) === serialized) continue;
      this.jobs.set(job.id, serialized);
      updates.push(job);
    }
    if (updates.length) {
      patch.jobUpdates = updates;
      changed = true;
    }
    return changed ? patch : undefined;
  }
  private rememberJobs(list: StudioJob[]) {
    this.jobOrder = list.map(job => job.id).join(',');
    this.jobs = new Map(list.map(job => [job.id, JSON.stringify(job)]));
    this.jobsCheckedAt = this.now();
  }
}

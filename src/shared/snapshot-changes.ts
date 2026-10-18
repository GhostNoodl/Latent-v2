import type { AppSnapshot, StudioJob } from './types';

/**
 * What the studio pushes to the window: the top-level fields that changed, and for a job list
 * whose order is unchanged, just the jobs that moved (a progress tick is one job, not the queue).
 */
export type SnapshotChanges = Partial<AppSnapshot> & { jobUpdates?: StudioJob[] };

export function applySnapshotChanges(current: AppSnapshot, changes: SnapshotChanges): AppSnapshot {
  const { jobUpdates, ...fields } = changes;
  const next = { ...current, ...fields };
  if (jobUpdates?.length) {
    const updates = new Map(jobUpdates.map(job => [job.id, job]));
    next.jobs = next.jobs.map(job => updates.get(job.id) ?? job);
  }
  return next;
}

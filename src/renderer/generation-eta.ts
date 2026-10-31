import { useEffect, useRef, useState } from 'react';
import type { GenerationDraft, GenerationJob, GenerationRecord } from '../shared/types';

/** How alike two recipes must be for one's run time to predict the other's. */
function similar(a: GenerationDraft, b: GenerationDraft) {
  const pixels = (draft: GenerationDraft) => draft.width * draft.height;
  return (
    Math.abs(pixels(a) / pixels(b) - 1) <= 0.15 &&
    Math.abs(a.steps - b.steps) <= 2 &&
    Boolean(a.hiresFix) === Boolean(b.hiresFix) &&
    Boolean(a.upscale) === Boolean(b.upscale) &&
    Boolean(a.enhance) === Boolean(b.enhance) &&
    Boolean(a.autoFace) === Boolean(b.autoFace) &&
    Boolean(a.imageInput) === Boolean(b.imageInput) &&
    Boolean(a.controlNet) === Boolean(b.controlNet)
  );
}

/** Median time of recent similar images, or undefined when there is nothing alike to go on. */
export function estimateDurationMs(history: GenerationRecord[], draft: GenerationDraft): number | undefined {
  const times: number[] = [];
  const seenJobs = new Set<string>();
  for (const record of history) {
    if (times.length >= 15) break;
    // A batch shares one job; its duration is the whole job, so count it once.
    if (seenJobs.has(record.jobId) || !(record.durationMs > 0)) continue;
    if (record.draft.batchSize !== draft.batchSize || !similar(record.draft, draft)) continue;
    seenJobs.add(record.jobId);
    times.push(record.durationMs);
  }
  if (times.length === 0) return undefined;
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

/**
 * Seconds left for a running job. Uses past similar images as the baseline and
 * the live step rate when there is no history (or the baseline has run out).
 */
export function remainingSeconds(input: {
  now: number;
  startedAt: number;
  estimateMs?: number;
  progress: number;
  progressMax: number;
  stepStartedAt?: number;
}): number | undefined {
  const elapsed = input.now - input.startedAt;
  const byHistory = input.estimateMs === undefined ? undefined : input.estimateMs - elapsed;
  let byRate: number | undefined;
  if (input.stepStartedAt !== undefined && input.progress >= 2 && input.progressMax > input.progress) {
    // Timing starts at step 1, so it covers progress - 1 finished steps.
    const perStep = (input.now - input.stepStartedAt) / (input.progress - 1);
    byRate = perStep * (input.progressMax - input.progress);
  }
  const left = byHistory !== undefined && byHistory > 1000 ? byHistory : byRate;
  return left === undefined ? undefined : Math.max(1, Math.ceil(left / 1000));
}

export function formatSeconds(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Ticks once a second while a job runs and returns its seconds left, if known. */
export function useCountdown(job: GenerationJob | undefined, history: GenerationRecord[]) {
  const track = useRef<{ id: string; startedAt: number; stepStartedAt?: number; max: number; estimateMs?: number }>(
    undefined,
  );
  const [now, setNow] = useState(() => Date.now());
  const running = job?.queueState === 'running' || job?.status === 'running';
  if (!running || !job) track.current = undefined;
  else if (track.current?.id !== job.id) {
    track.current = {
      id: job.id,
      startedAt: Date.now(),
      max: job.progressMax,
      estimateMs: estimateDurationMs(history, job.draft),
    };
  }
  const current = track.current;
  if (current && job) {
    // A new sampler (hires fix, face pass) restarts the step count.
    if (job.progressMax !== current.max || job.progress === 0) {
      current.max = job.progressMax;
      current.stepStartedAt = undefined;
    }
    if (current.stepStartedAt === undefined && job.progress >= 1 && job.progressMax > 1)
      current.stepStartedAt = Date.now();
  }
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!current || !job) return undefined;
  return remainingSeconds({
    now,
    startedAt: current.startedAt,
    estimateMs: current.estimateMs,
    progress: job.progress,
    progressMax: job.progressMax,
    stepStartedAt: current.stepStartedAt,
  });
}

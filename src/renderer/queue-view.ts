import { isImageJob, isVideoJob, type StudioJob } from '../shared/types';

export const runningImageJob = (jobs: readonly StudioJob[]) => jobs.filter(isImageJob).find(job => job.status === 'running');
export const qwenConversationJobs = (jobs: readonly StudioJob[], conversationId?: string) => jobs.filter(isImageJob).filter(job => !!conversationId && job.draft.qwenEdit?.lineage.conversationId === conversationId);
export const queueJobActive = (job: StudioJob) => job.status === 'queued' || job.status === 'running' || isVideoJob(job) && job.finalization === 'pending';
export function queueJobPresentation(job: StudioJob, foreignJobs = 0) {
  const video = isVideoJob(job);
  const finalization = video ? job.finalization : undefined;
  const state = finalization === 'pending' ? 'Saving video' : finalization === 'failed' ? 'Video saving failed'
    : job.status === 'running' ? job.queueState === 'running' ? 'Running' : job.queueState === 'pending' ? 'Waiting' : job.queueState === 'submitting' ? 'Starting' : 'Preparing'
    : job.status === 'queued' && foreignJobs ? 'Waiting for the engine' : job.status;
  const dimensions = video ? `${job.video.width} × ${job.video.height}` : `${job.draft.upscale?.width ?? job.draft.hiresFix?.width ?? job.draft.width} × ${job.draft.upscale?.height ?? job.draft.hiresFix?.height ?? job.draft.height}`;
  return {
    title: video ? `Video: ${job.video.prompt || 'Untitled video'}` : job.draft.upscale ? job.draft.upscale.mode === 'learned' ? 'Enhance source image' : 'Resize source image' : job.draft.prompt || 'Untitled image',
    state, summary: `${state}${video ? ' · Video' : ' · Image'}`,
    phase: finalization === 'pending' ? 'Inference finished. Saving and validating the video output.' : finalization === 'failed' ? 'Inference finished. Retry saving to preserve the existing output.' : job.phase,
    showProgress: job.status === 'running' && job.queueState === 'running' && !finalization,
    saving: finalization === 'pending', canCancel: ['queued', 'running'].includes(job.status) && !finalization,
    canRetrySaving: finalization === 'failed', canRetryGeneration: ['failed', 'cancelled'].includes(job.status) && !finalization,
    canRequestImageAdvice: isImageJob(job) && job.status === 'failed',
  };
}

/** Ignore image jobs, progress ticks and queue reordering when refreshing video history. */
export function videoHistoryRevision(jobs: readonly StudioJob[]): string {
  return JSON.stringify(jobs.filter(isVideoJob).filter(job => job.status === 'completed' || job.outputIds.length > 0)
    .map(job => [job.id, job.status === 'completed', [...job.outputIds].sort()] as const).sort((a, b) => a[0].localeCompare(b[0])));
}

/** Keep every active control reachable; page terminal jobs without hiding retries. */
export function queueView(jobs: readonly StudioJob[], terminalLimit: number) {
  const priority = { running: 0, queued: 1, failed: 2, cancelled: 3, completed: 4 };
  const rank = (job: StudioJob) => isVideoJob(job) && job.finalization ? job.finalization === 'pending' ? 0 : 2 : priority[job.status];
  const sorted = [...jobs].sort((a, b) => rank(a) - rank(b)
    || (a.status === 'queued' ? 0 : b.createdAt.localeCompare(a.createdAt)));
  const active = sorted.filter(queueJobActive);
  const terminal = sorted.filter(job => !queueJobActive(job));
  const limit = Math.max(0, Math.floor(terminalLimit));
  return { visible: [...active, ...terminal.slice(0, limit)], remaining: Math.max(0, terminal.length - limit) };
}

export const queueClearKey = (job: StudioJob) => `${job.id}:${job.status}:${job.updatedAt}`;

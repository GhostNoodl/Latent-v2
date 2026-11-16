import type { StudioJob, VideoJob } from '../shared/types';
import { isVideoJob } from '../shared/types';
import type { VideoHistoryRecord } from '../shared/video-types';
import { formatDuration, safeVideoHistoryUrl } from './video-url';

function when(iso: string) {
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date.getTime()) / 86400000);
  if (days < 1) return date.toDateString() === new Date().toDateString() ? 'today' : 'yesterday';
  if (days < 2) return 'yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export function activeVideoJobs(jobs: readonly StudioJob[]): VideoJob[] {
  return jobs.filter(
    (job): job is VideoJob =>
      isVideoJob(job) && (['queued', 'running'].includes(job.status) || job.finalization === 'failed'),
  );
}
export function jobPercent(job: VideoJob) {
  if (job.status !== 'running') return 0;
  return job.progressMax ? Math.round((job.progress / job.progressMax) * 100) : 0;
}

/** The clips rail: what's making or waiting, then finished clips, newest first. */
export function VideoClips({
  jobs,
  records,
  selectedId,
  warnings,
  loading,
  onSelect,
  onSelectJob,
  onCancel,
  onRetrySave,
}: {
  jobs: readonly StudioJob[];
  records: readonly VideoHistoryRecord[];
  selectedId?: string;
  warnings: readonly string[];
  loading?: boolean;
  onSelect(id: string): void;
  onSelectJob(id: string): void;
  onCancel(id: string): void;
  onRetrySave(id: string): void;
}) {
  const active = activeVideoJobs(jobs);
  const failed = jobs.filter((job): job is VideoJob => isVideoJob(job) && job.status === 'failed').slice(0, 3);
  return (
    <aside className="vp-clips" aria-label="Clips">
      <h2>Clips</h2>
      <ul>
        {active.map((job, index) => (
          <li key={job.id}>
            <button
              type="button"
              className={`vp-clip ${selectedId === job.id ? 'on' : ''}`}
              aria-current={selectedId === job.id || undefined}
              onClick={() => onSelectJob(job.id)}
            >
              <span className="vp-clip-thumb waiting" aria-hidden="true" />
              <span className="vp-clip-text">
                <span className="vp-clip-title">{job.video.prompt.trim() || 'Untitled clip'}</span>
                <span className={`vp-clip-meta ${job.status === 'running' ? 'accent' : ''}`}>
                  {job.finalization === 'failed'
                    ? 'Saving needs a retry'
                    : job.status === 'running'
                      ? `${job.phase ?? 'Making'} · ${jobPercent(job)}%`
                      : index === (active[0]?.status === 'running' ? 1 : 0)
                        ? 'Waiting · next up'
                        : 'Waiting'}
                </span>
              </span>
            </button>
            {job.finalization === 'failed' ? (
              <button type="button" className="vp-clip-action" onClick={() => onRetrySave(job.id)}>
                Retry saving
              </button>
            ) : (
              <button
                type="button"
                className="vp-clip-action"
                aria-label="Stop this clip"
                onClick={() => onCancel(job.id)}
              >
                Stop
              </button>
            )}
          </li>
        ))}
        {failed.map(job => (
          <li key={job.id}>
            <button
              type="button"
              className={`vp-clip ${selectedId === job.id ? 'on' : ''}`}
              onClick={() => onSelectJob(job.id)}
            >
              <span className="vp-clip-thumb failed" aria-hidden="true" />
              <span className="vp-clip-text">
                <span className="vp-clip-title">{job.video.prompt.trim() || 'Untitled clip'}</span>
                <span className="vp-clip-meta error">Didn’t finish</span>
              </span>
            </button>
          </li>
        ))}
        {records.map(record => {
          const url = safeVideoHistoryUrl(record);
          return (
            <li key={record.id}>
              <button
                type="button"
                className={`vp-clip ${selectedId === record.id ? 'on' : ''}`}
                aria-current={selectedId === record.id || undefined}
                onClick={() => onSelect(record.id)}
              >
                {url ? (
                  <video className="vp-clip-thumb" src={`${url}#t=0.5`} muted playsInline preload="metadata" />
                ) : (
                  <span className="vp-clip-thumb" aria-hidden="true" />
                )}
                <span className="vp-clip-text">
                  <span className="vp-clip-title">{record.title}</span>
                  <span className="vp-clip-meta">
                    {Math.round(record.media.durationSeconds)} s
                    {record.elapsedMs ? ` · ${formatDuration(record.elapsedMs)}` : ''} · {when(record.createdAt)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!active.length && !records.length && !failed.length && (
        <p className="vp-empty">{loading ? 'Loading clips…' : 'Your clips show up here.'}</p>
      )}
      {warnings.length > 0 && <p className="vp-empty">{warnings[0]}</p>}
    </aside>
  );
}

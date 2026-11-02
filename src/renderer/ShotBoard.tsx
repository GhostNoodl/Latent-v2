import { ArrowDown, ArrowUp, Clapperboard, Play, Plus, Star, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  addTake,
  moveShot,
  newShot,
  playlist,
  removeTake,
  SHOT_LIMIT,
  TAKE_LIMIT,
  toggleKeeper,
  type Shot,
  type ShotBoard as Board,
} from '../shared/shot-board';
import { isVideoJob, type StudioJob } from '../shared/types';
import type { VideoHistoryRecord } from '../shared/video-types';
import { actionErrorMessage } from '../shared/action-error';
import { safeVideoHistoryUrl } from './VideoHistory';
import { Modal } from './ui';

type Showing = { kind: 'take'; jobId: string } | { kind: 'playlist'; index: number };

/** Line up shots, make a few takes of each, star the keeper, play the keepers in order. */
export function ShotBoard({
  records,
  jobs,
  selectedRecordId,
  defaultPrompt,
  takeBlocked,
  onMakeTake,
  onClose,
}: {
  records: VideoHistoryRecord[];
  jobs: StudioJob[];
  selectedRecordId?: string;
  defaultPrompt: string;
  /** Why a new take can't be queued right now. */
  takeBlocked?: string;
  onMakeTake(prompt: string): Promise<string>;
  onClose(): void;
}) {
  const [board, setBoard] = useState<Board>();
  const [error, setError] = useState('');
  const [making, setMaking] = useState<string>();
  const [showing, setShowing] = useState<Showing>();
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef<Board | undefined>(undefined);
  const player = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let live = true;
    window.latent
      .getShotBoard()
      .then(saved => {
        if (!live) return;
        latest.current = saved;
        setBoard(saved);
      })
      .catch(cause => live && setError(`Could not open the shot board: ${actionErrorMessage(cause)}`));
    return () => {
      live = false;
      clearTimeout(saveTimer.current);
      if (latest.current) void window.latent.saveShotBoard(latest.current).catch(() => undefined);
    };
  }, []);

  const change = (next: Board, now = false) => {
    latest.current = next;
    setBoard(next);
    clearTimeout(saveTimer.current);
    const save = () =>
      void window.latent
        .saveShotBoard(next)
        .catch(cause => setError(`Could not save the shot board: ${actionErrorMessage(cause)}`));
    if (now) save();
    else saveTimer.current = setTimeout(save, 400);
  };
  const editShot = (id: string, patch: Partial<Shot>) =>
    board && change({ ...board, shots: board.shots.map(shot => (shot.id === id ? { ...shot, ...patch } : shot)) });

  const finished = records.filter(record => record.evidenceKind === 'generated');
  const byJob = new Map(finished.map(record => [record.jobId, record]));
  const jobById = new Map(jobs.filter(isVideoJob).map(job => [job.id, job]));
  const order = board ? playlist(board, finished) : [];
  const selected = records.find(record => record.id === selectedRecordId && record.evidenceKind === 'generated');

  const current =
    showing?.kind === 'take'
      ? byJob.get(showing.jobId)
      : showing?.kind === 'playlist'
        ? order[showing.index]?.clip
        : undefined;
  const currentShot =
    showing?.kind === 'playlist'
      ? order[showing.index]?.shot
      : board?.shots.find(shot => current && shot.jobIds.includes(current.jobId));
  const caption = current
    ? `Shot ${(board?.shots.findIndex(shot => shot.id === currentShot?.id) ?? -1) + 1}${
        currentShot?.title ? ` · ${currentShot.title}` : ''
      } · take ${(currentShot?.jobIds.indexOf(current.jobId) ?? -1) + 1}${
        showing?.kind === 'playlist' ? ` · ${showing.index + 1} of ${order.length}` : ''
      }`
    : order.length
      ? 'Pick a take, or play the keepers in order.'
      : 'Make a take of a shot to see it here.';

  useEffect(() => {
    if (current) void player.current?.play().catch(() => undefined);
  }, [current]);

  const makeTake = async (shot: Shot) => {
    if (!board) return;
    setMaking(shot.id);
    setError('');
    try {
      const jobId = await onMakeTake(shot.prompt.trim() || defaultPrompt);
      change(addTake(latest.current ?? board, shot.id, jobId), true);
    } catch (cause) {
      setError(actionErrorMessage(cause));
    } finally {
      setMaking(undefined);
    }
  };

  return (
    <Modal title="Shot board" onClose={onClose}>
      <div className="shot-board">
        <div className="shot-player">
          <div className="shot-screen">
            {current && safeVideoHistoryUrl(current) ? (
              <video
                ref={player}
                key={current.id}
                src={safeVideoHistoryUrl(current)}
                controls
                playsInline
                onEnded={() =>
                  showing?.kind === 'playlist' &&
                  showing.index + 1 < order.length &&
                  setShowing({ kind: 'playlist', index: showing.index + 1 })
                }
              />
            ) : (
              <Clapperboard size={36} aria-hidden="true" />
            )}
          </div>
          <p className="shot-caption">{caption}</p>
          <div className="shot-player-actions">
            <button
              type="button"
              className="primary"
              disabled={!order.length}
              onClick={() => setShowing({ kind: 'playlist', index: 0 })}
            >
              <Play size={14} />
              Play keepers
            </button>
            <span className="muted small">
              {order.length} of {board?.shots.length ?? 0} shots have a clip
            </span>
          </div>
          {error && <p className="inline-error small">{error}</p>}
        </div>
        <div className="shot-list">
          {!board ? (
            <p className="muted">Opening…</p>
          ) : (
            <>
              {board.shots.map((shot, index) => (
                <section key={shot.id} className="shot-row" aria-label={`Shot ${index + 1}`}>
                  <div className="shot-head">
                    <b className="shot-number">{index + 1}</b>
                    <input
                      aria-label="Shot name"
                      placeholder={`Shot ${index + 1}`}
                      maxLength={80}
                      value={shot.title}
                      onChange={event => editShot(shot.id, { title: event.target.value })}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Move up"
                      disabled={index === 0}
                      onClick={() => change(moveShot(board, shot.id, -1), true)}
                    >
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Move down"
                      disabled={index === board.shots.length - 1}
                      onClick={() => change(moveShot(board, shot.id, 1), true)}
                    >
                      <ArrowDown size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Remove shot"
                      title="Remove shot (the clips stay in your videos)"
                      onClick={() => change({ ...board, shots: board.shots.filter(item => item.id !== shot.id) }, true)}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                  <textarea
                    rows={2}
                    aria-label="Shot prompt"
                    placeholder="What happens in this shot"
                    maxLength={4000}
                    value={shot.prompt}
                    onChange={event => editShot(shot.id, { prompt: event.target.value })}
                  />
                  <div className="shot-takes">
                    {shot.jobIds.map((jobId, take) => {
                      const record = byJob.get(jobId);
                      const job = jobById.get(jobId);
                      const keeper = shot.keeperJobId === jobId;
                      if (!record)
                        return (
                          <div key={jobId} className="shot-take waiting">
                            <span>
                              {job?.status === 'running'
                                ? `${job.progressMax ? Math.round((job.progress / job.progressMax) * 100) : 0}%`
                                : job?.status === 'queued'
                                  ? 'Waiting'
                                  : job?.status === 'failed' || job?.status === 'cancelled'
                                    ? 'Failed'
                                    : 'Gone'}
                            </span>
                            {(!job || job.status === 'failed' || job.status === 'cancelled') && (
                              <button
                                type="button"
                                className="shot-take-remove"
                                aria-label="Remove take"
                                onClick={() => change(removeTake(board, shot.id, jobId), true)}
                              >
                                <X size={12} />
                              </button>
                            )}
                          </div>
                        );
                      return (
                        <div
                          key={jobId}
                          className={`shot-take${keeper ? ' keeper' : ''}${current?.jobId === jobId ? ' showing' : ''}`}
                        >
                          <button
                            type="button"
                            className="shot-take-view"
                            aria-label={`Play take ${take + 1}`}
                            onClick={() => setShowing({ kind: 'take', jobId })}
                          >
                            {safeVideoHistoryUrl(record) && (
                              <video src={safeVideoHistoryUrl(record)} muted playsInline preload="metadata" />
                            )}
                            <small>{take + 1}</small>
                          </button>
                          <button
                            type="button"
                            className="shot-take-star"
                            aria-pressed={keeper}
                            aria-label={keeper ? 'Keeper. Click to unstar' : 'Make this the keeper'}
                            title={keeper ? 'Keeper' : 'Make this the keeper'}
                            onClick={() => change(toggleKeeper(board, shot.id, jobId), true)}
                          >
                            <Star size={12} fill={keeper ? 'currentColor' : 'none'} />
                          </button>
                          <button
                            type="button"
                            className="shot-take-remove"
                            aria-label="Take off the board"
                            title="Take off the board (the clip stays in your videos)"
                            onClick={() => change(removeTake(board, shot.id, jobId), true)}
                          >
                            <X size={12} />
                          </button>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className="shot-take-add"
                      disabled={Boolean(takeBlocked) || Boolean(making) || shot.jobIds.length >= TAKE_LIMIT}
                      title={takeBlocked || 'Make a new take with your current video settings'}
                      onClick={() => void makeTake(shot)}
                    >
                      <Plus size={14} />
                      {making === shot.id ? 'Queueing…' : 'Take'}
                    </button>
                    {selected && !shot.jobIds.includes(selected.jobId) && (
                      <button
                        type="button"
                        className="text-button small"
                        disabled={shot.jobIds.length >= TAKE_LIMIT}
                        title="Add the video selected in your videos list"
                        onClick={() => change(addTake(board, shot.id, selected.jobId), true)}
                      >
                        Add selected video
                      </button>
                    )}
                  </div>
                </section>
              ))}
              <button
                type="button"
                className="shot-add"
                disabled={board.shots.length >= SHOT_LIMIT}
                onClick={() => change({ ...board, shots: [...board.shots, newShot()] }, true)}
              >
                <Plus size={15} />
                Add shot
              </button>
              <p className="muted small">New takes use your current video settings with the shot’s prompt.</p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Clapperboard, FolderOpen, RotateCcw, Sparkles, Undo2 } from 'lucide-react';
import type { AppSnapshot, GenerationRecord } from '../shared/types';
import { isVideoJob } from '../shared/types';
import type { VideoDraft, VideoHistoryRecord } from '../shared/video-types';
import { DEFAULT_VIDEO_DRAFT } from '../shared/video-plan';
import { videoProfileReady } from '../shared/video-assets';
import { videoConversationSchema, type VideoConversation, type VideoEditorSession } from '../shared/video-conversation';
import { actionErrorMessage } from '../shared/action-error';
import { VideoAssetSetup } from './VideoAssetSetup';
import { VideoDock } from './VideoDock';
import type { VideoMissingItem } from './video-missing';
import { VideoClips, activeVideoJobs, jobPercent } from './VideoClips';
import { applyVideoHistoryRestore, selectVideoHistory } from './video-history-state';
import { videoHistoryRevision } from './queue-view';
import { estimateVideoMs, formatDuration, safeVideoHistoryUrl } from './video-url';
import { Busy, Notice, type RunAction } from './ui';
import './video-studio.css';
import './video-page.css';
import { AssistantPanel, assistantAnchor } from './assistant/AssistantPanel';
import { openAssistantSettings } from './assistant/open-settings';
import { ShotBoard } from './ShotBoard';
import { DEFAULT_DRAFT } from '../shared/defaults';

function newSession(initial: VideoDraft = DEFAULT_VIDEO_DRAFT): VideoEditorSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'Untitled video',
    createdAt: now,
    updatedAt: now,
    draft: structuredClone(initial),
  };
}
export interface VideoStudioProps {
  snapshot: AppSnapshot;
  selectedRecord?: GenerationRecord;
  visible: boolean;
  run: RunAction;
  /** Opens Settings on the Assistant tab. */
  onOpenSettings?: () => void;
}
/** Remains mounted after first opening so navigation cannot discard a pending close flush. */
export function VideoStudio({
  snapshot,
  selectedRecord: selectedImage,
  visible,
  run,
  onOpenSettings,
}: VideoStudioProps) {
  const [assistantPlace, setAssistantPlace] = useState<CSSProperties>();
  const [shotBoardOpen, setShotBoardOpen] = useState(false);
  const makeSession = () => newSession(DEFAULT_VIDEO_DRAFT);
  const [conversation, setConversation] = useState<VideoConversation>();
  const current = useRef<VideoConversation | undefined>(undefined);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  const closing = useRef(false);
  const closeEpoch = useRef(0);
  const closeRequested = useRef(false);
  const pendingQueue = useRef<Promise<unknown> | undefined>(undefined);
  const [previous, setPrevious] = useState<{ id: string; draft: VideoDraft }>();
  const [history, setHistory] = useState<VideoHistoryRecord[]>([]);
  const [historyWarnings, setHistoryWarnings] = useState<string[]>([]);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [draftLoadError, setDraftLoadError] = useState('');
  const [draftLoading, setDraftLoading] = useState(false);
  const historyRequest = useRef(0);
  const draftRequest = useRef(0);
  const actionPending = useRef(false);
  const historyRevision = videoHistoryRevision(snapshot.jobs);
  const [assetCancelPending, setAssetCancelPending] = useState(false);
  const assetCancelInFlight = useRef(false);
  const loadHistory = useCallback(async () => {
    const request = ++historyRequest.current;
    setHistoryLoading(true);
    try {
      const result = await window.latent.getVideoHistory();
      if (request !== historyRequest.current) return;
      setHistory(result.records);
      setHistoryWarnings(result.warnings);
      setHistoryError('');
    } catch (cause) {
      if (request === historyRequest.current) setHistoryError(`Couldn’t load your clips: ${actionErrorMessage(cause)}`);
    } finally {
      if (request === historyRequest.current) setHistoryLoading(false);
    }
  }, []);
  const loadDrafts = useCallback(async () => {
    const request = ++draftRequest.current;
    setDraftLoading(true);
    try {
      let value = await window.latent.getVideoConversation();
      if (request !== draftRequest.current || current.current) return;
      if (!value) {
        const session = makeSession();
        value = { schema: 1, activeSessionId: session.id, sessions: [session] };
      } else {
        if (!value.sessions.some(item => item.id === value!.activeSessionId)) {
          const session = value.sessions[0] ?? makeSession();
          value = {
            ...value,
            activeSessionId: session.id,
            sessions: value.sessions.length ? value.sessions : [session],
          };
        }
      }
      current.current = value;
      setConversation(value);
      setDraftLoadError('');
    } catch (cause) {
      if (request === draftRequest.current)
        setDraftLoadError(`Couldn’t open the video settings: ${actionErrorMessage(cause)}`);
    } finally {
      if (request === draftRequest.current) setDraftLoading(false);
    }
  }, []);
  const persist = useCallback((force = false) => {
    if (!current.current || (!force && revision.current === savedRevision.current)) return pendingSave.current;
    const value = videoConversationSchema.parse(structuredClone(current.current));
    const captured = revision.current;
    const request = pendingSave.current
      .catch(() => undefined)
      .then(() => window.latent.saveVideoConversation(value))
      .then(() => {
        savedRevision.current = captured;
      })
      .catch(cause => {
        if (revision.current === captured) {
          setError(`Couldn’t save the video settings: ${actionErrorMessage(cause)}`);
        }
        throw cause;
      });
    pendingSave.current = request;
    return request;
  }, []);
  const flush = useCallback(async () => {
    clearTimeout(timer.current);
    await pendingSave.current.catch(() => undefined);
    // History selection and editor changes can arrive while a previous IPC save is pending.
    // A close acknowledgment must include every revision observed before this drain finishes.
    do {
      await persist();
      clearTimeout(timer.current);
    } while (revision.current !== savedRevision.current);
  }, [persist]);
  useEffect(() => {
    void loadDrafts();
    return () => {
      draftRequest.current++;
      historyRequest.current++;
      clearTimeout(timer.current);
    };
  }, [loadDrafts]);
  useEffect(() => {
    if (visible) void loadHistory();
  }, [visible, loadHistory, historyRevision]);
  useEffect(() => {
    const beforeClose = window.latent.onBeforeClose(async () => {
      closeRequested.current = true;
      const requestedEpoch = ++closeEpoch.current;
      try {
        await pendingQueue.current;
        await flush();
        if (revision.current !== savedRevision.current)
          throw new Error('The video settings changed while saving. Try closing again.');
        if (requestedEpoch === closeEpoch.current) closing.current = true;
      } catch (cause) {
        if (requestedEpoch === closeEpoch.current) closeRequested.current = false;
        throw cause;
      }
    });
    const cancelled = window.latent.onCloseCancelled(() => {
      closeEpoch.current++;
      closing.current = false;
      closeRequested.current = false;
    });
    const hidden = () => {
      if (document.visibilityState === 'hidden' && !closing.current) void flush().catch(() => undefined);
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      beforeClose();
      cancelled();
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [flush]);
  const commit = (value: VideoConversation, selectionOnly = false) => {
    if (closing.current) return;
    current.current = value;
    setConversation(value);
    revision.current++;
    if (!selectionOnly) {
      setError('');
      setMessage('');
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void persist().catch(() => undefined);
    }, 300);
  };
  const updateSession = (patch: Partial<VideoEditorSession>) => {
    const value = current.current;
    if (!value) return;
    commit({
      ...value,
      sessions: value.sessions.map(item =>
        item.id === value!.activeSessionId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item,
      ),
    });
  };
  const action = (key: string, task: () => Promise<void>) => {
    if (closing.current || closeRequested.current || actionPending.current) return;
    actionPending.current = true;
    setPendingAction(key);
    setError('');
    void run(`video-${key}`, async () => {
      try {
        await task();
      } catch (cause) {
        setError(actionErrorMessage(cause));
        throw cause;
      }
    }).finally(() => {
      actionPending.current = false;
      setPendingAction('');
    });
  };
  const active = conversation?.sessions.find(item => item.id === conversation.activeSessionId);
  const cancelAssetSetup = () => {
    if (assetCancelInFlight.current || !['installing', 'verifying'].includes(snapshot.video.assets?.state ?? ''))
      return;
    assetCancelInFlight.current = true;
    setAssetCancelPending(true);
    // Cancellation must remain available while the long setup action is pending.
    void run('video-assets-cancel', async () => {
      try {
        await window.latent.cancelVideoAssetSetup();
      } catch (cause) {
        setError(actionErrorMessage(cause));
        throw cause;
      }
    }).finally(() => {
      assetCancelInFlight.current = false;
      setAssetCancelPending(false);
    });
  };
  const selectSavedVideo = (id: string) => {
    if (!current.current) {
      setError('The video settings are still opening.');
      return;
    }
    try {
      commit(selectVideoHistory(current.current, id, makeSession), true);
    } catch (cause) {
      setError(actionErrorMessage(cause));
    }
  };
  const reuseSavedVideo = (id: string) =>
    action('reuse', async () => {
      if (!current.current) throw new Error('The video settings are still opening.');
      const captured = revision.current;
      const proposal = await window.latent.restoreVideoParameters(id);
      if (closing.current) throw new Error('Latent is closing.');
      const result = applyVideoHistoryRestore(current.current, proposal, id, captured, revision.current, makeSession);
      commit(result.conversation);
      setPrevious(result.previous);
      setMessage('Settings loaded, seed included.');
    });
  const attachSource = (
    role: 'firstFrame' | 'lastFrame',
    load: () => ReturnType<typeof window.latent.importSourceImage>,
  ) =>
    action('source', async () => {
      const captured = revision.current;
      const source = await load();
      if (!source || closing.current) return;
      if (captured !== revision.current || !current.current?.activeSessionId) {
        setMessage('Image added. Pick it from the frame slot.');
        return;
      }
      const session = current.current.sessions.find(item => item.id === current.current!.activeSessionId)!;
      updateSession({
        draft: {
          ...session.draft,
          mode: 'img2vid',
          [role]: { sourceId: source.id, sha256: source.normalized.sha256 },
        },
      });
    });
  const queueVideo = () =>
    action('queue', async () => {
      if (!snapshot.video.canGenerate) throw new Error(snapshot.video.message);
      const session = current.current?.sessions.find(item => item.id === current.current?.activeSessionId);
      if (!session) throw new Error('The video settings are still opening.');
      const captured = revision.current,
        preparationEpoch = closeEpoch.current;
      const frozen = structuredClone(session.draft);
      await flush();
      if (closeRequested.current || preparationEpoch !== closeEpoch.current)
        throw new Error('Latent is closing, so the clip wasn’t started.');
      if (captured !== revision.current || closing.current)
        throw new Error('The settings changed while saving. Press Make clip again.');
      const request = window.latent.queueVideo(frozen);
      pendingQueue.current = request;
      try {
        const job = await request;
        setMessage('');
        commit(selectVideoHistory(current.current!, job.id, makeSession), true);
      } finally {
        if (pendingQueue.current === request) pendingQueue.current = undefined;
      }
    });
  /** One take for the shot board: the current settings with the shot's prompt. */
  const makeTake = async (prompt: string) => {
    if (!snapshot.video.canGenerate) throw new Error(snapshot.video.message);
    const session = current.current?.sessions.find(item => item.id === current.current?.activeSessionId);
    if (!session) throw new Error('The video settings are still opening.');
    if (closing.current || closeRequested.current) throw new Error('The studio is closing.');
    const job = await window.latent.queueVideo({ ...structuredClone(session.draft), prompt });
    return job.id;
  };
  const [solBusy, setSolBusy] = useState(false);
  const installSol = () => {
    if (solBusy) return;
    setSolBusy(true);
    void run(
      'video-sol',
      async () => {
        try {
          await window.latent.installSolAttention();
          const now = current.current?.sessions.find(item => item.id === current.current?.activeSessionId)?.draft;
          if (now) updateSession({ draft: { ...now, speed: { ...now.speed, attention: 'sage-sol' } } });
        } catch (cause) {
          setError(actionErrorMessage(cause));
          throw cause;
        }
      },
      'Sol is installed. The engine restarted.',
    ).finally(() => setSolBusy(false));
  };
  const [gettingMissing, setGettingMissing] = useState(false);
  /** One button for everything a clip needs: files, finishing models and engine add-ons, one after another. */
  const getMissing = (items: VideoMissingItem[]) => {
    const profile = active?.draft.profile;
    if (gettingMissing || !profile) return;
    setGettingMissing(true);
    void run(
      'video-missing',
      async () => {
        try {
          for (const item of items) {
            if (item.kind === 'files') await window.latent.setupVideoAssets(profile);
            else if (item.kind === 'extra') await window.latent.installVideoExtra(item.id);
            else if (item.kind === 'sage') await window.latent.installSageAttention();
            else await window.latent.installSolAttention();
          }
          setMessage('');
        } catch (cause) {
          setError(actionErrorMessage(cause));
          throw cause;
        }
      },
      'All set. You can make the clip now.',
    ).finally(() => setGettingMissing(false));
  };
  const draft = active?.draft;
  const selectedId = active?.selectedRecordId ?? activeVideoJobs(snapshot.jobs)[0]?.id ?? history[0]?.id;
  const selectedJob = snapshot.jobs.find(job => job.id === selectedId && isVideoJob(job));
  const selectedRecord = history.find(record => record.id === selectedId);
  const showJob = selectedJob && isVideoJob(selectedJob) && !selectedRecord ? selectedJob : undefined;
  const filesReady = draft ? videoProfileReady(snapshot.video.assets, draft.profile) : false;
  const assetsBusy = ['installing', 'verifying'].includes(snapshot.video.assets?.state ?? '');
  const estimateMs = draft ? estimateVideoMs(draft, history) : undefined;
  const url = selectedRecord && safeVideoHistoryUrl(selectedRecord);
  const percent = showJob ? jobPercent(showJob) : 0;
  return (
    <div className="vp">
      <div className="vp-main">
        <div className="vp-toolbar">
          {previous && previous.id === active?.id && (
            <button
              type="button"
              className="vp-ghost"
              onClick={() => {
                updateSession({ draft: structuredClone(previous.draft) });
                setPrevious(undefined);
              }}
            >
              <Undo2 size={15} /> Undo
            </button>
          )}
          <span className="vp-spacer" />
          <button type="button" className="vp-ghost" onClick={() => setShotBoardOpen(true)}>
            <Clapperboard size={15} /> Shot board
          </button>
          <button
            type="button"
            className="vp-ghost"
            disabled={!active}
            aria-expanded={Boolean(assistantPlace)}
            onClick={event => {
              const rect = event.currentTarget.getBoundingClientRect();
              setAssistantPlace(place => (place ? undefined : assistantAnchor(rect)));
            }}
          >
            <Sparkles size={15} /> Help me write
          </button>
        </div>
        {(error || draftLoadError || historyError || message) && (
          <div className="vp-notices">
            {error && <Notice error>{error}</Notice>}
            {draftLoadError && <Notice error>{draftLoadError}</Notice>}
            {historyError && <Notice error>{historyError}</Notice>}
            {message && <Notice>{message}</Notice>}
          </div>
        )}
        <div className="vp-stage">
          {!conversation ? (
            <div className="vp-placeholder">
              <Busy active={draftLoading} />
              <p>{draftLoadError ? 'Your saved settings were left as they were.' : 'Opening video settings…'}</p>
              {draftLoadError && (
                <button type="button" disabled={draftLoading} onClick={() => void loadDrafts()}>
                  Try again
                </button>
              )}
            </div>
          ) : draft && (!filesReady || assetsBusy) ? (
            <VideoAssetSetup
              status={snapshot.video.assets}
              profile={draft.profile}
              busy={Boolean(pendingAction)}
              cancelBusy={assetCancelPending}
              onSetup={profile =>
                action('assets-setup', async () => {
                  await window.latent.setupVideoAssets(profile);
                  setMessage('');
                })
              }
              onVerify={profile =>
                action('assets-verify', async () => {
                  await window.latent.verifyVideoAssets(profile);
                  setMessage('');
                })
              }
              onCancel={cancelAssetSetup}
            />
          ) : showJob ? (
            <div
              className="vp-screen vp-making"
              style={{ aspectRatio: `${showJob.video.width} / ${showJob.video.height}` }}
            >
              <div className="vp-making-card" role="status">
                <strong>
                  {showJob.status === 'running'
                    ? 'Making your clip'
                    : showJob.status === 'queued'
                      ? 'Waiting its turn'
                      : 'This clip didn’t finish'}
                </strong>
                {showJob.status === 'running' && (
                  <>
                    <div className="vp-bar">
                      <span style={{ width: `${percent}%` }} />
                    </div>
                    <span>
                      {showJob.phase ?? 'Getting ready'}
                      {showJob.progressMax
                        ? ` · step ${Math.min(showJob.progress, showJob.progressMax)} of ${showJob.progressMax}`
                        : ''}
                    </span>
                  </>
                )}
                {showJob.status === 'failed' && showJob.error && <span className="vp-error-text">{showJob.error}</span>}
                <span className="vp-dim">{showJob.video.prompt}</span>
              </div>
            </div>
          ) : selectedRecord && url ? (
            <div
              className="vp-screen"
              style={{ aspectRatio: `${selectedRecord.media.width} / ${selectedRecord.media.height}` }}
            >
              {visible && <video key={selectedRecord.id} src={url} controls playsInline loop />}
            </div>
          ) : (
            <div className="vp-placeholder">
              <p>Your clip plays here.</p>
              <p className="vp-dim">Describe what happens below, then press Make clip.</p>
            </div>
          )}
          {selectedRecord && filesReady && !assetsBusy && !showJob && (
            <div className="vp-under">
              <span className="vp-dim">
                {selectedRecord.media.width}×{selectedRecord.media.height} ·{' '}
                {selectedRecord.media.durationSeconds.toFixed(1)} s
                {selectedRecord.plan ? ` · seed ${selectedRecord.plan.actualSeed}` : ''}
                {selectedRecord.elapsedMs ? ` · made in ${formatDuration(selectedRecord.elapsedMs)}` : ''}
              </span>
              <span className="vp-spacer" />
              <button
                type="button"
                className="vp-ghost"
                disabled={Boolean(pendingAction)}
                onClick={() => reuseSavedVideo(selectedRecord.id)}
              >
                <RotateCcw size={14} /> Reuse settings
              </button>
              <button
                type="button"
                className="vp-ghost"
                onClick={() => action('reveal', () => window.latent.revealVideo(selectedRecord.id))}
              >
                <FolderOpen size={14} /> Show file
              </button>
            </div>
          )}
        </div>
        {draft && (
          <VideoDock
            draft={draft}
            status={snapshot.video}
            sources={snapshot.sourceImages.sources}
            busy={Boolean(pendingAction) && pendingAction !== 'reveal'}
            estimateMs={estimateMs}
            selectedImageAvailable={Boolean(selectedImage)}
            lastSeed={history[0]?.plan?.actualSeed}
            onChange={next => updateSession({ draft: next })}
            onImportSource={role => attachSource(role, () => window.latent.importSourceImage())}
            onUseSelectedImage={role =>
              selectedImage && attachSource(role, () => window.latent.useOutputAsSource(selectedImage.id))
            }
            onInstallSol={installSol}
            solBusy={solBusy}
            sage={snapshot.sageAttention.state}
            onGetMissing={getMissing}
            gettingMissing={gettingMissing}
            onGenerate={queueVideo}
          />
        )}
      </div>
      <VideoClips
        jobs={snapshot.jobs}
        records={history}
        selectedId={selectedId}
        warnings={historyWarnings}
        loading={historyLoading}
        onSelect={selectSavedVideo}
        onSelectJob={selectSavedVideo}
        onCancel={id => action('cancel', () => window.latent.cancelJob(id))}
        onRetrySave={id => action('retry-save', () => window.latent.retryVideoSave(id))}
      />
      {visible && assistantPlace && active && (
        <AssistantPanel
          target="video"
          videoContext={active.draft}
          status={snapshot.assistant}
          draft={{ ...DEFAULT_DRAFT, prompt: active.draft.prompt, negativePrompt: '' }}
          place={assistantPlace}
          images={
            active.draft.mode === 'img2vid' && active.draft.firstFrame
              ? [{ ref: { kind: 'source', id: active.draft.firstFrame.sourceId }, label: 'First frame' }]
              : []
          }
          onClose={() => setAssistantPlace(undefined)}
          onOpenSettings={() => {
            setAssistantPlace(undefined);
            openAssistantSettings();
            onOpenSettings?.();
          }}
          onApply={option => {
            setPrevious({ id: active.id, draft: structuredClone(active.draft) });
            updateSession({ draft: { ...active.draft, prompt: option.prompt } });
          }}
        />
      )}
      {visible && shotBoardOpen && (
        <ShotBoard
          records={history}
          jobs={snapshot.jobs}
          selectedRecordId={selectedRecord?.id ?? history[0]?.id}
          defaultPrompt={active?.draft.prompt ?? ''}
          takeBlocked={
            !snapshot.video.canGenerate
              ? snapshot.video.message
              : !active
                ? 'The video settings are still opening.'
                : undefined
          }
          onMakeTake={makeTake}
          onClose={() => setShotBoardOpen(false)}
        />
      )}
    </div>
  );
}

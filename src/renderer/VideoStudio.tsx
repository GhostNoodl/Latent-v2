import { useCallback, useEffect, useRef, useState } from 'react';
import { Undo2 } from 'lucide-react';
import type { AppSnapshot, GenerationRecord } from '../shared/types';
import type { VideoDraft, VideoHistoryRecord, VideoPlan } from '../shared/video-types';
import { DEFAULT_VIDEO_DRAFT } from '../shared/video-plan';
import { videoConversationSchema, type VideoConversation, type VideoEditorSession } from '../shared/video-conversation';
import { actionErrorMessage } from '../shared/action-error';
import { VideoPlanner } from './VideoPlanner';
import { VideoHistory } from './VideoHistory';
import { VideoAssetSetup } from './VideoAssetSetup';
import { applyVideoHistoryRestore, selectVideoHistory } from './video-history-state';
import { videoHistoryRevision } from './queue-view';
import { Busy, Notice, Modal, type RunAction } from './ui';
import './video-studio.css';
import { PromptAssistant } from './PromptAssistant';
import { DEFAULT_DRAFT } from '../shared/defaults';

function newSession(initial: VideoDraft = DEFAULT_VIDEO_DRAFT): VideoEditorSession { const now = new Date().toISOString(); return { id: crypto.randomUUID(), name: 'Untitled video', createdAt: now, updatedAt: now, draft: structuredClone(initial) }; }
export interface VideoStudioProps { snapshot: AppSnapshot; selectedRecord?: GenerationRecord; visible: boolean; run: RunAction; }
/** Remains mounted after first opening so navigation cannot discard a pending close flush. */
export function VideoStudio({ snapshot, selectedRecord, visible, run }: VideoStudioProps) {
  const [assistantOpen, setAssistantOpen] = useState(false);
  const makeSession = () => newSession(snapshot.video.assets?.fusedPresent ? { ...DEFAULT_VIDEO_DRAFT, profile: 'fused4', width: 832, height: 480, decodeMode: 'auto' } : DEFAULT_VIDEO_DRAFT);
  const [conversation, setConversation] = useState<VideoConversation>(); const current = useRef<VideoConversation | undefined>(undefined);
  const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [pendingAction, setPendingAction] = useState('');
  const [saveState, setSaveState] = useState<'new' | 'saved' | 'editing' | 'saving' | 'error'>('new');
  const revision = useRef(0); const savedRevision = useRef(0); const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pendingSave = useRef<Promise<void>>(Promise.resolve()); const closing = useRef(false); const closeEpoch = useRef(0);
  const closeRequested = useRef(false); const pendingQueue = useRef<Promise<unknown> | undefined>(undefined);
  const [plan, setPlan] = useState<VideoPlan>(); const [previous, setPrevious] = useState<{ id: string; draft: VideoDraft }>();
  const [fixture, setFixture] = useState<VideoHistoryRecord>();
  const [history, setHistory] = useState<VideoHistoryRecord[]>([]); const [historyWarnings, setHistoryWarnings] = useState<string[]>([]);
  const [historyError, setHistoryError] = useState(''); const [historyLoading, setHistoryLoading] = useState(false);
  const [draftLoadError, setDraftLoadError] = useState(''); const [draftLoading, setDraftLoading] = useState(false);
  const historyRequest = useRef(0); const draftRequest = useRef(0); const actionPending = useRef(false);
  const historyRevision = videoHistoryRevision(snapshot.jobs);
  const [assetCancelPending, setAssetCancelPending] = useState(false); const assetCancelInFlight = useRef(false);
  const loadHistory = useCallback(async () => {
    const request = ++historyRequest.current; setHistoryLoading(true);
    try { const result = await window.latent.getVideoHistory(); if (request !== historyRequest.current) return; setHistory(result.records); setHistoryWarnings(result.warnings); setHistoryError(''); }
    catch (cause) { if (request === historyRequest.current) setHistoryError(`Could not refresh saved videos: ${actionErrorMessage(cause)}`); }
    finally { if (request === historyRequest.current) setHistoryLoading(false); }
  }, []);
  const loadDrafts = useCallback(async () => {
    const request = ++draftRequest.current; setDraftLoading(true);
    try {
      let value = await window.latent.getVideoConversation(); if (request !== draftRequest.current || current.current) return;
      if (!value) { const session = makeSession(); value = { schema: 1, activeSessionId: session.id, sessions: [session] }; } else { if (!value.sessions.some(item => item.id === value!.activeSessionId)) { const session = value.sessions[0] ?? makeSession(); value = { ...value, activeSessionId: session.id, sessions: value.sessions.length ? value.sessions : [session] }; } setSaveState('saved'); }
      current.current = value; setConversation(value); setDraftLoadError('');
    } catch (cause) { if (request === draftRequest.current) setDraftLoadError(`Could not open saved video drafts: ${actionErrorMessage(cause)}`); }
    finally { if (request === draftRequest.current) setDraftLoading(false); }
  }, []);
  const persist = useCallback((force = false) => {
    if (!current.current || (!force && revision.current === savedRevision.current)) return pendingSave.current;
    const value = videoConversationSchema.parse(structuredClone(current.current)); const captured = revision.current;
    setSaveState('saving');
    const request = pendingSave.current.catch(() => undefined).then(() => window.latent.saveVideoConversation(value)).then(() => {
      savedRevision.current = captured; if (revision.current === captured) setSaveState('saved');
    }).catch(cause => { if (revision.current === captured) { setSaveState('error'); setError(`Could not save the video draft: ${actionErrorMessage(cause)}`); } throw cause; });
    pendingSave.current = request; return request;
  }, []);
  const flush = useCallback(async () => {
    clearTimeout(timer.current); await pendingSave.current.catch(() => undefined);
    // History selection and editor changes can arrive while a previous IPC save is pending.
    // A close acknowledgment must include every revision observed before this drain finishes.
    do { await persist(); clearTimeout(timer.current); } while (revision.current !== savedRevision.current);
  }, [persist]);
  useEffect(() => {
    void loadDrafts();
    return () => { draftRequest.current++; historyRequest.current++; clearTimeout(timer.current); };
  }, [loadDrafts]);
  useEffect(() => { if (visible) void loadHistory(); }, [visible, loadHistory, historyRevision]);
  useEffect(() => {
    const beforeClose = window.latent.onBeforeClose(async () => {
      closeRequested.current = true; const requestedEpoch = ++closeEpoch.current;
      try {
        await pendingQueue.current;
        await flush();
        if (revision.current !== savedRevision.current) throw new Error('The video draft changed while saving. Keep the studio open and try closing again.');
        if (requestedEpoch === closeEpoch.current) closing.current = true;
      } catch (cause) { if (requestedEpoch === closeEpoch.current) closeRequested.current = false; throw cause; }
    });
    const cancelled = window.latent.onCloseCancelled(() => { closeEpoch.current++; closing.current = false; closeRequested.current = false; });
    const hidden = () => { if (document.visibilityState === 'hidden' && !closing.current) void flush().catch(() => undefined); };
    document.addEventListener('visibilitychange', hidden);
    return () => { beforeClose(); cancelled(); document.removeEventListener('visibilitychange', hidden); };
  }, [flush]);
  const commit = (value: VideoConversation, selectionOnly = false) => {
    if (closing.current) return;
    current.current = value; setConversation(value); revision.current++; setSaveState('editing'); if (!selectionOnly) { setPlan(undefined); setError(''); setMessage(''); }
    clearTimeout(timer.current); timer.current = setTimeout(() => { void persist().catch(() => undefined); }, 300);
  };
  const updateSession = (patch: Partial<VideoEditorSession>) => { const value = current.current; if (!value) return; commit({ ...value, sessions: value.sessions.map(item => item.id === value!.activeSessionId ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item) }); };
  const action = (key: string, task: () => Promise<void>) => { if (closing.current || closeRequested.current || actionPending.current) return; actionPending.current = true; setPendingAction(key); setError(''); void run(`video-${key}`, async () => { try { await task(); } catch (cause) { setError(actionErrorMessage(cause)); throw cause; } }).finally(() => { actionPending.current = false; setPendingAction(''); }); };
  const active = conversation?.sessions.find(item => item.id === conversation.activeSessionId);
  const cancelAssetSetup = () => {
    if (assetCancelInFlight.current || !['installing', 'verifying'].includes(snapshot.video.assets?.state ?? '')) return;
    assetCancelInFlight.current = true; setAssetCancelPending(true);
    // Cancellation must remain available while the long setup action is pending.
    void run('video-assets-cancel', async () => {
      try { await window.latent.cancelVideoAssetSetup(); }
      catch (cause) { setError(actionErrorMessage(cause)); throw cause; }
    }).finally(() => { assetCancelInFlight.current = false; setAssetCancelPending(false); });
  };
  const selectSavedVideo = (id: string) => {
    if (!current.current) { setError('Open your saved video settings before selecting a video.'); return; }
    try { commit(selectVideoHistory(current.current, id, makeSession), true); } catch (cause) { setError(actionErrorMessage(cause)); }
  };
  const reuseSavedVideo = (id: string) => action('reuse', async () => {
    if (!current.current) throw new Error('Open your saved video drafts before restoring a recipe.');
    const captured = revision.current;
    const proposal = await window.latent.restoreVideoParameters(id);
    if (closing.current) throw new Error('The studio is closing. Reuse the saved video after opening it again.');
    const result = applyVideoHistoryRestore(current.current, proposal, id, captured, revision.current, makeSession);
    commit(result.conversation); setPrevious(result.previous);
    setMessage('Saved video parameters restored with the actual seed. Undo restores your previous settings.');
  });
  const attachSource = (load: () => ReturnType<typeof window.latent.importSourceImage>) => action('source', async () => {
    const captured = revision.current; const source = await load(); if (!source) return;
    if (closing.current) return;
    if (captured !== revision.current || !current.current?.activeSessionId) { setMessage('Source imported. Choose it from the frame list when ready.'); return; }
    const session = current.current.sessions.find(item => item.id === current.current!.activeSessionId)!;
    updateSession({ draft: { ...session.draft, mode: 'img2vid', firstFrame: { sourceId: source.id, sha256: source.normalized.sha256 } } });
  });
  const reviewPlan = () => action('plan', async () => {
    if (!active) return; const captured = revision.current; const result = await window.latent.planVideoDraft(structuredClone(active.draft));
    if (captured !== revision.current) { setMessage('The draft changed during review. Review the current draft again.'); return; }
    setPlan(result); setMessage('Plan reviewed locally. No generation was queued and no model was downloaded.');
  });
  const queueVideo = () => action('queue', async () => {
    if (!snapshot.video.canGenerate) throw new Error('Video generation is not enabled for this studio configuration.');
    const session = current.current?.sessions.find(item => item.id === current.current?.activeSessionId);
    if (!session) throw new Error('Choose a video draft before generating.');
    const captured = revision.current, preparationEpoch = closeEpoch.current; const frozen = structuredClone(session.draft);
    await flush();
    if (closeRequested.current || preparationEpoch !== closeEpoch.current) throw new Error('Video generation was not submitted because the studio began closing. Generate again when ready.');
    if (captured !== revision.current || closing.current) throw new Error('The video draft changed while saving. Review the current draft before generating.');
    const request = window.latent.queueVideo(frozen); pendingQueue.current = request;
    try {
      const job = await request;
      setMessage(`Video added to the shared queue · seed ${job.actualSeed}. You can keep adjusting settings while it runs.`);
    } finally { if (pendingQueue.current === request) pendingQueue.current = undefined; }
  });
  return <div className="video-studio video-create-layout">
    {error && <Notice error>{error}</Notice>}
    {draftLoadError && <Notice error>{draftLoadError}</Notice>}
    {!conversation ? <section className="settings-card"><Busy active={draftLoading} /><p>{draftLoadError ? 'Saved settings remain untouched.' : 'Opening video settings…'}</p>{draftLoadError && <button type="button" disabled={draftLoading} onClick={() => void loadDrafts()}>Retry opening video settings</button>}</section> : <>
      {active && <VideoPlanner onAssistant={() => setAssistantOpen(true)} saveLabel={saveState === 'saved' ? 'Settings saved' : saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save needs attention' : 'Settings save automatically'} sidebarExtras={<>
        {selectedRecord && <button type="button" disabled={Boolean(pendingAction)} onClick={() => attachSource(() => window.latent.useOutputAsSource(selectedRecord.id))}>Use selected image as first frame</button>}
        {previous && previous.id === active.id && <button type="button" onClick={() => { updateSession({ draft: structuredClone(previous.draft) }); setPrevious(undefined); }}><Undo2 size={14} />Undo settings change</button>}
        {conversation.sessions.length > 1 && <details><summary>Previous setups</summary><label>Load previous setup<select value={conversation.activeSessionId ?? ''} disabled={Boolean(pendingAction)} onChange={event => { commit({ ...conversation, activeSessionId: event.target.value }); setPrevious(undefined); }}>{conversation.sessions.map(session => <option key={session.id} value={session.id}>{session.name.trim() || 'Untitled video'}</option>)}</select></label></details>}
        <details><summary>Playback diagnostic</summary><p>Check local playback with a bundled two-second test clip.</p><button type="button" disabled={Boolean(pendingAction)} onClick={() => action('playback', async () => setFixture(await window.latent.getVideoPlaybackFixture()))}>Open playback diagnostic</button></details>
      </>} assetSetup={<VideoAssetSetup status={snapshot.video.assets} profile={active?.draft.profile ?? 'base'} busy={Boolean(pendingAction)} cancelBusy={assetCancelPending}
      onSetup={profile => action('assets-setup', async () => { await window.latent.setupVideoAssets(profile); setMessage('Video files are ready. Start the engine to generate; each job checks compatibility.'); })}
      onVerify={profile => action('assets-verify', async () => { await window.latent.verifyVideoAssets(profile); setMessage('Saved video files verified. Start the engine to generate.'); })}
      onCancel={cancelAssetSetup} />} draft={active.draft} status={snapshot.video} sources={snapshot.sourceImages.sources} busy={Boolean(pendingAction)} message={message} onChange={draft => updateSession({ draft })} onSaveDraft={() => action('save', async () => { clearTimeout(timer.current); await persist(true); })} onResetDraft={() => { setPrevious({ id: active.id, draft: structuredClone(active.draft) }); updateSession({ draft: structuredClone(makeSession().draft) }); }} onImportSource={() => attachSource(() => window.latent.importSourceImage())} onOpenLicense={() => action('license', () => window.latent.openVideoLicense())} onReviewPlan={reviewPlan} onGenerate={queueVideo} />}
      {plan && <Modal title="Reviewed video plan" onClose={() => setPlan(undefined)}><dl className="metadata"><dt>Output</dt><dd>{plan.width} × {plan.height} · {plan.frames} frames at 24 fps · {plan.durationSeconds.toFixed(4)} s</dd><dt>Seed for this review</dt><dd>{plan.actualSeed}{plan.draft.seed === 'random' && ' · another review resolves a new seed'}</dd><dt>Candidate sampling</dt><dd>{plan.sampling.steps} steps · {plan.sampling.sampler} / {plan.sampling.scheduler}</dd><dt>Sources</dt><dd>{plan.sources.length ? plan.sources.map(source => <p key={source.role}>{source.role === 'first' ? 'First' : 'Last'} frame: {source.originalWidth} × {source.originalHeight} → {plan.width} × {plan.height}, {source.resize === 'center-crop' ? 'center crop' : 'stretch'} with Lanczos. Source identity: {source.sha256}</p>) : 'Text to video; no image references.'}</dd></dl><Notice>Reviewing a plan does not start generation. Current availability is shown above; each submitted job verifies its model files, source images and engine compatibility.</Notice></Modal>}
    </>}
    <VideoHistory studio playbackVisible={visible} records={history} selectedId={active?.selectedRecordId ?? history[0]?.id} loading={historyLoading} error={historyError} warnings={historyWarnings} onRefresh={() => void loadHistory()} reuseDisabled={!conversation || Boolean(pendingAction)} onSelect={selectSavedVideo} onReuse={reuseSavedVideo} onReveal={id => action('reveal', () => window.latent.revealVideo(id))} />
    {visible && assistantOpen && active && <PromptAssistant target="video" videoContext={active.draft} status={snapshot.assistant} draft={{ ...DEFAULT_DRAFT, prompt: active.draft.prompt, negativePrompt: '' }} run={run} onClose={() => setAssistantOpen(false)} onApply={suggestion => { setPrevious({ id: active.id, draft: structuredClone(active.draft) }); updateSession({ draft: { ...active.draft, prompt: suggestion.proposedDraft.prompt } }); }} />}
    {visible && fixture && <Modal title="Playback diagnostic" onClose={() => setFixture(undefined)}><VideoHistory title="Playback diagnostic · no AI model used" records={[fixture]} selectedId={fixture.id} onSelect={() => undefined} onReuse={() => undefined} onReveal={id => action('reveal', () => window.latent.revealVideo(id))} /></Modal>}
  </div>;
}

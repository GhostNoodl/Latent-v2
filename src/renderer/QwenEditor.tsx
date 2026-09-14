import { PackageSetupStorage } from './PackageSetupStorage';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, Check, CircleStop, Dices, Download, FileImage, History, ImagePlus, LoaderCircle, Play, Plus, RotateCcw, Send, Sparkles, Trash2, Undo2 } from 'lucide-react';
import { isImageJob, type AppSnapshot, type GenerationJob, type GenerationRecord } from '../shared/types';
import type { SourceImageAsset } from '../shared/source-types';
import { qwenEditJobRequestSchema, type QwenEditJobRequest } from '../shared/qwen-edit-types';
import { createQwenConversationDraft, QWEN_CONVERSATION_LIMIT, qwenConversationSchema, type QwenConversationDraft, type QwenConversationStore } from '../shared/qwen-conversation';
import { CompareImage } from './CompareImage';
import { bytes, Field, Modal, Notice, shortDate, type RunAction } from './ui';
import { qwenInferenceSize } from '../shared/qwen-edit-canvas';
import { actionErrorMessage as errorMessage } from '../shared/action-error';
import { qwenConversationJobs } from './queue-view';
import './qwen-editor.css';

export interface QwenEditorProps {
  snapshot: AppSnapshot;
  run: RunAction;
  busy: Record<string, boolean>;
  onClose: () => void;
  onSnapshot?: (snapshot: AppSnapshot) => void;
  initialRecord?: GenerationRecord;
  initialMode?: 'preview' | 'reuse';
}
/** Live previews use accepted job values, never the previously selected saved version. */
export function QwenLivePreviewDetails({ job }: { job: GenerationJob }) {
  const recipe = job.draft.qwenEdit;
  return <div className="qwen-version-detail" aria-label="Current generation details"><strong>Generating this edit</strong><small>{job.draft.width} × {job.draft.height} saved size · {recipe?.settings.steps ?? job.draft.steps} steps · seed {job.actualSeed}</small><small>Job {job.id.slice(0, 8)}{recipe?.lineage.parentRecordId && ` · parent ${recipe.lineage.parentRecordId.slice(0, 8)}`}</small><p>{recipe?.instruction ?? job.draft.prompt}</p><small>This preview is unfinished. Select a saved version below to continue, branch, or reuse it.</small></div>;
}
export function QwenSelectedStudioImageDetails({ record, locked, onUse }: { record: GenerationRecord; locked: boolean; onUse: () => void }) {
  return <div className="qwen-version-detail" aria-label="Image selected in Create"><strong>{record.width} × {record.height}</strong><small>This image is being previewed from Create. Your saved conversation and current edit input are unchanged.</small><button type="button" disabled={locked} onClick={onUse}><ImagePlus size={14} />Use this image as input</button></div>;
}
/** A submitted job remains durable while offline; that does not mean it is still sampling. */
export function QwenQueueJobDetails({ job }: { job: GenerationJob }) {
  const running = job.status === 'running' && job.queueState === 'running';
  const label = job.status === 'running'
    ? running ? 'Editing image' : job.queueState === 'pending' ? 'Waiting in ComfyUI' : job.queueState === 'submitting' ? 'Submitting to ComfyUI' : 'Checking engine state'
    : job.status === 'queued' ? 'Queued image edit' : job.status === 'failed' ? 'Image edit failed' : job.status === 'completed' ? 'Image edit complete' : 'Image edit cancelled';
  const detail = running ? job.progressMax ? `${job.progress} / ${job.progressMax} steps` : 'Working…'
    : job.status === 'queued' ? 'Saved in the studio queue' : label;
  return <div><strong>{label} · {job.actualSeed}</strong>{running && <progress value={job.progress} max={job.progressMax || 1} />}<small>{job.error || detail}{job.draft.qwenEdit && ` · branch ${job.draft.qwenEdit.lineage.branchId.slice(0, 6)}`}</small></div>;
}
const emptyStore = (): QwenConversationStore => ({ schemaVersion: 1, conversations: [] });
const sourceUrl = (id: string) => `latent-asset://source/${encodeURIComponent(id)}`;
const sizes = Array.from({ length: 13 }, (_, index) => 256 + index * 64);
const clampSize = (size: number) => Math.max(256, Math.min(1024, Math.round(size / 64) * 64));

/** Exact replay derives only from retained recipe metadata, not current bundle
 * defaults or the normal Create draft. Selecting a preview never calls this.
 */
export function qwenReplayDraft(record: GenerationRecord, existing?: QwenConversationDraft): QwenConversationDraft {
  const edit = record.qwenEdit;
  if (!edit) throw new Error('This image does not contain a complete Qwen edit recipe.');
  const plan = edit.plan; const assets = plan.bundle.assets;
  const base = existing ?? createQwenConversationDraft('Replayed image edit', edit.lineage.conversationId);
  return { ...base, id: edit.lineage.conversationId, branchId: edit.lineage.branchId, source: { id: plan.source.id, sha256: plan.source.normalized.sha256, parentRecordId: plan.source.originGenerationId }, selectedRecordId: record.id, instruction: plan.instruction, negativePrompt: plan.negativePrompt, settings: { ...plan.settings, seed: record.actualSeed }, frozenRecipe: { reusedRecordId: record.id, workflowVersion: plan.workflowVersion, assetHashes: { diffusion: assets.diffusion.sha256, encoder: assets.encoder.sha256, vae: assets.vae.sha256, ...(assets.lightning ? { lightning: assets.lightning.sha256 } : {}) } }, updatedAt: new Date().toISOString() };
}

export function QwenEditor({ snapshot, run, busy, onClose, onSnapshot, initialRecord, initialMode = 'preview' }: QwenEditorProps) {
  const [saved, setSaved] = useState<QwenConversationStore>(emptyStore);
  const [loaded, setLoaded] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(''); const [saveError, setSaveError] = useState(''); const [notice, setNotice] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving'>('saved');
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [extraSources, setExtraSources] = useState<SourceImageAsset[]>([]);
  const [previous, setPrevious] = useState<QwenConversationStore>();
  const [compare, setCompare] = useState<GenerationRecord>();
  const [initialPreview, setInitialPreview] = useState<GenerationRecord | undefined>(initialRecord);
  const [showLive, setShowLive] = useState(false); const [imageError, setImageError] = useState('');
  const current = useRef(saved); const live = useRef(snapshot); live.current = snapshot;
  const snapshotReceiver = useRef(onSnapshot); snapshotReceiver.current = onSnapshot;
  const mounted = useRef(true); const hydrated = useRef(false); const closing = useRef(false);
  const version = useRef(0); const persisted = useRef(0); const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const activeActions = useRef(new Set<string>()); const criticalActions = useRef(new Set<Promise<unknown>>());
  const lastQueued = useRef<{ id: string; conversationId: string; selectedRecordId?: string } | undefined>(undefined);
  const loadEpoch = useRef(0); const initial = useRef({ record: initialRecord, mode: initialMode });
  const fieldId = useId();

  const changeStore = useCallback((value: QwenConversationStore) => {
    current.current = structuredClone(value); version.current++;
    if (mounted.current) { setSaved(current.current); setSaveState('pending'); setSaveError(''); }
  }, []);
  const persist = useCallback((value: QwenConversationStore, revision: number) => {
    const task = saveQueue.current.catch(() => {}).then(async () => {
      if (revision <= persisted.current) return;
      if (mounted.current) setSaveState('saving');
      await window.latent.saveQwenConversation(qwenConversationSchema.parse(value)); persisted.current = revision;
      if (mounted.current) { setSaveError(''); setSaveState(persisted.current === version.current ? 'saved' : 'pending'); }
    });
    saveQueue.current = task;
    return task.catch(reason => { if (mounted.current) { setSaveError(errorMessage(reason)); setSaveState('pending'); } throw reason; });
  }, []);
  const flush = useCallback(async () => {
    if (!hydrated.current) return;
    // Preview selection can change while a save is awaiting IPC, including during
    // close. Drain every intervening revision before allowing the editor to leave.
    do { await persist(structuredClone(current.current), version.current); }
    while (persisted.current < version.current);
  }, [persist]);
  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current; setLoading(true); setError('');
    try {
      if (!window.latent?.getQwenConversation) throw new Error('Open the updated desktop app to use the local image editor.');
      const value = qwenConversationSchema.parse(await window.latent.getQwenConversation() ?? emptyStore());
      if (!mounted.current || epoch !== loadEpoch.current) return;
      let next = value;
      const record = initial.current.record;
      if (record?.qwenEdit) {
        const conversationId = record.qwenEdit.lineage.conversationId;
        const existing = next.conversations.find(item => item.id === conversationId);
        if (!existing && next.conversations.length >= QWEN_CONVERSATION_LIMIT) {
          setNotice('This image is previewed, but 50 saved editor drafts already exist. Remove an unused editor draft to replay or branch here.');
        } else {
          const draft = initial.current.mode === 'reuse' ? qwenReplayDraft(record, existing) : { ...(existing ?? createQwenConversationDraft('Image edit', conversationId)), selectedRecordId: record.id };
          next = { ...next, activeConversationId: draft.id, conversations: [...next.conversations.filter(item => item.id !== draft.id), draft] };
          if (initial.current.mode === 'reuse') { setPrevious(value); setNotice('Exact Qwen recipe restored, including its actual seed and recorded model hashes. Generate is still your choice.'); }
        }
      }
      if (!next.activeConversationId && next.conversations.length) next = { ...next, activeConversationId: next.conversations[0].id };
      if (!next.conversations.length) { const draft = createQwenConversationDraft(); next = { ...next, activeConversationId: draft.id, conversations: [draft] }; }
      current.current = next; setSaved(next); hydrated.current = true; setLoaded(true);
      if (JSON.stringify(next) !== JSON.stringify(value)) { version.current++; setSaveState('pending'); }
    } catch (reason) { if (mounted.current && epoch === loadEpoch.current) setError(`Image editor could not be opened: ${errorMessage(reason)}`); }
    finally { if (mounted.current && epoch === loadEpoch.current) setLoading(false); }
  }, []);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; loadEpoch.current++; }; }, [load]);
  useEffect(() => {
    let cancelled = false;
    void window.latent.getSnapshot().then(value => { if (!cancelled) snapshotReceiver.current?.(value); })
      .catch(reason => { if (!cancelled) setError(`Could not refresh image editing readiness: ${errorMessage(reason)}`); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!loaded || closing.current || version.current <= persisted.current) return;
    const timer = window.setTimeout(() => { void flush().catch(() => {}); }, 300); return () => window.clearTimeout(timer);
  }, [saved, loaded, flush]);
  useEffect(() => {
    const hidden = () => { if (!closing.current && document.visibilityState === 'hidden') void flush().catch(() => {}); };
    document.addEventListener('visibilitychange', hidden);
    const resetClose = () => { closing.current = false; if (mounted.current) setPending(value => ({ ...value, close: false })); };
    const before = window.latent?.onBeforeClose?.(async () => {
      closing.current = true; if (mounted.current) setPending(value => ({ ...value, close: true }));
      try { await Promise.all([...criticalActions.current]); await flush(); }
      catch (error) { resetClose(); throw error; }
    });
    const cancelled = window.latent?.onCloseCancelled?.(resetClose);
    return () => { document.removeEventListener('visibilitychange', hidden); before?.(); cancelled?.(); };
  }, [flush]);

  const draft = saved.conversations.find(item => item.id === saved.activeConversationId);
  const sources = useMemo(() => [...new Map([...extraSources, ...snapshot.sourceImages.sources].map(source => [source.id, source])).values()], [snapshot.sourceImages.sources, extraSources]);
  const source = sources.find(item => item.id === draft?.source?.id);
  const sourceChanged = Boolean(draft?.source && (!source || source.normalized.sha256 !== draft.source.sha256 || source.originGenerationId !== draft.source.parentRecordId));
  const records = snapshot.history.filter(record => draft && record.qwenEdit?.lineage.conversationId === draft.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const selected = initialPreview ?? snapshot.history.find(record => record.id === draft?.selectedRecordId) ?? records.at(-1);
  const showingStudioSelection = Boolean(initialPreview && (!initialPreview.qwenEdit || initialPreview.qwenEdit.lineage.conversationId !== draft?.id));
  const jobs = qwenConversationJobs(snapshot.jobs, draft?.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const activeJob = jobs.find(job => job.status === 'running');
  const currentJobs = jobs.filter(job => ['queued', 'running'].includes(job.status));
  const failedJobs = jobs.filter(job => ['failed', 'cancelled'].includes(job.status)).slice(0, 2);
  const historyConversations = [...new Set(snapshot.history.flatMap(record => record.qwenEdit ? [record.qwenEdit.lineage.conversationId] : []))];
  const allConversationIds = [...new Set([...saved.conversations.map(item => item.id), ...historyConversations])];
  const profile = draft?.settings.profile ?? 'base';
  const profileReady = profile === 'base' ? snapshot.qwenEdit.baseReady : snapshot.qwenEdit.fastReady;
  const repairNeeded = snapshot.qwenEdit.state === 'error';
  const installing = snapshot.qwenEdit.state === 'installing' || pending.setup;
  const locked = !loaded || pending.close || pending.source || pending.queue;
  const steps = draft?.settings.steps ?? (profile === 'fast' ? 4 : 40); const guidance = draft?.settings.guidance ?? (profile === 'fast' ? 1 : 4);
  const request: QwenEditJobRequest | undefined = draft?.source ? { mode: 'qwen-edit', sourceId: draft.source.id, sourceSha256: draft.source.sha256, instruction: draft.instruction, negativePrompt: draft.negativePrompt, settings: draft.settings, lineage: { conversationId: draft.id, branchId: draft.branchId, parentRecordId: draft.source.parentRecordId }, assetHashes: draft.frozenRecipe?.assetHashes, workflowVersion: draft.frozenRecipe?.workflowVersion } : undefined;
  const parsedRequest = qwenEditJobRequestSchema.safeParse(request);
  const seedValid = Boolean(draft && (draft.settings.seed === 'random' || /^\d+$/.test(draft.settings.seed) && BigInt(draft.settings.seed) <= BigInt(Number.MAX_SAFE_INTEGER)));
  const sourceParent = source?.originGenerationId ? snapshot.history.find(record => record.id === source.originGenerationId) : undefined;
  const showingLive = Boolean(showLive && snapshot.settings.showGenerationPreview && activeJob?.previewUrl);
  const imageUrl = showingLive ? activeJob!.previewUrl : selected?.imageUrl ?? (source ? sourceUrl(source.id) : undefined);
  useEffect(() => { setImageError(''); }, [imageUrl]);
  useEffect(() => {
    const queued = lastQueued.current; if (!queued) return;
    const job = snapshot.jobs.find(item => item.id === queued.id);
    if (!job || !isImageJob(job) || !['completed', 'failed', 'cancelled'].includes(job.status)) return;
    const output = snapshot.history.find(record => job.outputIds.includes(record.id));
    if (job.status === 'completed' && !output) return;
    lastQueued.current = undefined;
    const draft = current.current.conversations.find(item => item.id === current.current.activeConversationId);
    if (output && draft?.id === queued.conversationId && draft.selectedRecordId === queued.selectedRecordId) {
      changeStore({ ...current.current, conversations: current.current.conversations.map(item => item.id === draft.id ? { ...item, selectedRecordId: output.id } : item) });
      setInitialPreview(undefined); setShowLive(false); setNotice('New version saved. Review it, then Continue from this version for the next edit.');
    }
  }, [snapshot.jobs, snapshot.history, changeStore]);

  const action = useCallback(async (key: string, task: () => Promise<void>, success?: string, critical = false) => {
    if (closing.current || activeActions.current.has(key)) return false;
    activeActions.current.add(key); setPending(value => ({ ...value, [key]: true })); setError('');
    let acceptedWork: Promise<void> | undefined;
    const work = run(`qwen-${key}`, async () => {
      try {
        acceptedWork = task();
        // The parent reports errors as false. Close must observe an accepted
        // request's actual failure, while a declined task adds nothing to drain.
        if (critical) criticalActions.current.add(acceptedWork);
        await acceptedWork;
      } catch (reason) { if (mounted.current) setError(errorMessage(reason)); throw reason; }
    }, success);
    try { return await work; }
    finally { if (acceptedWork) criticalActions.current.delete(acceptedWork); activeActions.current.delete(key); if (mounted.current) setPending(value => ({ ...value, [key]: false })); }
  }, [run]);
  const getDraft = () => current.current.conversations.find(item => item.id === current.current.activeConversationId);
  function replaceDraft(next: QwenConversationDraft, undo = false) {
    if (undo) setPrevious(structuredClone(current.current));
    changeStore({ ...current.current, activeConversationId: next.id, conversations: [...current.current.conversations.filter(item => item.id !== next.id), { ...next, updatedAt: new Date().toISOString() }] });
  }
  function edit(patch: Partial<QwenConversationDraft>, recipeChange = true) {
    const latest = getDraft(); if (!latest) return;
    if (recipeChange && latest.frozenRecipe) setNotice('You changed the restored recipe. Its model/workflow freeze was cleared; the next edit uses the selected current bundle.');
    replaceDraft({ ...latest, ...patch, ...(recipeChange ? { frozenRecipe: undefined } : {}) });
  }
  function selectRecord(record: GenerationRecord) { lastQueued.current = undefined; edit({ selectedRecordId: record.id }, false); setInitialPreview(undefined); setShowLive(false); }
  function canAddConversation(id?: string) { return Boolean(id && current.current.conversations.some(item => item.id === id)) || current.current.conversations.length < QWEN_CONVERSATION_LIMIT; }
  function newConversation() {
    if (!canAddConversation()) { setError('There are 50 saved editor drafts. Remove an unused editor draft before creating another; generated versions are kept.'); return; }
    replaceDraft(createQwenConversationDraft(), true); setInitialPreview(undefined); setShowLive(false); setNotice('New image-edit conversation. Choose a starting image.');
  }
  function openConversation(id: string) {
    const existing = current.current.conversations.find(item => item.id === id);
    if (existing) changeStore({ ...current.current, activeConversationId: id });
    else {
      if (!canAddConversation(id)) { setError('Remove an unused editor draft before reopening this conversation. Its versions remain in the Library.'); return; }
      const latest = [...live.current.history].filter(record => record.qwenEdit?.lineage.conversationId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      replaceDraft({ ...createQwenConversationDraft('Saved image edits', id), selectedRecordId: latest?.id });
    }
    setInitialPreview(undefined); setShowLive(false); setError('');
  }
  function removeDraft() {
    const latest = getDraft(); if (!latest) return;
    setPrevious(structuredClone(current.current)); const conversations = current.current.conversations.filter(item => item.id !== latest.id);
    changeStore({ schemaVersion: 1, conversations, activeConversationId: conversations[0]?.id }); setInitialPreview(undefined);
    setNotice('Saved editor draft removed. Every generated version and its complete recipe remains in the Library.');
  }
  function hasChildren(record: GenerationRecord) {
    return live.current.history.some(item => item.qwenEdit?.lineage.parentRecordId === record.id) || live.current.jobs.some(job => isImageJob(job) && ['queued', 'running'].includes(job.status) && job.draft.qwenEdit?.lineage.parentRecordId === record.id);
  }
  function assignSource(next: SourceImageAsset, parent?: GenerationRecord, forceBranch = false) {
    if (next.originGenerationId !== parent?.id) throw new Error('The imported source does not match the selected parent image. The editor was not changed.');
    const prior = getDraft(); const conversationId = parent?.qwenEdit?.lineage.conversationId;
    let target = conversationId ? current.current.conversations.find(item => item.id === conversationId) : undefined;
    const startingDraft = !conversationId && prior && !prior.source && !live.current.history.some(record => record.qwenEdit?.lineage.conversationId === prior.id) ? prior : undefined;
    if (!target && startingDraft) target = startingDraft;
    if (!target && !canAddConversation(conversationId)) throw new Error('Remove an unused editor draft before starting another conversation. Generated versions are kept.');
    target ??= createQwenConversationDraft(parent ? 'Image edit continuation' : next.name.slice(0, 80), conversationId);
    const branchId = parent?.qwenEdit && !forceBranch && !hasChildren(parent) ? parent.qwenEdit.lineage.branchId : crypto.randomUUID();
    setExtraSources(value => [...value.filter(item => item.id !== next.id), next]);
    replaceDraft({ ...target, branchId, source: { id: next.id, sha256: next.normalized.sha256, parentRecordId: next.originGenerationId }, instruction: startingDraft ? target.instruction : '', frozenRecipe: undefined, selectedRecordId: parent?.id, settings: startingDraft ? target.settings : { ...target.settings, seed: 'random', width: clampSize(parent?.width ?? 512), height: clampSize(parent?.height ?? 512) } }, true);
    setInitialPreview(undefined); setShowLive(false); setNotice(parent ? 'This exact version is now the input. Describe the next change; its parent is retained in the recipe.' : 'Starting image imported. Describe the first change.');
  }
  async function importImage() {
    await action('source', async () => {
      const result = await window.latent.importSourceImage(); if (!result) return;
      const parent = result.originGenerationId ? live.current.history.find(record => record.id === result.originGenerationId) : undefined;
      assignSource(result, parent); await flush(); onSnapshot?.(await window.latent.getSnapshot());
    }, undefined, true);
  }
  async function useRecord(record: GenerationRecord, branch = false) {
    const id = record.qwenEdit?.lineage.conversationId;
    if (!canAddConversation(id) && !(getDraft() && !getDraft()!.source && !id)) { setError('Remove an unused editor draft before branching into this conversation. All versions are kept.'); return; }
    await action('source', async () => { const source = await window.latent.useOutputAsSource(record.id); assignSource(source, record, branch); await flush(); onSnapshot?.(await window.latent.getSnapshot()); }, undefined, true);
  }
  function replay(record: GenerationRecord) {
    try {
    if (!record.qwenEdit || !canAddConversation(record.qwenEdit.lineage.conversationId)) { setError('Remove an unused editor draft before restoring this recipe.'); return; }
    const existing = current.current.conversations.find(item => item.id === record.qwenEdit!.lineage.conversationId);
    replaceDraft(qwenReplayDraft(record, existing), true); setInitialPreview(undefined); setShowLive(false); setNotice('Exact recipe restored with recorded source, instruction, actual seed, settings, and model hashes. Generation has not started.');
    } catch (reason) { setError(`Could not restore this image edit: ${errorMessage(reason)} Recover the original generation metadata. Your editor draft and Undo are unchanged.`); }
  }
  async function queueEdit() {
    if (closing.current || locked || !parsedRequest.success || sourceChanged || !source || !profileReady || live.current.backend.state !== 'ready') return;
    const frozen = structuredClone(parsedRequest.data);
    const submittedVersion = version.current; const selectedRecordId = getDraft()?.selectedRecordId;
    await action('queue', async () => {
      await flush(); const job = await window.latent.enqueueQwenEdit(frozen);
      // Browsing another saved version during preparation is an explicit preview
      // choice. A later acceptance/completion must not take that selection back.
      if (version.current === submittedVersion) { lastQueued.current = { id: job.id, conversationId: frozen.lineage.conversationId, selectedRecordId }; setShowLive(true); }
      onSnapshot?.(await window.latent.getSnapshot()); setNotice(`Image edit queued · seed ${job.actualSeed}. The input and instruction remain available while it runs.`);
    }, undefined, true);
  }
  async function close() {
    if (compare) { setCompare(undefined); return; }
    if (activeActions.current.has('close')) return;
    if (!hydrated.current) { onClose(); return; }
    await action('close', async () => { await Promise.all([...criticalActions.current]); await flush(); closing.current = true; onClose(); });
  }

  return <div className="qwen-editor" onKeyDown={event => { if (!event.nativeEvent.isComposing && !event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (!compare) void queueEdit(); } }}>
    {!compare && <Modal title="Qwen image editor" onClose={() => { void close(); }}>
      <div className="qwen-intro"><div className="qwen-emblem"><Sparkles size={22} /></div><div><strong>A conversation with your image.</strong><p>Make a focused change, inspect the result, then continue or branch from an earlier version.</p></div><span className="qwen-state">Local · experimental</span></div>
      {!profileReady && <PackageSetupStorage packageId={profile === 'fast' ? 'qwen-fast' : 'qwen-base'} />}
      {repairNeeded && !['stopped', 'error', 'not-installed'].includes(snapshot.backend.state) && <p>Stop the image engine in Create before repairing Qwen assets.</p>}<div className="qwen-runtime"><div><strong>{snapshot.qwenEdit.message}</strong><small>Native Qwen Image Edit 2511 · CPU text encoder · Native sampling uses about one megapixel, even for smaller saved images. Memory and quality depend on the recipe.</small>{installing && <><progress max={100} value={Math.max(0, Math.min(100, snapshot.qwenEdit.installProgress ?? 0))} /><small>{snapshot.qwenEdit.activeRole ? `Preparing ${snapshot.qwenEdit.activeRole}` : 'Preparing model bundle'} · {Math.round(snapshot.qwenEdit.installProgress ?? 0)}%</small></>}</div><div className="button-row">{installing ? <button type="button" disabled={pending.cancelSetup} onClick={() => { void action('cancelSetup', () => window.latent.cancelQwenEditSetup()); }}><CircleStop size={15} />Cancel download</button> : <button type="button" disabled={!loaded || pending.setup || (profileReady && !repairNeeded) || (repairNeeded && !['stopped', 'error', 'not-installed'].includes(snapshot.backend.state))} onClick={() => { void action('setup', async () => { await window.latent.setupQwenEdit(profile, repairNeeded); onSnapshot?.(await window.latent.getSnapshot()); }, 'Qwen image-edit bundle is ready.'); }}>{profileReady && !repairNeeded ? <Check size={15} /> : <Download size={15} />}{repairNeeded ? 'Verify / repair Qwen bundle' : profileReady ? `${profile === 'fast' ? 'Fast' : 'Base'} bundle ready` : `Install ${profile === 'fast' ? 'fast' : 'base'} · ${bytes(profile === 'fast' ? snapshot.qwenEdit.fastBytes : snapshot.qwenEdit.baseBytes)}`}</button>}{snapshot.backend.state !== 'ready' && <button type="button" disabled={pending.start || !['stopped', 'error'].includes(snapshot.backend.state)} onClick={() => { void action('start', () => window.latent.startBackend()); }}><Play size={15} />Start image engine</button>}</div></div>
      {snapshot.qwenEdit.verification?.state === 'verifying' && <div className="qwen-runtime" role="status"><div><strong>Model file verification</strong><small>{snapshot.qwenEdit.verification.message}</small><progress aria-label="Model file verification" max={100} value={snapshot.qwenEdit.verification.progress} /><small>{bytes(snapshot.qwenEdit.verification.completedBytes)} of {bytes(snapshot.qwenEdit.verification.totalBytes)} checked</small></div></div>}
      {pending.queue && <p className="qwen-notice" role="status">Preparing edit… Checking the source and model files before adding it to the queue.</p>}
      {(error || saveError) && <Notice error>{error || `Editor draft could not be saved: ${saveError}`}</Notice>}
      {notice && <p className="qwen-notice" role="status">{notice}</p>}
      {loading ? <div className="qwen-loading"><LoaderCircle className="spin" />Opening saved image-edit drafts…</div> : !loaded ? <button type="button" onClick={() => { void load(); }}>Retry opening editor</button> : <>
        <div className="qwen-conversation-bar"><label htmlFor={`${fieldId}-conversation`}>Conversation<select id={`${fieldId}-conversation`} value={draft?.id ?? ''} disabled={locked} onChange={event => openConversation(event.target.value)}><option value="" disabled>Choose a conversation…</option>{allConversationIds.map(id => { const stored = saved.conversations.find(item => item.id === id); const versions = snapshot.history.filter(record => record.qwenEdit?.lineage.conversationId === id).length; return <option key={id} value={id}>{stored?.title ?? 'Saved image edits'} · {versions} version{versions === 1 ? '' : 's'} · {id.slice(0, 6)}{!stored ? ' (history)' : ''}</option>; })}</select></label><div className="button-row"><button type="button" disabled={locked || saved.conversations.length >= QWEN_CONVERSATION_LIMIT} onClick={newConversation}><Plus size={15} />New edit</button><button type="button" disabled={locked || !previous} onClick={() => { if (previous) { changeStore(previous); setPrevious(undefined); setNotice('Previous image-editor draft restored.'); setInitialPreview(undefined); } }}><Undo2 size={15} />Undo</button><button type="button" disabled={locked || !draft} title="Remove only this saved editor draft; retain every generated version" onClick={removeDraft}><Trash2 size={15} />Remove draft</button></div></div>
        {saved.conversations.length >= QWEN_CONVERSATION_LIMIT && <Notice>50 editor drafts are saved. Remove an unused draft to start another conversation. Every generated version remains in the Library.</Notice>}
        <div className="qwen-workspace">
          <section className="qwen-viewer" aria-label="Image versions">
            <div className="qwen-preview-heading"><strong>{showingLive ? 'Live generation preview' : showingStudioSelection ? 'Image selected in Create' : selected ? `Version ${selected.qwenEdit?.lineage.version ?? 'preview'}` : 'Starting image'}</strong>{activeJob?.previewUrl && snapshot.settings.showGenerationPreview && <button type="button" className="text-button" onClick={() => setShowLive(!showLive)}>{showLive ? showingStudioSelection ? 'Show selected image' : 'Show selected version' : 'Show live preview'}</button>}</div>
            <div className="qwen-preview">{imageUrl ? <img src={imageUrl} alt={showingLive ? 'Current generation preview' : showingStudioSelection ? 'Image selected in Create; current edit input unchanged' : selected ? 'Selected saved image version' : 'Starting image for editing'} onError={() => setImageError('The image preview could not be loaded. Its saved recipe is retained.')} /> : <div><FileImage size={38} /><strong>Start with an image.</strong><p>Import an image or choose a saved version to edit.</p></div>}</div>
            {imageError && <p className="qwen-image-error" role="alert">{imageError}</p>}
            {showingLive && activeJob && <QwenLivePreviewDetails job={activeJob} />}
            {!showingLive && showingStudioSelection && selected && <QwenSelectedStudioImageDetails record={selected} locked={locked} onUse={() => { void useRecord(selected); }} />}
            {!showingLive && !showingStudioSelection && selected && <div className="qwen-version-detail"><div><strong>{selected.width} × {selected.height}{selected.qwenEdit && ` · ${selected.qwenEdit.plan.settings.steps} steps · seed ${selected.actualSeed}`}</strong><small>{shortDate(selected.createdAt)}{selected.qwenEdit && ` · branch ${selected.qwenEdit.lineage.branchId.slice(0, 6)}`}{selected.qwenEdit?.lineage.parentRecordId && ` · parent ${selected.qwenEdit.lineage.parentRecordId.slice(0, 8)}`}</small></div>{selected.qwenEdit && <p>{selected.qwenEdit.plan.instruction}</p>}<div className="button-row"><button type="button" disabled={locked} onClick={() => { void useRecord(selected); }}><ImagePlus size={14} />{hasChildren(selected) ? 'Branch from this version' : 'Continue from this version'}</button>{selected.qwenEdit && <><button type="button" disabled={locked} onClick={() => replay(selected)}><RotateCcw size={14} />Reuse exact recipe</button><button type="button" onClick={() => setCompare(selected)}><ArrowLeftRight size={14} />Compare input</button></>}</div></div>}
            <div className="qwen-version-strip" aria-label="Saved versions">{records.length ? records.map(record => <button type="button" key={record.id} className={record.id === selected?.id && !showingLive ? 'selected' : ''} onClick={() => selectRecord(record)} aria-label={`Preview version ${record.qwenEdit!.lineage.version}, branch ${record.qwenEdit!.lineage.branchId.slice(0, 6)}; leave editor input unchanged`} aria-pressed={record.id === selected?.id && !showingLive}><img src={record.imageUrl} alt="" /><span>v{record.qwenEdit!.lineage.version} · {record.qwenEdit!.lineage.branchId.slice(0, 4)}</span></button>) : <p><History size={16} />Generated versions will appear here with their exact edit recipes.</p>}</div>
          </section>
          <section className="qwen-composer" aria-label="Next image edit">
            {draft ? <><Field label="Conversation name"><input value={draft.title} maxLength={80} disabled={locked} onChange={event => edit({ title: event.target.value || 'Untitled image edit' }, false)} /></Field>
              <div className="qwen-source"><div className="label-row"><strong>Input for the next edit</strong><button type="button" disabled={locked} onClick={() => { void importImage(); }}><ImagePlus size={14} />Import image</button></div><Field label="Saved source"><select value={draft.source?.id ?? ''} disabled={locked} onChange={event => { const chosen = sources.find(item => item.id === event.target.value); if (!chosen) return; try { const parent = chosen.originGenerationId ? snapshot.history.find(record => record.id === chosen.originGenerationId) : undefined; assignSource(chosen, parent); } catch (reason) { setError(errorMessage(reason)); } }}><option value="">Choose a starting image…</option>{draft.source && !source && <option value={draft.source.id}>Missing source · {draft.source.id.slice(-8)}</option>}{sources.map(item => <option key={item.id} value={item.id}>{item.name} · {item.normalized.width} × {item.normalized.height}</option>)}</select></Field>{source && <div className="qwen-source-chip"><img src={sourceUrl(source.id)} alt="Current edit input" /><span>{source.name}<small>{source.normalized.width} × {source.normalized.height}{sourceParent?.qwenEdit ? ` · version ${sourceParent.qwenEdit.lineage.version}` : sourceParent ? ' · saved studio image' : ' · imported original'}</small></span></div>}{sourceChanged && <Notice error>The retained input is missing or its identity differs. Choose the intended source explicitly before generating.</Notice>}<small>Choosing a version above previews it. Continue from that version to change this input.</small></div>
              {draft.frozenRecipe && <div className="qwen-frozen"><Check size={14} /><span>Exact recipe replay · source, seed and model hashes retained. Changing the edit or its settings clears the freeze.</span></div>}
              <Field label="What should change?" hint={`${draft.instruction.length.toLocaleString()} / 4,000 characters · Ctrl+Enter to queue`}><textarea value={draft.instruction} maxLength={4000} rows={5} disabled={locked} onChange={event => edit({ instruction: event.target.value })} placeholder="Keep the character and composition. Change the coat to deep red and make the background a rainy street…" /></Field>
              <details><summary>Negative instruction</summary><textarea aria-label="Negative instruction" value={draft.negativePrompt} maxLength={4000} rows={2} disabled={locked} onChange={event => edit({ negativePrompt: event.target.value })} placeholder="Unwanted changes or artifacts…" /></details>
              <Field label="Editing profile" hint={`${steps} steps · CFG ${guidance}${draft.frozenRecipe ? ' · recorded recipe' : ''}`}><select value={profile} disabled={locked || installing} onChange={event => { const profile = event.target.value as 'base' | 'fast'; edit({ settings: { ...draft.settings, profile, steps: profile === 'fast' ? 4 : 40, guidance: profile === 'fast' ? 1 : 4 } }); }}><option value="base">Base · {profile === 'base' ? steps : 40} steps</option><option value="fast">Fast · 4 steps with Lightning adapter</option></select></Field>
              <div className="two-columns"><Field label="Saved width"><select value={draft.settings.width} disabled={locked} onChange={event => edit({ settings: { ...draft.settings, width: Number(event.target.value) } })}>{sizes.map(size => <option key={size}>{size}</option>)}</select></Field><Field label="Saved height"><select value={draft.settings.height} disabled={locked} onChange={event => edit({ settings: { ...draft.settings, height: Number(event.target.value) } })}>{sizes.map(size => <option key={size}>{size}</option>)}</select></Field></div>
              <Field label="Fit input to output"><select value={draft.settings.resize} disabled={locked} onChange={event => edit({ settings: { ...draft.settings, resize: event.target.value as 'stretch' | 'center-crop' } })}><option value="center-crop">Center crop</option><option value="stretch">Stretch to fit</option></select></Field>
              <Field label="Seed" hint="Random chooses a new actual seed when queued."><div className="input-with-button"><input value={draft.settings.seed} maxLength={32} disabled={locked} onChange={event => edit({ settings: { ...draft.settings, seed: event.target.value } })} /><button type="button" disabled={locked} aria-label="Use random seed" onClick={() => edit({ settings: { ...draft.settings, seed: 'random' } })}><Dices size={16} /></button></div></Field>{!seedValid && <p className="qwen-image-error">Use random or a whole-number seed from 0 to {Number.MAX_SAFE_INTEGER.toLocaleString()}. Your unfinished text is saved.</p>}
              <small>{draft.frozenRecipe?.workflowVersion === 'qwen-image-edit-2511-int8@1' ? `Legacy exact replay: samples at ${draft.settings.width} × ${draft.settings.height}; reference dimensions differ for most sizes and can change framing.` : `Native inference and reference: ${qwenInferenceSize(draft.settings.width, draft.settings.height).width} × ${qwenInferenceSize(draft.settings.width, draft.settings.height).height}. Source fitting uses this canvas; the decoded result is resized with Lanczos to the saved dimensions. A smaller saved size does not reduce sampling cost. Eight-pixel rounding can slightly adjust the aspect ratio.`}</small>
              <div className="qwen-queue-action"><small>{snapshot.backend.state !== 'ready' ? 'Start the image engine to queue this edit.' : !profileReady ? 'Install the selected Qwen bundle above.' : !draft.source ? 'Choose an input image.' : !draft.instruction.trim() ? 'Describe the change to make.' : `${draft.settings.width} × ${draft.settings.height} · ${steps} steps · one image`}</small><button type="button" className="primary" disabled={locked || !parsedRequest.success || sourceChanged || !source || !profileReady || snapshot.backend.state !== 'ready'} onClick={() => { void queueEdit(); }}>{pending.queue ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{pending.queue ? 'Preparing edit…' : 'Queue image edit'}</button></div>
            </> : <div className="qwen-no-draft"><p>Create a saved editor draft or open a conversation from history. Removing a draft keeps every generated version.</p><button type="button" onClick={newConversation}><Plus size={15} />New image edit</button></div>}
          </section>
        </div>
        {(currentJobs.length > 0 || failedJobs.length > 0) && <div className="qwen-jobs" aria-label="Image edit queue">{[...currentJobs, ...failedJobs].map(job => <div className="qwen-job" key={job.id}><QwenQueueJobDetails job={job} />{['running', 'queued'].includes(job.status) ? <button type="button" disabled={busy[`cancel-${job.id}`] || pending[`cancel-${job.id}`]} onClick={() => { void action(`cancel-${job.id}`, () => window.latent.cancelJob(job.id), undefined, true); }}><CircleStop size={14} />Cancel</button> : <button type="button" disabled={pending[`retry-${job.id}`] || snapshot.backend.state !== 'ready'} onClick={() => { void action(`retry-${job.id}`, async () => { await window.latent.retryJob(job.id); onSnapshot?.(await window.latent.getSnapshot()); }, undefined, true); }}><RotateCcw size={14} />Retry exact job</button>}</div>)}</div>}
      </>}
      <div className="qwen-footer"><small>{saveState === 'saved' ? 'Editor draft saved locally.' : saveState === 'saving' ? 'Saving editor draft…' : 'Editor draft has unsaved changes.'} Generated versions and full recipes are retained separately in the Library. Closing this editor leaves queued jobs running.</small><div className="button-row">{saveError && <button type="button" onClick={() => { void flush().catch(() => {}); }}>Retry save</button>}<button type="button" disabled={pending.close} onClick={() => { void close(); }}>{pending.close ? <LoaderCircle className="spin" size={15} /> : null}Done</button></div></div>
    </Modal>}
    {compare?.qwenEdit && <CompareImage before={{ url: sourceUrl(compare.qwenEdit.plan.source.id), label: 'Recorded edit input', width: compare.qwenEdit.plan.source.normalized.width, height: compare.qwenEdit.plan.source.normalized.height }} after={{ url: compare.imageUrl, label: `Version ${compare.qwenEdit.lineage.version}`, width: compare.width, height: compare.height }} sourceFittingSize={compare.qwenEdit.plan.canvas?.sourceFitting} alignment={compare.qwenEdit.plan.settings.resize} onClose={() => setCompare(undefined)} />}
  </div>;
}

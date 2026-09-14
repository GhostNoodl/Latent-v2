import { imageSetupReason } from '../shared/setup';
import { SetupHub } from './SetupHub';
import { queueClearKey } from './queue-view';
import { CanvasViewport } from './CanvasViewport';
import { NotificationCenter } from './NotificationCenter';
import { ModelPicker, ModelArtwork, modelDisplayName } from './ModelPicker';
import { CivitaiBrowser } from './CivitaiBrowser';
import { variationDescription } from './variation-description';
import { ImagePreview } from './ImagePreview';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpRight, Boxes, Compass, Check, ChevronDown, ChevronUp, CircleHelp, Dices, Film, Images, ListOrdered, Maximize, Minus, Orbit, Play, Plus, RefreshCw, RotateCcw, Save, Settings2, Sparkles, Sprout, Trash2, Undo2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { isImageJob, isVideoJob, type AppSnapshot, type GenerationDraft, type GenerationRecord, type LoraSelection, type ModelAsset, type StudioJob } from '../shared/types';
import { DEFAULT_DRAFT, SAMPLERS, SCHEDULERS, SIZE_PRESETS } from '../shared/defaults';
import { automaticTriggerWords, resolvePrompt } from '../shared/workflow';
import { applyTriggerResolutionChange, restoreTriggerResolution } from '../shared/trigger-resolution';
import { editTriggersAsPromptText, useCurrentModelTriggers } from '../shared/trigger-editing';
import { selectedHistoryRecord } from '../shared/history-selection';
import { PreviewSelectionSaver } from './preview-selection';
import { draftSchema } from '../shared/validation';
import { History } from './History';
import { Models } from './Models';
import { StudioSettings } from './Settings';
import { StudioHelp } from './StudioHelp';
import { PromptAssistant } from './PromptAssistant';
import { SourceInput } from './SourceInput';
import { CompareImage } from './CompareImage';
import { DynamicPrompts } from './DynamicPrompts';
import { restoreHiresSettings, editHiresSettings, learnedUpscaleSourceError } from '../shared/advanced-image-workflow';
import { AdvancedImageControls } from './AdvancedImageControls';
import { ControlNetControls } from './ControlNetControls';
import { RegionalPrompts } from './RegionalPrompts';
import { activeRegionalPromptRegions } from '../shared/regional-prompt-types';
import { IPAdapterControls } from './IPAdapterControls';
import { FaceDetailerEditor } from './FaceDetailerEditor';
import { QwenEditor } from './QwenEditor';
import { VideoStudio } from './VideoStudio';
import { actionErrorMessage } from '../shared/action-error';
import type { CollectionActions, CollectionSnapshot } from '../shared/collections-types';
import { invalidateDynamicPromptFreeze, restoreDynamicPromptRecipe } from '../shared/dynamic-prompt-recipe';
import { acceptHardwareProfileApplication } from '../shared/hardware-profile-application';
import { SharedBackendActivity } from './SharedBackendActivity';
import { queueJobActive, queueJobPresentation, queueView, runningImageJob } from './queue-view';
import type { HardwareOomAdvice } from '../shared/hardware-profile-types';
import { Busy, Field, Modal, Notice, Toggle, shortDate, type RunAction } from './ui';

type Page = 'create' | 'library' | 'video' | 'models' | 'discover' | 'settings';
const pages = { discover: ['Discover models', 'Explore Civitai and find your next style.'], create: ['Create an image', 'A little room for imagination.'], library: ['Your library', 'Keep the good ideas close.'], video: ['Video studio', 'Save a motion idea. Review what comes next.'], models: ['Models', 'Find your own style.'], settings: ['Studio settings', 'Make yourself at home.'] };
function copyDraft(draft: GenerationDraft): GenerationDraft { return { ...restoreTriggerResolution(draft), faceDetailer: draft.faceDetailer ? structuredClone(draft.faceDetailer) : undefined, ipAdapter: draft.ipAdapter ? structuredClone(draft.ipAdapter) : undefined, qwenEdit: draft.qwenEdit ? structuredClone(draft.qwenEdit) : undefined, regionalPrompts: draft.regionalPrompts ? structuredClone(draft.regionalPrompts) : undefined, variationOfRecordId: draft.variationOfRecordId, controlNet: draft.controlNet ? structuredClone(draft.controlNet) : undefined, dynamicPrompts: draft.dynamicPrompts ? structuredClone(draft.dynamicPrompts) : undefined, hiresFix: draft.hiresFix ? structuredClone(draft.hiresFix) : undefined, upscale: draft.upscale ? structuredClone(draft.upscale) : undefined, imageInput: draft.imageInput ? structuredClone(draft.imageInput) : undefined, triggerWords: draft.triggerWords ? structuredClone(draft.triggerWords) : undefined, assetHashes: draft.assetHashes ? structuredClone(draft.assetHashes) : undefined }; }
const presentAsset = (asset: ModelAsset | undefined): asset is ModelAsset => Boolean(asset);

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [draft, setDraft] = useState<GenerationDraft>(DEFAULT_DRAFT);
  const draftRef = useRef(draft);
  const initialized = useRef(false);
  const closing = useRef(false);
  const closeRequested = useRef(false);
  const closeEpoch = useRef(0);
  const pendingGeneration = useRef<Promise<unknown>>(Promise.resolve());
  const pendingUserWrites = useRef(new Set<Promise<unknown>>());
  const revision = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => { clearTimeout(saveTimer.current); }, []);
  const pendingSave = useRef<Promise<void>>(Promise.resolve());
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'editing' | 'error'>('saved');
  const [bootError, setBootError] = useState('');
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const inFlight = useRef(new Set<string>());
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [checkpointOpen, setCheckpointOpen] = useState(false);
  const [page, setPage] = useState<Page>('create');
  const [setupOpen, setSetupOpen] = useState(false);
  const previousImageIds = useRef<Set<string>>(undefined);
  const [videoOpened, setVideoOpened] = useState(false);
  useEffect(() => { if (page === 'video') setVideoOpened(true); }, [page]);
  const [selectedId, setSelectedId] = useState<string>();
  const previewSelectionSaver = useRef(new PreviewSelectionSaver(recordId => window.latent.savePreviewSelection(recordId)));
  const previewSelectionRevision = useRef(0);
  const [previousDraft, setPreviousDraft] = useState<GenerationDraft>();
  const [hardwareReportContext, setHardwareReportContext] = useState<{ id: string; revision: number }>();
  const [hardwareError, setHardwareError] = useState('');
  const [jobAdvice, setJobAdvice] = useState<Record<string, { advice?: HardwareOomAdvice; error?: string }>>({});
  const [zoom, setZoom] = useState(0);
  const [viewLivePreview, setViewLivePreview] = useState(true);
  const [activityPanel, setActivityPanel] = useState<'queue' | 'notifications'>();
  const queueOpen = activityPanel === 'queue';
  const setQueueOpen = (open: boolean) => setActivityPanel(previous => open ? 'queue' : previous === 'queue' ? undefined : previous);
  const [queueHistoryLimit, setQueueHistoryLimit] = useState(5);
  const [negativeOpen, setNegativeOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [presetName, setPresetName] = useState('');
  const presetNameRevision = useRef(0);
  const [loraOpen, setLoraOpen] = useState(false);
  const [loraSearch, setLoraSearch] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [compareRecord, setCompareRecord] = useState<GenerationRecord>();
  const [faceEditor, setFaceEditor] = useState<{ record?: GenerationRecord }>();
  const [qwenEditor, setQwenEditor] = useState<{ record?: GenerationRecord; mode?: 'preview' | 'reuse' }>();
  useEffect(() => {
    if (!notice || notice.error || previousDraft) return;
    const timer = setTimeout(() => setNotice(undefined), 8000);
    return () => clearTimeout(timer);
  }, [notice, previousDraft]);

  const receive = useCallback((next: AppSnapshot) => {
    const known = previousImageIds.current;
    previousImageIds.current = new Set(next.history.map(record => record.id));
    setSnapshot(next);
    if (known) {
      const newest = next.history.find(record => !known.has(record.id));
      if (newest) {
        setSelectedId(newest.id); setViewLivePreview(false); setZoom(0);
        previewSelectionRevision.current++;
        void previewSelectionSaver.current.save(newest.id).catch(error => setNotice({text:'Could not remember the new preview: '+actionErrorMessage(error),error:true}));
      }
    }
    if (!initialized.current) {
      initialized.current = true;
      if (next.backend.state === 'not-installed') setSetupOpen(true);
      draftRef.current = copyDraft(next.draft);
      setDraft(draftRef.current);
      setNegativeOpen(Boolean(next.draft.negativePrompt));
      setSelectedId(next.previewSelectedRecordId ?? undefined);
      if (next.previewSelectedRecordId) setViewLivePreview(false);
    }
  }, []);
  const connect = useCallback(async () => {
    setBootError('');
    if (!window.latent) { setBootError('Open Latent from its desktop launcher to connect the studio. This page needs the local desktop bridge.'); return; }
    try { receive(await window.latent.getSnapshot()); } catch (error) { setBootError(error instanceof Error ? error.message : String(error)); }
  }, [receive]);
  useEffect(() => {
    const unsubscribe = window.latent?.onSnapshot(receive);
    void connect();
    return () => unsubscribe?.();
  }, [connect, receive]);

  const persist = useCallback((value: GenerationDraft, currentRevision: number) => {
    if (!draftSchema.safeParse(value).success) { if (revision.current === currentRevision) setSaveState('editing'); return Promise.resolve(); }
    setSaveState('saving');
    const task = pendingSave.current.catch(() => undefined).then(() => window.latent.saveDraft(value)).then(() => {
      if (revision.current === currentRevision) setSaveState('saved');
    });
    pendingSave.current = task;
    void task.catch((error: unknown) => {
      if (revision.current === currentRevision) { setSaveState('error'); setNotice({ text: `Could not save your draft: ${error instanceof Error ? error.message : String(error)}`, error: true }); }
    });
    return task;
  }, []);
  const changeDraft = useCallback((change: Partial<GenerationDraft> | GenerationDraft) => {
    if (closing.current) return;
    const merged = applyTriggerResolutionChange(draftRef.current, change);
    const next = Object.hasOwn(change, 'dynamicPrompts') ? merged : invalidateDynamicPromptFreeze(draftRef.current, merged);
    if (!Object.hasOwn(change, 'imageInput') && next.imageInput?.cropPlan && (next.width !== draftRef.current.width || next.height !== draftRef.current.height)) next.imageInput = { ...next.imageInput, cropPlan: undefined };
    if (!Object.hasOwn(change, 'regionalPrompts') && next.regionalPrompts?.frozen && (next.width !== draftRef.current.width || next.height !== draftRef.current.height || next.checkpointId !== draftRef.current.checkpointId || JSON.stringify(next.loras) !== JSON.stringify(draftRef.current.loras))) next.regionalPrompts = { settings: next.regionalPrompts.settings };
    if (!Object.hasOwn(change, 'ipAdapter') && next.ipAdapter?.frozen && (next.width !== draftRef.current.width || next.height !== draftRef.current.height || next.family !== draftRef.current.family || next.checkpointId !== draftRef.current.checkpointId || JSON.stringify(next.loras) !== JSON.stringify(draftRef.current.loras))) next.ipAdapter = { settings: next.ipAdapter.settings };
    if (Object.hasOwn(change, 'checkpointId') && !Object.hasOwn(change, 'assetHashes') && next.assetHashes) {
      next.assetHashes = { ...next.assetHashes };
      delete next.assetHashes[draftRef.current.checkpointId];
      delete next.assetHashes[next.checkpointId];
    }
    if (change.loras && !Object.hasOwn(change, 'triggerWords')) {
      const selectedIds = new Set(change.loras.map(lora => lora.modelId));
      if (next.triggerWords) next.triggerWords = Object.fromEntries(Object.entries(next.triggerWords).filter(([id]) => selectedIds.has(id)));
      if (next.assetHashes) next.assetHashes = Object.fromEntries(Object.entries(next.assetHashes).filter(([id]) => selectedIds.has(id) || id === next.checkpointId));
    }
    draftRef.current = next;
    revision.current += 1;
    setDraft(next);
    setSaveState('saving');
    clearTimeout(saveTimer.current);
    const currentRevision = revision.current;
    saveTimer.current = setTimeout(() => { void persist(copyDraft(next), currentRevision); }, 300);
  }, [persist]);
  const flushDraft = useCallback(async () => {
    if (!initialized.current) return;
    let savingRevision: number;
    do {
      clearTimeout(saveTimer.current);
      savingRevision = revision.current;
      const validation = draftSchema.safeParse(draftRef.current);
      if (!validation.success) throw new Error(`Your latest draft has an unfinished field: ${validation.error.issues[0].path.join(' ')}. Finish editing to save it.`);
      await persist(copyDraft(draftRef.current), savingRevision);
    } while (savingRevision !== revision.current);
  }, [persist]);
  useEffect(() => {
    const onHidden = () => { if (!closing.current && document.visibilityState === 'hidden') void flushDraft().catch(() => undefined); };
    const unsubscribeClose = window.latent?.onBeforeClose?.(async () => {
      closeRequested.current = true;
      const requestedEpoch = ++closeEpoch.current;
      try {
        // Finish an already submitted request, but stop preparation from submitting
        // after shutdown begins. Edits remain saveable until the final acknowledgement.
        await pendingGeneration.current.catch(() => undefined);
        await Promise.all([...pendingUserWrites.current]);
        let draftRevision: number, selectionRevision: number;
        do {
          draftRevision = revision.current;
          selectionRevision = previewSelectionRevision.current;
          await flushDraft();
          await previewSelectionSaver.current.flush();
        } while (draftRevision !== revision.current || selectionRevision !== previewSelectionRevision.current);
        if (requestedEpoch === closeEpoch.current) closing.current = true;
      } catch (error) { if (requestedEpoch === closeEpoch.current) closeRequested.current = false; throw error; }
    });
    const unsubscribeCancelled = window.latent?.onCloseCancelled?.(() => { closeEpoch.current += 1; closing.current = false; closeRequested.current = false; });
    document.addEventListener('visibilitychange', onHidden);
    return () => { document.removeEventListener('visibilitychange', onHidden); unsubscribeClose?.(); unsubscribeCancelled?.(); };
  }, [flushDraft]);
  const run: RunAction = useCallback(async (key, task, success) => {
    if (closing.current || closeRequested.current || inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    setBusy(current => ({ ...current, [key]: true }));
    try { await task(); if (success) setNotice({ text: success }); return true; }
    catch (error) { setNotice({ text: actionErrorMessage(error), error: true }); return false; }
    finally { inFlight.current.delete(key); setBusy(current => ({ ...current, [key]: false })); }
  }, []);

  async function trackUserWrite<T>(task: Promise<T>): Promise<T> {
    pendingUserWrites.current.add(task);
    try { return await task; } finally { pendingUserWrites.current.delete(task); }
  }
  function runUserWrite(key: string, operation: () => Promise<unknown>, success?: string) {
    return run(key, () => trackUserWrite(operation()), success);
  }
  function saveNewPreset() {
    if (!presetName.trim()) return;
    const nameRevision = presetNameRevision.current;
    const preset = { id: crypto.randomUUID(), name: presetName.trim(), draft: copyDraft(draftRef.current) };
    void runUserWrite('save-preset', async () => {
      receive(await window.latent.savePreset(preset));
      if (presetNameRevision.current === nameRevision) setPresetName('');
    }, 'Preset saved.');
  }

  function selectPreview(recordId: string) {
    if (closing.current) return;
    setSelectedId(recordId);
    setViewLivePreview(false);
    setZoom(0);
    const requestedRevision = ++previewSelectionRevision.current;
    void previewSelectionSaver.current.save(recordId).catch(error => {
      if (previewSelectionRevision.current === requestedRevision) setNotice({ text: `Could not remember this preview: ${actionErrorMessage(error)} Select the image again to retry.`, error: true });
    });
  }
  const selectImage = (record: GenerationRecord) => { selectPreview(record.id); setPage('create'); };
  function hardwareAction(action: () => Promise<void>) {
    void run('hardware', async () => { setHardwareError(''); try { await action(); } catch (error) { setHardwareError(error instanceof Error ? error.message : String(error)); throw error; } });
  }
  function refreshHardware() {
    hardwareAction(async () => { const status = await window.latent.refreshHardwareProfiles(); setSnapshot(current => current ? { ...current, hardwareProfiles: status } : current); });
  }
  function recommendHardware() {
    const requestedRevision = revision.current; const current = copyDraft(draftRef.current);
    hardwareAction(async () => { const report = await window.latent.recommendHardwareProfiles(current); setHardwareReportContext({ id: report.id, revision: requestedRevision }); receive(await window.latent.getSnapshot()); });
  }
  function applyHardware(profileId: string, reportId: string) {
    const requestedRevision = revision.current; const current = copyDraft(draftRef.current);
    hardwareAction(async () => {
      const result = await window.latent.applyHardwareProfile({ reportId, profileId, draft: current });
      const accepted = acceptHardwareProfileApplication(result, draftRef.current, requestedRevision, revision.current);
      if (closing.current) return;
      setPreviousDraft(copyDraft(draftRef.current)); changeDraft(accepted); setNegativeOpen(Boolean(accepted.negativePrompt));
      setNotice({ text: `${result.explanation} No image was queued.` });
    });
  }
  function applyHardwareBackend(reportId: string) {
    hardwareAction(() => trackUserWrite((async () => { receive(await window.latent.applyHardwareBackendRecommendation(reportId)); setHardwareReportContext(undefined); setNotice({ text: 'Automatic device selection is saved for the next backend start. Your generation draft is unchanged.' }); })()));
  }
  function inspectJobAdvice(jobId: string) {
    const job = snapshot?.jobs.find(item => item.id === jobId);
    if (!job || !isImageJob(job)) return;
    void run(`advice-${jobId}`, async () => {
      try { const advice = await window.latent.getJobMemoryAdvice(jobId); setJobAdvice(current => ({ ...current, [jobId]: { advice } })); }
      catch (error) { setJobAdvice(current => ({ ...current, [jobId]: { error: error instanceof Error ? error.message : String(error) } })); throw error; }
    });
  }
  const restore = (record: GenerationRecord) => {
    if (closing.current) return;
    if (record.faceDetailer) { setFaceEditor({ record }); return; }
    if (record.qwenEdit) { setQwenEditor({ record, mode: 'reuse' }); return; }
    let recipe: GenerationDraft;
    try {
      const dynamicRecipe = record.dynamicPromptRecipe ?? record.draft.dynamicPrompts?.frozen;
      if (record.draft.dynamicPrompts?.enabled && !dynamicRecipe) throw new Error('The saved wildcard choices are missing. Recover the original generation metadata to reuse this setup exactly.');
      recipe = dynamicRecipe ? restoreDynamicPromptRecipe(copyDraft(record.draft), dynamicRecipe) : copyDraft(record.draft);
      if (recipe.hiresFix) {
        if (record.advancedImage && record.advancedImage.workflowVersion !== record.workflowVersion) throw new Error('The saved hires workflow versions conflict. Inspect the original generation metadata before restoring it.');
        recipe.hiresFix = restoreHiresSettings(recipe.hiresFix, record.workflowVersion);
      }
      if (record.cropInpaint && recipe.imageInput) recipe.imageInput.cropPlan = structuredClone(record.cropInpaint);
      if (record.regionalPrompts) recipe.regionalPrompts = { settings: structuredClone(record.regionalPrompts.settings), frozen: structuredClone(record.regionalPrompts) };
      if (record.ipAdapter) recipe.ipAdapter = { settings: structuredClone(record.ipAdapter.settings), frozen: structuredClone(record.ipAdapter) };
      if (!Array.isArray(record.loras) || record.loras.some(lora => !lora || !Array.isArray(lora.triggers) || lora.triggers.some(trigger => typeof trigger !== 'string'))) throw new Error('The saved LoRA trigger metadata is incomplete. Recover the original generation metadata before reusing this setup.');
      recipe = { ...recipe, seed: record.actualSeed, triggerWords: Object.fromEntries(record.loras.map(lora => [lora.id, [...lora.triggers]])), assetHashes: Object.fromEntries([record.checkpoint, ...record.loras].filter(presentAsset).filter(asset => asset.sha256).map(asset => [asset.id, asset.sha256!])) };
    } catch (error) {
      setNotice({ text: `Could not restore these parameters: ${actionErrorMessage(error)} Your draft and Undo are unchanged.`, error: true });
      return false;
    }
    setPreviousDraft(copyDraft(draftRef.current));
    changeDraft(recipe);
    setNegativeOpen(Boolean(record.draft.negativePrompt));
    selectPreview(record.id);
    setViewLivePreview(false);
    setZoom(0);
    setPage('create');
    setNotice({ text: 'Image parameters restored, including the exact seed. Your previous draft is available with Undo.' });
    return true;
  };
  function undoRestore() {
    if (closing.current || !previousDraft) return;
    changeDraft(copyDraft(previousDraft));
    setNegativeOpen(Boolean(previousDraft.negativePrompt));
    setPreviousDraft(undefined);
    setNotice({ text: 'Your previous draft is back.' });
  }

  function editAutomaticTriggers() {
    const requestedRevision = revision.current;
    const current = copyDraft(draftRef.current);
    void run('edit-triggers', async () => {
      const seedBytes = crypto.getRandomValues(new Uint32Array(2));
      const allocatedSeed = String(seedBytes[0] * 65536 + (seedBytes[1] & 65535));
      const result = await editTriggersAsPromptText(current, snapshot!.models, snapshot!.wildcards, allocatedSeed);
      if (closing.current) return;
      if (revision.current !== requestedRevision) throw new Error('Your draft changed while preparing the trigger words. Try again with your current prompt.');
      if (!result.addedTriggers.length) {
        setNotice({ text: 'No automatic additions to move: the trigger words are already in this prompt or variation. Your draft is unchanged.' });
        return;
      }
      setPreviousDraft(current);
      changeDraft(result.draft);
      setNotice({ text: `Trigger words are now yours to edit in the prompt and will stay when you remove a LoRA.${current.dynamicPrompts?.enabled ? ' The current variation is retained; Regenerate variations chooses again.' : ''} Undo restores the previous draft.` });
      document.getElementById('prompt')?.focus();
    });
  }

  function resetLoraTriggers(modelId: string) {
    if (closing.current) return;
    setPreviousDraft(copyDraft(draftRef.current));
    changeDraft(useCurrentModelTriggers(draftRef.current, modelId));
    setNotice({ text: 'This LoRA now uses its current model trigger words. Your prompt text is unchanged. Undo restores the previous draft.' });
  }

  if (!snapshot) return <div className="boot"><span className="brand-mark"><Orbit size={28} /></span><h1>latent <small>v2</small></h1>{bootError ? <><Notice error>{bootError}</Notice>{window.latent && <button className="primary" onClick={() => void connect()}><RefreshCw size={17} />Try again</button>}</> : <><Busy active /><p>Opening your studio…</p></>}</div>;

  const models = snapshot.models;
  const checkpoints = models.filter(model => model.kind === 'checkpoint');
  const loras = models.filter(model => model.kind === 'lora');
  const historicalAssets = snapshot.history.flatMap(record => [record.checkpoint, ...record.loras]).filter(presentAsset);
  const findAsset = (id: string) => models.find(model => model.id === id) ?? historicalAssets.find(model => model.id === id);
  const checkpoint = findAsset(draft.checkpointId);
  const missing = [draft.checkpointId, ...draft.loras.map(lora => lora.modelId)].filter(id => id && !models.some(model => model.id === id && model.status === 'ready'));
  const selected = selectedHistoryRecord(snapshot.history, selectedId);
  const comparisonBase = compareRecord?.baseRecordId ? snapshot.history.find(record => record.id === compareRecord.baseRecordId) : undefined;
  const comparisonBefore = compareRecord?.faceDetailer ? { url: `latent-asset://source/${compareRecord.faceDetailer.source.id}`, label: 'Original face source', width: compareRecord.faceDetailer.source.normalized.width, height: compareRecord.faceDetailer.source.normalized.height } : comparisonBase ? { url: comparisonBase.imageUrl, label: 'Base image', width: comparisonBase.width, height: comparisonBase.height } : compareRecord?.imageInput?.source ? { url: `latent-asset://source/${compareRecord.imageInput.source.id}`, label: 'Source image', width: compareRecord.imageInput.source.normalized.width, height: compareRecord.imageInput.source.normalized.height } : undefined;
  const activeJobs = snapshot.jobs.filter(queueJobActive);
  const queueItems = snapshot.jobs.filter(job => queueJobActive(job) || !snapshot.dismissedActivity?.queue.includes(queueClearKey(job)));
  const visibleQueue = queueView(queueItems, queueHistoryLimit);
  const activity = snapshot.backendActivity;
  const foreignJobs = (activity.foreignRunning ?? 0) + (activity.foreignPending ?? 0);
  const activeJob = runningImageJob(snapshot.jobs);
  const runningJob = activeJob?.queueState === 'running' ? activeJob : undefined;
  const jobStateLabel = (job: StudioJob) => queueJobPresentation(job, foreignJobs).state;
  const engineLabel = activity.state !== 'ready' ? 'Checking engine activity' : foreignJobs ? `ComfyUI: ${activity.foreignRunning} running · ${activity.foreignPending} waiting` : activity.totalRunning ? 'Generating in studio' : activeJobs.length ? 'Studio jobs waiting' : 'Ready to create';
  const livePreview = snapshot.settings.showGenerationPreview && viewLivePreview && runningJob?.previewUrl;
  const canvasUrl = livePreview || selected?.imageUrl;
  const canvasWidth = livePreview ? runningJob.draft.width : selected?.width ?? 1024;
  const canvasAlt = livePreview ? `Live generation preview: ${runningJob.draft.prompt}` : selected?.draft.prompt || 'Generated image';
  const compatibleLoras = loras.filter(model => model.status === 'ready' && !draft.loras.some(selection => selection.modelId === model.id) && `${model.name} ${model.triggers.join(' ')}`.toLowerCase().includes(loraSearch.toLowerCase()));
  const triggers = [...new Set(draft.loras.flatMap(selection => draft.triggerWords?.[selection.modelId] ?? findAsset(selection.modelId)?.triggers ?? []))];
  const triggerAdditions = draft.dynamicPrompts?.enabled ? undefined : automaticTriggerWords(draft, models);
  const triggerSummary = !draft.autoTriggers ? `Available triggers: ${triggers.join(', ')}`
    : triggerAdditions === undefined ? `Available triggers (additions depend on the variation): ${triggers.join(', ')}`
    : triggerAdditions.length ? `Added when generating: ${triggerAdditions.join(', ')}`
    : 'Trigger words are already in your prompt. No automatic additions are needed.';
  const resolvedPrompt = resolvePrompt(draft, models);
  const unavailableSampling = !SAMPLERS.includes(draft.sampler) || !SCHEDULERS.includes(draft.scheduler);
  const familyMismatch = checkpoint && checkpoint.family !== draft.family;
  const loraMismatch = draft.loras.some(lora => findAsset(lora.modelId)?.family !== draft.family);
  const changedAssets = [draft.checkpointId, ...draft.loras.map(lora => lora.modelId)].filter(id => draft.assetHashes?.[id] && models.find(model => model.id === id && model.status === 'ready')?.sha256 !== draft.assetHashes[id] && !missing.includes(id));
  const validation = draftSchema.safeParse(draft);
  const invalidDraft = validation.success ? '' : `${validation.error.issues[0].path.join(' ')}: ${validation.error.issues[0].message}`;
  const input = draft.imageInput;
  const validSource = !input || snapshot.sourceImages.sources.some(source => source.id === input.sourceId && source.normalized.sha256 === input.sourceSha256);
  const learnedSource = draft.upscale?.mode === 'learned' && input ? snapshot.sourceImages.sources.find(source => source.id === input.sourceId && source.normalized.sha256 === input.sourceSha256) : undefined;
  const learnedSourceError = learnedSource ? learnedUpscaleSourceError(learnedSource.normalized.width, learnedSource.normalized.height) : undefined;
  const validMask = !input || input.mode !== 'inpaint' || snapshot.sourceImages.masks.some(mask => mask.id === input.maskId && mask.sha256 === input.maskSha256 && mask.sourceId === input.sourceId && mask.sourceSha256 === input.sourceSha256);
  const diffusionError = draft.upscale ? '' : !draft.checkpointId ? 'Choose a checkpoint in Models to begin.' : missing.length ? 'Restore the missing model files before generating.' : changedAssets.length ? 'Saved model versions differ. Choose replacements deliberately.' : familyMismatch ? checkpoint?.family === 'unknown' ? 'Tag your checkpoint with its matching family in Models.' : 'Select the family matching your checkpoint, or choose a matching checkpoint.' : loraMismatch ? 'Check the family tags of your selected LoRAs.' : unavailableSampling ? 'Choose a supported sampler and scheduler.' : '';
  const hires = draft.hiresFix;
  const advancedError = draft.upscale ? !input ? 'Choose a source image before resizing.' : draft.batchSize !== 1 || input.mode !== 'img2img' ? 'Source enlargement requires image-to-image mode and batch 1.' : hires ? 'Choose source enlargement or hires fix.' : draft.upscale.mode === 'learned' && snapshot.upscaler.state !== 'ready' ? 'Set up the illustration upscaler first.' : '' : hires ? input?.mode === 'inpaint' ? 'Turn off hires fix or inpainting before generating.' : hires.width < draft.width || hires.height < draft.height || hires.width * hires.height <= draft.width * draft.height || hires.width * hires.height > 4 * 1024 * 1024 ? 'Refined size must enlarge the base within 4 megapixels.' : '' : '';
  const controlError = draft.controlNet ? draft.upscale || hires || input?.mode === 'inpaint' ? 'Use edge control with one ordinary sampling pass.' : snapshot.controlNet.state !== 'ready' ? 'Set up Canny ControlNet first.' : !snapshot.sourceImages.sources.some(source => source.id === draft.controlNet!.sourceId && source.normalized.sha256 === draft.controlNet!.sourceSha256) ? 'Choose the original control reference or a deliberate replacement.' : '' : '';
  const cropError = input?.crop ? input.mode !== 'inpaint' ? 'Focused editing requires inpainting mode.' : (() => { const source = snapshot.sourceImages.sources.find(source => source.id === input.sourceId); return source && source.normalized.width * source.normalized.height > 4 * 1024 * 1024 ? 'Focused editing supports source canvases up to 4 megapixels.' : ''; })() : '';
  const regionalDisabledReason = input || hires || draft.upscale || draft.controlNet || draft.ipAdapter || draft.batchSize !== 1 ? 'Regional prompts currently use one text-to-image pass, without other image workflows.' : undefined;
  const regionalError = draft.regionalPrompts?.settings.enabled ? regionalDisabledReason || (!activeRegionalPromptRegions(draft.regionalPrompts.settings).length ? 'Write a prompt in at least one region, or turn regional prompts off.' : '') : '';
  const ipAdapterDisabledReason = input || hires || draft.upscale || draft.controlNet || draft.regionalPrompts?.settings.enabled || draft.batchSize !== 1 ? 'Image reference currently uses one text-to-image pass, without other image workflows.' : undefined;
  const ipAdapterSource = snapshot.sourceImages.sources.find(source => source.id === draft.ipAdapter?.settings.sourceId);
  const ipAdapterError = draft.ipAdapter ? ipAdapterDisabledReason || (snapshot.ipAdapter.state !== 'ready' ? 'Set up and activate the image-reference tools first.' : !ipAdapterSource || ipAdapterSource.normalized.sha256 !== draft.ipAdapter.settings.sourceSha256 ? 'Choose the original image reference or a deliberate replacement.' : ipAdapterSource.normalized.width * ipAdapterSource.normalized.height > 4 * 1024 * 1024 ? 'Image reference supports source images up to 4 megapixels.' : '') : '';
  const cannotGenerate = (draft.faceDetailer ? 'Open Refine faces to review and queue this saved face recipe.' : '') || invalidDraft || advancedError || learnedSourceError || controlError || cropError || regionalError || ipAdapterError || (!validSource ? 'Choose the original source image or import a replacement.' : !validMask ? 'Paint and save a mask for this source image.' : input?.mode === 'inpaint' && draft.batchSize !== 1 ? 'Set batch size to 1 for inpainting.' : diffusionError || imageSetupReason({ ...snapshot, draft }));
  const collectionActions: CollectionActions = { create: window.latent.createCollection, rename: window.latent.renameCollection, remove: window.latent.removeCollection, addMembers: window.latent.addCollectionMembers, removeMembers: window.latent.removeCollectionMembers };
  const onCollectionChange = (collections: CollectionSnapshot) => setSnapshot(current => current ? { ...current, collections } : current);
  const collectionProps = { collections: snapshot.collections, collectionActions, onCollectionChange };
  const variation = (record: GenerationRecord) => { if (closing.current) return; if (record.faceDetailer || record.qwenEdit) { restore(record); return; } if (!restore(record)) return; changeDraft({ variationOfRecordId: record.id, seed: 'random', dynamicPrompts: record.draft.dynamicPrompts?.enabled ? { enabled: true } : undefined, hiresFix: record.draft.hiresFix ? editHiresSettings(record.draft.hiresFix, { seed: 'random' }) : undefined }); setNotice({ text: 'Variation ready. ' + variationDescription(record.draft) + ' Generate when ready, or Undo to return to your draft.' }); };
  function updateLora(index: number, values: Partial<LoraSelection>) { changeDraft({ loras: draft.loras.map((lora, i) => i === index ? { ...lora, ...values } : lora) }); }
  const generate = () => {
    const requestedDraft = copyDraft(draftRef.current);
    const requestedPreview = previewSelectionRevision.current;
    const requestedCloseEpoch = closeEpoch.current;
    void run('generate', async () => {
      await flushDraft();
      if (closing.current || closeRequested.current || requestedCloseEpoch !== closeEpoch.current) throw new Error('Generation was not submitted because the studio is closing. Your draft is saved.');
      const accepted = window.latent.queueGeneration(requestedDraft);
      pendingGeneration.current = accepted;
      await accepted;
      if (previewSelectionRevision.current === requestedPreview) { setViewLivePreview(true); setZoom(0); }

    }, 'Added to the generation queue.');
  };
  const onKeyDown = (event: React.KeyboardEvent) => { if (event.nativeEvent.isComposing || event.defaultPrevented || (event.target instanceof Element && event.target.closest('[role="dialog"]'))) return; if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && page === 'create' && !cannotGenerate) { event.preventDefault(); generate(); } };

  return <div className="studio" data-theme={snapshot.settings.theme} data-accent={snapshot.settings.accent} onKeyDown={onKeyDown}>
    <header className="titlebar"><div className="brand"><span className="brand-mark"><Orbit size={19} /></span>latent <small>v2</small></div><span className="edition">Moonstone studio</span><button className="runtime" onClick={() => setPage('settings')}><span className={`status-dot ${snapshot.backend.state}`} /><span>{snapshot.backend.state === 'ready' ? engineLabel : snapshot.backend.state === 'not-installed' ? 'Setup needed' : snapshot.backend.state === 'installing' ? 'Setting up…' : snapshot.backend.state === 'starting' ? 'Starting…' : snapshot.backend.state === 'error' ? 'Backend needs attention' : 'Backend stopped'}</span><ChevronDown size={13} /></button></header>
    <div className="shell"><nav className="navigation" aria-label="Studio navigation">{([['create', Sparkles, 'Create'], ['video', Film, 'Video'], ['library', Images, 'Library'], ['models', Boxes, 'Models'], ['discover', Compass, 'Discover'], ['settings', Settings2, 'Settings']] as const).map(([key, Icon, label]) => <button key={key} aria-pressed={page === key} onClick={() => setPage(key)}><Icon size={21} /><span>{label}</span></button>)}<button aria-label="Set up studio" onClick={() => setSetupOpen(true)}><Sprout size={21} /><span>Setup</span></button><button className="help-button" aria-label="Studio help" onClick={() => setHelpOpen(true)}><CircleHelp size={19} /><span>Help</span></button></nav>
    <main className={`main ${page === 'create' ? 'main-create' : page === 'video' ? 'main-video' : ''}`}>{page === 'create' || page === 'video' ? <h1 className="create-page-title">{pages[page][0]}</h1> : <div className="page-heading"><h1>{pages[page][0]}</h1><p>{pages[page][1]}</p></div>}
      {page === 'create' && <div className="workspace"><form className="composer" onSubmit={event => { event.preventDefault(); if (!cannotGenerate) generate(); }}><div className="composer-fields">
        <section className="model-settings"><div className="label-row"><h2>Models</h2><button type="button" className="text-button" onClick={() => setPage('models')}><Boxes size={12} />Manage</button></div><label className="parameter-label" htmlFor="checkpoint">Checkpoint</label><button type="button" id="checkpoint" aria-haspopup="dialog" className="selected-model" onClick={() => setCheckpointOpen(true)}>{checkpoint ? <><ModelArtwork model={checkpoint} showCivitai={snapshot.settings.civitaiDisplayMetadata !== false} history={snapshot.history} /><span><strong>{modelDisplayName(checkpoint, snapshot.settings.civitaiDisplayMetadata !== false)}</strong><small>{checkpoint.family} · Change checkpoint</small></span></> : <span>Choose a checkpoint…</span>}<ChevronDown size={15} className="model-picker-chevron" /></button>{familyMismatch && <p className="inline-error">{checkpoint.family === 'unknown' ? 'Set this checkpoint’s family in Models before generating.' : 'Select the family matching your checkpoint.'}</p>}{missing.length > 0 && <Notice error>Missing assets: {missing.map(id => findAsset(id)?.name || id).join(', ')}. Their selections are preserved.</Notice>}{changedAssets.length > 0 && <Notice error>Saved model versions differ: {changedAssets.map(id => findAsset(id)?.name || id).join(', ')}. Restore the original files for this recipe, or deliberately choose a checkpoint in Models / remove and re-add a LoRA to use a replacement.</Notice>}
        <div className="lora-section"><div className="label-row"><label>LoRAs <span className="muted">{draft.loras.length || ''}</span></label><button type="button" className="text-button" disabled={draft.loras.length >= 8} onClick={() => setLoraOpen(true)}><Plus size={13} />Add</button></div>{!draft.loras.length && <button type="button" className="empty-lora-picker" aria-haspopup="dialog" onClick={() => setLoraOpen(true)}><Plus size={14} />Choose LoRAs<span>Optional</span></button>}<div className="lora-list">{draft.loras.map((lora, index) => { const asset = findAsset(lora.modelId); return <div className="lora-card" key={`${lora.modelId}-${index}`}><div className="label-row"><strong title={asset?.filename ?? lora.modelId}>{asset?.name ?? `Missing: ${lora.modelId}`}</strong><button type="button" className="icon-button" aria-label={`Remove ${asset?.name ?? 'LoRA'}`} onClick={() => changeDraft({ loras: draft.loras.filter((_, i) => i !== index) })}><X size={14} /></button></div><div className="two-columns"><Field label="Model weight"><input type="number" min={-2} max={2} step={0.05} value={lora.weight} onChange={event => updateLora(index, { weight: Number(event.target.value) })} /></Field><Field label="CLIP weight"><input type="number" min={-2} max={2} step={0.05} value={lora.clipWeight} onChange={event => updateLora(index, { clipWeight: Number(event.target.value) })} /></Field></div>{asset?.family !== draft.family && <p className="muted small">Tagged {asset?.family}; check compatibility with your checkpoint.</p>}{Object.hasOwn(draft.triggerWords ?? {}, lora.modelId) && <div><p className="muted small">{draft.triggerWords![lora.modelId].length ? "Using trigger words saved with this draft." : "No automatic additions for this LoRA in this draft."}</p><button type="button" className="text-button" disabled={!models.some(model => model.id === lora.modelId && model.status === "ready")} onClick={() => resetLoraTriggers(lora.modelId)}>Use current model triggers</button></div>}</div>; })}</div>{draft.loras.length > 0 && <><Toggle label="Include trigger words automatically" checked={draft.autoTriggers} onChange={autoTriggers => changeDraft({ autoTriggers })} /><p className="trigger-preview">{triggers.length ? triggerSummary : draft.loras.some(lora => Object.hasOwn(draft.triggerWords ?? {}, lora.modelId)) ? 'This draft has no automatic trigger additions. Your prompt text is kept as written.' : 'No saved trigger words for these LoRAs.'}</p>{draft.autoTriggers && triggers.length > 0 && (triggerAdditions === undefined || triggerAdditions.length > 0) && <div><button type="button" className="text-button" disabled={busy["edit-triggers"]} onClick={editAutomaticTriggers}><Busy active={busy["edit-triggers"]} />Edit as prompt text</button><p className="muted small">Move automatic additions into your prompt to edit them. They stay when you remove a LoRA.{draft.dynamicPrompts?.enabled ? " Keeps the current variation and its expressions; Random chooses a seed first." : ""}</p></div>}{!draft.dynamicPrompts?.enabled && draft.autoTriggers && resolvedPrompt !== draft.prompt && <details className="resolved-prompt"><summary>Prompt sent to ComfyUI</summary><p>{resolvedPrompt}</p></details>}</>}</div></section><SourceInput snapshot={snapshot} draft={draft} onChange={changeDraft} selected={selected} run={run} />
        <section><label>Image size</label><div className="size-presets">{SIZE_PRESETS.map(size => <button type="button" key={size.name} aria-pressed={draft.width === size.width && draft.height === size.height} onClick={() => changeDraft({ width: size.width, height: size.height })}><span className={`shape ${size.name.toLowerCase()}`} />{size.name}</button>)}</div><p className="dimensions">{draft.width} × {draft.height}</p></section>
        <details className="advanced" open><summary>Fine-tune generation</summary><div className="advanced-grid"><div className="two-columns"><Field label="Width"><input type="number" min={256} max={2048} step={64} value={draft.width || ''} onChange={event => changeDraft({ width: Number(event.target.value) })} /></Field><Field label="Height"><input type="number" min={256} max={2048} step={64} value={draft.height || ''} onChange={event => changeDraft({ height: Number(event.target.value) })} /></Field></div><div className="two-columns"><Field label="Steps"><input type="number" min={1} max={100} value={draft.steps} onChange={event => changeDraft({ steps: Number(event.target.value) })} /></Field><Field label="Guidance (CFG)"><input type="number" min={0} max={30} step={0.5} value={draft.cfg} onChange={event => changeDraft({ cfg: Number(event.target.value) })} /></Field></div><Field label="Seed" hint="Random chooses a new seed for each queued job."><div className="input-with-button"><input value={draft.seed} onChange={event => changeDraft({ seed: event.target.value })} placeholder="random" /><button type="button" aria-label="Use random seed" title="Use random seed" onClick={() => changeDraft({ seed: 'random' })}><Dices size={17} /></button></div></Field><Field label="Sampler"><select value={draft.sampler} onChange={event => changeDraft({ sampler: event.target.value })}>{!SAMPLERS.includes(draft.sampler) && <option value={draft.sampler}>{draft.sampler} (unavailable)</option>}{SAMPLERS.map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Scheduler"><select value={draft.scheduler} onChange={event => changeDraft({ scheduler: event.target.value })}>{!SCHEDULERS.includes(draft.scheduler) && <option value={draft.scheduler}>{draft.scheduler} (unavailable)</option>}{SCHEDULERS.map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Images per batch"><input type="number" min={1} max={4} value={draft.batchSize} onChange={event => changeDraft({ batchSize: Number(event.target.value) })} /></Field></div></details>
        <ControlNetControls snapshot={snapshot} draft={draft} selected={selected} onChange={changeDraft} run={run} /><AdvancedImageControls draft={draft} snapshot={snapshot} onChange={changeDraft} run={run} />
        <RegionalPrompts value={draft.regionalPrompts?.settings} width={draft.width} height={draft.height} disabledReason={regionalDisabledReason} onChange={settings => changeDraft({ regionalPrompts: settings ? { settings } : undefined })} />
        <button type="button" onClick={() => setFaceEditor({})}>Refine faces…</button>
        <IPAdapterControls draftRevision={draft} family={draft.family} value={draft.ipAdapter?.settings} frozen={Boolean(draft.ipAdapter?.frozen)} sources={snapshot.sourceImages.sources} status={snapshot.ipAdapter} engineStopped={snapshot.backend.state === 'stopped' && activeJobs.length === 0} disabledReason={ipAdapterDisabledReason} onChange={settings => changeDraft({ ipAdapter: settings ? { settings } : undefined })} onImportSource={() => window.latent.importSourceImage()} onStage={() => window.latent.stageIPAdapter(snapshot.ipAdapter.state === 'error')} onActivate={() => window.latent.activateIPAdapter()} onCancelSetup={() => window.latent.cancelIPAdapterSetup()} />
        <button type="button" className="presets-button" onClick={() => { presetNameRevision.current += 1; setPresetsOpen(true); }}><Save size={15} />Presets<span>{snapshot.presets.length}</span></button>
        </div><div className="prompt-workspace">        <section><div className="label-row"><label htmlFor="prompt">Your prompt</label><button type="button" className="text-button" onClick={() => setAssistantOpen(true)}><Sparkles size={13} />Help me write</button><button type="button" className="text-button" onClick={() => changeDraft({ prompt: '' })}>Clear</button></div><textarea id="prompt" rows={5} maxLength={16000} value={draft.prompt} onChange={event => changeDraft({ prompt: event.target.value })} placeholder="A quiet greenhouse at dusk, fireflies between the flowers, delicate anime illustration…" /><div id="negative-area" hidden={false}><Field label="What to avoid"><textarea rows={3} maxLength={16000} value={draft.negativePrompt} onChange={event => changeDraft({ negativePrompt: event.target.value })} placeholder="Unwanted details or styles" /></Field></div></section>
<details className="prompt-extras"><summary>Prompt variations &amp; wildcards<span>{draft.dynamicPrompts?.enabled ? 'On' : 'Off'} · {Object.keys(snapshot.wildcards.entries).length} wildcard lists</span></summary><DynamicPrompts draft={draft} wildcards={snapshot.wildcards} onChange={dynamicPrompts => changeDraft({ dynamicPrompts })} onReroll={() => { const seedBytes = crypto.getRandomValues(new Uint32Array(2)); const seed = String(seedBytes[0] * 65536 + (seedBytes[1] & 65535)); changeDraft({ dynamicPrompts: { enabled: true }, seed }); }} onSaveWildcards={entries => window.latent.saveWildcards(entries)} /></details>
</div><div className="generate-area"><button className="primary generate" type="submit" disabled={Boolean(cannotGenerate) || busy.generate}><Busy active={busy.generate} />{!busy.generate && <Sparkles size={18} />}{activeJobs.length || foreignJobs ? 'Add to queue' : draft.upscale ? draft.upscale.mode === 'resize' ? 'Resize image' : 'Enhance image' : draft.hiresFix ? 'Generate and refine' : 'Generate image'}</button><p className="hint">{cannotGenerate || (foreignJobs ? 'Will wait for ordinary ComfyUI to finish.' : 'Ctrl + Enter to generate')}</p><p className={`draft-status ${saveState === 'error' ? 'inline-error' : ''}`} aria-live="polite">{saveState === 'saved' ? <><Check size={11} />Draft saved</> : saveState === 'saving' ? 'Saving draft…' : saveState === 'editing' ? 'Finish editing to save your draft' : <button type="button" onClick={() => void run('save-draft', flushDraft)}>Draft not saved · Retry</button>}</p></div>
      </form><div className="stage"><div className="stagebar"><span>{livePreview ? 'Live generation preview' : selected ? `Preview · ${selected.width} × ${selected.height}` : 'Canvas'}</span><div className="button-row"><button type="button" className="text-button qwen-preview-action" onClick={() => setQwenEditor({ record: selected })}><Sparkles size={14} />Edit with Qwen</button><button className="icon-button" disabled={!canvasUrl || zoom === 0.25} aria-label="Zoom out" onClick={() => setZoom(value => Math.max(0.25, (value || 1) - 0.25))}><ZoomOut size={16} /></button><span className="zoom-label">{zoom ? `${Math.round(zoom * 100)}%` : 'Fit'}</span><button className="icon-button" disabled={!canvasUrl || zoom >= 3} aria-label="Zoom in" onClick={() => setZoom(value => Math.min(3, (value || 1) + 0.25))}><ZoomIn size={16} /></button><button disabled={!canvasUrl} onClick={() => setZoom(0)}><Maximize size={14} />Fit to view</button></div></div><CanvasViewport zoom={zoom} onZoom={setZoom} width={canvasWidth} hasImage={Boolean(canvasUrl)}>{canvasUrl ? <ImagePreview key={canvasUrl} saved={!livePreview} className="canvas-image" src={canvasUrl} alt={canvasAlt} style={zoom ? { width: canvasWidth * zoom, maxWidth: 'none', maxHeight: 'none' } : undefined} /> : <div className="empty-canvas" style={{ aspectRatio: `${draft.width || 1024}/${draft.height || 1024}` }}><div className="empty"><span className="seed-mark"><Sprout size={28} /></span><h2>Your next idea starts here</h2><p>A prompt, a few possibilities.<br />Your images will have this space.</p><button type="button" className="soft-button" onClick={() => setPage(snapshot.backend.state === 'ready' ? 'models' : 'settings')}>{snapshot.backend.state === 'ready' ? 'Choose your models' : 'Set up generation'}<ArrowUpRight size={15} /></button></div></div>}</CanvasViewport>
        {activeJob && !runningJob && <div className="generation-progress"><div className="label-row"><span><Busy active />{jobStateLabel(activeJob)}</span><button type="button" className="text-button" disabled={busy[`cancel-${activeJob.id}`]} onClick={() => void runUserWrite(`cancel-${activeJob.id}`, () => window.latent.cancelJob(activeJob.id))}>Cancel</button></div></div>}{runningJob && <div className="generation-progress"><div className="label-row"><span><Busy active />{runningJob.phase ?? 'Generating image'}</span><button className="text-button" disabled={busy[`cancel-${runningJob.id}`]} onClick={() => void runUserWrite(`cancel-${runningJob.id}`, () => window.latent.cancelJob(runningJob.id))}>Cancel</button></div><progress value={runningJob.progress} max={runningJob.progressMax || 1} />{snapshot.settings.showGenerationPreview && runningJob.previewUrl && !viewLivePreview && <button className="text-button" onClick={() => { setViewLivePreview(true); setZoom(0); }}>View live preview</button>}<small>{runningJob.progressMax ? `${runningJob.progress} / ${runningJob.progressMax} steps` : 'Working…'}</small></div>}
        {selected && !livePreview && <div className="preview-caption"><p title={selected.draft.prompt}>{selected.draft.prompt || 'Untitled image'}</p>{(selected.faceDetailer?.source || selected.imageInput?.source || selected.baseRecordId) && <button className="text-button" onClick={() => setCompareRecord(selected)}>Compare</button>}<button className="text-button" onClick={() => restore(selected)}><RotateCcw size={13} />Reuse parameters</button></div>}
      </div><aside className="create-history" aria-label="Recent images"><History scrollable {...collectionProps} onVariation={variation} records={snapshot.history} selectedId={selected?.id} onSelect={selectImage} onReuse={restore} onCompare={setCompareRecord} run={run} />
      </aside></div>}
      {page === 'library' && <div className="page-content"><div className="family" aria-label="Library media"><button aria-pressed>Images</button><button onClick={() => setPage('video')}>Videos · open video history</button></div><History {...collectionProps} onVariation={variation} library records={snapshot.history} selectedId={selected?.id} onSelect={selectImage} onReuse={restore} onCompare={setCompareRecord} run={run} /></div>}
      {(videoOpened || page === 'video') && <div hidden={page !== 'video'}><VideoStudio snapshot={snapshot} selectedRecord={selected} visible={page === 'video'} run={run} /></div>}
      {page === 'models' && <Models {...collectionProps} snapshot={snapshot} receive={receive} run={run} busy={busy} onUse={model => { if (model.kind === 'checkpoint') changeDraft({ checkpointId: model.id, ...(model.family !== 'unknown' ? { family: model.family } : {}) }); else if (!draft.loras.some(lora => lora.modelId === model.id)) changeDraft({ loras: [...draft.loras, { modelId: model.id, weight: 1, clipWeight: 1 }] }); setPage('create'); }} />}
      {page === 'discover' && <CivitaiBrowser snapshot={snapshot} receive={receive} onBack={() => setPage('models')} onUse={model => { if (model.kind === 'checkpoint') changeDraft({ checkpointId: model.id, ...(model.family !== 'unknown' ? { family: model.family } : {}) }); else if (!draft.loras.some(item => item.modelId === model.id)) changeDraft({ loras: [...draft.loras, { modelId: model.id, weight: 1, clipWeight: 1 }] }); setPage('create'); }} />}
      {page === 'settings' && <StudioSettings snapshot={snapshot} receive={receive} run={run} busy={busy} hardwareActions={{ onRefresh: refreshHardware, onRecommend: recommendHardware, onApply: applyHardware, onApplyBackend: applyHardwareBackend, error: hardwareError, draftInvalid: !draftSchema.safeParse(draft).success, draftChanged: Boolean(snapshot.hardwareProfiles.report && (hardwareReportContext?.id !== snapshot.hardwareProfiles.report.id || hardwareReportContext.revision !== revision.current)) }} />}
    </main></div>
    {compareRecord && comparisonBefore && <CompareImage before={comparisonBefore} after={{ url: compareRecord.imageUrl, label: 'Result', width: compareRecord.width, height: compareRecord.height }} sourceFittingSize={compareRecord.qwenEdit?.plan.canvas?.sourceFitting} alignment={compareRecord.faceDetailer || compareRecord.cropInpaint ? 'same-canvas' : comparisonBase ? 'stretch' : compareRecord.qwenEdit?.plan.settings.resize ?? compareRecord.draft.upscale?.resize ?? compareRecord.draft.imageInput?.resize ?? 'stretch'} onClose={() => setCompareRecord(undefined)} />}
    {queueOpen && <section className="queue-panel" aria-label="Generation queue"><div className="section-heading"><div><h3>Queue</h3><div className="button-row"><button disabled={!queueItems.some(job => !queueJobActive(job)) || busy['clear-queue']} onClick={() => void runUserWrite('clear-queue', async () => { receive(await window.latent.dismissActivity('queue', queueItems.filter(job => !queueJobActive(job)).map(queueClearKey))); })}>Clear finished</button>{!!snapshot.dismissedActivity?.queue.length && <button onClick={() => void runUserWrite('clear-queue', async () => { receive(await window.latent.dismissActivity('queue', null)); })}>Show cleared</button>}</div><p className="muted small">{activeJobs.length ? `${activeJobs.length} job${activeJobs.length === 1 ? '' : 's'} in progress or waiting` : activity.state === 'ready' && !foreignJobs ? 'No active jobs.' : 'Checking the engine…'}</p></div><button className="icon-button" aria-label="Close queue" onClick={() => setQueueOpen(false)}><X size={18} /></button></div><details className="queue-engine-details"><summary>Engine details</summary><SharedBackendActivity showOpen={false} status={activity} canOpen={snapshot.backend.state === 'ready'} busy={busy.comfy} onOpen={() => void run('comfy', () => window.latent.openComfyUI())} /></details><div className="queue-list">{queueItems.length ? visibleQueue.visible.map(job => { const presentation = queueJobPresentation(job, foreignJobs); const queued = snapshot.jobs.filter(item => item.status === 'queued'); const index = queued.findIndex(item => item.id === job.id); const reorder = (offset: number) => { const ids = queued.map(item => item.id); [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]]; void runUserWrite('reorder', () => window.latent.reorderJobs(ids)); }; return <div className="queue-job" key={job.id}><div className="queue-job-info"><strong>{presentation.title}</strong><p>{presentation.summary}</p>{presentation.saving && <p><Busy active />Saving video…</p>}{presentation.showProgress && <progress value={job.progress} max={job.progressMax || 1} />}{(job.error || presentation.phase) && <details><summary>{job.error ? "Error details" : "Progress details"}</summary><p className={job.error ? "inline-error" : "muted small"}>{job.error || presentation.phase}</p><p className="muted small">Seed {job.actualSeed} · {shortDate(job.createdAt)}</p></details>}{isImageJob(job) && jobAdvice[job.id]?.error && <p className="inline-error">{jobAdvice[job.id].error}</p>}{isImageJob(job) && jobAdvice[job.id]?.advice && <div className="queue-recovery"><strong>{jobAdvice[job.id].advice!.title}</strong><ol>{jobAdvice[job.id].advice!.steps.map(step => <li key={step}>{step}</li>)}</ol><p>No settings changed; no retry was started.</p><button type="button" className="text-button" onClick={() => { setPage('settings'); setQueueOpen(false); }}>Open hardware settings</button></div>}</div><div className="button-row">{!queueJobActive(job) && <button aria-label="Clear job" onClick={() => void runUserWrite('clear-queue', async () => { receive(await window.latent.dismissActivity('queue', [queueClearKey(job)])); })}><X size={14} /></button>}{job.status === 'queued' && <><button className="icon-button" aria-label="Move job earlier" disabled={index === 0 || busy.reorder} onClick={() => reorder(-1)}><ArrowUp size={16} /></button><button className="icon-button" aria-label="Move job later" disabled={index === queued.length - 1 || busy.reorder} onClick={() => reorder(1)}><ArrowDown size={16} /></button></>}{presentation.canCancel && <button disabled={busy[`cancel-${job.id}`]} onClick={() => void runUserWrite(`cancel-${job.id}`, () => window.latent.cancelJob(job.id))}><X size={15} />Cancel</button>}{presentation.canRequestImageAdvice && <button type="button" disabled={busy[`advice-${job.id}`]} onClick={() => inspectJobAdvice(job.id)} aria-label="Recovery advice">Help</button>}{presentation.canRetrySaving && <button type="button" disabled={busy[`retry-save-${job.id}`]} onClick={() => void runUserWrite(`retry-save-${job.id}`, () => window.latent.retryVideoSave(job.id), 'Video saving retried; generation was not repeated.')}><Save size={15} />Retry saving</button>}{presentation.canRetryGeneration && <button disabled={busy[`retry-${job.id}`] || isVideoJob(job) && !snapshot.video.canGenerate} onClick={() => void runUserWrite(`retry-${job.id}`, () => window.latent.retryJob(job.id), 'Job queued again with its original seed.')}><RefreshCw size={15} />Retry</button>}</div></div>; }) : <p className="muted small">Your generation jobs will appear here.</p>}{visibleQueue.remaining > 0 && <button type="button" onClick={() => setQueueHistoryLimit(limit => limit + 8)}>Show more jobs ({visibleQueue.remaining} remaining)</button>}</div></section>}
    <footer className="bottom-bar"><NotificationCenter open={activityPanel === 'notifications'} onOpenChange={open => setActivityPanel(previous => open ? 'notifications' : previous === 'notifications' ? undefined : previous)} snapshot={snapshot} refresh={async () => receive(await window.latent.getSnapshot())} onQueue={() => setQueueOpen(true)} /><button onClick={() => setQueueOpen(!queueOpen)} aria-expanded={queueOpen}><ListOrdered size={15} />Queue <span className="count">{activeJobs.length + foreignJobs}</span>{foreignJobs > 0 && <span> · ComfyUI</span>}{snapshot.backend.state === 'ready' && activity.state !== 'ready' && <span> · checking</span>}{queueOpen ? <ChevronDown size={13} /> : <ChevronUp size={13} />}</button><span>Local studio · SDXL / Illustrious</span></footer>
    {(notice || previousDraft) && <div className={`toast ${notice?.error ? 'error' : ''}`} role={notice?.error ? 'alert' : 'status'}><span tabIndex={notice?.error ? 0 : undefined} aria-label={notice?.error ? 'Error details' : undefined}>{notice?.text || 'Parameters restored.'}</span><div className="button-row">{previousDraft && <button onClick={undoRestore}><Undo2 size={15} />Undo restore</button>}<button className="icon-button" aria-label="Dismiss message" onClick={() => { if (closing.current) return; setNotice(undefined); if (previousDraft) setPreviousDraft(undefined); }}><X size={15} /></button></div></div>}
    {assistantOpen && <PromptAssistant status={snapshot.assistant} draft={draft} onClose={() => setAssistantOpen(false)} run={run} onApply={suggestion => { if (closing.current) return; setPreviousDraft(copyDraft(draftRef.current)); changeDraft({ prompt: suggestion.proposedDraft.prompt, negativePrompt: suggestion.proposedDraft.negativePrompt }); setNegativeOpen(Boolean(suggestion.proposedDraft.negativePrompt)); setNotice({ text: "Suggested prompts applied. Your previous draft is available with Undo." }); }} />}
    {faceEditor && <FaceDetailerEditor previewRevision={previewSelectionRevision.current} snapshot={snapshot} draft={draft} record={faceEditor.record} preview={selected} run={run} onClose={() => setFaceEditor(undefined)} onQueued={() => { setViewLivePreview(true); }} />}
    {qwenEditor && <QwenEditor snapshot={snapshot} run={run} busy={busy} initialRecord={qwenEditor.record} initialMode={qwenEditor.mode} onSnapshot={receive} onClose={() => setQwenEditor(undefined)} />}
    {checkpointOpen && <ModelPicker onUpdated={receive} snapshot={snapshot} kind="checkpoint" selectedIds={[draft.checkpointId]} onClose={() => setCheckpointOpen(false)} onChoose={model => { changeDraft({ checkpointId: model.id, ...(model.family !== 'unknown' ? { family: model.family } : {}) }); setCheckpointOpen(false); }} />}
    {loraOpen && <ModelPicker onUpdated={receive} snapshot={snapshot} kind="lora" family={draft.family} selectedIds={draft.loras.map(item => item.modelId)} onClose={() => setLoraOpen(false)} onChoose={model => { changeDraft({ loras: [...draft.loras, { modelId: model.id, weight: 1, clipWeight: 1 }] }); setLoraOpen(false); }} />}
    {presetsOpen && <Modal title="Generation presets" onClose={() => { presetNameRevision.current += 1; setPresetsOpen(false); }}><form onSubmit={event => { event.preventDefault(); saveNewPreset(); }}><Field label="Save the current recipe"><input autoFocus value={presetName} onChange={event => { presetNameRevision.current += 1; setPresetName(event.target.value); }} placeholder="Name your preset" maxLength={80} required /></Field><button className="primary" disabled={!presetName.trim() || busy['save-preset']}><Save size={15} />Save preset</button></form><div className="preset-list">{snapshot.presets.map(preset => <div className="preset-card" key={preset.id}><div><strong>{preset.name}</strong><p>{preset.draft.family} · {preset.draft.width} × {preset.draft.height} · {preset.draft.steps} steps</p></div><div className="button-row"><button onClick={() => { if (closing.current) return; setPreviousDraft(copyDraft(draftRef.current)); changeDraft(copyDraft(preset.draft)); setNegativeOpen(Boolean(preset.draft.negativePrompt)); setPresetsOpen(false); setNotice({ text: `Loaded “${preset.name}”.` }); }}><Play size={14} />Use</button><button aria-label={`Update ${preset.name} with current recipe`} title="Replace this preset with the current recipe" disabled={busy[`preset-${preset.id}`]} onClick={() => void runUserWrite(`preset-${preset.id}`, async () => receive(await window.latent.savePreset({ ...preset, draft: copyDraft(draftRef.current) })), `Updated “${preset.name}”.`)}><Save size={14} /></button><button aria-label={`Delete preset ${preset.name}`} disabled={busy[`preset-${preset.id}`]} onClick={() => void runUserWrite(`preset-${preset.id}`, async () => receive(await window.latent.deletePreset(preset.id)), 'Preset deleted.')}><Trash2 size={14} /></button></div></div>)}</div>{!snapshot.presets.length && <p className="muted small">Save a recipe to make it easy to return to.</p>}</Modal>}
    {setupOpen && <SetupHub snapshot={snapshot} receive={receive} onClose={()=>setSetupOpen(false)} onModels={()=>setPage('models')} onSettings={()=>setPage('settings')} onCreate={()=>setPage('create')} onEdit={()=>setQwenEditor({record:selected})} onVideo={()=>setPage('video')} />}
    {helpOpen && <Modal title="A little studio guide" onClose={() => setHelpOpen(false)}><StudioHelp /></Modal>}
  </div>;
}


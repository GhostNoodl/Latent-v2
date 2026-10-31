import { SetupActivityPanel } from './SetupActivityPanel';
import { ErrorBoundary } from './ErrorBoundary';
import { isLoraFamilyCompatible } from '../shared/types';
import { TagPrompt, TagSourcePicker } from './TagPrompt';
import brandIcon from '../../resources/latent-icon.svg';
import {
  prepareOneClickEnhancement,
  enhancementActionLabel,
  enhancementIssue,
  reconcileEnhancementChange,
} from '../shared/enhancement';
import { reconcileVisibleTriggers } from '../shared/visible-triggers';
import { LoraTriggerChoices } from './LoraTriggerChoices';
import { SizePresets } from './SizePresets';
import { PreviewMenu } from './PreviewMenu';
import { draftFieldLabel } from './draft-field-label';
import { hiddenAdvancedSettings } from '../shared/create-mode';
import { applySnapshotChanges, type SnapshotChanges } from '../shared/snapshot-changes';
import { useDismissiblePanel, useTuneFlyouts } from './useDismissiblePanel';
import { imageSetupReason } from '../shared/setup';
import { SetupHub } from './SetupHub';
import { queueClearKey } from './queue-view';
import { CanvasViewport } from './CanvasViewport';
import { formatSeconds, useCountdown } from './generation-eta';
import { SizePeek } from './SizePeek';
import { SavedPrompts } from './SavedPrompts';
import { PromptPieces } from './PromptPieces';
import { GridSweepSetup, SweepGrid } from './GridSweep';
import { NotificationCenter } from './NotificationCenter';
import { ModelPicker, ModelArtwork, modelDisplayName } from './ModelPicker';
// Heavy editors load on first use. Their stylesheets stay in the main bundle so the cascade order is unchanged.
import './civitai.css';
import { variationDescription } from './variation-description';
import { ImagePreview } from './ImagePreview';
import { LibraryDetail } from './LibraryDetail';
import { Suspense, lazy, memo, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Boxes,
  Compass,
  CircleHelp,
  Dices,
  Film,
  Images,
  ListOrdered,
  Maximize,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  Sparkles,
  WandSparkles,
  Sprout,
  GripVertical,
  LayoutGrid,
  Trash2,
  Undo2,
  MoreHorizontal,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  isImageJob,
  isVideoJob,
  type AppSnapshot,
  type GenerationDraft,
  type GenerationRecord,
  type Preset,
  type LoraSelection,
  type ModelAsset,
  type StudioJob,
} from '../shared/types';
import { DEFAULT_DRAFT, SAMPLERS, SCHEDULERS } from '../shared/defaults';
import { automaticTriggerWords, resolvePrompt } from '../shared/workflow';
import { applyTriggerResolutionChange, restoreTriggerResolution } from '../shared/trigger-resolution';
import { editTriggersAsPromptText, applyCurrentModelTriggers } from '../shared/trigger-editing';
import { selectedHistoryRecord } from '../shared/history-selection';
import { DEFAULT_IMAGE_VERSIONS, groupImageVersions, imageVersionLabel } from '../shared/image-versions';
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
import {
  restoreHiresSettings,
  editHiresSettings,
  followHiresScale,
  learnedUpscaleSourceError,
} from '../shared/advanced-image-workflow';
import { AdvancedImageControls } from './AdvancedImageControls';
import { ControlNetControls } from './ControlNetControls';
import { RegionalPrompts } from './RegionalPrompts';
import { activeRegionalPromptRegions } from '../shared/regional-prompt-types';
import { IPAdapterControls } from './IPAdapterControls';
import { FaceDetailerEditor } from './FaceDetailerEditor';
import './qwen-editor.css';
import './video-studio.css';
import { actionErrorMessage } from '../shared/action-error';
import type { CollectionActions, CollectionSnapshot } from '../shared/collections-types';
import { invalidateDynamicPromptFreeze, restoreDynamicPromptRecipe } from '../shared/dynamic-prompt-recipe';
import { acceptHardwareProfileApplication } from '../shared/hardware-profile-application';
import { SharedBackendActivity } from './SharedBackendActivity';
import { queueJobActive, queueJobPresentation, queueView, runningImageJob } from './queue-view';
import type { HardwareOomAdvice } from '../shared/hardware-profile-types';
import { Busy, ConfirmDialog, Field, Modal, Notice, Toggle, shortDate, type RunAction } from './ui';

const CivitaiBrowser = lazy(() => import('./CivitaiBrowser').then(module => ({ default: module.CivitaiBrowser })));
const QwenEditor = lazy(() => import('./QwenEditor').then(module => ({ default: module.QwenEditor })));
// The video page stays mounted once opened; while hidden it skips the re-renders every snapshot update would cause.
const VideoStudio = lazy(() =>
  import('./VideoStudio').then(module => ({
    default: memo(module.VideoStudio, (previous, next) => !previous.visible && !next.visible),
  })),
);

type Page = 'qwen' | 'create' | 'library' | 'video' | 'models' | 'discover' | 'settings';
const pages = {
  qwen: ['Edit', 'Change a picture by describing it, or make a new one from text.'],
  discover: ['Models', 'Find checkpoints and LoRAs on Civitai.'],
  create: ['Create', 'Type a prompt, pick a model and generate.'],
  library: ['Library', 'Everything you have made, with the settings behind it.'],
  video: ['Video', 'Turn an idea or an image into a short clip.'],
  models: ['Models', 'The checkpoints and LoRAs on your PC.'],
  settings: ['Settings', 'Engine, updates, storage and preferences.'],
};
function copyDraft(draft: GenerationDraft): GenerationDraft {
  return {
    ...restoreTriggerResolution(draft),
    autoFace: draft.autoFace ? structuredClone(draft.autoFace) : undefined,
    autoFaceParentRecordId: draft.autoFaceParentRecordId,
    // A grid cell's marker belongs to that one run; reusing its settings starts a normal image.
    sweep: undefined,
    enhance: draft.enhance ? structuredClone(draft.enhance) : undefined,
    promptTriggerSpans: draft.promptTriggerSpans ? structuredClone(draft.promptTriggerSpans) : undefined,
    faceDetailer: draft.faceDetailer ? structuredClone(draft.faceDetailer) : undefined,
    ipAdapter: draft.ipAdapter ? structuredClone(draft.ipAdapter) : undefined,
    qwenEdit: draft.qwenEdit ? structuredClone(draft.qwenEdit) : undefined,
    regionalPrompts: draft.regionalPrompts ? structuredClone(draft.regionalPrompts) : undefined,
    variationOfRecordId: draft.variationOfRecordId,
    controlNet: draft.controlNet ? structuredClone(draft.controlNet) : undefined,
    dynamicPrompts: draft.dynamicPrompts ? structuredClone(draft.dynamicPrompts) : undefined,
    hiresFix: draft.hiresFix ? structuredClone(draft.hiresFix) : undefined,
    upscale: draft.upscale ? structuredClone(draft.upscale) : undefined,
    imageInput: draft.imageInput ? structuredClone(draft.imageInput) : undefined,
    triggerWords: draft.triggerWords ? structuredClone(draft.triggerWords) : undefined,
    assetHashes: draft.assetHashes ? structuredClone(draft.assetHashes) : undefined,
  };
}
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
  useEffect(
    () => () => {
      clearTimeout(saveTimer.current);
    },
    [],
  );
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
  useEffect(() => {
    if (page === 'video') setVideoOpened(true);
  }, [page]);
  const [selectedId, setSelectedId] = useState<string>();
  const previewSelectionSaver = useRef(
    new PreviewSelectionSaver(recordId => window.latent.savePreviewSelection(recordId)),
  );
  const previewSelectionRevision = useRef(0);
  const [previousDraft, setPreviousDraft] = useState<GenerationDraft>();
  const [hardwareReportContext, setHardwareReportContext] = useState<{ id: string; revision: number }>();
  const [hardwareError, setHardwareError] = useState('');
  const [jobAdvice, setJobAdvice] = useState<Record<string, { advice?: HardwareOomAdvice; error?: string }>>({});
  const [zoom, setZoom] = useState(0);
  const [enhanceScale, setEnhanceScale] = useState<1.5 | 2>(2);
  const [viewLivePreview, setViewLivePreview] = useState(true);
  const [activityPanel, setActivityPanel] = useState<'queue' | 'notifications'>();
  const [previewMenu, setPreviewMenu] = useState<{ record: GenerationRecord; x: number; y: number }>();
  const closePreviewMenu = useCallback(() => setPreviewMenu(undefined), []);
  const [loraPopover, setLoraPopover] = useState<number>();
  useTuneFlyouts();
  useDismissiblePanel(
    loraPopover !== undefined,
    useCallback(() => setLoraPopover(undefined), []),
    '.lora-popover, .dock-chip-lora',
  );
  useDismissiblePanel(
    Boolean(activityPanel),
    useCallback(() => setActivityPanel(undefined), []),
    '.queue-panel, .notification-center, .notification-button, .queue-toggle',
  );
  const queueOpen = activityPanel === 'queue';
  const setQueueOpen = (open: boolean) =>
    setActivityPanel(previous => (open ? 'queue' : previous === 'queue' ? undefined : previous));
  const [queueHistoryLimit, setQueueHistoryLimit] = useState(5);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<
    { kind: 'preset'; preset: Preset } | { kind: 'image'; record: GenerationRecord }
  >();
  const [presetName, setPresetName] = useState('');
  const presetNameRevision = useRef(0);
  const [loraOpen, setLoraOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [compareRecord, setCompareRecord] = useState<GenerationRecord>();
  const [compareAgainst, setCompareAgainst] = useState<GenerationRecord>();
  const compare = (record: GenerationRecord, against?: GenerationRecord) => {
    setCompareAgainst(against);
    setCompareRecord(record);
  };
  const [faceEditor, setFaceEditor] = useState<{ record?: GenerationRecord }>();
  const [qwenEditor, setQwenEditor] = useState<{ record?: GenerationRecord; mode?: 'preview' | 'reuse' }>();
  useEffect(() => {
    if (!notice || notice.error || previousDraft) return;
    const timer = setTimeout(() => setNotice(undefined), 8000);
    return () => clearTimeout(timer);
  }, [notice, previousDraft]);

  const noteHistory = useCallback((history: AppSnapshot['history']) => {
    const known = previousImageIds.current;
    // Keep ids that left the list (deleted files), so restoring one is not mistaken for a new image.
    previousImageIds.current = new Set([...(known ?? []), ...history.map(record => record.id)]);
    if (known) {
      const newest = history.find(record => !known.has(record.id));
      if (newest) {
        setSelectedId(newest.id);
        setViewLivePreview(false);
        setZoom(0);
        previewSelectionRevision.current++;
        void previewSelectionSaver.current
          .save(newest.id)
          .catch(error =>
            setNotice({ text: 'Could not remember the new preview: ' + actionErrorMessage(error), error: true }),
          );
      }
    }
  }, []);
  const receive = useCallback(
    (next: AppSnapshot) => {
      noteHistory(next.history);
      setSnapshot(next);
      if (initialized.current) return;
      initialized.current = true;
      if (next.backend.state === 'not-installed') setSetupOpen(true);
      draftRef.current = copyDraft(next.draft);
      if (draftRef.current.triggerResolutionVersion === 'visible@3' && !draftRef.current.autoTriggers)
        draftRef.current = reconcileVisibleTriggers(draftRef.current, { ...draftRef.current, autoTriggers: true });
      setDraft(draftRef.current);
      setSelectedId(next.previewSelectedRecordId ?? undefined);
      if (next.previewSelectedRecordId) setViewLivePreview(false);
    },
    [noteHistory],
  );
  /** Pushed updates carry only changed fields; untouched fields keep their identity. */
  const receiveChanges = useCallback(
    (changes: SnapshotChanges) => {
      if (!initialized.current) return; // The initial full snapshot is still on its way.
      if (changes.history) noteHistory(changes.history);
      setSnapshot(current => (current ? applySnapshotChanges(current, changes) : current));
    },
    [noteHistory],
  );
  const connect = useCallback(async () => {
    setBootError('');
    if (!window.latent) {
      setBootError(
        'Open Latent from its desktop launcher to connect the studio. This page needs the local desktop bridge.',
      );
      return;
    }
    try {
      receive(await window.latent.getSnapshot());
    } catch (error) {
      setBootError(error instanceof Error ? error.message : String(error));
    }
  }, [receive]);
  useEffect(() => {
    const unsubscribe = window.latent?.onSnapshot(receiveChanges);
    void connect();
    return () => unsubscribe?.();
  }, [connect, receiveChanges]);

  const persist = useCallback((value: GenerationDraft, currentRevision: number) => {
    if (!draftSchema.safeParse(value).success) {
      if (revision.current === currentRevision) setSaveState('editing');
      return Promise.resolve();
    }
    setSaveState('saving');
    const task = pendingSave.current
      .catch(() => undefined)
      .then(() => window.latent.saveDraft(value))
      .then(() => {
        if (revision.current === currentRevision) setSaveState('saved');
      });
    pendingSave.current = task;
    void task.catch((error: unknown) => {
      if (revision.current === currentRevision) {
        setSaveState('error');
        setNotice({
          text: `Could not save your draft: ${error instanceof Error ? error.message : String(error)}`,
          error: true,
        });
      }
    });
    return task;
  }, []);
  const changeDraft = useCallback(
    (change: Partial<GenerationDraft> | GenerationDraft) => {
      if (closing.current) return;
      if (
        change.checkpointId &&
        change.checkpointId !== draftRef.current.checkpointId &&
        !Object.hasOwn(change, 'modelSampling')
      )
        change = { ...change, modelSampling: undefined };
      change = reconcileEnhancementChange(draftRef.current, change);
      const applied = applyTriggerResolutionChange(draftRef.current, change);
      let merged: GenerationDraft;
      try {
        merged = Object.hasOwn(change, 'triggerResolutionVersion')
          ? applied
          : reconcileVisibleTriggers(draftRef.current, applied);
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : 'The trigger words could not be added.',
          error: true,
        });
        return;
      }
      const next = Object.hasOwn(change, 'dynamicPrompts')
        ? merged
        : invalidateDynamicPromptFreeze(draftRef.current, merged);
      if (
        !Object.hasOwn(change, 'imageInput') &&
        next.imageInput?.cropPlan &&
        (next.width !== draftRef.current.width || next.height !== draftRef.current.height)
      )
        next.imageInput = { ...next.imageInput, cropPlan: undefined };
      if (
        !Object.hasOwn(change, 'regionalPrompts') &&
        next.regionalPrompts?.frozen &&
        (next.width !== draftRef.current.width ||
          next.height !== draftRef.current.height ||
          next.checkpointId !== draftRef.current.checkpointId ||
          JSON.stringify(next.loras) !== JSON.stringify(draftRef.current.loras))
      )
        next.regionalPrompts = { settings: next.regionalPrompts.settings };
      if (
        !Object.hasOwn(change, 'ipAdapter') &&
        next.ipAdapter?.frozen &&
        (next.width !== draftRef.current.width ||
          next.height !== draftRef.current.height ||
          next.family !== draftRef.current.family ||
          JSON.stringify(next.modelSampling) !== JSON.stringify(draftRef.current.modelSampling) ||
          next.checkpointId !== draftRef.current.checkpointId ||
          JSON.stringify(next.loras) !== JSON.stringify(draftRef.current.loras))
      )
        next.ipAdapter = { settings: next.ipAdapter.settings };
      if (Object.hasOwn(change, 'checkpointId') && !Object.hasOwn(change, 'assetHashes') && next.assetHashes) {
        next.assetHashes = { ...next.assetHashes };
        delete next.assetHashes[draftRef.current.checkpointId];
        delete next.assetHashes[next.checkpointId];
      }
      if (change.loras && !Object.hasOwn(change, 'triggerWords')) {
        const selectedIds = new Set(change.loras.map(lora => lora.modelId));
        if (next.triggerWords)
          next.triggerWords = Object.fromEntries(
            Object.entries(next.triggerWords).filter(([id]) => selectedIds.has(id)),
          );
        if (next.assetHashes)
          next.assetHashes = Object.fromEntries(
            Object.entries(next.assetHashes).filter(([id]) => selectedIds.has(id) || id === next.checkpointId),
          );
      }
      if (
        !Object.hasOwn(change, 'hiresFix') &&
        next.hiresFix &&
        (next.width !== draftRef.current.width || next.height !== draftRef.current.height)
      )
        next.hiresFix = followHiresScale(next.hiresFix, next.width, next.height);
      draftRef.current = next;
      revision.current += 1;
      setDraft(next);
      setSaveState('saving');
      clearTimeout(saveTimer.current);
      const currentRevision = revision.current;
      saveTimer.current = setTimeout(() => {
        void persist(copyDraft(next), currentRevision);
      }, 300);
    },
    [persist],
  );
  const flushDraft = useCallback(async () => {
    if (!initialized.current) return;
    let savingRevision: number;
    do {
      clearTimeout(saveTimer.current);
      savingRevision = revision.current;
      const validation = draftSchema.safeParse(draftRef.current);
      if (!validation.success)
        throw new Error(
          `Check ${draftFieldLabel(validation.error.issues[0].path)}: it isn't a valid value yet. Your draft saves as soon as it is.`,
        );
      await persist(copyDraft(draftRef.current), savingRevision);
    } while (savingRevision !== revision.current);
  }, [persist]);
  useEffect(() => {
    const onHidden = () => {
      if (!closing.current && document.visibilityState === 'hidden') void flushDraft().catch(() => undefined);
    };
    const unsubscribeClose = window.latent?.onBeforeClose?.(async () => {
      closeRequested.current = true;
      const requestedEpoch = ++closeEpoch.current;
      try {
        // Finish an already submitted request, but stop preparation from submitting
        // after shutdown begins. Edits remain saveable until the final acknowledgement.
        await pendingGeneration.current.catch(() => undefined);
        await Promise.all(pendingUserWrites.current);
        let draftRevision: number, selectionRevision: number;
        do {
          draftRevision = revision.current;
          selectionRevision = previewSelectionRevision.current;
          await flushDraft();
          await previewSelectionSaver.current.flush();
        } while (draftRevision !== revision.current || selectionRevision !== previewSelectionRevision.current);
        if (requestedEpoch === closeEpoch.current) closing.current = true;
      } catch (error) {
        if (requestedEpoch === closeEpoch.current) closeRequested.current = false;
        throw error;
      }
    });
    const unsubscribeCancelled = window.latent?.onCloseCancelled?.(() => {
      closeEpoch.current += 1;
      closing.current = false;
      closeRequested.current = false;
    });
    document.addEventListener('visibilitychange', onHidden);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      unsubscribeClose?.();
      unsubscribeCancelled?.();
    };
  }, [flushDraft]);
  const run: RunAction = useCallback(async (key, task, success) => {
    if (closing.current || closeRequested.current || inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    setBusy(current => ({ ...current, [key]: true }));
    try {
      await task();
      if (success) setNotice({ text: success });
      return true;
    } catch (error) {
      setNotice({ text: actionErrorMessage(error), error: true });
      return false;
    } finally {
      inFlight.current.delete(key);
      setBusy(current => ({ ...current, [key]: false }));
    }
  }, []);

  async function trackUserWrite<T>(task: Promise<T>): Promise<T> {
    pendingUserWrites.current.add(task);
    try {
      return await task;
    } finally {
      pendingUserWrites.current.delete(task);
    }
  }
  function runUserWrite(key: string, operation: () => Promise<unknown>, success?: string) {
    return run(key, () => trackUserWrite(operation()), success);
  }
  function saveNewPreset() {
    if (!presetName.trim()) return;
    const nameRevision = presetNameRevision.current;
    const preset = { id: crypto.randomUUID(), name: presetName.trim(), draft: copyDraft(draftRef.current) };
    void runUserWrite(
      'save-preset',
      async () => {
        receive(await window.latent.savePreset(preset));
        if (presetNameRevision.current === nameRevision) setPresetName('');
      },
      'Preset saved.',
    );
  }

  function selectPreview(recordId: string) {
    if (closing.current) return;
    setSelectedId(recordId);
    setViewLivePreview(false);
    setZoom(0);
    const requestedRevision = ++previewSelectionRevision.current;
    void previewSelectionSaver.current.save(recordId).catch(error => {
      if (previewSelectionRevision.current === requestedRevision)
        setNotice({
          text: `Could not remember this preview: ${actionErrorMessage(error)} Select the image again to retry.`,
          error: true,
        });
    });
  }
  const selectImage = (record: GenerationRecord) => {
    selectPreview(record.id);
    setPage('create');
  };
  function hardwareAction(action: () => Promise<void>) {
    void run('hardware', async () => {
      setHardwareError('');
      try {
        await action();
      } catch (error) {
        setHardwareError(error instanceof Error ? error.message : String(error));
        throw error;
      }
    });
  }
  function refreshHardware() {
    hardwareAction(async () => {
      const status = await window.latent.refreshHardwareProfiles();
      setSnapshot(current => (current ? { ...current, hardwareProfiles: status } : current));
    });
  }
  function recommendHardware() {
    const requestedRevision = revision.current;
    const current = copyDraft(draftRef.current);
    hardwareAction(async () => {
      const report = await window.latent.recommendHardwareProfiles(current);
      setHardwareReportContext({ id: report.id, revision: requestedRevision });
      receive(await window.latent.getSnapshot());
    });
  }
  function applyHardware(profileId: string, reportId: string) {
    const requestedRevision = revision.current;
    const current = copyDraft(draftRef.current);
    hardwareAction(async () => {
      const result = await window.latent.applyHardwareProfile({ reportId, profileId, draft: current });
      const accepted = acceptHardwareProfileApplication(result, draftRef.current, requestedRevision, revision.current);
      if (closing.current) return;
      setPreviousDraft(copyDraft(draftRef.current));
      changeDraft(accepted);
      setNotice({ text: `${result.explanation} No image was queued.` });
    });
  }
  function applyHardwareBackend(reportId: string) {
    hardwareAction(() =>
      trackUserWrite(
        (async () => {
          receive(await window.latent.applyHardwareBackendRecommendation(reportId));
          setHardwareReportContext(undefined);
          setNotice({
            text: 'Saved. The engine picks the best device the next time it starts.',
          });
        })(),
      ),
    );
  }
  function inspectJobAdvice(jobId: string) {
    const job = snapshot?.jobs.find(item => item.id === jobId);
    if (!job || !isImageJob(job)) return;
    void run(`advice-${jobId}`, async () => {
      try {
        const advice = await window.latent.getJobMemoryAdvice(jobId);
        setJobAdvice(current => ({ ...current, [jobId]: { advice } }));
      } catch (error) {
        setJobAdvice(current => ({
          ...current,
          [jobId]: { error: error instanceof Error ? error.message : String(error) },
        }));
        throw error;
      }
    });
  }
  const restore = (record: GenerationRecord) => {
    if (closing.current) return;
    if (record.faceDetailer) {
      setFaceEditor({ record });
      return;
    }
    if (record.qwenEdit) {
      setQwenEditor({ record, mode: 'reuse' });
      return;
    }
    let recipe: GenerationDraft;
    try {
      const dynamicRecipe = record.dynamicPromptRecipe ?? record.draft.dynamicPrompts?.frozen;
      if (record.draft.dynamicPrompts?.enabled && !dynamicRecipe)
        throw new Error(
          'The saved wildcard choices are missing. Recover the original generation metadata to reuse this setup exactly.',
        );
      recipe = dynamicRecipe
        ? restoreDynamicPromptRecipe(copyDraft(record.draft), dynamicRecipe)
        : copyDraft(record.draft);
      if (recipe.hiresFix) {
        if (record.advancedImage && record.advancedImage.workflowVersion !== record.workflowVersion)
          throw new Error(
            'The saved hires workflow versions conflict. Inspect the original generation metadata before restoring it.',
          );
        recipe.hiresFix = restoreHiresSettings(recipe.hiresFix, record.workflowVersion);
      }
      if (record.cropInpaint && recipe.imageInput) recipe.imageInput.cropPlan = structuredClone(record.cropInpaint);
      if (record.regionalPrompts)
        recipe.regionalPrompts = {
          settings: structuredClone(record.regionalPrompts.settings),
          frozen: structuredClone(record.regionalPrompts),
        };
      if (record.ipAdapter)
        recipe.ipAdapter = {
          settings: structuredClone(record.ipAdapter.settings),
          frozen: structuredClone(record.ipAdapter),
        };
      if (
        !Array.isArray(record.loras) ||
        record.loras.some(
          lora => !lora || !Array.isArray(lora.triggers) || lora.triggers.some(trigger => typeof trigger !== 'string'),
        )
      )
        throw new Error(
          'The saved LoRA trigger metadata is incomplete. Recover the original generation metadata before reusing this setup.',
        );
      recipe = {
        ...recipe,
        seed: record.actualSeed,
        triggerWords: Object.fromEntries(record.loras.map(lora => [lora.id, [...lora.triggers]])),
        assetHashes: Object.fromEntries(
          [record.checkpoint, ...record.loras]
            .filter(presentAsset)
            .filter(asset => asset.sha256)
            .map(asset => [asset.id, asset.sha256!]),
        ),
      };
    } catch (error) {
      setNotice({
        text: `Could not load these settings: ${actionErrorMessage(error)} Your draft and Undo are unchanged.`,
        error: true,
      });
      return false;
    }
    setPreviousDraft(copyDraft(draftRef.current));
    changeDraft(recipe);
    selectPreview(record.id);
    setViewLivePreview(false);
    setZoom(0);
    setPage('create');
    setNotice({
      text: 'Settings loaded, seed included. Undo brings back what you had.',
    });
    return true;
  };
  function undoRestore() {
    if (closing.current || !previousDraft) return;
    changeDraft(copyDraft(previousDraft));
    setPreviousDraft(undefined);
    setNotice({ text: 'Your previous draft is back.' });
  }

  function editAutomaticTriggers() {
    const requestedRevision = revision.current;
    const current = copyDraft(draftRef.current);
    void run('edit-triggers', async () => {
      const seedBytes = crypto.getRandomValues(new Uint32Array(2));
      const allocatedSeed = String(seedBytes[0] * 65536 + (seedBytes[1] & 65535));
      const result = current.autoTriggers
        ? await editTriggersAsPromptText(current, snapshot!.models, snapshot!.wildcards, allocatedSeed)
        : { draft: current, addedTriggers: [] };
      if (closing.current) return;
      if (revision.current !== requestedRevision)
        throw new Error('Your draft changed while preparing the trigger words. Try again with your current prompt.');
      setPreviousDraft(current);
      changeDraft({
        ...result.draft,
        triggerResolutionVersion: 'visible@3',
        promptTriggerSpans: [],
        triggerWords: Object.fromEntries(current.loras.map(l => [l.modelId, []])),
      });
      setNotice({
        text: 'Visible trigger choices are enabled. Existing prompt text is yours; choose new additions on each LoRA.',
      });
    });
  }

  function resetLoraTriggers(modelId: string) {
    if (closing.current) return;
    setPreviousDraft(copyDraft(draftRef.current));
    changeDraft(applyCurrentModelTriggers(draftRef.current, modelId));
    setNotice({
      text: 'This LoRA now uses its current trigger words. Your prompt is unchanged.',
    });
  }

  const countdownJob = snapshot ? runningImageJob(snapshot.jobs) : undefined;
  const secondsLeft = useCountdown(
    countdownJob?.queueState === 'running' ? countdownJob : undefined,
    snapshot?.history ?? [],
  );
  const stageRef = useRef<HTMLDivElement>(null);
  const [sweepView, setSweepView] = useState<GenerationDraft['sweep']>();
  // Outline the next image's shape on the stage while a size is hovered, and briefly after it changes.
  const [hoveredSize, setHoveredSize] = useState<{ width: number; height: number }>();
  const [sizeFlash, setSizeFlash] = useState(false);
  const shownSize = useRef(`${draft.width}x${draft.height}`);
  useEffect(() => {
    const key = `${draft.width}x${draft.height}`;
    if (key === shownSize.current) return;
    shownSize.current = key;
    setSizeFlash(true);
    const timer = window.setTimeout(() => setSizeFlash(false), 1800);
    return () => window.clearTimeout(timer);
  }, [draft.width, draft.height]);
  const sizePeek = hoveredSize ?? (sizeFlash ? { width: draft.width, height: draft.height } : undefined);

  if (!snapshot)
    return (
      <div className="boot">
        <span className="brand-mark">
          <img src={brandIcon} alt="" />
        </span>
        <h1>
          latent <small>v2</small>
        </h1>
        {bootError ? (
          <>
            <Notice error>{bootError}</Notice>
            {window.latent && (
              <button className="primary" onClick={() => void connect()}>
                <RefreshCw size={17} />
                Try again
              </button>
            )}
          </>
        ) : (
          <>
            <Busy active />
            <p>Opening your studio…</p>
          </>
        )}
      </div>
    );

  const models = snapshot.models;
  const historicalAssets = snapshot.history
    .flatMap(record => [record.checkpoint, ...record.loras])
    .filter(presentAsset);
  const openLora =
    loraPopover !== undefined && draft.loras[loraPopover]
      ? { index: loraPopover, lora: draft.loras[loraPopover] }
      : undefined;
  const findAsset = (id: string) =>
    models.find(model => model.id === id) ?? historicalAssets.find(model => model.id === id);
  const checkpoint = findAsset(draft.checkpointId);
  const missing = [draft.checkpointId, ...draft.loras.map(lora => lora.modelId)].filter(
    id => id && !models.some(model => model.id === id && model.status === 'ready'),
  );
  const selected = selectedHistoryRecord(snapshot.history, selectedId);
  const comparisonBase = compareRecord?.baseRecordId
    ? snapshot.history.find(record => record.id === compareRecord.baseRecordId)
    : undefined;
  const selectedVersions = selected
    ? groupImageVersions(snapshot.history).find(group => group.versions.includes(selected))
    : undefined;
  const imageVersions = snapshot.settings.imageVersions ?? DEFAULT_IMAGE_VERSIONS;
  const comparisonBefore = compareAgainst
    ? {
        url: compareAgainst.imageUrl,
        label: imageVersionLabel(compareAgainst),
        width: compareAgainst.width,
        height: compareAgainst.height,
      }
    : compareRecord?.faceDetailer
      ? {
          url: `latent-asset://source/${compareRecord.faceDetailer.source.id}`,
          label: 'Original face source',
          width: compareRecord.faceDetailer.source.normalized.width,
          height: compareRecord.faceDetailer.source.normalized.height,
        }
      : comparisonBase
        ? {
            url: comparisonBase.imageUrl,
            label: 'Base image',
            width: comparisonBase.width,
            height: comparisonBase.height,
          }
        : compareRecord?.imageInput?.source
          ? {
              url: `latent-asset://source/${compareRecord.imageInput.source.id}`,
              label: 'Source image',
              width: compareRecord.imageInput.source.normalized.width,
              height: compareRecord.imageInput.source.normalized.height,
            }
          : undefined;
  const createMode = snapshot.settings.createMode ?? 'advanced';
  const hiddenSettings = createMode === 'simple' ? hiddenAdvancedSettings(draft) : [];
  const activeJobs = snapshot.jobs.filter(queueJobActive);
  const queueItems = snapshot.jobs.filter(
    job => queueJobActive(job) || !snapshot.dismissedActivity?.queue.includes(queueClearKey(job)),
  );
  const visibleQueue = queueView(queueItems, queueHistoryLimit);
  const activity = snapshot.backendActivity;
  const foreignJobs = (activity.foreignRunning ?? 0) + (activity.foreignPending ?? 0);
  const activeJob = runningImageJob(snapshot.jobs);
  const runningJob = activeJob?.queueState === 'running' ? activeJob : undefined;
  const jobStateLabel = (job: StudioJob) => queueJobPresentation(job, foreignJobs).state;
  const engineLabel =
    activity.state !== 'ready'
      ? 'Checking engine activity'
      : foreignJobs
        ? `Waiting on ComfyUI: ${activity.foreignRunning} running · ${activity.foreignPending} queued`
        : activity.totalRunning
          ? 'Generating in studio'
          : activeJobs.length
            ? 'Studio jobs waiting'
            : 'Ready to create';
  const livePreview = snapshot.settings.showGenerationPreview && viewLivePreview && runningJob?.previewUrl;
  const canvasUrl = livePreview || selected?.imageUrl;
  const canvasWidth = livePreview ? runningJob.draft.width : (selected?.width ?? 1024);
  const canvasAlt = livePreview
    ? `Live generation preview: ${runningJob.draft.prompt}`
    : (selected?.resolvedPrompt ?? selected?.draft.prompt) || 'Generated image';
  const triggers = [
    ...new Set(
      draft.loras.flatMap(
        selection => draft.triggerWords?.[selection.modelId] ?? findAsset(selection.modelId)?.triggers ?? [],
      ),
    ),
  ];
  const triggerAdditions = draft.dynamicPrompts?.enabled ? undefined : automaticTriggerWords(draft, models);
  const triggerSummary = !draft.autoTriggers
    ? `Available triggers: ${triggers.join(', ')}`
    : triggerAdditions === undefined
      ? `Available triggers (additions depend on the variation): ${triggers.join(', ')}`
      : triggerAdditions.length
        ? `Added when generating: ${triggerAdditions.join(', ')}`
        : 'Trigger words are already in your prompt. No automatic additions are needed.';
  const resolvedPrompt = resolvePrompt(draft, models);
  const unavailableSampling = !SAMPLERS.includes(draft.sampler) || !SCHEDULERS.includes(draft.scheduler);
  const familyMismatch = checkpoint && checkpoint.family !== draft.family;
  const loraMismatch = draft.loras.some(lora => !isLoraFamilyCompatible(findAsset(lora.modelId)?.family, draft.family));
  const changedAssets = [draft.checkpointId, ...draft.loras.map(lora => lora.modelId)].filter(
    id =>
      draft.assetHashes?.[id] &&
      models.find(model => model.id === id && model.status === 'ready')?.sha256 !== draft.assetHashes[id] &&
      !missing.includes(id),
  );
  const validation = draftSchema.safeParse(draft);
  const invalidDraft = validation.success
    ? ''
    : `${validation.error.issues[0].path.join(' ')}: ${validation.error.issues[0].message}`;
  const input = draft.imageInput;
  const validSource =
    !input ||
    snapshot.sourceImages.sources.some(
      source => source.id === input.sourceId && source.normalized.sha256 === input.sourceSha256,
    );
  const learnedSource =
    draft.upscale?.mode === 'learned' && input
      ? snapshot.sourceImages.sources.find(
          source => source.id === input.sourceId && source.normalized.sha256 === input.sourceSha256,
        )
      : undefined;
  const learnedSourceError = learnedSource
    ? learnedUpscaleSourceError(learnedSource.normalized.width, learnedSource.normalized.height)
    : undefined;
  const validMask =
    !input ||
    input.mode !== 'inpaint' ||
    snapshot.sourceImages.masks.some(
      mask =>
        mask.id === input.maskId &&
        mask.sha256 === input.maskSha256 &&
        mask.sourceId === input.sourceId &&
        mask.sourceSha256 === input.sourceSha256,
    );
  const diffusionError = draft.upscale
    ? ''
    : !draft.checkpointId
      ? 'Choose a checkpoint in Models to begin.'
      : missing.length
        ? 'Restore the missing model files before generating.'
        : changedAssets.length
          ? 'A model file changed since this image was made. See the note above.'
          : familyMismatch
            ? checkpoint?.family === 'unknown'
              ? 'Tag your checkpoint with its matching family in Models.'
              : 'Select the family matching your checkpoint, or choose a matching checkpoint.'
            : loraMismatch
              ? 'Check the family tags of your selected LoRAs.'
              : unavailableSampling
                ? 'Choose a supported sampler and scheduler.'
                : '';
  const hires = draft.hiresFix;
  const advancedError =
    enhancementIssue(draft) ||
    (draft.upscale
      ? !input
        ? 'Choose a source image before resizing.'
        : draft.batchSize !== 1 || input.mode !== 'img2img'
          ? 'Source enlargement requires image-to-image mode and batch 1.'
          : hires
            ? 'Choose source enlargement or hires fix.'
            : draft.upscale.mode === 'learned' && snapshot.upscaler.state !== 'ready'
              ? 'Set up the illustration upscaler first.'
              : ''
      : hires
        ? input?.mode === 'inpaint'
          ? 'Turn off hires fix or inpainting before generating.'
          : hires.width < draft.width ||
              hires.height < draft.height ||
              hires.width * hires.height <= draft.width * draft.height ||
              hires.width * hires.height > 4 * 1024 * 1024
            ? 'Refined size must enlarge the base within 4 megapixels.'
            : ''
        : '');
  const controlError = draft.controlNet
    ? draft.upscale || hires || input?.mode === 'inpaint'
      ? 'Use edge control with one ordinary sampling pass.'
      : snapshot.controlNet.state !== 'ready'
        ? 'Set up Canny ControlNet first.'
        : !snapshot.sourceImages.sources.some(
              source =>
                source.id === draft.controlNet!.sourceId && source.normalized.sha256 === draft.controlNet!.sourceSha256,
            )
          ? 'Choose the original control reference or a deliberate replacement.'
          : ''
    : '';
  const cropError = input?.crop
    ? input.mode !== 'inpaint'
      ? 'Focused editing requires inpainting mode.'
      : (() => {
          const source = snapshot.sourceImages.sources.find(source => source.id === input.sourceId);
          return source && source.normalized.width * source.normalized.height > 4 * 1024 * 1024
            ? 'Focused editing supports source canvases up to 4 megapixels.'
            : '';
        })()
    : '';
  const regionalDisabledReason =
    input || hires || draft.upscale || draft.controlNet || draft.ipAdapter || draft.batchSize !== 1
      ? 'Regional prompts currently use one text-to-image pass, without other image workflows.'
      : undefined;
  const regionalError = draft.regionalPrompts?.settings.enabled
    ? regionalDisabledReason ||
      (!activeRegionalPromptRegions(draft.regionalPrompts.settings).length
        ? 'Write a prompt in at least one region, or turn regional prompts off.'
        : '')
    : '';
  const ipAdapterDisabledReason =
    input ||
    hires ||
    draft.upscale ||
    draft.controlNet ||
    draft.regionalPrompts?.settings.enabled ||
    draft.batchSize !== 1
      ? 'Image reference currently uses one text-to-image pass, without other image workflows.'
      : undefined;
  const ipAdapterSource = snapshot.sourceImages.sources.find(
    source => source.id === draft.ipAdapter?.settings.sourceId,
  );
  const ipAdapterError = draft.ipAdapter
    ? ipAdapterDisabledReason ||
      (snapshot.ipAdapter.state !== 'ready'
        ? 'Set up and activate the image-reference tools first.'
        : !ipAdapterSource || ipAdapterSource.normalized.sha256 !== draft.ipAdapter.settings.sourceSha256
          ? 'Choose the original image reference or a deliberate replacement.'
          : ipAdapterSource.normalized.width * ipAdapterSource.normalized.height > 4 * 1024 * 1024
            ? 'Image reference supports source images up to 4 megapixels.'
            : '')
    : '';
  const cannotGenerate =
    (draft.faceDetailer ? 'Reuse this face edit from image history, or return to normal generation.' : '') ||
    invalidDraft ||
    advancedError ||
    learnedSourceError ||
    controlError ||
    cropError ||
    regionalError ||
    ipAdapterError ||
    (!validSource
      ? 'Choose the original source image or import a replacement.'
      : !validMask
        ? 'Paint and save a mask for this source image.'
        : input?.mode === 'inpaint' && draft.batchSize !== 1
          ? 'Set batch size to 1 for inpainting.'
          : diffusionError || imageSetupReason({ ...snapshot, draft }));
  const collectionActions: CollectionActions = {
    create: window.latent.createCollection,
    rename: window.latent.renameCollection,
    remove: window.latent.removeCollection,
    addMembers: window.latent.addCollectionMembers,
    removeMembers: window.latent.removeCollectionMembers,
  };
  const onCollectionChange = (collections: CollectionSnapshot) =>
    setSnapshot(current => (current ? { ...current, collections } : current));
  const collectionProps = { collections: snapshot.collections, collectionActions, onCollectionChange };
  const variation = (record: GenerationRecord) => {
    if (closing.current) return;
    if (record.faceDetailer || record.qwenEdit) {
      restore(record);
      return;
    }
    if (!restore(record)) return;
    changeDraft({
      variationOfRecordId: record.id,
      seed: 'random',
      dynamicPrompts: record.draft.dynamicPrompts?.enabled ? { enabled: true } : undefined,
      hiresFix: record.draft.hiresFix ? editHiresSettings(record.draft.hiresFix, { seed: 'random' }) : undefined,
    });
    setNotice({
      text:
        'Variation ready. ' +
        variationDescription(record.draft) +
        ' Generate when ready, or Undo to return to your draft.',
    });
  };
  function updateLora(index: number, values: Partial<LoraSelection>) {
    changeDraft({ loras: draft.loras.map((lora, i) => (i === index ? { ...lora, ...values } : lora)) });
  }
  const enhanceImage = (record: GenerationRecord) => {
    const current = copyDraft(draftRef.current),
      requestedCloseEpoch = closeEpoch.current,
      requestedPreview = previewSelectionRevision.current;
    void runUserWrite(
      'enhance-image',
      async () => {
        const source = await window.latent.useOutputAsSource(record.id);
        if (closing.current || closeRequested.current || requestedCloseEpoch !== closeEpoch.current)
          throw new Error('Enhancement was not submitted because the studio is closing.');
        const requested = prepareOneClickEnhancement(record, source, current, enhanceScale);
        await window.latent.queueGeneration(requested);
        if (previewSelectionRevision.current === requestedPreview) {
          setViewLivePreview(true);
          setZoom(0);
        }
      },
      'Image refinement queued. Your original is kept.',
    );
  };
  const generate = () => {
    const requestedDraft = copyDraft(draftRef.current);
    const requestedPreview = previewSelectionRevision.current;
    const requestedCloseEpoch = closeEpoch.current;
    void run(
      'generate',
      async () => {
        await flushDraft();
        if (closing.current || closeRequested.current || requestedCloseEpoch !== closeEpoch.current)
          throw new Error('Generation was not submitted because the studio is closing. Your draft is saved.');
        const accepted = window.latent.queueGeneration(requestedDraft);
        pendingGeneration.current = accepted;
        await accepted;
        if (previewSelectionRevision.current === requestedPreview) {
          setViewLivePreview(true);
          setZoom(0);
        }
      },
      'Queued.',
    );
  };
  const queueSweep = (drafts: GenerationDraft[]) => {
    if (!drafts.length) return;
    void run(
      'generate',
      async () => {
        await flushDraft();
        for (const cell of drafts) await window.latent.queueGeneration(cell);
        setSweepView(drafts[0].sweep);
      },
      `${drafts.length} images queued.`,
    );
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (
      event.nativeEvent.isComposing ||
      event.defaultPrevented ||
      (event.target instanceof Element && event.target.closest('[role="dialog"]'))
    )
      return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && page === 'create' && !cannotGenerate) {
      event.preventDefault();
      generate();
    }
  };

  return (
    <div
      className="studio"
      data-theme={snapshot.settings.theme}
      data-accent={snapshot.settings.accent}
      onKeyDown={onKeyDown}
    >
      <SetupActivityPanel compact items={snapshot.setupActivity} />
      <div className="shell">
        <nav className="navigation" aria-label="Studio navigation">
          <span className="brand-mark rail-brand" title="Latent">
            <img src={brandIcon} alt="" />
          </span>
          {(
            [
              ['create', Sparkles, 'Create'],
              ['qwen', WandSparkles, 'Edit'],
              ['video', Film, 'Video'],
              ['library', Images, 'Library'],
              ['models', Boxes, 'Models'],
            ] as const
          ).map(([key, Icon, label]) => (
            <button
              key={key}
              aria-current={page === key || (key === 'models' && page === 'discover') ? 'page' : undefined}
              onClick={() => setPage(key)}
            >
              <Icon size={20} />
              <span>{label}</span>
            </button>
          ))}
          <button className="help-button" aria-label="Studio help" onClick={() => setHelpOpen(true)}>
            <CircleHelp size={19} />
            <span>Help</span>
          </button>
          <button aria-current={page === 'settings' ? 'page' : undefined} onClick={() => setPage('settings')}>
            <Settings2 size={20} />
            <span>Settings</span>
          </button>
        </nav>
        <main className={`main ${page === 'create' ? 'main-create' : page === 'video' ? 'main-video' : ''}`}>
          <header className={`page-top ${page === 'create' || page === 'video' ? 'page-top-compact' : ''}`}>
            <div className="page-top-title">
              <h1>{pages[page][0]}</h1>
              {page !== 'create' && page !== 'video' && <p>{pages[page][1]}</p>}
            </div>
            {(page === 'models' || page === 'discover') && (
              <div className="page-tabs" role="group" aria-label="Models">
                <button aria-pressed={page === 'models'} onClick={() => setPage('models')}>
                  On this PC
                </button>
                <button aria-pressed={page === 'discover'} onClick={() => setPage('discover')}>
                  <Compass size={14} />
                  Discover
                </button>
              </div>
            )}
            {page === 'library' && (
              <div className="page-tabs" role="group" aria-label="Library">
                <button aria-pressed>Images</button>
                <button onClick={() => setPage('video')}>Videos</button>
              </div>
            )}
            <div className="page-top-actions">
              <NotificationCenter
                open={activityPanel === 'notifications'}
                onOpenChange={open =>
                  setActivityPanel(previous =>
                    open ? 'notifications' : previous === 'notifications' ? undefined : previous,
                  )
                }
                snapshot={snapshot}
                refresh={async () => receive(await window.latent.getSnapshot())}
                onQueue={() => setQueueOpen(true)}
              />
              <button className="queue-toggle" onClick={() => setQueueOpen(!queueOpen)} aria-expanded={queueOpen}>
                <ListOrdered size={15} />
                Queue <span className="count">{activeJobs.length + foreignJobs}</span>
                {foreignJobs > 0 && <span> · ComfyUI</span>}
                {snapshot.backend.state === 'ready' && activity.state !== 'ready' && <span> · checking</span>}
              </button>
              <button className="runtime" onClick={() => setPage('settings')}>
                <span className={`status-dot ${snapshot.backend.state}`} />
                <span>
                  {snapshot.backend.state === 'ready'
                    ? engineLabel
                    : snapshot.backend.state === 'not-installed'
                      ? 'Setup needed'
                      : snapshot.backend.state === 'installing'
                        ? 'Setting up…'
                        : snapshot.backend.state === 'starting'
                          ? 'Starting…'
                          : snapshot.backend.state === 'error'
                            ? 'Engine needs attention'
                            : 'Engine stopped'}
                </span>
              </button>
            </div>
          </header>
          {page === 'create' && (
            <ErrorBoundary label="Create" resetKey={page}>
              <div className="workspace">
                <form
                  className="composer"
                  onSubmit={event => {
                    event.preventDefault();
                    if (!cannotGenerate) generate();
                  }}
                >
                  <div className="composer-fields">
                    <div className="tune-heading">
                      <h2>Tune</h2>
                      <div className="create-mode" role="group" aria-label="How many controls to show">
                        {(['simple', 'advanced'] as const).map(mode => (
                          <button
                            key={mode}
                            type="button"
                            aria-pressed={createMode === mode}
                            disabled={busy.settings}
                            onClick={() =>
                              void run('settings', async () =>
                                receive(await window.latent.updateSettings({ createMode: mode })),
                              )
                            }
                          >
                            {mode === 'simple' ? 'Simple' : 'Advanced'}
                          </button>
                        ))}
                      </div>
                    </div>
                    {createMode === 'simple' && hiddenSettings.length > 0 && (
                      <Notice>
                        This draft also uses {hiddenSettings.join(', ')}, which Simple hides.{' '}
                        <button
                          type="button"
                          className="text-button"
                          onClick={() =>
                            void run('settings', async () =>
                              receive(await window.latent.updateSettings({ createMode: 'advanced' })),
                            )
                          }
                        >
                          Show advanced
                        </button>
                      </Notice>
                    )}
                    <SizePresets
                      sizes={snapshot.settings.sizePresets}
                      width={draft.width}
                      height={draft.height}
                      onChoose={size => changeDraft({ width: size.width, height: size.height })}
                      onPreview={size => setHoveredSize(size)}
                      onSave={async sizePresets => {
                        receive(await window.latent.updateSettings({ sizePresets }));
                      }}
                    />
                    <div id="negative-area" hidden={false}>
                      <Field label="Negative prompt">
                        <TagPrompt
                          wildcards={snapshot.wildcards.entries}
                          wildcardSelections={draft.dynamicPrompts?.selections}
                          onWildcardSelections={selections =>
                            changeDraft({ dynamicPrompts: { enabled: true, selections } })
                          }
                          aria-label="Negative prompt"
                          sourcePicker={false}
                          rows={3}
                          maxLength={16000}
                          value={draft.negativePrompt}
                          onChange={negativePrompt => changeDraft({ negativePrompt })}
                          placeholder="Unwanted details or styles"
                        />
                      </Field>
                    </div>
                    {draft.enhance && (
                      <Notice>
                        Enhancing a saved image. The original will be preserved.
                        <button
                          type="button"
                          onClick={() =>
                            changeDraft({ enhance: undefined, imageInput: undefined, variationOfRecordId: undefined })
                          }
                        >
                          Return to text-to-image
                        </button>
                      </Notice>
                    )}

                    <details className="advanced generation-settings" open>
                      <summary>Generation settings</summary>
                      <div className="advanced-grid">
                        {createMode === 'advanced' && (
                          <div className="two-columns size-fields">
                            <Field label="Width">
                              <input
                                type="number"
                                min={256}
                                max={2048}
                                step={64}
                                value={draft.width || ''}
                                onChange={event => changeDraft({ width: Number(event.target.value) })}
                              />
                            </Field>
                            <Field label="Height">
                              <input
                                type="number"
                                min={256}
                                max={2048}
                                step={64}
                                value={draft.height || ''}
                                onChange={event => changeDraft({ height: Number(event.target.value) })}
                              />
                            </Field>
                          </div>
                        )}
                        <div className="two-columns">
                          <Field label="Steps" className="slider-field">
                            <input
                              type="number"
                              min={1}
                              max={100}
                              value={draft.steps}
                              onChange={event => changeDraft({ steps: Number(event.target.value) })}
                            />
                            <input
                              type="range"
                              min={1}
                              max={60}
                              aria-label="Steps slider"
                              value={Math.min(60, draft.steps)}
                              onChange={event => changeDraft({ steps: Number(event.target.value) })}
                            />
                          </Field>
                          <Field label="Guidance (CFG)" className="slider-field">
                            <input
                              type="number"
                              min={0}
                              max={30}
                              step={0.5}
                              value={draft.cfg}
                              onChange={event => changeDraft({ cfg: Number(event.target.value) })}
                            />
                            <input
                              type="range"
                              min={1}
                              max={15}
                              step={0.5}
                              aria-label="Guidance slider"
                              value={Math.min(15, draft.cfg)}
                              onChange={event => changeDraft({ cfg: Number(event.target.value) })}
                            />
                          </Field>
                        </div>
                        {createMode === 'advanced' && (
                          <>
                            <div className="two-columns">
                              <Field label="Sampler">
                                <select
                                  value={draft.sampler}
                                  onChange={event => changeDraft({ sampler: event.target.value })}
                                >
                                  {!SAMPLERS.includes(draft.sampler) && (
                                    <option value={draft.sampler}>{draft.sampler} (unavailable)</option>
                                  )}
                                  {SAMPLERS.map(value => (
                                    <option key={value}>{value}</option>
                                  ))}
                                </select>
                              </Field>
                              <Field label="Scheduler">
                                <select
                                  value={draft.scheduler}
                                  onChange={event => changeDraft({ scheduler: event.target.value })}
                                >
                                  {!SCHEDULERS.includes(draft.scheduler) && (
                                    <option value={draft.scheduler}>{draft.scheduler} (unavailable)</option>
                                  )}
                                  {SCHEDULERS.map(value => (
                                    <option key={value}>{value}</option>
                                  ))}
                                </select>
                              </Field>
                            </div>
                          </>
                        )}
                        <Field label="Seed">
                          <div className="input-with-button">
                            <input
                              value={draft.seed}
                              onChange={event => changeDraft({ seed: event.target.value })}
                              placeholder="random"
                            />
                            <button
                              type="button"
                              aria-label="Use random seed"
                              title="Use random seed"
                              onClick={() => changeDraft({ seed: 'random' })}
                            >
                              <Dices size={17} />
                            </button>
                          </div>
                        </Field>
                        {createMode === 'advanced' && (
                          <details className="tune-flyout sampling-flyout">
                            <summary>Model sampling</summary>
                            <Field label="Prediction type">
                              <select
                                value={draft.modelSampling?.prediction ?? 'auto'}
                                onChange={event =>
                                  changeDraft({
                                    modelSampling:
                                      event.target.value === 'auto'
                                        ? undefined
                                        : {
                                            prediction: event.target.value as 'eps' | 'v_prediction' | 'lcm' | 'x0',
                                            zeroTerminalSnr: event.target.value === 'v_prediction',
                                          },
                                  })
                                }
                              >
                                <option value="auto">Automatic (checkpoint default)</option>
                                <option value="eps">Epsilon / standard SDXL</option>
                                <option value="v_prediction">V-prediction / NoobAI V-pred</option>
                                <option value="lcm">LCM</option>
                                <option value="x0">X0 / one-step Lightning</option>
                              </select>
                            </Field>
                            {draft.modelSampling && (
                              <label className="checkbox-label">
                                <input
                                  type="checkbox"
                                  checked={draft.modelSampling.zeroTerminalSnr}
                                  onChange={event =>
                                    changeDraft({
                                      modelSampling: {
                                        ...draft.modelSampling!,
                                        zeroTerminalSnr: event.target.checked,
                                      },
                                    })
                                  }
                                />
                                Zero terminal SNR
                              </label>
                            )}
                            <p className="muted small">
                              Use the model author's recommended steps, guidance and sampler.
                            </p>
                          </details>
                        )}
                      </div>
                    </details>
                    <AdvancedImageControls draft={draft} snapshot={snapshot} onChange={changeDraft} run={run} />
                    {createMode === 'advanced' && (
                      <>
                        <SourceInput
                          snapshot={snapshot}
                          draft={draft}
                          onChange={changeDraft}
                          selected={selected}
                          run={run}
                        />
                        <ControlNetControls
                          snapshot={snapshot}
                          draft={draft}
                          selected={selected}
                          onChange={changeDraft}
                          run={run}
                        />
                        <IPAdapterControls
                          draftRevision={draft}
                          family={draft.family}
                          value={draft.ipAdapter?.settings}
                          frozen={Boolean(draft.ipAdapter?.frozen)}
                          sources={snapshot.sourceImages.sources}
                          status={snapshot.ipAdapter}
                          engineStopped={snapshot.backend.state === 'stopped' && activeJobs.length === 0}
                          disabledReason={ipAdapterDisabledReason}
                          onChange={settings => changeDraft({ ipAdapter: settings ? { settings } : undefined })}
                          onImportSource={() => window.latent.importSourceImage()}
                          onStage={() => window.latent.stageIPAdapter(snapshot.ipAdapter.state === 'error')}
                          onActivate={() => window.latent.activateIPAdapter()}
                          onCancelSetup={() => window.latent.cancelIPAdapterSetup()}
                        />
                      </>
                    )}
                    <GridSweepSetup
                      draft={draft}
                      models={models}
                      disabledReason={cannotGenerate || undefined}
                      onQueue={queueSweep}
                    />
                    <details className="extra-row tune-flyout">
                      <summary>
                        {createMode === 'advanced' ? 'Regions and wildcards' : 'Wildcards'}
                        {(draft.dynamicPrompts?.enabled || draft.regionalPrompts?.settings.enabled) && (
                          <span className="extra-status">On</span>
                        )}
                      </summary>
                      {createMode === 'advanced' && (
                        <RegionalPrompts
                          value={draft.regionalPrompts?.settings}
                          width={draft.width}
                          height={draft.height}
                          disabledReason={regionalDisabledReason}
                          onChange={settings => changeDraft({ regionalPrompts: settings ? { settings } : undefined })}
                        />
                      )}
                      <DynamicPrompts
                        draft={draft}
                        wildcards={snapshot.wildcards}
                        onChange={dynamicPrompts => changeDraft({ dynamicPrompts })}
                        onReroll={() => {
                          const seedBytes = crypto.getRandomValues(new Uint32Array(2));
                          const seed = String(seedBytes[0] * 65536 + (seedBytes[1] & 65535));
                          changeDraft({
                            dynamicPrompts: { enabled: true, selections: draft.dynamicPrompts?.selections },
                            seed,
                          });
                        }}
                        onSaveWildcards={entries => window.latent.saveWildcards(entries)}
                      />
                    </details>
                    <button
                      type="button"
                      className="presets-button"
                      onClick={() => {
                        presetNameRevision.current += 1;
                        setPresetsOpen(true);
                      }}
                    >
                      <Save size={15} />
                      Presets<span>{snapshot.presets.length}</span>
                    </button>
                  </div>
                  <div className="prompt-dock">
                    {openLora && (
                      <div className="lora-popover" role="group" aria-label="LoRA settings">
                        {(() => {
                          const index = openLora.index;
                          const lora = openLora.lora;
                          const asset = findAsset(lora.modelId);
                          return (
                            <div className="lora-card">
                              <div className="label-row">
                                <div className="selected-lora-heading">
                                  {asset && (
                                    <ModelArtwork
                                      model={asset}
                                      history={snapshot.history}
                                      showCivitai={snapshot.settings.civitaiDisplayMetadata !== false}
                                    />
                                  )}
                                  <strong title={asset?.filename ?? lora.modelId}>
                                    {asset
                                      ? modelDisplayName(asset, snapshot.settings.civitaiDisplayMetadata !== false)
                                      : `Missing: ${lora.modelId}`}
                                  </strong>
                                </div>
                                <button
                                  type="button"
                                  className="icon-button"
                                  aria-label={`Remove ${asset?.name ?? 'LoRA'}`}
                                  onClick={() => {
                                    changeDraft({ loras: draft.loras.filter((_, i) => i !== index) });
                                    setLoraPopover(undefined);
                                  }}
                                >
                                  <X size={14} />
                                </button>
                              </div>
                              <div className="two-columns">
                                <Field label="Model weight">
                                  <input
                                    type="number"
                                    step={0.05}
                                    value={lora.weight}
                                    onChange={event => updateLora(index, { weight: Number(event.target.value) })}
                                  />
                                </Field>
                                <Field label="CLIP weight">
                                  <input
                                    type="number"
                                    step={0.05}
                                    value={lora.clipWeight}
                                    onChange={event => updateLora(index, { clipWeight: Number(event.target.value) })}
                                  />
                                </Field>
                              </div>
                              {asset?.family !== draft.family && (
                                <p className="muted small">
                                  Tagged {asset?.family}; check compatibility with your checkpoint.
                                </p>
                              )}
                              {draft.triggerResolutionVersion === 'visible@3' && (
                                <LoraTriggerChoices
                                  words={asset?.triggers ?? []}
                                  selected={draft.triggerWords?.[lora.modelId] ?? []}
                                  onChange={words =>
                                    changeDraft({
                                      autoTriggers: true,
                                      triggerWords: { ...draft.triggerWords, [lora.modelId]: words },
                                    })
                                  }
                                />
                              )}{' '}
                              {draft.triggerResolutionVersion !== 'visible@3' &&
                                Object.hasOwn(draft.triggerWords ?? {}, lora.modelId) && (
                                  <div>
                                    <p className="muted small">
                                      {draft.triggerWords![lora.modelId].length
                                        ? 'Using trigger words saved with this draft.'
                                        : 'No automatic additions for this LoRA in this draft.'}
                                    </p>
                                    <button
                                      type="button"
                                      className="text-button"
                                      disabled={
                                        !models.some(model => model.id === lora.modelId && model.status === 'ready')
                                      }
                                      onClick={() => resetLoraTriggers(lora.modelId)}
                                    >
                                      Use current model triggers
                                    </button>
                                  </div>
                                )}
                            </div>
                          );
                        })()}
                        {draft.loras.length > 0 && draft.triggerResolutionVersion !== 'visible@3' && (
                          <>
                            <Toggle
                              label="Include trigger words automatically"
                              checked={draft.autoTriggers}
                              onChange={autoTriggers => changeDraft({ autoTriggers })}
                            />
                            <p className="trigger-preview">
                              {triggers.length
                                ? triggerSummary
                                : draft.loras.some(lora => Object.hasOwn(draft.triggerWords ?? {}, lora.modelId))
                                  ? 'This draft has no automatic trigger additions. Your prompt text is kept as written.'
                                  : 'No saved trigger words for these LoRAs.'}
                            </p>
                            <div>
                              <button
                                type="button"
                                className="text-button"
                                disabled={busy['edit-triggers']}
                                onClick={editAutomaticTriggers}
                              >
                                <Busy active={busy['edit-triggers']} />
                                Use visible trigger choices
                              </button>
                              <p className="muted small">
                                Keep this older recipe as-is, or switch to visible trigger choices. Existing additions
                                become your prompt text and stay when a LoRA is removed.
                                {draft.dynamicPrompts?.enabled
                                  ? ' Keeps the current variation and its expressions; Random chooses a seed first.'
                                  : ''}
                              </p>
                            </div>
                            {!draft.dynamicPrompts?.enabled &&
                              draft.autoTriggers &&
                              resolvedPrompt !== draft.prompt && (
                                <details className="resolved-prompt">
                                  <summary>Full prompt with trigger words</summary>
                                  <p>{resolvedPrompt}</p>
                                </details>
                              )}
                          </>
                        )}
                      </div>
                    )}
                    <div className="prompt-workspace">
                      {' '}
                      <section>
                        <div className="label-row">
                          <label htmlFor="prompt">Prompt</label>
                          <TagSourcePicker />
                          <SavedPrompts
                            prompt={draft.prompt}
                            saved={snapshot.settings.savedPrompts ?? []}
                            onUse={prompt => changeDraft({ prompt })}
                            onSave={async savedPrompts => {
                              receive(await window.latent.updateSettings({ savedPrompts }));
                            }}
                          />
                          <button
                            type="button"
                            className="text-button"
                            aria-pressed={Boolean(snapshot.settings.promptPieces)}
                            title="Show the prompt as pieces you can drag around"
                            onClick={() =>
                              void run('prompt-pieces', async () =>
                                receive(
                                  await window.latent.updateSettings({ promptPieces: !snapshot.settings.promptPieces }),
                                ),
                              )
                            }
                          >
                            <GripVertical size={13} />
                            Pieces
                          </button>
                          <button type="button" className="text-button" onClick={() => setAssistantOpen(true)}>
                            <Sparkles size={13} />
                            Help me write
                          </button>
                          <button type="button" className="text-button" onClick={() => changeDraft({ prompt: '' })}>
                            Clear
                          </button>
                        </div>
                        {snapshot.settings.promptPieces ? (
                          <PromptPieces value={draft.prompt} onChange={prompt => changeDraft({ prompt })} />
                        ) : (
                          <TagPrompt
                            wildcards={snapshot.wildcards.entries}
                            wildcardSelections={draft.dynamicPrompts?.selections}
                            onWildcardSelections={selections =>
                              changeDraft({ dynamicPrompts: { enabled: true, selections } })
                            }
                            id="prompt"
                            sourcePicker={false}
                            rows={2}
                            maxLength={16000}
                            value={draft.prompt}
                            onChange={prompt => changeDraft({ prompt })}
                            placeholder="A quiet greenhouse at dusk, fireflies between the flowers, delicate anime illustration…"
                          />
                        )}
                      </section>
                    </div>
                    {(familyMismatch || missing.length > 0 || changedAssets.length > 0) && (
                      <div className="dock-notices">
                        {familyMismatch && (
                          <p className="inline-error">
                            {checkpoint.family === 'unknown'
                              ? 'Set this checkpoint’s family in Models before generating.'
                              : 'Select the family matching your checkpoint.'}
                          </p>
                        )}
                        {missing.length > 0 && (
                          <Notice error>
                            Missing assets: {missing.map(id => findAsset(id)?.name || id).join(', ')}. Their selections
                            are preserved.
                          </Notice>
                        )}
                        {changedAssets.length > 0 && (
                          <Notice error>
                            These model files changed since this image was made:{' '}
                            {changedAssets.map(id => findAsset(id)?.name || id).join(', ')}. Put the original files
                            back, or pick a different checkpoint (or remove and re-add the LoRA) to use the new version.
                          </Notice>
                        )}
                      </div>
                    )}
                    <div className="dock-chips">
                      <button
                        type="button"
                        id="checkpoint"
                        className="dock-chip"
                        aria-haspopup="dialog"
                        title="Change checkpoint"
                        onClick={() => setCheckpointOpen(true)}
                      >
                        {checkpoint ? (
                          <>
                            <ModelArtwork
                              model={checkpoint}
                              showCivitai={snapshot.settings.civitaiDisplayMetadata !== false}
                              history={snapshot.history}
                            />
                            {modelDisplayName(checkpoint, snapshot.settings.civitaiDisplayMetadata !== false)}
                          </>
                        ) : (
                          'Choose a checkpoint'
                        )}
                      </button>
                      {draft.loras.map((lora, index) => {
                        const asset = findAsset(lora.modelId);
                        return (
                          <button
                            type="button"
                            key={`${lora.modelId}-${index}`}
                            className="dock-chip dock-chip-lora"
                            aria-expanded={loraPopover === index}
                            title="LoRA settings"
                            onClick={() => setLoraPopover(loraPopover === index ? undefined : index)}
                          >
                            {asset
                              ? modelDisplayName(asset, snapshot.settings.civitaiDisplayMetadata !== false)
                              : 'Missing LoRA'}
                            <span className="dock-chip-value">{lora.weight}</span>
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        className="dock-chip"
                        aria-haspopup="dialog"
                        disabled={draft.loras.length >= 8}
                        onClick={() => setLoraOpen(true)}
                      >
                        <Plus size={13} />
                        LoRA
                      </button>
                      <button
                        type="button"
                        className="dock-chip"
                        title="Image size"
                        onClick={() =>
                          document
                            .querySelector('.composer-fields .image-size-section')
                            ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                        }
                      >
                        {draft.width}×{draft.height}
                      </button>
                      <Field label="Images per batch" className="dock-chip-field">
                        <select
                          value={draft.batchSize}
                          onChange={event => changeDraft({ batchSize: Number(event.target.value) })}
                        >
                          {[1, 2, 3, 4].map(count => (
                            <option key={count} value={count}>
                              {count === 1 ? '1 image' : `${count} images`}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </div>
                    <div className="generate-area">
                      {draft.enhance && (
                        <button
                          type="button"
                          className="soft-button"
                          onClick={() =>
                            changeDraft({
                              enhance: undefined,
                              imageInput: undefined,
                              upscale: undefined,
                              variationOfRecordId: undefined,
                            })
                          }
                        >
                          Exit Enhance
                        </button>
                      )}
                      <button
                        className="primary generate"
                        type="submit"
                        title="Ctrl + Enter"
                        disabled={Boolean(cannotGenerate) || busy.generate}
                      >
                        <Busy active={busy.generate} />
                        {!busy.generate && <Sparkles size={18} />}
                        {activeJobs.length || foreignJobs
                          ? 'Add to queue'
                          : draft.enhance
                            ? 'Enhance image'
                            : draft.upscale
                              ? draft.upscale.mode === 'resize'
                                ? 'Resize image'
                                : 'Enhance image'
                              : draft.hiresFix
                                ? 'Generate and refine'
                                : 'Generate image'}
                        {secondsLeft !== undefined && (
                          <span className="generate-countdown" title="Time left on the current image">
                            {formatSeconds(secondsLeft)}
                          </span>
                        )}
                      </button>
                      {Boolean(cannotGenerate || foreignJobs) && (
                        <p className="hint">{cannotGenerate || 'Starts once the ComfyUI work ahead of it finishes.'}</p>
                      )}
                      {saveState === 'error' && (
                        <p className="draft-status inline-error" role="alert">
                          <button type="button" onClick={() => void run('save-draft', flushDraft)}>
                            Draft not saved · Retry
                          </button>
                        </p>
                      )}
                    </div>
                  </div>
                </form>
                <div
                  className="stage"
                  ref={stageRef}
                  onContextMenu={event => {
                    if (
                      selected &&
                      !livePreview &&
                      event.target instanceof Element &&
                      event.target.closest('img.canvas-image')
                    ) {
                      event.preventDefault();
                      setPreviewMenu({ record: selected, x: event.clientX, y: event.clientY });
                    }
                  }}
                >
                  <div className="stagebar">
                    <span>
                      {livePreview
                        ? 'Live generation preview'
                        : selected
                          ? `Preview · ${selected.width} × ${selected.height}`
                          : 'Canvas'}
                    </span>
                    <div className="button-row zoom-controls" role="group" aria-label="Zoom">
                      <button
                        className="icon-button"
                        disabled={!canvasUrl || zoom === 0.25}
                        aria-label="Zoom out"
                        onClick={() => setZoom(value => Math.max(0.25, (value || 1) - 0.25))}
                      >
                        <ZoomOut size={16} />
                      </button>
                      <span className="zoom-label">{zoom ? `${Math.round(zoom * 100)}%` : 'Fit'}</span>
                      <button
                        className="icon-button"
                        disabled={!canvasUrl || zoom >= 3}
                        aria-label="Zoom in"
                        onClick={() => setZoom(value => Math.min(3, (value || 1) + 0.25))}
                      >
                        <ZoomIn size={16} />
                      </button>
                      <button
                        className="icon-button"
                        disabled={!canvasUrl}
                        aria-label="Fit to view"
                        title="Fit to view"
                        onClick={() => setZoom(0)}
                      >
                        <Maximize size={14} />
                      </button>
                    </div>
                  </div>
                  {canvasUrl && sizePeek && (
                    <SizePeek stage={stageRef} width={sizePeek.width} height={sizePeek.height} />
                  )}
                  <CanvasViewport zoom={zoom} onZoom={setZoom} width={canvasWidth} hasImage={Boolean(canvasUrl)}>
                    {canvasUrl ? (
                      <ImagePreview
                        key={canvasUrl}
                        saved={!livePreview}
                        className="canvas-image"
                        src={canvasUrl}
                        alt={canvasAlt}
                        style={zoom ? { width: canvasWidth * zoom, maxWidth: 'none', maxHeight: 'none' } : undefined}
                      />
                    ) : (
                      <div
                        className="empty-canvas"
                        style={{ aspectRatio: `${draft.width || 1024}/${draft.height || 1024}` }}
                      >
                        <div className="empty">
                          <span className="seed-mark">
                            <Sprout size={28} />
                          </span>
                          <h2>Your next idea starts here</h2>
                          <p>
                            A prompt, a few possibilities.
                            <br />
                            Your images will have this space.
                          </p>
                          <button
                            type="button"
                            className="soft-button"
                            onClick={() =>
                              snapshot.backend.state === 'not-installed'
                                ? setSetupOpen(true)
                                : setPage(snapshot.backend.state === 'ready' ? 'models' : 'settings')
                            }
                          >
                            {snapshot.backend.state === 'ready'
                              ? 'Choose your models'
                              : snapshot.backend.state === 'not-installed'
                                ? 'Open setup'
                                : 'Go to the engine'}
                            <ArrowUpRight size={15} />
                          </button>
                        </div>
                      </div>
                    )}
                  </CanvasViewport>
                  {selected && !livePreview && (
                    <div className="stage-actions">
                      <div className="enhance-action">
                        <select
                          aria-label="Enhancement scale"
                          value={enhanceScale}
                          disabled={busy['enhance-image'] || Math.max(selected.width, selected.height) >= 2048}
                          title="Enlargement is limited to 2048 pixels per side."
                          onChange={event => setEnhanceScale(event.target.value === '1.5' ? 1.5 : 2)}
                        >
                          <option value="1.5">1.5×</option>
                          <option value="2">2×</option>
                        </select>
                        <button
                          type="button"
                          disabled={busy['enhance-image']}
                          title={`Enlarge up to ${enhanceScale}× and refine immediately (maximum 2048 pixels per side). Keeps the original image.`}
                          onClick={() => enhanceImage(selected)}
                        >
                          {busy['enhance-image'] ? 'Queueing...' : enhancementActionLabel(selected)}
                        </button>
                      </div>
                      <button
                        type="button"
                        className="qwen-preview-action"
                        onClick={() => setQwenEditor({ record: selected })}
                      >
                        <WandSparkles size={14} />
                        Edit
                      </button>
                      {(selected.faceDetailer?.source || selected.imageInput?.source || selected.baseRecordId) && (
                        <button type="button" onClick={() => compare(selected)}>
                          Compare
                        </button>
                      )}
                      {selected.draft.sweep && (
                        <button type="button" onClick={() => setSweepView(selected.draft.sweep)}>
                          <LayoutGrid size={13} />
                          Grid
                        </button>
                      )}
                      <button type="button" onClick={() => restore(selected)}>
                        <RotateCcw size={13} />
                        Reuse settings
                      </button>
                      <button
                        type="button"
                        aria-haspopup="menu"
                        aria-label="Image actions"
                        title="More"
                        onClick={event => {
                          const r = event.currentTarget.getBoundingClientRect();
                          setPreviewMenu({ record: selected, x: r.left, y: r.bottom });
                        }}
                      >
                        <MoreHorizontal size={16} />
                      </button>
                    </div>
                  )}
                  {activeJob && !runningJob && (
                    <div className="generation-progress">
                      <div className="label-row">
                        <span>
                          <Busy active />
                          {jobStateLabel(activeJob)}
                        </span>
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy[`cancel-${activeJob.id}`]}
                          onClick={() =>
                            void runUserWrite(`cancel-${activeJob.id}`, () => window.latent.cancelJob(activeJob.id))
                          }
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  {runningJob && (
                    <div className="generation-progress">
                      <div className="label-row">
                        <span>
                          <Busy active />
                          {runningJob.phase ?? 'Generating image'}
                          {secondsLeft !== undefined && (
                            <span className="seconds-left"> · {formatSeconds(secondsLeft)} left</span>
                          )}
                        </span>
                        <button
                          className="text-button"
                          disabled={busy[`cancel-${runningJob.id}`]}
                          onClick={() =>
                            void runUserWrite(`cancel-${runningJob.id}`, () => window.latent.cancelJob(runningJob.id))
                          }
                        >
                          Cancel
                        </button>
                      </div>
                      <progress value={runningJob.progress} max={runningJob.progressMax || 1} />
                      {snapshot.settings.showGenerationPreview && runningJob.previewUrl && !viewLivePreview && (
                        <button
                          className="text-button"
                          onClick={() => {
                            setViewLivePreview(true);
                            setZoom(0);
                          }}
                        >
                          View live preview
                        </button>
                      )}
                      <small>
                        {runningJob.progressMax
                          ? `${runningJob.progress} / ${runningJob.progressMax} steps`
                          : 'Working…'}
                      </small>
                    </div>
                  )}
                  {selected &&
                    !livePreview &&
                    (() => {
                      const outcome = snapshot.jobs.find(job => job.id === selected.jobId);
                      const result =
                        outcome && isImageJob(outcome) ? outcome.autoFaceResults?.[selected.id] : undefined;
                      return result && result.state !== 'queued' ? (
                        <p className="muted small" role="status">
                          {result.state === 'skipped'
                            ? 'Face refinement skipped: no face detected. Original kept.'
                            : 'Face refinement could not start. Original kept; see the queue for details.'}
                        </p>
                      ) : null;
                    })()}
                  {selected && !livePreview && (
                    <div className="preview-caption">
                      <p title={selected.resolvedPrompt ?? selected.draft.prompt}>
                        {(selected.resolvedPrompt ?? selected.draft.prompt) || 'Untitled image'}
                      </p>
                    </div>
                  )}
                  {selected && !livePreview && selectedVersions && selectedVersions.versions.length > 1 && (
                    <div className="preview-versions" role="group" aria-label="Versions of this image">
                      <span className="muted">Versions</span>
                      {selectedVersions.versions.map(version => (
                        <button
                          key={version.id}
                          type="button"
                          className="text-button"
                          aria-pressed={version.id === selected.id}
                          onClick={() => selectImage(version)}
                        >
                          {imageVersionLabel(version)}
                        </button>
                      ))}
                      {selectedVersions.versions[0].id !== selected.id && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => compare(selected, selectedVersions.versions[0])}
                        >
                          Compare with original
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <aside className="create-history" aria-label="Recent images">
                  <History
                    scrollable
                    {...collectionProps}
                    onVariation={variation}
                    records={snapshot.history}
                    selectedId={selected?.id}
                    onSelect={selectImage}
                    onReuse={restore}
                    onCompare={compare}
                    imageVersions={imageVersions}
                    run={run}
                  />
                </aside>
              </div>
            </ErrorBoundary>
          )}
          {page === 'library' && (
            <ErrorBoundary label="Library" resetKey={page}>
              <div className={`page-content library-content ${selected ? 'has-detail' : ''}`}>
                <History
                  {...collectionProps}
                  onVariation={variation}
                  library
                  records={snapshot.history}
                  selectedId={selected?.id}
                  onSelect={record => selectPreview(record.id)}
                  onReuse={restore}
                  onCompare={compare}
                  imageVersions={imageVersions}
                  run={run}
                />
                {selected && (
                  <LibraryDetail
                    record={selected}
                    records={snapshot.history}
                    onSelect={record => selectPreview(record.id)}
                    onReuse={record => {
                      restore(record);
                      setPage('create');
                    }}
                    onOpen={selectImage}
                    onEdit={record => setQwenEditor({ record })}
                    onVideo={record => {
                      selectPreview(record.id);
                      setPage('video');
                    }}
                  />
                )}
              </div>
            </ErrorBoundary>
          )}
          {(videoOpened || page === 'video') && (
            <ErrorBoundary label="Video" resetKey={page}>
              <div hidden={page !== 'video'}>
                <Suspense fallback={<Busy active />}>
                  <VideoStudio snapshot={snapshot} selectedRecord={selected} visible={page === 'video'} run={run} />
                </Suspense>
              </div>
            </ErrorBoundary>
          )}
          {page === 'qwen' && (
            <ErrorBoundary label="Qwen editing" resetKey={page}>
              <Suspense fallback={<Busy active />}>
                <QwenEditor
                  embedded
                  snapshot={snapshot}
                  run={run}
                  busy={busy}
                  onSnapshot={receive}
                  onClose={() => setPage('create')}
                />
              </Suspense>
            </ErrorBoundary>
          )}
          {page === 'models' && (
            <ErrorBoundary label="Models" resetKey={page}>
              <Models
                {...collectionProps}
                snapshot={snapshot}
                receive={receive}
                run={run}
                busy={busy}
                onUse={model => {
                  if (model.kind === 'checkpoint')
                    changeDraft({
                      checkpointId: model.id,
                      ...(model.family !== 'unknown' ? { family: model.family } : {}),
                    });
                  else if (!draft.loras.some(lora => lora.modelId === model.id))
                    changeDraft({ loras: [...draft.loras, { modelId: model.id, weight: 1, clipWeight: 1 }] });
                  setPage('create');
                }}
              />
            </ErrorBoundary>
          )}
          {page === 'discover' && (
            <ErrorBoundary label="Discover" resetKey={page}>
              <Suspense fallback={<Busy active />}>
                <CivitaiBrowser
                  snapshot={snapshot}
                  receive={receive}
                  onBack={() => setPage('models')}
                  onUse={model => {
                    if (model.kind === 'checkpoint')
                      changeDraft({
                        checkpointId: model.id,
                        ...(model.family !== 'unknown' ? { family: model.family } : {}),
                      });
                    else if (!draft.loras.some(item => item.modelId === model.id))
                      changeDraft({ loras: [...draft.loras, { modelId: model.id, weight: 1, clipWeight: 1 }] });
                    setPage('create');
                  }}
                />
              </Suspense>
            </ErrorBoundary>
          )}
          {page === 'settings' && (
            <ErrorBoundary label="Settings" resetKey={page}>
              <StudioSettings
                onSetup={() => setSetupOpen(true)}
                snapshot={snapshot}
                receive={receive}
                run={run}
                busy={busy}
                hardwareActions={{
                  onRefresh: refreshHardware,
                  onRecommend: recommendHardware,
                  onApply: applyHardware,
                  onApplyBackend: applyHardwareBackend,
                  error: hardwareError,
                  draftInvalid: !draftSchema.safeParse(draft).success,
                  draftChanged: Boolean(
                    snapshot.hardwareProfiles.report &&
                    (hardwareReportContext?.id !== snapshot.hardwareProfiles.report.id ||
                      hardwareReportContext.revision !== revision.current),
                  ),
                }}
              />
            </ErrorBoundary>
          )}
        </main>
      </div>
      {compareRecord && comparisonBefore && (
        <CompareImage
          before={comparisonBefore}
          after={{
            url: compareRecord.imageUrl,
            label: 'Result',
            width: compareRecord.width,
            height: compareRecord.height,
          }}
          sourceFittingSize={compareRecord.qwenEdit?.plan.canvas?.sourceFitting}
          alignment={
            compareAgainst
              ? 'stretch'
              : compareRecord.faceDetailer || compareRecord.cropInpaint
                ? 'same-canvas'
                : comparisonBase
                  ? 'stretch'
                  : (compareRecord.qwenEdit?.plan.settings.resize ??
                    compareRecord.draft.upscale?.resize ??
                    compareRecord.draft.imageInput?.resize ??
                    'stretch')
          }
          onClose={() => {
            setCompareRecord(undefined);
            setCompareAgainst(undefined);
          }}
        />
      )}
      {sweepView && (
        <SweepGrid
          sweep={sweepView}
          history={snapshot.history}
          jobs={snapshot.jobs}
          onClose={() => setSweepView(undefined)}
          onPick={record => {
            setSweepView(undefined);
            setPage('create');
            selectImage(record);
          }}
        />
      )}
      {previewMenu && (
        <PreviewMenu
          {...previewMenu}
          onClose={closePreviewMenu}
          onReuse={() => restore(previewMenu.record)}
          onEnhance={() => enhanceImage(previewMenu.record)}
          onTrash={() => setConfirmDelete({ kind: 'image', record: previewMenu.record })}
          run={run}
        />
      )}
      {queueOpen && (
        <section className="queue-panel" aria-label="Generation queue">
          <div className="section-heading">
            <div>
              <h3>Queue</h3>
              <div className="button-row">
                <button
                  disabled={!queueItems.some(job => !queueJobActive(job)) || busy['clear-queue']}
                  onClick={() =>
                    void runUserWrite('clear-queue', async () => {
                      receive(
                        await window.latent.dismissActivity(
                          'queue',
                          queueItems.filter(job => !queueJobActive(job)).map(queueClearKey),
                        ),
                      );
                    })
                  }
                >
                  Clear finished
                </button>
                {!!snapshot.dismissedActivity?.queue.length && (
                  <button
                    onClick={() =>
                      void runUserWrite('clear-queue', async () => {
                        receive(await window.latent.dismissActivity('queue', null));
                      })
                    }
                  >
                    Show cleared
                  </button>
                )}
              </div>
              <p className="muted small">
                {activeJobs.length
                  ? `${activeJobs.length} job${activeJobs.length === 1 ? '' : 's'} in progress or waiting`
                  : activity.state === 'ready' && !foreignJobs
                    ? 'No active jobs.'
                    : 'Checking the engine…'}
              </p>
            </div>
            <button className="icon-button" aria-label="Close queue" onClick={() => setQueueOpen(false)}>
              <X size={18} />
            </button>
          </div>
          <details className="queue-engine-details">
            <summary>Engine details</summary>
            <SharedBackendActivity
              showOpen={false}
              status={activity}
              canOpen={snapshot.backend.state === 'ready'}
              busy={busy.comfy}
              onOpen={() => void run('comfy', () => window.latent.openComfyUI())}
            />
          </details>
          <div className="queue-list">
            {queueItems.length ? (
              visibleQueue.visible.map(job => {
                const presentation = queueJobPresentation(job, foreignJobs);
                const queued = snapshot.jobs.filter(item => item.status === 'queued');
                const index = queued.findIndex(item => item.id === job.id);
                const reorder = (offset: number) => {
                  const ids = queued.map(item => item.id);
                  [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
                  void runUserWrite('reorder', () => window.latent.reorderJobs(ids));
                };
                return (
                  <div className="queue-job" key={job.id}>
                    <div className="queue-job-info">
                      <strong>{presentation.title}</strong>
                      <p>
                        {presentation.state}
                        {isVideoJob(job) ? ' \u00b7 Video' : ' \u00b7 Image'}
                      </p>
                      {presentation.faceSummary && <p role="status">{presentation.faceSummary}</p>}
                      {presentation.saving && (
                        <p>
                          <Busy active />
                          Saving video…
                        </p>
                      )}
                      {presentation.showProgress && <progress value={job.progress} max={job.progressMax || 1} />}
                      {(job.error || presentation.phase) && (
                        <details>
                          <summary>{job.error ? 'Error details' : 'Progress details'}</summary>
                          <p className={job.error ? 'inline-error' : 'muted small'}>
                            {job.error || presentation.phase}
                          </p>
                          <p className="muted small">
                            Seed {job.actualSeed} · {shortDate(job.createdAt)}
                          </p>
                        </details>
                      )}
                      {isImageJob(job) && jobAdvice[job.id]?.error && (
                        <p className="inline-error">{jobAdvice[job.id].error}</p>
                      )}
                      {isImageJob(job) && jobAdvice[job.id]?.advice && (
                        <div className="queue-recovery">
                          <strong>{jobAdvice[job.id].advice!.title}</strong>
                          <ol>
                            {jobAdvice[job.id].advice!.steps.map(step => (
                              <li key={step}>{step}</li>
                            ))}
                          </ol>
                          <p>No settings changed; no retry was started.</p>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              setPage('settings');
                              setQueueOpen(false);
                            }}
                          >
                            Open hardware settings
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="button-row">
                      {!queueJobActive(job) && (
                        <button
                          aria-label="Clear job"
                          onClick={() =>
                            void runUserWrite('clear-queue', async () => {
                              receive(await window.latent.dismissActivity('queue', [queueClearKey(job)]));
                            })
                          }
                        >
                          <X size={14} />
                        </button>
                      )}
                      {job.status === 'queued' && (
                        <>
                          <button
                            className="icon-button"
                            aria-label="Move job earlier"
                            disabled={index === 0 || busy.reorder}
                            onClick={() => reorder(-1)}
                          >
                            <ArrowUp size={16} />
                          </button>
                          <button
                            className="icon-button"
                            aria-label="Move job later"
                            disabled={index === queued.length - 1 || busy.reorder}
                            onClick={() => reorder(1)}
                          >
                            <ArrowDown size={16} />
                          </button>
                        </>
                      )}
                      {presentation.canCancel && (
                        <button
                          disabled={busy[`cancel-${job.id}`]}
                          onClick={() => void runUserWrite(`cancel-${job.id}`, () => window.latent.cancelJob(job.id))}
                        >
                          <X size={15} />
                          Cancel
                        </button>
                      )}
                      {presentation.canRequestImageAdvice && (
                        <button
                          type="button"
                          disabled={busy[`advice-${job.id}`]}
                          onClick={() => inspectJobAdvice(job.id)}
                          aria-label="Recovery advice"
                        >
                          Help
                        </button>
                      )}
                      {presentation.canRetrySaving && (
                        <button
                          type="button"
                          disabled={busy[`retry-save-${job.id}`]}
                          onClick={() =>
                            void runUserWrite(
                              `retry-save-${job.id}`,
                              () => window.latent.retryVideoSave(job.id),
                              'Video saving retried; generation was not repeated.',
                            )
                          }
                        >
                          <Save size={15} />
                          Retry saving
                        </button>
                      )}
                      {presentation.canRetryGeneration && (
                        <button
                          disabled={busy[`retry-${job.id}`] || (isVideoJob(job) && !snapshot.video.canGenerate)}
                          onClick={() =>
                            void runUserWrite(
                              `retry-${job.id}`,
                              () => window.latent.retryJob(job.id),
                              'Job queued again with its original seed.',
                            )
                          }
                        >
                          <RefreshCw size={15} />
                          Retry
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="muted small">Your generation jobs will appear here.</p>
            )}
            {visibleQueue.remaining > 0 && (
              <button type="button" onClick={() => setQueueHistoryLimit(limit => limit + 8)}>
                Show more jobs ({visibleQueue.remaining} remaining)
              </button>
            )}
          </div>
        </section>
      )}
      {(notice || previousDraft) && (
        <div className={`toast ${notice?.error ? 'error' : ''}`} role={notice?.error ? 'alert' : 'status'}>
          <span tabIndex={notice?.error ? 0 : undefined} aria-label={notice?.error ? 'Error details' : undefined}>
            {notice?.text || 'Settings loaded.'}
          </span>
          <div className="button-row">
            {previousDraft && (
              <button onClick={undoRestore}>
                <Undo2 size={15} />
                Undo restore
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Dismiss message"
              onClick={() => {
                if (closing.current) return;
                setNotice(undefined);
                if (previousDraft) setPreviousDraft(undefined);
              }}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      )}
      {assistantOpen && (
        <PromptAssistant
          status={snapshot.assistant}
          draft={draft}
          loraNames={draft.loras.map(lora => models.find(model => model.id === lora.modelId)?.name ?? lora.modelId)}
          onClose={() => setAssistantOpen(false)}
          run={run}
          onApply={suggestion => {
            if (closing.current) return;
            setPreviousDraft(copyDraft(draftRef.current));
            changeDraft({
              prompt: suggestion.proposedDraft.prompt,
              negativePrompt: suggestion.proposedDraft.negativePrompt,
            });
            setNotice({ text: 'Suggested prompts applied. Your previous draft is available with Undo.' });
          }}
        />
      )}
      {faceEditor && (
        <FaceDetailerEditor
          previewRevision={previewSelectionRevision.current}
          snapshot={snapshot}
          draft={draft}
          record={faceEditor.record}
          preview={selected}
          run={run}
          onClose={() => setFaceEditor(undefined)}
          onQueued={() => {
            setViewLivePreview(true);
          }}
        />
      )}
      {qwenEditor && (
        <Suspense fallback={<Busy active />}>
          <QwenEditor
            snapshot={snapshot}
            run={run}
            busy={busy}
            initialRecord={qwenEditor.record}
            initialMode={qwenEditor.mode}
            onSnapshot={receive}
            onClose={() => setQwenEditor(undefined)}
          />
        </Suspense>
      )}
      {checkpointOpen && (
        <ModelPicker
          onUpdated={receive}
          snapshot={snapshot}
          kind="checkpoint"
          selectedIds={[draft.checkpointId]}
          onClose={() => setCheckpointOpen(false)}
          onChoose={model => {
            changeDraft({ checkpointId: model.id, ...(model.family !== 'unknown' ? { family: model.family } : {}) });
            setCheckpointOpen(false);
          }}
        />
      )}
      {loraOpen && (
        <ModelPicker
          onUpdated={receive}
          snapshot={snapshot}
          kind="lora"
          family={draft.family}
          selectedIds={draft.loras.map(item => item.modelId)}
          onClose={() => setLoraOpen(false)}
          onChoose={model => {
            changeDraft({ loras: [...draft.loras, { modelId: model.id, weight: 1, clipWeight: 1 }] });
            setLoraOpen(false);
          }}
        />
      )}
      {presetsOpen && (
        <Modal
          title="Generation presets"
          onClose={() => {
            presetNameRevision.current += 1;
            setPresetsOpen(false);
          }}
        >
          <form
            onSubmit={event => {
              event.preventDefault();
              saveNewPreset();
            }}
          >
            <Field label="Save the current recipe">
              <input
                autoFocus
                value={presetName}
                onChange={event => {
                  presetNameRevision.current += 1;
                  setPresetName(event.target.value);
                }}
                placeholder="Name your preset"
                maxLength={80}
                required
              />
            </Field>
            <button className="primary" disabled={!presetName.trim() || busy['save-preset']}>
              <Save size={15} />
              Save preset
            </button>
          </form>
          <div className="preset-list">
            {snapshot.presets.map(preset => (
              <div className="preset-card" key={preset.id}>
                <div>
                  <strong>{preset.name}</strong>
                  <p>
                    {preset.draft.family} · {preset.draft.width} × {preset.draft.height} · {preset.draft.steps} steps
                  </p>
                </div>
                <div className="button-row">
                  <button
                    onClick={() => {
                      if (closing.current) return;
                      setPreviousDraft(copyDraft(draftRef.current));
                      changeDraft(copyDraft(preset.draft));
                      setPresetsOpen(false);
                      setNotice({ text: `Loaded “${preset.name}”.` });
                    }}
                  >
                    <Play size={14} />
                    Use
                  </button>
                  <button
                    aria-label={`Update ${preset.name} with current recipe`}
                    title="Replace this preset with the current recipe"
                    disabled={busy[`preset-${preset.id}`]}
                    onClick={() =>
                      void runUserWrite(
                        `preset-${preset.id}`,
                        async () =>
                          receive(await window.latent.savePreset({ ...preset, draft: copyDraft(draftRef.current) })),
                        `Updated “${preset.name}”.`,
                      )
                    }
                  >
                    <Save size={14} />
                  </button>
                  <button
                    aria-label={`Delete preset ${preset.name}`}
                    disabled={busy[`preset-${preset.id}`]}
                    onClick={() => setConfirmDelete({ kind: 'preset', preset })}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          {!snapshot.presets.length && <p className="muted small">Save a recipe to make it easy to return to.</p>}
        </Modal>
      )}
      {setupOpen && (
        <SetupHub
          snapshot={snapshot}
          receive={receive}
          onClose={() => setSetupOpen(false)}
          onModels={() => setPage('models')}
          onSettings={() => setPage('settings')}
          onCreate={() => setPage('create')}
          onEdit={() => setQwenEditor({ record: selected })}
          onVideo={() => setPage('video')}
        />
      )}
      {helpOpen && (
        <Modal title="A little studio guide" onClose={() => setHelpOpen(false)}>
          <StudioHelp />
        </Modal>
      )}
      {confirmDelete?.kind === 'preset' && (
        <ConfirmDialog
          title={`Delete “${confirmDelete.preset.name}”?`}
          confirmLabel="Delete preset"
          onClose={() => setConfirmDelete(undefined)}
          onConfirm={() =>
            void runUserWrite(
              `preset-${confirmDelete.preset.id}`,
              async () => receive(await window.latent.deletePreset(confirmDelete.preset.id)),
              'Preset deleted.',
            )
          }
        >
          <p>This preset is gone for good once you delete it. Images you made with it keep their recipes.</p>
        </ConfirmDialog>
      )}
      {confirmDelete?.kind === 'image' && (
        <ConfirmDialog
          title="Delete this image?"
          confirmLabel="Move to Recycle Bin"
          onClose={() => setConfirmDelete(undefined)}
          onConfirm={() => void run('trash-outputs', () => window.latent.trashOutputs([confirmDelete.record.id]))}
        >
          <p>
            This removes the image from your library. Changed your mind later? Restore it from the Recycle Bin and it
            comes right back.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

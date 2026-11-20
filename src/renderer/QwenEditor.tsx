import { droppedImage, imageDropProps, sourceFromDrop, startRecordDrag, type DroppedImage } from './image-drag';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Brush,
  ChevronDown,
  ChevronRight,
  Dices,
  Download,
  Eraser,
  ExternalLink,
  ImagePlus,
  LoaderCircle,
  MousePointerClick,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Square,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  X,
} from 'lucide-react';
import { isImageJob, type AppSnapshot, type GenerationJob, type GenerationRecord } from '../shared/types';
import type { SourceImageAsset } from '../shared/source-types';
import {
  qwenProfileSteps,
  isQwen21Profile,
  isFastQwenProfile,
  type QwenEditProfile,
  qwenEditJobRequestSchema,
  type QwenEditJobRequest,
} from '../shared/qwen-edit-types';
import {
  createQwenConversationDraft,
  QWEN_CONVERSATION_LIMIT,
  qwenConversationSchema,
  type QwenConversationDraft,
  type QwenConversationStore,
} from '../shared/qwen-conversation';
import { qwenSameSize, qwenWorkingSize } from '../shared/qwen-area';
import { DEFAULT_DRAFT } from '../shared/defaults';
import { CompareImage } from './CompareImage';
import { bytes, Notice, type RunAction } from './ui';
import { actionErrorMessage as errorMessage } from '../shared/action-error';
import { qwenConversationJobs } from './queue-view';
import { EditPaint, type EditPaintHandle, type PaintTool } from './EditPaint';
import { Popover } from './EditPopover';
import './qwen-editor.css';
import './edit-page.css';

export interface QwenEditorProps {
  embedded?: boolean;
  snapshot: AppSnapshot;
  run: RunAction;
  busy: Record<string, boolean>;
  onClose: () => void;
  onSnapshot?: (snapshot: AppSnapshot) => void;
  initialRecord?: GenerationRecord;
  initialMode?: 'preview' | 'reuse';
  /** An image dropped on the Edit button in the side rail, used as the starting image once loaded. */
  dropped?: DroppedImage;
  onDroppedUsed?: () => void;
  onOpenInCreate?: (record: GenerationRecord) => void;
}

const emptyStore = (): QwenConversationStore => ({ schemaVersion: 1, conversations: [] });
const sourceUrl = (id: string) => `latent-asset://source/${encodeURIComponent(id)}`;
const maskUrl = (id: string) => `latent-asset://mask/${encodeURIComponent(id)}`;

const QUALITY: Array<{ profile: QwenEditProfile; label: string; detail: string }> = [
  { profile: 'fast', label: 'Fast', detail: '4 steps' },
  { profile: 'lightning8', label: 'Good', detail: '8 steps' },
  { profile: 'base', label: 'Best', detail: '40 steps, slow' },
];
export function qualityLabel(profile: QwenEditProfile) {
  if (profile === 'compact') return 'Fast · small files';
  if (profile === 'qwen21') return 'Qwen Image 2.1';
  return QUALITY.find(item => item.profile === profile)?.label ?? 'Good';
}
const CREATE_SIZES = {
  square: { width: 1024, height: 1024, label: 'Square' },
  portrait: { width: 768, height: 1024, label: 'Portrait' },
  landscape: { width: 1024, height: 768, label: 'Landscape' },
} as const;

/** One click fills in a tested instruction. Some also switch to painting. */
const QUICK: Array<{ label: string; text: string; area?: boolean; open?: boolean }> = [
  {
    label: 'Remove background',
    text: 'Replace the background with a plain, clean white backdrop. Keep the subject exactly as it is, including the edges of hair and clothes.',
  },
  {
    label: 'Remove object',
    text: 'Remove what is in the painted area and fill it in so it matches the surroundings.',
    area: true,
  },
  { label: 'Change outfit', text: 'Change the outfit to ', open: true },
  {
    label: 'Relight',
    text: 'Relight the picture with soft, warm evening light coming from the left. Keep everything else the same.',
  },
  {
    label: 'Restyle',
    text: 'Turn this into a watercolor painting. Keep the composition, the people and their poses the same.',
  },
  {
    label: 'Fix face',
    text: 'Fix the face in the painted area so it looks natural and sharp. Keep the same person, expression and angle.',
    area: true,
  },
];
const MORE_QUICK: typeof QUICK = [
  { label: 'Change hair', text: 'Change the hair to ', open: true },
  {
    label: 'Make it night',
    text: 'Make it night time with moonlight and soft city lights. Keep everything else the same.',
  },
  {
    label: 'Restore old photo',
    text: 'Restore this old photo: remove scratches, dust and noise, fix faded colours and sharpen details. Keep the people exactly the same.',
  },
  { label: 'Add text', text: 'Add the words "" in clean bold lettering at the top.', open: true },
  {
    label: 'Close-up',
    text: 'Zoom in to a close-up of the main subject. Keep the same look, lighting and style.',
  },
];

/** Exact replay derives only from retained recipe metadata, not current bundle
 * defaults or the normal Create draft. Selecting a preview never calls this.
 */
export function qwenReplayDraft(record: GenerationRecord, existing?: QwenConversationDraft): QwenConversationDraft {
  const edit = record.qwenEdit;
  if (!edit) throw new Error('This image does not contain a complete Qwen edit recipe.');
  const plan = edit.plan;
  const assets = plan.bundle.assets;
  const base = existing ?? createQwenConversationDraft('Replayed image edit', edit.lineage.conversationId);
  const request = record.draft?.qwenEdit;
  return {
    ...base,
    id: edit.lineage.conversationId,
    branchId: edit.lineage.branchId,
    source: plan.source
      ? { id: plan.source.id, sha256: plan.source.normalized.sha256, parentRecordId: plan.source.originGenerationId }
      : undefined,
    operation: plan.operation,
    transparent: plan.transparent,
    references: plan.references?.map(ref => ({ sourceId: ref.source.id, sha256: ref.source.normalized.sha256 })),
    selectedRecordId: record.id,
    instruction: plan.instruction,
    negativePrompt: plan.negativePrompt,
    settings: { ...plan.settings, seed: record.actualSeed },
    mode: plan.area ? 'area' : 'whole',
    tries: 1,
    frozenRecipe: {
      reusedRecordId: record.id,
      workflowVersion: plan.workflowVersion,
      assetHashes: {
        diffusion: assets.diffusion.sha256,
        encoder: assets.encoder.sha256,
        vae: assets.vae.sha256,
        ...(assets.lightning ? { lightning: assets.lightning.sha256 } : {}),
      },
      ...(plan.area ? { area: structuredClone(plan.area) } : {}),
      ...(request?.output ? { output: structuredClone(request.output) } : {}),
    },
    updatedAt: new Date().toISOString(),
  };
}

/** A step in the timeline: one edit, with all the tries that were made for it. */
interface Step {
  key: string;
  records: GenerationRecord[];
  parentRecordId?: string;
  number: number;
  parentStep?: number;
  branch: boolean;
}
export function buildSteps(records: GenerationRecord[]): Step[] {
  const groups = new Map<string, GenerationRecord[]>();
  for (const record of records) {
    const key = record.qwenEdit?.lineage.group ?? record.id;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  const steps: Step[] = [];
  for (const [key, items] of groups) {
    const parentRecordId = items[0].qwenEdit?.lineage.parentRecordId;
    const parentIndex = steps.findIndex(step => step.records.some(record => record.id === parentRecordId));
    steps.push({
      key,
      records: items,
      parentRecordId,
      number: steps.length + 1,
      parentStep: parentIndex >= 0 ? parentIndex + 1 : undefined,
      branch: steps.length > 0 && parentIndex !== steps.length - 1,
    });
  }
  return steps;
}

export function QwenEditor({
  embedded,
  snapshot,
  run,
  busy,
  onClose,
  onSnapshot,
  initialRecord,
  initialMode = 'preview',
  dropped,
  onDroppedUsed,
  onOpenInCreate,
}: QwenEditorProps) {
  const [dropOver, setDropOver] = useState(false);
  const [saved, setSaved] = useState<QwenConversationStore>(emptyStore);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [extraSources, setExtraSources] = useState<SourceImageAsset[]>([]);
  const [previous, setPrevious] = useState<QwenConversationStore>();
  const [compare, setCompare] = useState<GenerationRecord>();
  const [view, setView] = useState<'after' | 'before'>('after');
  const [triesGroup, setTriesGroup] = useState<string>();
  const [menu, setMenu] = useState<string>();
  const [tool, setTool] = useState<PaintTool>('brush');
  const [brush, setBrush] = useState(46);
  const [painted, setPainted] = useState(false);
  const [imageError, setImageError] = useState('');
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [fit, setFit] = useState({ width: 0, height: 0 });
  const paint = useRef<EditPaintHandle>(null);
  const canvasArea = useRef<HTMLDivElement>(null);
  const textBox = useRef<HTMLTextAreaElement>(null);
  const current = useRef(saved);
  const live = useRef(snapshot);
  live.current = snapshot;
  const snapshotReceiver = useRef(onSnapshot);
  snapshotReceiver.current = onSnapshot;
  const mounted = useRef(true);
  const hydrated = useRef(false);
  const closing = useRef(false);
  const version = useRef(0);
  const persisted = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const activeActions = useRef(new Set<string>());
  const criticalActions = useRef(new Set<Promise<unknown>>());
  const lastQueued = useRef<{ ids: string[]; conversationId: string; group?: string; selectedRecordId?: string }>(
    undefined,
  );
  const loadEpoch = useRef(0);
  const initial = useRef({ record: initialRecord, mode: initialMode });
  const closeMenu = useCallback(() => setMenu(undefined), []);

  useEffect(() => {
    setSlot(document.getElementById('edit-top-slot'));
  }, []);

  const changeStore = useCallback((value: QwenConversationStore) => {
    current.current = structuredClone(value);
    version.current++;
    if (mounted.current) {
      setSaved(current.current);
      setSaveError('');
    }
  }, []);
  const persist = useCallback((value: QwenConversationStore, revision: number) => {
    const task = saveQueue.current
      .catch(() => {})
      .then(async () => {
        if (revision <= persisted.current) return;
        await window.latent.saveQwenConversation(qwenConversationSchema.parse(value));
        persisted.current = revision;
        if (mounted.current) setSaveError('');
      });
    saveQueue.current = task;
    return task.catch(reason => {
      if (mounted.current) setSaveError(errorMessage(reason));
      throw reason;
    });
  }, []);
  const flush = useCallback(async () => {
    if (!hydrated.current) return;
    // Selection can change while a save is awaiting IPC, including during
    // close. Drain every intervening revision before allowing the editor to leave.
    do {
      await persist(structuredClone(current.current), version.current);
    } while (persisted.current < version.current);
  }, [persist]);
  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    setLoading(true);
    setError('');
    try {
      if (!window.latent?.getQwenConversation)
        throw new Error('Open the updated desktop app to use the local image editor.');
      const value = qwenConversationSchema.parse((await window.latent.getQwenConversation()) ?? emptyStore());
      if (!mounted.current || epoch !== loadEpoch.current) return;
      let next = value;
      const record = initial.current.record;
      if (record?.qwenEdit) {
        const conversationId = record.qwenEdit.lineage.conversationId;
        const existing = next.conversations.find(item => item.id === conversationId);
        if (!existing && next.conversations.length >= QWEN_CONVERSATION_LIMIT) {
          setNotice('You have 50 saved edits, which is the limit. Remove one you no longer need first.');
        } else {
          const draft =
            initial.current.mode === 'reuse'
              ? qwenReplayDraft(record, existing)
              : {
                  ...(existing ?? createQwenConversationDraft('Image edit', conversationId)),
                  selectedRecordId: record.id,
                };
          next = {
            ...next,
            activeConversationId: draft.id,
            conversations: [...next.conversations.filter(item => item.id !== draft.id), draft],
          };
          if (initial.current.mode === 'reuse') {
            setPrevious(value);
            setNotice('Recipe restored with its exact seed. Press Edit to run it again.');
          }
        }
      }
      if (!next.activeConversationId && next.conversations.length)
        next = { ...next, activeConversationId: next.conversations[0].id };
      if (!next.conversations.length) {
        const draft = createQwenConversationDraft();
        next = { ...next, activeConversationId: draft.id, conversations: [draft] };
      }
      current.current = next;
      setSaved(next);
      hydrated.current = true;
      setLoaded(true);
      if (JSON.stringify(next) !== JSON.stringify(value)) version.current++;
    } catch (reason) {
      if (mounted.current && epoch === loadEpoch.current)
        setError(`Edit could not open your saved edits: ${errorMessage(reason)}`);
    } finally {
      if (mounted.current && epoch === loadEpoch.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      loadEpoch.current++;
      if (hydrated.current) void run('qwen-save', flush);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  useEffect(() => {
    let cancelled = false;
    void window.latent
      .getSnapshot()
      .then(value => {
        if (!cancelled) snapshotReceiver.current?.(value);
      })
      .catch(reason => {
        if (!cancelled) setError(`Could not check whether editing is ready: ${errorMessage(reason)}`);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!loaded || closing.current || version.current <= persisted.current) return;
    const timer = window.setTimeout(() => {
      void flush().catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [saved, loaded, flush]);
  useEffect(() => {
    const hidden = () => {
      if (!closing.current && document.visibilityState === 'hidden') void flush().catch(() => {});
    };
    document.addEventListener('visibilitychange', hidden);
    const resetClose = () => {
      closing.current = false;
      if (mounted.current) setPending(value => ({ ...value, close: false }));
    };
    const before = window.latent?.onBeforeClose?.(async () => {
      closing.current = true;
      if (mounted.current) setPending(value => ({ ...value, close: true }));
      try {
        await Promise.all([...criticalActions.current]);
        await flush();
      } catch (error) {
        resetClose();
        throw error;
      }
    });
    const cancelled = window.latent?.onCloseCancelled?.(resetClose);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      before?.();
      cancelled?.();
    };
  }, [flush]);

  const draft = saved.conversations.find(item => item.id === saved.activeConversationId);
  const sources = useMemo(
    () => [...new Map([...extraSources, ...snapshot.sourceImages.sources].map(source => [source.id, source])).values()],
    [snapshot.sourceImages.sources, extraSources],
  );
  const source = sources.find(item => item.id === draft?.source?.id);
  const sourceChanged = Boolean(
    draft?.source &&
    (!source ||
      source.normalized.sha256 !== draft.source.sha256 ||
      source.originGenerationId !== draft.source.parentRecordId),
  );
  const records = snapshot.history
    .filter(record => draft && record.qwenEdit?.lineage.conversationId === draft.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const steps = buildSteps(records);
  const selected = snapshot.history.find(record => record.id === draft?.selectedRecordId);
  const chainSelected = selected?.qwenEdit?.lineage.conversationId === draft?.id ? selected : undefined;
  const rootSource = records[0]?.qwenEdit?.plan.source ?? source;
  const jobs = qwenConversationJobs(snapshot.jobs, draft?.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const currentJobs = jobs.filter(job => ['queued', 'running'].includes(job.status));
  const failedJobs = jobs.filter(job => ['failed'].includes(job.status)).slice(-2);
  const historyConversations = [
    ...new Set(snapshot.history.flatMap(record => (record.qwenEdit ? [record.qwenEdit.lineage.conversationId] : []))),
  ];
  const allConversationIds = [...new Set([...saved.conversations.map(item => item.id), ...historyConversations])];
  const creating = draft?.operation === 'create';
  const mode = creating ? 'whole' : (draft?.mode ?? 'whole');
  const profile = draft?.settings.profile ?? 'lightning8';
  const readyFor = (value: QwenEditProfile) =>
    isQwen21Profile(value)
      ? snapshot.qwenEdit.qwen21Ready === true && snapshot.runtimeUpdates?.current?.setId === 'comfy-0-37-0-qwen21-1'
      : value === 'lightning8'
        ? snapshot.qwenEdit.lightning8Ready === true
        : value === 'compact'
          ? snapshot.qwenEdit.compactReady === true
          : value === 'base'
            ? snapshot.qwenEdit.baseReady
            : snapshot.qwenEdit.fastReady;
  const profileReady = readyFor(profile);
  const repairNeeded = snapshot.qwenEdit.state === 'error';
  const engineSetup =
    isQwen21Profile(profile) && ['staging', 'applying', 'checking'].includes(snapshot.runtimeUpdates?.state ?? '');
  const installing = snapshot.qwenEdit.state === 'installing' || pending.setup || engineSetup;
  const locked = !loaded || pending.close || pending.source || pending.reference || pending.queue;
  const recent = snapshot.history.filter(record => record.imageUrl).slice(0, 8);
  const tries = draft?.frozenRecipe ? 1 : (draft?.tries ?? 1);
  const sizeChoice = draft?.size ?? (creating ? 'square' : 'same');
  const profileBytes =
    profile === 'qwen21'
      ? (snapshot.qwenEdit.qwen21Bytes ?? 17283091112)
      : profile === 'lightning8'
        ? (snapshot.qwenEdit.lightning8Bytes ?? 31836511854)
        : profile === 'compact'
          ? (snapshot.qwenEdit.compactBytes ?? 22898832710)
          : profile === 'fast'
            ? snapshot.qwenEdit.fastBytes
            : snapshot.qwenEdit.baseBytes;
  const steps_ = draft?.settings.steps ?? qwenProfileSteps(profile);
  const usesNegative = !isQwen21Profile(profile) && !isFastQwenProfile(profile);
  const usedDrop = useRef<DroppedImage>(undefined);
  useEffect(() => {
    if (!loaded || !dropped || usedDrop.current === dropped) return;
    usedDrop.current = dropped;
    onDroppedUsed?.();
    void startFromDrop(dropped);
    // Runs once per dropped image, after the saved drafts load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, dropped]);

  // The picture the next edit starts from, and what the stage shows.
  const inputRecord = chainSelected ?? (selected && !selected.qwenEdit ? selected : undefined);
  const baseSize = inputRecord
    ? { width: inputRecord.width, height: inputRecord.height }
    : source
      ? { width: source.normalized.width, height: source.normalized.height }
      : undefined;
  const runningJob = currentJobs.find(job => job.status === 'running');
  const livePreview =
    runningJob?.previewUrl && snapshot.settings.showGenerationPreview && !triesGroup
      ? runningJob.previewUrl
      : undefined;
  const beforeUrl = chainSelected?.qwenEdit?.plan.source ? sourceUrl(chainSelected.qwenEdit.plan.source.id) : undefined;
  const pictureUrl =
    view === 'before' && beforeUrl
      ? beforeUrl
      : (livePreview ?? inputRecord?.imageUrl ?? (source && !creating ? sourceUrl(source.id) : undefined));
  const tryRecords = triesGroup ? records.filter(record => record.qwenEdit?.lineage.group === triesGroup) : [];
  const tryJobs = triesGroup ? currentJobs.filter(job => job.draft.qwenEdit?.lineage.group === triesGroup) : [];
  const showTries = Boolean(triesGroup && tryRecords.length + tryJobs.length > 1);
  useEffect(() => {
    setImageError('');
  }, [pictureUrl]);
  useEffect(() => {
    if (view === 'before' && !beforeUrl) setView('after');
  }, [view, beforeUrl]);
  // Size the picture frame to fit the stage, so the paint layer lines up exactly.
  useLayoutEffect(() => {
    const area = canvasArea.current;
    if (!area || !baseSize) return;
    const measure = () => {
      const pad = 28;
      const width = Math.max(0, area.clientWidth - pad);
      const height = Math.max(0, area.clientHeight - pad);
      const scale = Math.min(width / baseSize.width, height / baseSize.height);
      setFit({ width: Math.floor(baseSize.width * scale), height: Math.floor(baseSize.height * scale) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [baseSize?.width, baseSize?.height, showTries]);
  // A new picture size means old paint no longer lines up.
  useEffect(() => {
    paint.current?.clear();
  }, [baseSize?.width, baseSize?.height]);

  // When queued tries finish, show the first one, and the tries grid when there are several.
  useEffect(() => {
    const queued = lastQueued.current;
    if (!queued) return;
    const finished = queued.ids
      .map(id => snapshot.jobs.find(item => item.id === id))
      .filter((job): job is GenerationJob => Boolean(job && isImageJob(job)));
    const outputs = snapshot.history.filter(record => finished.some(job => job.outputIds.includes(record.id)));
    const latest = current.current.conversations.find(item => item.id === current.current.activeConversationId);
    if (outputs.length && latest?.id === queued.conversationId && latest.selectedRecordId === queued.selectedRecordId) {
      const first = outputs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      changeStore({
        ...current.current,
        conversations: current.current.conversations.map(item =>
          item.id === latest.id ? { ...item, selectedRecordId: first.id } : item,
        ),
      });
      queued.selectedRecordId = first.id;
      setView('after');
    }
    if (finished.length === queued.ids.length && finished.every(job => !['queued', 'running'].includes(job.status)))
      lastQueued.current = undefined;
  }, [snapshot.jobs, snapshot.history, changeStore]);

  const action = useCallback(
    async (key: string, task: () => Promise<void>, success?: string, critical = false) => {
      if (closing.current || activeActions.current.has(key)) return false;
      activeActions.current.add(key);
      setPending(value => ({ ...value, [key]: true }));
      setError('');
      let acceptedWork: Promise<void> | undefined;
      const work = run(
        `qwen-${key}`,
        async () => {
          try {
            acceptedWork = task();
            if (critical) criticalActions.current.add(acceptedWork);
            await acceptedWork;
          } catch (reason) {
            if (mounted.current) setError(errorMessage(reason));
            throw reason;
          }
        },
        success,
      );
      try {
        return await work;
      } finally {
        if (acceptedWork) criticalActions.current.delete(acceptedWork);
        activeActions.current.delete(key);
        if (mounted.current) setPending(value => ({ ...value, [key]: false }));
      }
    },
    [run],
  );
  const getDraft = () => current.current.conversations.find(item => item.id === current.current.activeConversationId);
  function replaceDraft(next: QwenConversationDraft, undo = false) {
    if (undo) setPrevious(structuredClone(current.current));
    changeStore({
      ...current.current,
      activeConversationId: next.id,
      conversations: [
        ...current.current.conversations.filter(item => item.id !== next.id),
        { ...next, updatedAt: new Date().toISOString() },
      ],
    });
  }
  function edit(patch: Partial<QwenConversationDraft>, recipeChange = true) {
    const latest = getDraft();
    if (!latest) return;
    if (recipeChange && latest.frozenRecipe) setNotice('You changed the restored recipe, so it runs as a new edit.');
    replaceDraft({ ...latest, ...patch, ...(recipeChange ? { frozenRecipe: undefined } : {}) });
  }
  function selectRecord(record?: GenerationRecord) {
    lastQueued.current = undefined;
    edit({ selectedRecordId: record?.id }, false);
    setTriesGroup(undefined);
    setView('after');
  }
  function canAddConversation(id?: string) {
    return (
      Boolean(id && current.current.conversations.some(item => item.id === id)) ||
      current.current.conversations.length < QWEN_CONVERSATION_LIMIT
    );
  }
  function newConversation(operation: 'edit' | 'create' = 'edit') {
    if (!canAddConversation()) {
      setError('You have 50 saved edits. Remove one you no longer need first. Every picture stays in the Library.');
      return;
    }
    const next = createQwenConversationDraft(operation === 'create' ? 'New picture' : 'New edit');
    const prior = getDraft();
    if (operation === 'create') {
      next.operation = 'create';
      next.settings = { ...next.settings, profile: 'qwen21', width: 1024, height: 1024, resize: 'stretch' };
      next.size = 'square';
    } else if (prior && !isQwen21Profile(prior.settings.profile))
      next.settings = { ...next.settings, profile: prior.settings.profile };
    replaceDraft(next, true);
    setTriesGroup(undefined);
    setMenu(undefined);
    paint.current?.clear();
  }
  function openConversation(id: string) {
    const existing = current.current.conversations.find(item => item.id === id);
    if (existing) changeStore({ ...current.current, activeConversationId: id });
    else {
      if (!canAddConversation(id)) {
        setError('Remove a saved edit you no longer need before reopening this one. Its pictures are in the Library.');
        return;
      }
      const latest = [...live.current.history]
        .filter(record => record.qwenEdit?.lineage.conversationId === id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      replaceDraft({ ...createQwenConversationDraft('Saved edit', id), selectedRecordId: latest?.id });
    }
    setTriesGroup(undefined);
    setMenu(undefined);
    setError('');
  }
  function removeConversation(id: string) {
    setPrevious(structuredClone(current.current));
    const conversations = current.current.conversations.filter(item => item.id !== id);
    const active =
      current.current.activeConversationId === id ? conversations[0]?.id : current.current.activeConversationId;
    changeStore({ schemaVersion: 1, conversations, activeConversationId: active });
    setNotice('Removed from the list. Its pictures stay in the Library.');
  }
  function hasChildren(record: GenerationRecord) {
    return (
      live.current.history.some(item => item.qwenEdit?.lineage.parentRecordId === record.id) ||
      live.current.jobs.some(
        job =>
          isImageJob(job) &&
          ['queued', 'running'].includes(job.status) &&
          job.draft.qwenEdit?.lineage.parentRecordId === record.id,
      )
    );
  }
  /** Starts a new edit chain from a picture (import, drop, or a picture from Create or the Library). */
  function assignSource(next: SourceImageAsset, parent?: GenerationRecord) {
    if (next.originGenerationId !== parent?.id)
      throw new Error('The imported picture does not match the picture you picked. Nothing changed.');
    const prior = getDraft();
    const conversationId = parent?.qwenEdit?.lineage.conversationId;
    let target = conversationId ? current.current.conversations.find(item => item.id === conversationId) : undefined;
    const startingDraft =
      !conversationId &&
      prior &&
      !prior.source &&
      prior.operation !== 'create' &&
      !live.current.history.some(record => record.qwenEdit?.lineage.conversationId === prior.id)
        ? prior
        : undefined;
    if (!target && startingDraft) target = startingDraft;
    if (!target && !canAddConversation(conversationId))
      throw new Error('Remove a saved edit you no longer need before starting another. Pictures are kept.');
    const profile = prior && !isQwen21Profile(prior.settings.profile) ? prior.settings.profile : 'lightning8';
    target ??= {
      ...createQwenConversationDraft(next.name.slice(0, 80) || 'Image edit', conversationId),
      settings: { ...createQwenConversationDraft().settings, profile },
    };
    setExtraSources(value => [...value.filter(item => item.id !== next.id), next]);
    replaceDraft(
      {
        ...target,
        operation: 'edit',
        branchId: parent?.qwenEdit && !hasChildren(parent) ? parent.qwenEdit.lineage.branchId : crypto.randomUUID(),
        source: { id: next.id, sha256: next.normalized.sha256, parentRecordId: next.originGenerationId },
        instruction: startingDraft ? target.instruction : '',
        frozenRecipe: undefined,
        selectedRecordId: parent?.qwenEdit ? parent.id : undefined,
        settings: {
          ...target.settings,
          profile: isQwen21Profile(target.settings.profile) ? 'lightning8' : target.settings.profile,
        },
      },
      true,
    );
    setTriesGroup(undefined);
    paint.current?.clear();
  }
  async function importImage() {
    await action(
      'source',
      async () => {
        const result = await window.latent.importSourceImage();
        if (!result) return;
        const parent = result.originGenerationId
          ? live.current.history.find(record => record.id === result.originGenerationId)
          : undefined;
        assignSource(result, parent);
        await flush();
        onSnapshot?.(await window.latent.getSnapshot());
      },
      undefined,
      true,
    );
  }
  async function addReference(fromFile?: File, fromRecord?: GenerationRecord) {
    await action(
      'reference',
      async () => {
        const ref = fromRecord
          ? await window.latent.useOutputAsSource(fromRecord.id)
          : fromFile
            ? await sourceFromDrop({ kind: 'file', file: fromFile })
            : await window.latent.importSourceImage();
        if (!ref) return;
        const latest = getDraft();
        if (!latest) return;
        setExtraSources(value => [...value.filter(item => item.id !== ref.id), ref]);
        const list = [
          ...(latest.references ?? []).filter(item => item.sourceId !== ref.id),
          {
            sourceId: ref.id,
            sha256: ref.normalized.sha256,
          },
        ].slice(-2);
        edit({ references: list });
        await flush();
        onSnapshot?.(await window.latent.getSnapshot());
      },
      undefined,
      true,
    );
  }
  async function startFromRecord(record: GenerationRecord) {
    const id = record.qwenEdit?.lineage.conversationId;
    if (!canAddConversation(id) && !(getDraft() && !getDraft()!.source && !id)) {
      setError('Remove a saved edit you no longer need first. Every picture stays in the Library.');
      return;
    }
    if (record.qwenEdit) {
      openConversation(record.qwenEdit.lineage.conversationId);
      const latest = getDraft();
      if (latest) replaceDraft({ ...latest, selectedRecordId: record.id });
      return;
    }
    await action(
      'source',
      async () => {
        const source = await window.latent.useOutputAsSource(record.id);
        assignSource(source, record);
        await flush();
        onSnapshot?.(await window.latent.getSnapshot());
      },
      undefined,
      true,
    );
  }
  async function startFromDrop(drop: DroppedImage) {
    if (drop.kind === 'record') return startFromRecord(drop.record);
    if (!canAddConversation(undefined) && !(getDraft() && !getDraft()!.source)) {
      setError('Remove a saved edit you no longer need first. Every picture stays in the Library.');
      return;
    }
    await action(
      'source',
      async () => {
        assignSource(await sourceFromDrop(drop));
        await flush();
        onSnapshot?.(await window.latent.getSnapshot());
      },
      undefined,
      true,
    );
  }
  /** The saved input picture for the next edit: the selected step, or the chain's own picture. */
  async function inputSource(latest: QwenConversationDraft) {
    const pick = live.current.history.find(record => record.id === latest.selectedRecordId);
    if (pick && pick.id !== latest.source?.parentRecordId) {
      const made = await window.latent.useOutputAsSource(pick.id);
      setExtraSources(value => [...value.filter(item => item.id !== made.id), made]);
      return { asset: made, parent: pick };
    }
    const asset = [...extraSources, ...live.current.sourceImages.sources].find(item => item.id === latest.source?.id);
    if (!asset || asset.normalized.sha256 !== latest.source?.sha256)
      throw new Error('The picture this edit starts from is missing or changed. Pick it again.');
    const parent = latest.source.parentRecordId
      ? live.current.history.find(record => record.id === latest.source!.parentRecordId)
      : undefined;
    return { asset, parent };
  }
  async function pickArea(x: number, y: number) {
    const latest = getDraft();
    if (!latest) return;
    await action('pick', async () => {
      const { asset } = await inputSource(latest);
      const result = await window.latent.suggestMask({ sourceId: asset.id, points: [{ x, y, label: 1 }] });
      await paint.current?.addMask(maskUrl(result.mask.id));
    });
  }
  async function tidyUp() {
    const latest = getDraft();
    if (!latest?.instruction.trim()) {
      setError('Type roughly what you want first, then Tidy up rewrites it.');
      return;
    }
    await action('tidy', async () => {
      const picture = latest.selectedRecordId
        ? { kind: 'output' as const, id: latest.selectedRecordId }
        : latest.source
          ? { kind: 'source' as const, id: latest.source.id }
          : undefined;
      const reply = await window.latent.assistantSuggest({
        target: 'edit',
        action: 'improve',
        draft: { ...structuredClone(DEFAULT_DRAFT), prompt: latest.instruction, negativePrompt: '' },
        ...(picture && live.current.assistant?.vision ? { image: picture } : {}),
      });
      const text = reply.options[0]?.prompt?.trim();
      if (text) edit({ instruction: text.slice(0, 4000) });
      setNotice(reply.message);
    });
  }
  async function queueEdit(sameAgain = false) {
    const latest = getDraft();
    if (
      closing.current ||
      locked ||
      !latest ||
      !latest.instruction.trim() ||
      !profileReady ||
      live.current.backend.state !== 'ready'
    )
      return;
    const submittedVersion = version.current;
    await action(
      'queue',
      async () => {
        await flush();
        const create = latest.operation === 'create';
        const frozen = latest.frozenRecipe;
        let request: QwenEditJobRequest;
        let nextSource = latest.source;
        let branchId = latest.branchId;
        if (create) {
          const size = CREATE_SIZES[latest.size as keyof typeof CREATE_SIZES] ?? CREATE_SIZES.square;
          request = {
            mode: 'qwen-edit',
            operation: 'create',
            transparent: latest.transparent,
            instruction: latest.instruction,
            negativePrompt: latest.negativePrompt,
            settings: { ...latest.settings, width: size.width, height: size.height },
            lineage: { conversationId: latest.id, branchId: latest.branchId },
          };
        } else if (frozen) {
          request = {
            mode: 'qwen-edit',
            sourceId: latest.source?.id,
            sourceSha256: latest.source?.sha256,
            operation: latest.operation,
            transparent: latest.transparent,
            references: latest.references,
            instruction: latest.instruction,
            negativePrompt: latest.negativePrompt,
            settings: latest.settings,
            ...(frozen.area ? { area: frozen.area } : {}),
            ...(frozen.output ? { output: frozen.output } : {}),
            lineage: {
              conversationId: latest.id,
              branchId: latest.branchId,
              parentRecordId: latest.source?.parentRecordId,
            },
            assetHashes: frozen.assetHashes,
            workflowVersion: frozen.workflowVersion,
          };
        } else {
          const { asset, parent } = await inputSource(latest);
          const inChain = parent?.qwenEdit?.lineage.conversationId === latest.id;
          const chainHasSteps = live.current.history.some(
            record => record.qwenEdit?.lineage.conversationId === latest.id,
          );
          branchId =
            parent?.qwenEdit && inChain
              ? hasChildren(parent) && !sameAgain
                ? crypto.randomUUID()
                : parent.qwenEdit.lineage.branchId
              : chainHasSteps && !sameAgain
                ? crypto.randomUUID()
                : latest.branchId;
          nextSource = { id: asset.id, sha256: asset.normalized.sha256, parentRecordId: asset.originGenerationId };
          const size = { width: asset.normalized.width, height: asset.normalized.height };
          let area: QwenEditJobRequest['area'];
          if ((latest.mode ?? 'whole') === 'area') {
            const png = await paint.current?.exportMask();
            if (!png) throw new Error('Paint the part you want to change first, or switch to Whole picture.');
            const mask = await window.latent.saveSourceMask(asset.id, png);
            area = { maskId: mask.id, maskSha256: mask.sha256, blend: latest.blend ?? 12 };
          }
          const working = qwenWorkingSize(size.width, size.height);
          request = {
            mode: 'qwen-edit',
            sourceId: asset.id,
            sourceSha256: asset.normalized.sha256,
            operation: 'edit',
            references: latest.references?.length ? latest.references : undefined,
            instruction: latest.instruction,
            negativePrompt: latest.negativePrompt,
            settings: { ...latest.settings, ...working, resize: 'stretch', steps: undefined, guidance: undefined },
            ...(area ? { area } : {}),
            ...(!area && (latest.size ?? 'same') === 'same' ? { output: qwenSameSize(size.width, size.height) } : {}),
            lineage: { conversationId: latest.id, branchId, parentRecordId: asset.originGenerationId },
          };
        }
        const count = frozen ? 1 : Math.max(1, Math.min(4, latest.tries ?? 1));
        const group = count > 1 ? crypto.randomUUID() : undefined;
        const seed = request.settings.seed;
        const ids: string[] = [];
        for (let index = 0; index < count; index++) {
          const next = structuredClone(request);
          if (group) next.lineage.group = group;
          if (seed !== 'random' && /^\d+$/.test(seed) && index > 0)
            next.settings.seed = String(BigInt(seed) + BigInt(index));
          const parsed = qwenEditJobRequestSchema.parse(next);
          const job = await window.latent.enqueueQwenEdit(parsed);
          ids.push(job.id);
        }
        const now = getDraft();
        if (now && now.id === latest.id)
          replaceDraft({ ...now, source: nextSource, branchId, frozenRecipe: undefined });
        if (version.current >= submittedVersion)
          lastQueued.current = {
            ids,
            conversationId: latest.id,
            group,
            selectedRecordId: getDraft()?.selectedRecordId,
          };
        setTriesGroup(group);
        onSnapshot?.(await window.latent.getSnapshot());
        setNotice('');
      },
      undefined,
      true,
    );
  }

  // ---------- View pieces ----------
  const chainTitle = draft?.title ?? 'New edit';
  const chainThumb = records.at(-1)?.imageUrl ?? (rootSource ? sourceUrl(rootSource.id) : undefined);
  const topBar = (
    <div className="ed-top">
      <div className="ed-anchor">
        <button
          type="button"
          className="ed-chain"
          aria-haspopup="dialog"
          aria-expanded={menu === 'chains'}
          onClick={() => setMenu(menu === 'chains' ? undefined : 'chains')}
        >
          {chainThumb ? <img src={chainThumb} alt="" /> : <span className="ed-chain-empty" />}
          <span>{chainTitle}</span>
          <small>
            {steps.length} step{steps.length === 1 ? '' : 's'}
          </small>
          <ChevronDown size={15} />
        </button>
        <Popover open={menu === 'chains'} onClose={closeMenu} className="ed-pop-down ed-chains">
          {draft && (
            <label className="ed-rename">
              Name
              <input
                value={draft.title}
                maxLength={80}
                disabled={locked}
                onChange={event => edit({ title: event.target.value || 'Untitled edit' }, false)}
              />
            </label>
          )}
          <div className="ed-chain-list" role="list">
            {allConversationIds.map(id => {
              const stored = saved.conversations.find(item => item.id === id);
              const pics = snapshot.history.filter(record => record.qwenEdit?.lineage.conversationId === id);
              const thumb = pics.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.imageUrl;
              return (
                <div key={id} role="listitem" className={id === draft?.id ? 'on' : ''}>
                  <button type="button" disabled={locked} onClick={() => openConversation(id)}>
                    {thumb ? <img src={thumb} alt="" /> : <span className="ed-chain-empty" />}
                    <span>
                      {stored?.title ?? 'Saved edit'}
                      <small>
                        {pics.length} picture{pics.length === 1 ? '' : 's'}
                      </small>
                    </span>
                  </button>
                  {stored && (
                    <button
                      type="button"
                      className="ed-icon"
                      title="Remove from this list. The pictures stay in the Library."
                      aria-label={`Remove ${stored.title} from the list`}
                      disabled={locked}
                      onClick={() => removeConversation(id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </Popover>
      </div>
      <div className="ed-anchor">
        <button
          type="button"
          className="ed-ghost"
          disabled={locked}
          aria-haspopup="dialog"
          aria-expanded={menu === 'new'}
          onClick={() => setMenu(menu === 'new' ? undefined : 'new')}
        >
          <Plus size={15} />
          New edit
        </button>
        <Popover open={menu === 'new'} onClose={closeMenu} className="ed-pop-down ed-menu">
          <button
            type="button"
            onClick={() => {
              newConversation('edit');
              void importImage();
            }}
          >
            <ImagePlus size={15} />
            Start from a picture
          </button>
          <button type="button" onClick={() => newConversation('create')}>
            <Type size={15} />
            Start from text
            <small>Qwen Image 2.1</small>
          </button>
        </Popover>
      </div>
    </div>
  );

  const stepLabel = (record: GenerationRecord) => {
    const plan = record.qwenEdit?.plan;
    if (!plan) return '';
    return qualityLabel(plan.settings.profile);
  };
  const seconds = (record: GenerationRecord) =>
    record.durationMs ? `${Math.max(1, Math.round(record.durationMs / 1000))} s` : '';

  const timeline = (
    <aside className="ed-side" aria-label="Steps">
      <header>
        <strong>Steps</strong>
        <small>Click a step to keep going from it</small>
      </header>
      <div className="ed-steps">
        {rootSource && !creating && (
          <button
            type="button"
            className={`ed-step ${!chainSelected ? 'sel' : ''}`}
            onClick={() => selectRecord(undefined)}
            disabled={locked}
          >
            <img src={sourceUrl(rootSource.id)} alt="" />
            <span>
              <b>Original</b>
              <small>
                {rootSource.normalized.width} × {rootSource.normalized.height}
              </small>
            </span>
          </button>
        )}
        {steps.map(step => {
          const pick = step.records.find(record => record.id === chainSelected?.id) ?? step.records[0];
          const plan = pick.qwenEdit!.plan;
          const isSelected = step.records.some(record => record.id === chainSelected?.id);
          return (
            <div
              key={step.key}
              className={`ed-step ${isSelected ? 'sel' : ''} ${step.branch ? 'branch' : ''}`}
              role="button"
              tabIndex={0}
              draggable
              onDragStart={event => startRecordDrag(event, pick)}
              onClick={() => selectRecord(pick)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  selectRecord(pick);
                }
              }}
            >
              <img src={pick.imageUrl} alt="" />
              <span>
                <b>{plan.instruction}</b>
                <small>
                  {plan.operation === 'create' ? (
                    <em className="tag">From text</em>
                  ) : plan.area ? (
                    <em className="tag acc">Painted area</em>
                  ) : (
                    <em className="tag">Whole picture</em>
                  )}
                  {step.branch && (
                    <em className="tag">{step.parentStep ? `From step ${step.parentStep}` : 'From original'}</em>
                  )}
                  {(plan.references?.length ?? 0) > 0 && <em className="tag">+{plan.references!.length} pic</em>}
                  {stepLabel(pick)}
                  {seconds(pick) && ` · ${seconds(pick)}`}
                </small>
                {step.records.length > 1 && (
                  <span className="ed-tries">
                    {step.records.map(record => (
                      <img
                        key={record.id}
                        src={record.imageUrl}
                        alt=""
                        className={record.id === pick.id ? 'k' : ''}
                        onClick={event => {
                          event.stopPropagation();
                          selectRecord(record);
                        }}
                      />
                    ))}
                  </span>
                )}
              </span>
            </div>
          );
        })}
        {currentJobs.length > 0 && (
          <div className="ed-step run sel" aria-live="polite">
            <span className="ed-step-wait">
              <LoaderCircle className="spin" size={18} />
            </span>
            <span>
              <b>{currentJobs[0].draft.qwenEdit?.instruction ?? 'Editing'}</b>
              <small>
                {runningJob
                  ? `Working · ${runningJob.progress} of ${runningJob.progressMax || '?'} steps`
                  : 'Waiting its turn'}
                {currentJobs.length > 1 && ` · ${currentJobs.length} left`}
              </small>
              {runningJob && (
                <span className="ed-bar">
                  <i style={{ width: `${(100 * runningJob.progress) / Math.max(1, runningJob.progressMax)}%` }} />
                </span>
              )}
              <span className="ed-step-actions">
                {currentJobs.map(job => (
                  <button
                    key={job.id}
                    type="button"
                    className="ed-link"
                    disabled={busy[`cancel-${job.id}`] || pending[`cancel-${job.id}`]}
                    onClick={() =>
                      void action(`cancel-${job.id}`, () => window.latent.cancelJob(job.id), undefined, true)
                    }
                  >
                    Stop{currentJobs.length > 1 ? ` ${currentJobs.indexOf(job) + 1}` : ''}
                  </button>
                ))}
              </span>
            </span>
          </div>
        )}
        {failedJobs.map(job => (
          <div key={job.id} className="ed-step failed">
            <span className="ed-step-wait">
              <X size={18} />
            </span>
            <span>
              <b>{job.draft.qwenEdit?.instruction ?? 'Edit'}</b>
              <small>{job.error ?? 'This edit failed.'}</small>
              <button
                type="button"
                className="ed-link"
                disabled={pending[`retry-${job.id}`] || snapshot.backend.state !== 'ready'}
                onClick={() =>
                  void action(
                    `retry-${job.id}`,
                    async () => {
                      await window.latent.retryJob(job.id);
                      onSnapshot?.(await window.latent.getSnapshot());
                    },
                    undefined,
                    true,
                  )
                }
              >
                Try again
              </button>
            </span>
          </div>
        ))}
      </div>
      <footer>
        <button
          type="button"
          className="ed-btn"
          disabled={locked || !previous}
          onClick={() => {
            if (previous) {
              changeStore(previous);
              setPrevious(undefined);
            }
          }}
        >
          <Undo2 size={15} />
          Undo
        </button>
        <button
          type="button"
          className="ed-btn"
          disabled={!inputRecord || !onOpenInCreate}
          onClick={() => inputRecord && onOpenInCreate?.(inputRecord)}
        >
          <ExternalLink size={15} />
          Open in Create
        </button>
      </footer>
    </aside>
  );

  const empty = !creating && !source && !inputRecord;
  const references = (draft?.references ?? []).map(ref => sources.find(item => item.id === ref.sourceId));
  const segmentationReady = ['ready', 'stopped', 'starting', 'segmenting'].includes(snapshot.segmentation?.state ?? '');
  const statusText =
    !snapshot.backend || snapshot.backend.state !== 'ready'
      ? 'Start the engine to edit.'
      : !profileReady
        ? installing
          ? `Getting ${qualityLabel(profile)} files · ${Math.round(snapshot.qwenEdit.installProgress ?? 0)}%`
          : `${qualityLabel(profile)} needs its model files (${bytes(profileBytes)}).`
        : !draft?.instruction.trim()
          ? creating
            ? 'Describe the picture to make.'
            : 'Describe the change.'
          : runningJob
            ? `Working · ${runningJob.progress} of ${runningJob.progressMax || '?'} steps`
            : `${tries} ${tries === 1 ? 'try' : 'tries'} · ${steps_} steps each · Ctrl+Enter`;

  const stage = (
    <section className="ed-stage">
      {!showTries ? (
        <div className="ed-toolbar">
          {!creating && !empty && (
            <span className="ed-seg" role="group" aria-label="What to change">
              <button
                type="button"
                aria-pressed={mode === 'whole'}
                disabled={locked || Boolean(draft?.frozenRecipe)}
                onClick={() => edit({ mode: 'whole' })}
              >
                <Square size={14} />
                Whole picture
              </button>
              <button
                type="button"
                aria-pressed={mode === 'area'}
                disabled={locked || Boolean(draft?.frozenRecipe)}
                onClick={() => edit({ mode: 'area' })}
              >
                <Brush size={14} />
                Painted area
              </button>
            </span>
          )}
          {mode === 'area' && !empty && (
            <span className="ed-tools">
              <button
                type="button"
                className={tool === 'brush' ? 'on' : ''}
                title="Brush"
                aria-label="Brush"
                aria-pressed={tool === 'brush'}
                onClick={() => setTool('brush')}
              >
                <Pencil size={15} />
              </button>
              <button
                type="button"
                className={tool === 'erase' ? 'on' : ''}
                title="Eraser"
                aria-label="Eraser"
                aria-pressed={tool === 'erase'}
                onClick={() => setTool('erase')}
              >
                <Eraser size={15} />
              </button>
              <button
                type="button"
                className={tool === 'pick' ? 'on' : ''}
                title={
                  segmentationReady
                    ? 'Auto pick: click a thing to paint it'
                    : 'Auto pick needs Smart select. Set it up from a picture in Create first.'
                }
                aria-label="Auto pick"
                aria-pressed={tool === 'pick'}
                disabled={!segmentationReady}
                onClick={() => setTool('pick')}
              >
                {pending.pick ? <LoaderCircle className="spin" size={15} /> : <MousePointerClick size={15} />}
              </button>
              <label className="ed-size">
                Brush
                <input
                  type="range"
                  min={8}
                  max={180}
                  value={brush}
                  onChange={event => setBrush(Number(event.target.value))}
                  aria-label="Brush size"
                />
                <span>{brush}</span>
              </label>
              <button
                type="button"
                title="Clear the paint"
                aria-label="Clear the paint"
                onClick={() => paint.current?.clear()}
              >
                <Trash2 size={15} />
              </button>
            </span>
          )}
          {mode === 'area' && !empty && (
            <span className="ed-hint">
              {painted ? (
                <>
                  Only the <b>painted part</b> changes. The rest stays the same.
                </>
              ) : (
                'Paint over the part you want to change.'
              )}
            </span>
          )}
          {mode === 'whole' && !empty && !creating && <span className="ed-hint">The whole picture gets redrawn.</span>}
          <span className="ed-spacer" />
          {beforeUrl && (
            <span className="ed-seg" role="group" aria-label="Compare">
              <button type="button" aria-pressed={view === 'after'} onClick={() => setView('after')}>
                After
              </button>
              <button type="button" aria-pressed={view === 'before'} onClick={() => setView('before')}>
                Before
              </button>
              <button type="button" onClick={() => chainSelected && setCompare(chainSelected)}>
                Slider
              </button>
            </span>
          )}
        </div>
      ) : (
        <div className="ed-toolbar">
          <span className="ed-hint ed-hint-strong">
            <b>{tryRecords.length + tryJobs.length} tries</b> · click the one to keep going from
          </span>
          <span className="ed-spacer" />
          <button type="button" className="ed-btn" onClick={() => setTriesGroup(undefined)}>
            Done
          </button>
          <button
            type="button"
            className="ed-btn"
            disabled={locked || !profileReady || snapshot.backend.state !== 'ready'}
            onClick={() => {
              const first = tryRecords[0];
              if (first?.qwenEdit?.lineage.parentRecordId) {
                const parent = snapshot.history.find(record => record.id === first.qwenEdit!.lineage.parentRecordId);
                if (parent) edit({ selectedRecordId: parent.id }, false);
              }
              void queueEdit(true);
            }}
          >
            <RefreshCw size={15} />
            {tries} more tries
          </button>
        </div>
      )}
      <div
        ref={canvasArea}
        className={`ed-canvas ${dropOver ? 'drop-over' : ''}`}
        {...imageDropProps(
          setDropOver,
          transfer => {
            const drop = droppedImage(transfer, snapshot.history);
            if (drop) void startFromDrop(drop);
            else setError('Drop a PNG, JPG or WebP picture.');
          },
          locked,
        )}
      >
        {showTries ? (
          <div className={`ed-grid n${Math.min(4, tryRecords.length + tryJobs.length)}`}>
            {tryRecords.map((record, index) => (
              <button
                type="button"
                key={record.id}
                className={`ed-try ${record.id === chainSelected?.id ? 'pick' : ''}`}
                onClick={() => selectRecord(record)}
                aria-label={`Keep try ${index + 1}`}
              >
                <img src={record.imageUrl} alt="" />
                <span className={`ed-pill ${record.id === chainSelected?.id ? 'acc' : ''}`}>
                  {index + 1}
                  {record.id === chainSelected?.id ? ' · picked' : ''}
                </span>
              </button>
            ))}
            {tryJobs.map((job, index) => (
              <div key={job.id} className="ed-try waiting">
                {job.previewUrl && snapshot.settings.showGenerationPreview ? <img src={job.previewUrl} alt="" /> : null}
                <span className="ed-pill">
                  {tryRecords.length + index + 1} · {job.status === 'running' ? 'working…' : 'waiting'}
                </span>
              </div>
            ))}
          </div>
        ) : empty ? (
          <div className="ed-empty">
            <strong>Start with a picture</strong>
            <p>Drop one here, pick a recent one, or import a file.</p>
            {recent.length > 0 && (
              <div className="ed-recent" aria-label="Recent pictures">
                {recent.map(record => (
                  <button
                    type="button"
                    key={record.id}
                    title="Edit this picture"
                    aria-label={`Edit ${record.resolvedPrompt || record.draft.prompt || 'picture'}`}
                    disabled={locked}
                    draggable
                    onDragStart={event => startRecordDrag(event, record)}
                    onClick={() => void startFromRecord(record)}
                  >
                    <img src={record.imageUrl} alt="" />
                  </button>
                ))}
              </div>
            )}
            <div className="ed-row">
              <button type="button" className="ed-btn" disabled={locked} onClick={() => void importImage()}>
                <ImagePlus size={15} />
                Import picture
              </button>
              <button type="button" className="ed-btn" disabled={locked} onClick={() => newConversation('create')}>
                <Type size={15} />
                Start from text
              </button>
            </div>
          </div>
        ) : creating && !inputRecord ? (
          <div className="ed-empty">
            <strong>Make a picture from text</strong>
            <p>Describe it below. Qwen Image 2.1 makes it, then you can keep editing.</p>
          </div>
        ) : pictureUrl && baseSize ? (
          <div className="ed-frame" style={{ width: fit.width, height: fit.height }}>
            <img
              src={pictureUrl}
              alt={view === 'before' ? 'Before this step' : 'Picture being edited'}
              onError={() => setImageError('This picture could not be shown. Pick another step or import it again.')}
            />
            {mode === 'area' && view === 'after' && !livePreview && (
              <EditPaint
                ref={paint}
                width={baseSize.width}
                height={baseSize.height}
                tool={tool}
                brush={brush}
                onPaintedChange={setPainted}
                onPick={(x, y) => void pickArea(x, y)}
              />
            )}
          </div>
        ) : null}
        {!showTries && !empty && baseSize && (
          <div className="ed-corner tr">
            <span className="ed-pill">
              {baseSize.width} × {baseSize.height}
            </span>
          </div>
        )}
        {!showTries && chainSelected && (
          <div className="ed-corner bl">
            <span className="ed-pill acc">
              {livePreview
                ? 'Working on it…'
                : `Step ${steps.findIndex(step => step.records.some(record => record.id === chainSelected.id)) + 1} · ${chainSelected.qwenEdit?.plan.instruction ?? ''}`}
            </span>
          </div>
        )}
        {imageError && <p className="ed-corner tl ed-error">{imageError}</p>}
      </div>
      {(error || saveError) && (
        <Notice error>
          {error || `Your edit list could not be saved: ${saveError}`}
          {saveError && (
            <button type="button" className="ed-link" onClick={() => void flush().catch(() => {})}>
              Try saving again
            </button>
          )}
        </Notice>
      )}
      {draft && (
        <div className="ed-dock">
          {!creating && (
            <div className="ed-quick" role="group" aria-label="Quick actions">
              {QUICK.map(item => (
                <button
                  type="button"
                  key={item.label}
                  className="ed-chip"
                  disabled={locked || empty}
                  onClick={() => {
                    edit({ instruction: item.text, ...(item.area ? { mode: 'area' as const } : {}) });
                    if (item.open)
                      requestAnimationFrame(() => {
                        const box = textBox.current;
                        if (!box) return;
                        box.focus();
                        const at = item.text.includes('""') ? item.text.indexOf('""') + 1 : item.text.length;
                        box.setSelectionRange(at, at);
                      });
                  }}
                >
                  {item.label}
                </button>
              ))}
              <span className="ed-anchor">
                <button
                  type="button"
                  className="ed-chip"
                  disabled={locked || empty}
                  aria-expanded={menu === 'more'}
                  onClick={() => setMenu(menu === 'more' ? undefined : 'more')}
                >
                  More
                </button>
                <Popover open={menu === 'more'} onClose={closeMenu} className="ed-menu">
                  {MORE_QUICK.map(item => (
                    <button
                      type="button"
                      key={item.label}
                      onClick={() => {
                        edit({ instruction: item.text });
                        setMenu(undefined);
                        requestAnimationFrame(() => {
                          const box = textBox.current;
                          if (!box || !item.open) return;
                          box.focus();
                          const at = item.text.includes('""') ? item.text.indexOf('""') + 1 : item.text.length;
                          box.setSelectionRange(at, at);
                        });
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </Popover>
              </span>
            </div>
          )}
          <div className="ed-write">
            {!creating && (
              <div className="ed-refs" aria-label="Pictures used">
                <div className="ed-ref">
                  {pictureUrl && view === 'after' ? <img src={inputRecord?.imageUrl ?? pictureUrl} alt="" /> : null}
                  <b>1</b>
                </div>
                {[0, 1].map(index => {
                  const ref = references[index];
                  return ref ? (
                    <div className="ed-ref" key={index}>
                      <img src={sourceUrl(ref.id)} alt="" />
                      <b>{index + 2}</b>
                      <button
                        type="button"
                        className="ed-ref-x"
                        aria-label={`Remove picture ${index + 2}`}
                        disabled={locked}
                        onClick={() =>
                          edit({ references: (draft.references ?? []).filter(item => item.sourceId !== ref.id) })
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : index === (draft.references?.length ?? 0) ? (
                    <button
                      type="button"
                      key={index}
                      className="ed-ref add"
                      disabled={locked || empty || isQwen21Profile(profile)}
                      title={`Add picture ${index + 2}: drop one here or click to import. Then write things like "the jacket from picture ${index + 2}".`}
                      onClick={() => void addReference()}
                      {...imageDropProps(
                        () => {},
                        transfer => {
                          const drop = droppedImage(transfer, snapshot.history);
                          if (drop?.kind === 'record') void addReference(undefined, drop.record);
                          else if (drop?.kind === 'file') void addReference(drop.file);
                        },
                        locked,
                      )}
                    >
                      <Plus size={14} />
                      Pic {index + 2}
                    </button>
                  ) : null;
                })}
              </div>
            )}
            <div className="ed-text">
              <textarea
                ref={textBox}
                aria-label={creating ? 'Describe the picture' : 'What should change?'}
                value={draft.instruction}
                maxLength={4000}
                rows={2}
                disabled={locked}
                placeholder={
                  creating
                    ? 'A fox in a yellow raincoat on a rainy street at night…'
                    : mode === 'area'
                      ? 'What should the painted part become?'
                      : 'What should change? For example: make the coat deep red, keep everything else.'
                }
                onChange={event => edit({ instruction: event.target.value })}
              />
              <button
                type="button"
                className="ed-chip ed-tidy"
                disabled={locked || pending.tidy || !draft.instruction.trim()}
                title={
                  snapshot.assistant?.ready
                    ? 'Let the assistant rewrite this so the model gets it right'
                    : snapshot.assistant?.reason
                }
                onClick={() => void tidyUp()}
              >
                {pending.tidy ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}
                Tidy up
              </button>
            </div>
          </div>
          <div className="ed-run">
            <span className="ed-anchor">
              <button
                type="button"
                className="ed-chip set"
                disabled={locked || creating || Boolean(draft.frozenRecipe)}
                aria-expanded={menu === 'quality'}
                onClick={() => setMenu(menu === 'quality' ? undefined : 'quality')}
              >
                <em>Quality</em> {qualityLabel(profile)} · {steps_} steps <ChevronDown size={13} />
              </button>
              <Popover open={menu === 'quality'} onClose={closeMenu} className="ed-menu">
                {QUALITY.map(item => (
                  <button
                    type="button"
                    key={item.profile}
                    aria-pressed={profile === item.profile}
                    onClick={() => {
                      edit({
                        settings: { ...draft.settings, profile: item.profile, steps: undefined, guidance: undefined },
                      });
                      setMenu(undefined);
                    }}
                  >
                    {item.label}
                    <small>
                      {item.detail}
                      {readyFor(item.profile) ? '' : ' · needs download'}
                    </small>
                  </button>
                ))}
              </Popover>
            </span>
            {!draft.frozenRecipe && (
              <span className="ed-anchor">
                <button
                  type="button"
                  className="ed-chip set"
                  disabled={locked}
                  aria-expanded={menu === 'tries'}
                  onClick={() => setMenu(menu === 'tries' ? undefined : 'tries')}
                >
                  <em>Tries</em> {tries} <ChevronDown size={13} />
                </button>
                <Popover open={menu === 'tries'} onClose={closeMenu} className="ed-menu ed-menu-row">
                  {[1, 2, 3, 4].map(count => (
                    <button
                      type="button"
                      key={count}
                      aria-pressed={tries === count}
                      onClick={() => {
                        edit({ tries: count }, false);
                        setMenu(undefined);
                      }}
                    >
                      {count}
                    </button>
                  ))}
                </Popover>
              </span>
            )}
            {mode === 'whole' && !draft.frozenRecipe && (
              <span className="ed-anchor">
                <button
                  type="button"
                  className="ed-chip set"
                  disabled={locked}
                  aria-expanded={menu === 'size'}
                  onClick={() => setMenu(menu === 'size' ? undefined : 'size')}
                >
                  <em>Size</em>{' '}
                  {creating
                    ? (CREATE_SIZES[sizeChoice as keyof typeof CREATE_SIZES]?.label ?? 'Square')
                    : sizeChoice === 'working'
                      ? 'About 1 MP'
                      : 'Same as picture'}{' '}
                  <ChevronDown size={13} />
                </button>
                <Popover open={menu === 'size'} onClose={closeMenu} className="ed-menu">
                  {(creating
                    ? (
                        Object.entries(CREATE_SIZES) as Array<
                          [string, { label: string; width: number; height: number }]
                        >
                      ).map(([key, value]) => [key, value.label, `${value.width} × ${value.height}`] as const)
                    : ([
                        [
                          'same',
                          'Same as picture',
                          baseSize
                            ? `${qwenSameSize(baseSize.width, baseSize.height).width} × ${qwenSameSize(baseSize.width, baseSize.height).height}`
                            : '',
                        ],
                        [
                          'working',
                          'About 1 MP',
                          baseSize
                            ? `${qwenWorkingSize(baseSize.width, baseSize.height).width} × ${qwenWorkingSize(baseSize.width, baseSize.height).height}`
                            : '',
                        ],
                      ] as const)
                  ).map(([key, label, detail]) => (
                    <button
                      type="button"
                      key={key}
                      aria-pressed={sizeChoice === key}
                      onClick={() => {
                        edit({ size: key as QwenConversationDraft['size'] }, false);
                        setMenu(undefined);
                      }}
                    >
                      {label}
                      <small>{detail}</small>
                    </button>
                  ))}
                </Popover>
              </span>
            )}
            {mode === 'area' && (
              <span className="ed-chip set ed-static">
                <em>Size</em> Same as picture
              </span>
            )}
            <span className="ed-anchor">
              <button
                type="button"
                className="ed-chip set"
                disabled={locked}
                aria-expanded={menu === 'tune'}
                onClick={() => setMenu(menu === 'tune' ? undefined : 'tune')}
              >
                <em>Tune</em> {mode === 'area' ? 'seed, edge blend' : 'seed, things to avoid'}{' '}
                <ChevronRight size={13} />
              </button>
              <Popover open={menu === 'tune'} onClose={closeMenu} className="ed-menu ed-tune">
                <label>
                  Seed
                  <span className="ed-inline">
                    <input
                      value={draft.settings.seed}
                      maxLength={32}
                      onChange={event => edit({ settings: { ...draft.settings, seed: event.target.value } })}
                    />
                    <button
                      type="button"
                      className="ed-icon"
                      aria-label="Use a random seed"
                      title="Random"
                      onClick={() => edit({ settings: { ...draft.settings, seed: 'random' } })}
                    >
                      <Dices size={15} />
                    </button>
                  </span>
                </label>
                {mode === 'area' && (
                  <label>
                    Edge blend · {draft.blend ?? 12} px
                    <input
                      type="range"
                      min={0}
                      max={64}
                      value={draft.blend ?? 12}
                      onChange={event => edit({ blend: Number(event.target.value) })}
                    />
                  </label>
                )}
                <label>
                  Things to avoid
                  <textarea
                    rows={2}
                    value={draft.negativePrompt}
                    maxLength={4000}
                    disabled={!usesNegative}
                    placeholder={usesNegative ? 'Blurry, extra fingers…' : 'Only Best quality uses this.'}
                    onChange={event => edit({ negativePrompt: event.target.value })}
                  />
                </label>
                {!creating && (
                  <label className="ed-check">
                    <input
                      type="checkbox"
                      checked={profile === 'compact'}
                      disabled={Boolean(draft.frozenRecipe)}
                      onChange={event =>
                        edit({
                          settings: {
                            ...draft.settings,
                            profile: event.target.checked ? 'compact' : 'lightning8',
                            steps: undefined,
                            guidance: undefined,
                          },
                        })
                      }
                    />
                    <span>
                      Smaller model files
                      <small>For 12–16 GB cards. Uses Fast quality.</small>
                    </span>
                  </label>
                )}
                {creating && (
                  <label className="ed-check">
                    <input
                      type="checkbox"
                      checked={draft.transparent ?? false}
                      onChange={event => edit({ transparent: event.target.checked })}
                    />
                    <span>Transparent background</span>
                  </label>
                )}
              </Popover>
            </span>
            <span className="ed-go">
              <small>{notice || statusText}</small>
              {snapshot.backend.state !== 'ready' ? (
                <button
                  type="button"
                  className="ed-primary"
                  disabled={pending.start || !['stopped', 'error'].includes(snapshot.backend.state)}
                  onClick={() => void action('start', () => window.latent.startBackend())}
                >
                  <Play size={16} />
                  Start the engine
                </button>
              ) : !profileReady || repairNeeded ? (
                installing ? (
                  <button
                    type="button"
                    className="ed-primary"
                    disabled={pending.cancelSetup}
                    onClick={() =>
                      void action('cancelSetup', async () => {
                        if (engineSetup) await window.latent.cancelRuntimeUpdate();
                        else await window.latent.cancelQwenEditSetup();
                      })
                    }
                  >
                    <X size={16} />
                    Stop download
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ed-primary"
                    disabled={!loaded || pending.setup}
                    onClick={() =>
                      void action('setup', async () => {
                        await window.latent.setupQwenEdit(profile, repairNeeded);
                        onSnapshot?.(await window.latent.getSnapshot());
                      })
                    }
                  >
                    <Download size={16} />
                    {repairNeeded ? 'Check and repair files' : `Get files · ${bytes(profileBytes)}`}
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="ed-primary"
                  disabled={
                    locked ||
                    empty ||
                    !draft.instruction.trim() ||
                    (!creating && sourceChanged && !chainSelected) ||
                    (mode === 'area' && !painted && !draft.frozenRecipe)
                  }
                  onClick={() => void queueEdit()}
                >
                  {pending.queue ? (
                    <LoaderCircle className="spin" size={16} />
                  ) : creating ? (
                    <Sparkles size={16} />
                  ) : (
                    <Pencil size={16} />
                  )}
                  {creating ? 'Make it' : 'Edit'}
                  {tries > 1 ? ` · ${tries} tries` : ''}
                </button>
              )}
            </span>
          </div>
        </div>
      )}
    </section>
  );

  return (
    <div
      className="ed-root"
      onKeyDown={event => {
        if (
          !event.nativeEvent.isComposing &&
          !event.defaultPrevented &&
          (event.ctrlKey || event.metaKey) &&
          event.key === 'Enter'
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (!compare) void queueEdit();
        }
      }}
    >
      {slot ? createPortal(topBar, slot) : topBar}
      {loading ? (
        <div className="ed-loading">
          <LoaderCircle className="spin" />
          Opening your edits…
        </div>
      ) : !loaded ? (
        <div className="ed-loading">
          {error && <Notice error>{error}</Notice>}
          <button type="button" className="ed-btn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : (
        <section className="ed" aria-label="Edit">
          {stage}
          {timeline}
        </section>
      )}
      {!embedded && (
        <button type="button" className="ed-btn ed-close" onClick={() => void close()}>
          Done
        </button>
      )}
      {compare?.qwenEdit?.plan.source && (
        <CompareImage
          before={{
            url: sourceUrl(compare.qwenEdit.plan.source.id),
            label: 'Before',
            width: compare.qwenEdit.plan.source.normalized.width,
            height: compare.qwenEdit.plan.source.normalized.height,
          }}
          after={{
            url: compare.imageUrl,
            label: 'After',
            width: compare.width,
            height: compare.height,
          }}
          sourceFittingSize={compare.qwenEdit.plan.area ? undefined : compare.qwenEdit.plan.canvas?.sourceFitting}
          alignment={compare.qwenEdit.plan.area ? 'stretch' : compare.qwenEdit.plan.settings.resize}
          onClose={() => setCompare(undefined)}
        />
      )}
    </div>
  );

  async function close() {
    if (compare) {
      setCompare(undefined);
      return;
    }
    if (activeActions.current.has('close')) return;
    if (!hydrated.current) {
      onClose();
      return;
    }
    await action('close', async () => {
      await Promise.all([...criticalActions.current]);
      await flush();
      closing.current = true;
      onClose();
    });
  }
}

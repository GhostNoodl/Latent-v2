import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { PNG } from 'pngjs';
import { preserveCropPixels, encodePreservedCrop } from './crop-output';
import type { AppPaths, BackendStatus, ComfyWorkflow, GenerationDraft, GenerationJob, GenerationRecord, ModelAsset, StudioJob, VideoJob } from '../shared/types';
import { buildWorkflow, resolvePrompt, validateAssets, WORKFLOW_VERSION } from '../shared/workflow';
import { bindModelPaths, canonicalModelPaths } from '../shared/workflow-model-paths';
import { draftSchema } from '../shared/validation';
import { containedPath, inside } from './paths';
import type { StudioStore } from './store';
import type { ModelService } from './models';
import { SourceImageService } from './source-images';
import { augmentImageWorkflow } from '../shared/image-workflow';
import { augmentHiresWorkflow, buildUpscaleWorkflow, restoreHiresSettings, validateHiresCapabilities } from '../shared/advanced-image-workflow';
import type { AdvancedImageOutput, AdvancedImagePlan } from '../shared/advanced-image-types';
import type { UpscalerService } from './upscaler';
import { prepareDynamicPromptDraft } from '../shared/dynamic-prompt-recipe';
import type { BackendActivityService } from './backend-activity';
import { ownedGenerationPreview } from './shared-backend-preview';
import { WildcardStore } from './wildcards';
import type { ControlNetService } from './controlnet';
import { augmentControlNetWorkflow, validateControlNetCapabilities } from '../shared/controlnet-workflow';
import type { ControlMapOutput } from '../shared/controlnet-types';
import { runtimeIdentitySchema, type RuntimeIdentitySnapshot } from '../shared/runtime-identity';
import { cropInpaintPlanSchema, type CropInpaintPlan } from '../shared/crop-inpaint-types';
import { createCropInpaintPlan, redMaskFromRgba } from '../shared/crop-inpaint-geometry';
import { augmentCropInpaintWorkflow, validateFrozenCropInpaintWorkflow } from '../shared/crop-inpaint-workflow';
import { DEFAULT_DRAFT } from '../shared/defaults';
import { qwenEditJobRequestSchema, type QwenEditJobRequest, type QwenEditRecord } from '../shared/qwen-edit-types';
import { bindQwenEditWorkflow, buildQwenEditWorkflow } from '../shared/qwen-edit-workflow';
import type { QwenEditAssetsService } from './qwen-edit-assets';
import { RegionalMaskService } from './regional-masks';
import { activeRegionalPromptRegions, regionalPromptPlanSchema, type RegionalPromptPlan } from '../shared/regional-prompt-types';
import { augmentRegionalPromptWorkflow } from '../shared/regional-prompt-workflow';
import { ipAdapterPlanSchema } from '../shared/ipadapter-types';
import { augmentIPAdapterWorkflow, validateIPAdapterCapabilities } from '../shared/ipadapter-workflow';
import type { IPAdapterService } from './ipadapter';
import { generationPhase } from '../shared/generation-phase';
import type { FaceDetailerService } from './face-detailer';
import { faceRefinementRequestSchema } from '../shared/face-detailer-types';
import { buildFaceRefinementWorkflow, faceRefinementPlanSchema, validateFaceRefinementCapabilities, validateFrozenFaceRefinementWorkflow, type FaceRefinementOutput } from '../shared/face-detailer-workflow';
import { isVideoJob } from '../shared/types';
import type { VideoDraft } from '../shared/video-types';
import { videoDraftSchema } from '../shared/video-plan';
import { videoOutputCandidates } from '../shared/video-output';
import { VideoQueueService, type VideoQueueContext } from './video-queue';
type JobOutput = AdvancedImageOutput | FaceRefinementOutput;


interface Backend { status(): BackendStatus; getUrl(): string | null; getRuntimeIdentity?(): RuntimeIdentitySnapshot | undefined; }
interface ExecutionContext { faceDetailer?: GenerationRecord['faceDetailer']; workflow: ComfyWorkflow; ipAdapter?: GenerationRecord['ipAdapter']; ipAdapterSource?: GenerationRecord['ipAdapterSource']; regionalPrompts?: RegionalPromptPlan; qwenEdit?: QwenEditRecord; cropInpaint?: CropInpaintPlan; runtimeIdentity?: RuntimeIdentitySnapshot; controlNet?: GenerationRecord['controlNet']; dynamicPromptRecipe?: GenerationRecord['dynamicPromptRecipe']; advancedImage?: AdvancedImagePlan; imageInput?: GenerationRecord['imageInput']; workflowVersion?: string; checkpoint?: ModelAsset; loras: GenerationRecord['loras']; resolvedPrompt: string; backendVersion: string; appVersion: string; startedAt?: number; cancelRequested?: boolean; }
interface HistoryEntry { outputs?: Record<string, { images?: Array<{ filename: string; subfolder: string; type: string }> }>; status?: { status_str?: string; completed?: boolean; messages?: Array<[string, { exception_message?: string }]> }; }
interface QueueResponse { queue_running: unknown[][]; queue_pending: unknown[][]; }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function faceSeeds(base: string, count: number) { return Array.from({ length: count }, (_, index) => ((BigInt(base) + BigInt(index)) % (BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toString()); }
class EngineRequestError extends Error { constructor(public status: number, text: string) { super(text); } }
class JobPersistenceError extends Error {}

export class JobService {
  private items: StudioJob[];
  private order: string[];
  private socket?: WebSocket;
  private socketUrl?: string;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private preparing = 0;
  private maintenance = false;
  private disposed = false;
  private clientId = randomUUID();
  private missingSince = new Map<string, number>();
  private shutdown = new AbortController();
  private drainWaiters: Array<() => void> = [];
  private sources: SourceImageService;
  private regionalMasks: RegionalMaskService;
  constructor(private paths: AppPaths, private store: StudioStore, private models: ModelService, private backend: Backend, private changed: () => void, private completed: (job: StudioJob) => void, private appVersion: string, private upscaler?: UpscalerService, private controlNetService?: ControlNetService, private qwenEditAssets?: QwenEditAssetsService, private ipAdapterService?: Pick<IPAdapterService, 'verify' | 'status'>, private runtimeBlockedReason?: () => string | undefined, private faceDetailerService?: Pick<FaceDetailerService, 'getDetection' | 'createRefinementPlan'>, private activity?: Pick<BackendActivityService, 'refresh' | 'status'>, private videoQueue?: VideoQueueService) {
    this.items = store.jobs();
    this.sources = new SourceImageService(paths, store);
    this.regionalMasks = new RegionalMaskService(paths);
    this.order = store.getState<string[]>('queue-order', []);
  }
  start() { if (!this.timer) this.timer = setInterval(() => void this.tick(), 1000); void this.tick(); }
  isProcessing() { return this.polling || this.preparing > 0; }
  isBackendIdle() { if (!this.activity) return true; const activity = this.activity.status(); return activity.state === 'offline' || activity.state === 'ready' && activity.totalRunning === 0 && activity.totalPending === 0; }
  async withRuntimeMaintenance<T>(operation: () => Promise<T>, options: { allowRetainedJobs: boolean }): Promise<T> {
    if (this.disposed || this.maintenance || this.preparing) throw new Error('Wait for the active queue preparation before runtime maintenance.');
    if (!options.allowRetainedJobs && this.items.some(job => ['queued', 'running'].includes(job.status))) throw new Error('Finish or cancel queued and running jobs before changing the runtime.');
    this.maintenance = true;
    try { if (this.polling) await new Promise<void>(resolve => this.drainWaiters.push(resolve)); return await operation(); }
    finally { this.maintenance = false; }
  }
  private assertQueueAvailable() {
    if (this.disposed) throw new Error('The generation queue is stopped.');
    const reason = this.runtimeBlockedReason?.();
    if (this.maintenance || reason) throw new Error(reason || 'Wait for runtime maintenance to finish before queueing generation.');
  }
  jobs() {
    const rank = (job: StudioJob) => { const n = this.order.indexOf(job.id); return n < 0 ? Number.MAX_SAFE_INTEGER : n; };
    return this.items.map(job => structuredClone(job)).sort((a, b) => {
      if ((a.status === 'queued') !== (b.status === 'queued')) return a.status === 'queued' ? 1 : -1;
      return a.status === 'queued' ? rank(a) - rank(b) || a.createdAt.localeCompare(b.createdAt) : a.createdAt.localeCompare(b.createdAt);
    });
  }
  async controlMapPath(recordId: string): Promise<string> {
    if (!/^[a-f0-9]{32}$/.test(recordId)) throw new Error('Control-map image is unavailable.');
    const record = this.store.records().find(item => item.id === recordId); const map = record?.controlNet?.map;
    if (!record || !map) throw new Error('Control-map image is unavailable or incomplete.');
    const output = this.controlOutput({ id: record.jobId, draft: record.draft }, record);
    if (!output || map.nodeId !== output.nodeId) throw new Error('Control-map image has an invalid saved recipe.');
    const checked = await this.inspectControlMap(output, map.filename);
    if (checked.sha256 !== map.sha256 || checked.bytes !== map.bytes || output.width !== map.width || output.height !== map.height) throw new Error('The retained control-map image changed.');
    return checked.full;
  }
  private save(job: StudioJob) { job.updatedAt = new Date().toISOString(); const { previewUrl: _, ...durable } = job; this.store.saveJob(durable); this.changed(); }
  private accept(job: StudioJob, context: ExecutionContext | VideoQueueContext) {
    const order = [...this.order, job.id]; this.store.acceptJob(job, context, order);
    this.items.push(job); this.order = order; this.changed();
  }
  private saveTogether(job: StudioJob, context: ExecutionContext | VideoQueueContext) {
    job.updatedAt = new Date().toISOString(); const { previewUrl: _, ...durable } = job;
    try { this.store.saveJobContext(durable, context); }
    catch (error) {
      // A failed acknowledgment may follow a successful commit. Reload the whole
      // durable row, preserving any output receipt instead of writing stale context.
      const saved = this.store.jobs().find(value => value.id === job.id);
      if (saved) { for (const key of Object.keys(job)) delete (job as unknown as Record<string, unknown>)[key]; Object.assign(job, saved); }
      throw new JobPersistenceError(`Could not persist the queue transition: ${message(error)}`);
    }
    this.changed();
  }
  private videoContext(job: VideoJob) {
    if (!this.videoQueue) throw new Error('The video queue integration is unavailable.');
    return this.videoQueue.validate(job, this.store.getState(`execution:${job.id}`, null));
  }
  private context(id: string) { const result = this.store.getState<ExecutionContext | null>(`execution:${id}`, null); if (!result) throw new Error('This job is missing its saved generation recipe.'); return result; }
  private saveContext(id: string, context: ExecutionContext) { this.store.setState(`execution:${id}`, context); }
  private async decodeVerifiedMask(mask: Awaited<ReturnType<SourceImageService['resolveMask']>>) {
    const bytes = await fs.readFile(mask.path);
    if (createHash('sha256').update(bytes).digest('hex') !== mask.mask.sha256) throw new Error('The saved mask changed while preparing its generation recipe.');
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    if (decoded.width !== mask.mask.width || decoded.height !== mask.mask.height) throw new Error('The saved mask dimensions differ from its generation recipe.');
    return decoded;
  }
  private async request<T>(endpoint: string, body?: unknown): Promise<T> {
    const base = this.backend.getUrl(); if (!base || this.backend.status().state !== 'ready') throw new Error('The image engine is offline. Start it in Settings.');
    const response = await fetch(`${base}${endpoint}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([AbortSignal.timeout(30000), this.shutdown.signal]) });
    const text = await response.text(); let result: any;
    try { result = text ? JSON.parse(text) : {}; } catch { throw new Error(`The engine returned an invalid response (${response.status}).`); }
    if (!response.ok) { const details = result.error?.message || result.error?.details || (typeof result.error === 'string' ? result.error : '') || text.slice(0, 1500); throw new EngineRequestError(response.status, `Engine rejected the request (${response.status}): ${details}${result.node_errors && Object.keys(result.node_errors).length ? ` ${JSON.stringify(result.node_errors).slice(0, 2500)}` : ''}`); }
    return result as T;
  }
  async enqueue(input: GenerationDraft): Promise<GenerationJob> {
    this.assertQueueAvailable(); this.preparing++;
    try { return await this.prepareEnqueue(input); } finally { this.preparing--; }
  }
  async enqueueVideo(input: VideoDraft): Promise<VideoJob> {
    this.assertQueueAvailable(); if (!this.videoQueue) throw new Error('Video queue integration is unavailable.'); this.preparing++;
    try {
      const draft = videoDraftSchema.parse(structuredClone(input)); const id = randomBytes(16).toString('hex');
      const actualSeed = draft.seed === 'random' ? String(randomBytes(6).readUIntBE(0, 6)) : draft.seed;
      const context = await this.videoQueue.prepare(draft, id, actualSeed, this.shutdown.signal); this.assertQueueAvailable();
      const now = new Date().toISOString(); const plan = context.prepared.contract.plan;
      const job: VideoJob = { kind: 'video', id, createdAt: now, updatedAt: now, video: structuredClone(plan.draft), actualSeed, frames: plan.frames, durationSeconds: plan.durationSeconds, status: 'queued', progress: 0, progressMax: plan.sampling.steps, outputIds: [] };
      this.accept(job, context); void this.tick(); return structuredClone(job);
    } finally { this.preparing--; }
  }
  private async prepareEnqueue(input: GenerationDraft): Promise<GenerationJob> {
    if (this.disposed) throw new Error('The generation queue is stopped.');
    const draft = draftSchema.parse(input);
    if (this.ipAdapterService?.status().state === 'activating') throw new Error('Wait for reference-tool activation to finish before queueing generation.');
    if (draft.faceDetailer && (draft.qwenEdit || draft.imageInput || draft.controlNet || draft.hiresFix || draft.upscale || draft.ipAdapter || draft.regionalPrompts?.settings.enabled || draft.batchSize !== 1 || draft.width !== 512 || draft.height !== 512)) throw new Error('Face refinement requires baseline SDXL/Illustrious, 512 square working crops, batch 1, and no other image workflow.');
    if (draft.faceDetailer && draft.faceDetailer.request.seed !== draft.seed) throw new Error('Use the same base seed in the face request and its generation recipe.');
    if (draft.ipAdapter && (draft.qwenEdit || draft.imageInput || draft.controlNet || draft.hiresFix || draft.upscale || draft.regionalPrompts?.settings.enabled || draft.batchSize !== 1)) throw new Error('IP Adapter requires one baseline SDXL or Illustrious text-to-image pass without other image workflows.');
    if (draft.qwenEdit) {
      if (draft.imageInput || draft.controlNet || draft.hiresFix || draft.upscale || draft.dynamicPrompts?.enabled || draft.regionalPrompts?.settings.enabled || draft.loras.length || draft.checkpointId || draft.variationOfRecordId) throw new Error('Qwen editing uses its own source, instruction and reviewed recipe. Remove ordinary diffusion, mask, ControlNet, hires, upscale or wildcard modifiers.');
      return this.enqueueQwenEdit(draft.qwenEdit);
    }
    if (draft.regionalPrompts?.frozen && !draft.regionalPrompts.settings.enabled) throw new Error('Turn off regional prompting with a new layout, or restore the frozen regional recipe.');
    if (draft.regionalPrompts?.settings.enabled && (draft.imageInput || draft.controlNet || draft.hiresFix || draft.upscale || draft.batchSize !== 1)) throw new Error('Regional prompts require one baseline text-to-image pass without other image workflows.');
    if (draft.regionalPrompts?.settings.enabled && !activeRegionalPromptRegions(draft.regionalPrompts.settings).length) throw new Error('Write a prompt in at least one region with positive strength, or turn regional prompting off.');
    if (draft.imageInput?.cropPlan && !draft.imageInput.crop) throw new Error('The frozen crop recipe requires crop inpainting. Choose its original crop settings or start a new recipe.');
    if (draft.imageInput?.crop && (draft.imageInput.mode !== 'inpaint' || draft.batchSize !== 1 || draft.hiresFix || draft.upscale || draft.controlNet)) throw new Error('Crop inpainting requires one source and mask, batch size 1, and cannot yet be combined with hires, standalone upscale or ControlNet.');
    if (draft.variationOfRecordId && !this.store.records().some(record => record.id === draft.variationOfRecordId)) throw new Error('The original image for this variation is no longer in the studio history.');
    if (draft.upscale && draft.hiresFix) throw new Error('Choose either standalone resize/enhancement or hires fix for this job.');
    if (draft.upscale && (draft.imageInput?.mode !== 'img2img' || draft.batchSize !== 1)) throw new Error('Standalone resize/enhancement requires one selected source image in img2img mode and batch size 1.');
    if (draft.controlNet && (draft.upscale || draft.hiresFix || draft.imageInput?.mode === 'inpaint')) throw new Error('Initial Canny control cannot yet be combined with hires, inpainting or standalone upscale.');
    const id = randomUUID(); const actualSeed = draft.seed === 'random' ? String(randomBytes(6).readUIntBE(0, 6)) : BigInt(draft.seed).toString();
    const context: ExecutionContext = { workflow: {}, loras: [], resolvedPrompt: draft.prompt, backendVersion: this.backend.status().version ?? 'unknown', appVersion: this.appVersion };
    if (!draft.upscale) {
      const prepared = await prepareDynamicPromptDraft(draft, actualSeed, draft.dynamicPrompts?.enabled ? new WildcardStore(this.store, () => {}).snapshot() : undefined);
      if (prepared.recipe) { draft.dynamicPrompts = { enabled: true, frozen: prepared.recipe }; context.dynamicPromptRecipe = prepared.recipe; }
      await this.models.refresh(); const { checkpoint, loras } = validateAssets(draft, this.models.assets);
      await this.models.verifyExternalModels?.([checkpoint.id, ...loras.map(asset => asset.id)]);
      draft.triggerWords = Object.fromEntries(loras.map(asset => [asset.id, draft.triggerWords?.[asset.id] ?? asset.triggers]));
      draft.assetHashes = Object.fromEntries([checkpoint, ...loras].filter(asset => asset.sha256).map(asset => [asset.id, asset.sha256!]));
      context.checkpoint = checkpoint; context.loras = loras.map((asset, index) => ({ ...asset, triggers: draft.triggerWords![asset.id], weight: draft.loras[index].weight, clipWeight: draft.loras[index].clipWeight }));
      const resolvedDraft = { ...draft, prompt: prepared.prompt, negativePrompt: prepared.negativePrompt };
      context.resolvedPrompt = resolvePrompt(resolvedDraft, this.models.assets); context.workflow = buildWorkflow(resolvedDraft, this.models.assets, actualSeed, id);
      if (draft.faceDetailer) {
        if (!this.faceDetailerService) throw new Error('The reviewed face refinement service is unavailable.');
        const authoring = draft.faceDetailer;
        const seeds = faceSeeds(actualSeed, authoring.request.faceIds.length);
        const current = await this.faceDetailerService.createRefinementPlan(authoring.request, seeds);
        const frozen = authoring.frozen ? faceRefinementPlanSchema.parse(authoring.frozen) : current;
        if (JSON.stringify(current) !== JSON.stringify(frozen)) throw new Error('The frozen face recipe no longer matches its source, selected masks, seeds or geometry. Restore the original recipe.');
        const detection = await this.faceDetailerService.getDetection(authoring.request.detectionId);
        const source = await this.sources.resolve(frozen.source.id);
        const masks: Record<string, string> = {};
        for (const pass of frozen.passes) { const mask = await this.sources.resolveMask(pass.crop.mask.id); masks[mask.mask.id] = path.relative(this.paths.inputs, mask.path).replaceAll('\\', '/'); }
        const result = buildFaceRefinementWorkflow(context.workflow, resolvedDraft, { plan: frozen, sourceFilename: path.relative(this.paths.inputs, source.normalizedPath).replaceAll('\\', '/'), maskFilenames: masks });
        authoring.request.seed = actualSeed; draft.seed = actualSeed; authoring.frozen = structuredClone(frozen);
        context.faceDetailer = { plan: frozen, detection, source: source.source, outputs: result.outputs };
        context.workflow = result.workflow; context.workflowVersion = result.workflowVersion;
      }
      if (draft.ipAdapter) {
        if (!this.ipAdapterService) throw new Error('The reviewed IP Adapter service is unavailable.');
        const source = await this.sources.resolve(draft.ipAdapter.settings.sourceId);
        const assets = await this.ipAdapterService.verify();
        const result = augmentIPAdapterWorkflow(context.workflow, resolvedDraft, draft.ipAdapter.settings, { source: source.source, sourceFilename: path.relative(this.paths.inputs, source.normalizedPath).replaceAll('\\', '/') }, assets, draft.ipAdapter.frozen);
        draft.ipAdapter.frozen = structuredClone(result.plan); context.ipAdapter = result.plan; context.ipAdapterSource = structuredClone(source.source);
        context.workflow = result.workflow; context.workflowVersion = result.workflowVersion;
      }
      if (draft.regionalPrompts?.settings.enabled) {
        const authoring = draft.regionalPrompts;
        const masks = await this.regionalMasks.prepare(authoring.settings, draft, authoring.frozen?.regions.map(region => region.mask));
        const result = await augmentRegionalPromptWorkflow(context.workflow, resolvedDraft, authoring.settings, masks, authoring.frozen);
        authoring.frozen = structuredClone(result.plan); context.regionalPrompts = result.plan;
        context.workflow = result.workflow; context.workflowVersion = result.workflowVersion;
      }
    }
    if (draft.imageInput) {
      const input = draft.imageInput;
      const source = await this.sources.resolve(input.sourceId);
      if (source.source.normalized.sha256 !== input.sourceSha256) throw new Error('The selected source differs from this draft. Choose its original source again.');
      const mask = input.mode === 'inpaint' && input.maskId ? await this.sources.resolveMask(input.maskId) : undefined;
      if (input.mode === 'inpaint' && (!mask || mask.mask.sha256 !== input.maskSha256 || mask.mask.sourceId !== input.sourceId)) throw new Error('Paint and save a mask for this exact source before inpainting.');
      const decodedMask = mask ? await this.decodeVerifiedMask(mask) : undefined;
      if (decodedMask && !decodedMask.data.some((value, index) => index % 4 === 0 && value > 0)) throw new Error('The mask is empty. Paint the area you want to change.');
      context.imageInput = { source: source.source, mask: mask?.mask };
      const sourceFilename = path.relative(this.paths.inputs, source.normalizedPath).replaceAll('\\', '/');
      if (draft.upscale) {
        if (draft.upscale.mode === 'learned' && !this.upscaler) throw new Error('The reviewed upscaler service is unavailable.');
        const asset = draft.upscale.mode === 'learned' ? await this.upscaler!.verify() : undefined;
        context.advancedImage = buildUpscaleWorkflow({ sourceFilename, sourceWidth: source.source.normalized.width, sourceHeight: source.source.normalized.height, jobId: id, settings: draft.upscale }, asset);
        context.workflow = context.advancedImage.workflow; context.workflowVersion = context.advancedImage.workflowVersion;
      } else if (input.mode === 'inpaint' && input.crop) {
        const computed = await createCropInpaintPlan({ source: source.source, mask: mask!.mask, maskRed: redMaskFromRgba(decodedMask!.data, decodedMask!.width, decodedMask!.height), working: { width: draft.width, height: draft.height }, settings: input.crop, denoise: input.denoise });
        const frozen = input.cropPlan ? cropInpaintPlanSchema.parse(input.cropPlan) : computed.plan;
        if (JSON.stringify(frozen) !== JSON.stringify(computed.plan)) throw new Error('The frozen crop recipe no longer matches its source, mask, settings or geometry. Restore its original inputs or deliberately start a new crop recipe.');
        const augmented = augmentCropInpaintWorkflow(context.workflow, draft, { sourceFilename, maskFilename: path.relative(this.paths.inputs, mask!.path).replaceAll('\\', '/'), plan: frozen });
        input.cropPlan = structuredClone(frozen); context.cropInpaint = frozen;
        context.workflow = augmented.workflow; context.workflowVersion = augmented.workflowVersion;
      } else {
        context.workflow = augmentImageWorkflow(context.workflow, draft, { mode: input.mode, sourceFilename, maskFilename: mask ? path.relative(this.paths.inputs, mask.path).replaceAll('\\', '/') : undefined, denoise: input.denoise, resize: input.resize });
        context.workflowVersion = `sdxl-${input.mode}@1`;
      }
    }
    if (draft.controlNet) {
      if (!this.controlNetService) throw new Error('The reviewed ControlNet service is unavailable.');
      const source = await this.sources.resolve(draft.controlNet.sourceId);
      if (source.source.normalized.sha256 !== draft.controlNet.sourceSha256) throw new Error('The selected control source differs from this draft. Choose its original source again.');
      const asset = await this.controlNetService.verify();
      const plan = augmentControlNetWorkflow(context.workflow, draft, draft.controlNet, { source: source.source, sourceFilename: path.relative(this.paths.inputs, source.normalizedPath).replaceAll('\\', '/'), jobId: id }, asset);
      context.controlNet = { plan }; context.workflow = plan.workflow; context.workflowVersion = plan.workflowVersion;
    }
    if (draft.hiresFix) {
      const secondSeed = draft.hiresFix.seed === 'random' ? String(randomBytes(6).readUIntBE(0, 6)) : BigInt(draft.hiresFix.seed).toString();
      context.advancedImage = augmentHiresWorkflow(context.workflow, draft, draft.hiresFix, secondSeed, draft.hiresFix.workflowVersion);
      draft.hiresFix = restoreHiresSettings(context.advancedImage.hires!, context.advancedImage.workflowVersion); context.advancedImage.hires = structuredClone(draft.hiresFix); context.workflow = context.advancedImage.workflow; context.workflowVersion = context.advancedImage.workflowVersion;
    }
    const now = new Date().toISOString(); const job: GenerationJob = { id, createdAt: now, updatedAt: now, draft: structuredClone(draft), actualSeed, status: 'queued', progress: 0, progressMax: draft.upscale ? 1 : draft.steps, outputIds: [] };
    this.accept(job, context); void this.tick(); return structuredClone(job);
  }
  async enqueueQwenEdit(input: QwenEditJobRequest): Promise<GenerationJob> {
    this.assertQueueAvailable(); this.preparing++;
    try { return await this.prepareQwenEdit(input); } finally { this.preparing--; }
  }
  private async prepareQwenEdit(input: QwenEditJobRequest): Promise<GenerationJob> {
    if (this.disposed) throw new Error('The generation queue is stopped.');
    if (this.ipAdapterService?.status().state === 'activating') throw new Error('Wait for reference-tool activation to finish before queueing generation.');
    const request = qwenEditJobRequestSchema.parse(input);
    if (!this.qwenEditAssets) throw new Error('The reviewed Qwen edit asset service is unavailable.');
    const source = await this.sources.resolve(request.sourceId);
    if (source.source.normalized.sha256 !== request.sourceSha256) throw new Error('The selected Qwen source changed. Choose its original image again.');
    const lineage = this.qwenLineage(request, source.source.originGenerationId);
    const bundle = await this.qwenEditAssets.verify(request.settings.profile);
    const hashes = Object.fromEntries(Object.entries(bundle.assets).map(([role, asset]) => [role, asset.sha256])) as NonNullable<QwenEditJobRequest['assetHashes']>;
    if (request.assetHashes && (Object.keys(request.assetHashes).length !== Object.keys(hashes).length || Object.entries(hashes).some(([role, hash]) => request.assetHashes![role as keyof typeof hashes] !== hash))) throw new Error('The reviewed Qwen assets differ from this frozen edit recipe. Choose a new recipe deliberately before editing.');
    const id = randomUUID(); const actualSeed = request.settings.seed === 'random' ? String(randomBytes(6).readUIntBE(0, 6)) : BigInt(request.settings.seed).toString();
    const plan = buildQwenEditWorkflow({ source: source.source, sourceFilename: path.relative(this.paths.inputs, source.normalizedPath).replaceAll('\\', '/'), instruction: request.instruction, negativePrompt: request.negativePrompt, jobId: id, settings: { ...request.settings, seed: actualSeed }, workflowVersion: request.workflowVersion }, bundle);
    request.settings = structuredClone(plan.settings); request.assetHashes = hashes; request.workflowVersion = plan.workflowVersion;
    const draft: GenerationDraft = { ...structuredClone(DEFAULT_DRAFT), checkpointId: '', loras: [], autoTriggers: false, prompt: request.instruction, negativePrompt: request.negativePrompt ?? '', width: plan.settings.width, height: plan.settings.height, steps: plan.settings.steps, cfg: plan.settings.guidance, sampler: 'euler', scheduler: 'simple', seed: actualSeed, batchSize: 1, qwenEdit: request };
    const context: ExecutionContext = { workflow: plan.workflow, workflowVersion: plan.workflowVersion, qwenEdit: { plan, lineage }, imageInput: { source: source.source }, loras: [], resolvedPrompt: request.instruction, backendVersion: this.backend.status().version ?? 'unknown', appVersion: this.appVersion };
    const now = new Date().toISOString(); const job: GenerationJob = { id, createdAt: now, updatedAt: now, draft, actualSeed, status: 'queued', progress: 0, progressMax: plan.settings.steps, outputIds: [] };
    this.accept(job, context); void this.tick(); return structuredClone(job);
  }
  private qwenLineage(request: QwenEditJobRequest, originGenerationId?: string): QwenEditRecord['lineage'] {
    const { parentRecordId } = request.lineage;
    if (parentRecordId !== originGenerationId) throw new Error('The Qwen edit parent must be the image from which this immutable source was imported.');
    const parent = parentRecordId ? this.store.records().find(record => record.id === parentRecordId) : undefined;
    if (parentRecordId && !parent) throw new Error('The original Qwen edit parent is no longer in studio history.');
    if (parent?.qwenEdit && parent.qwenEdit.lineage.conversationId !== request.lineage.conversationId) throw new Error('Continuing a Qwen image requires its original conversation identity. A new branch may use a new branch ID.');
    const previousVersion = parent?.qwenEdit?.lineage.version ?? 0;
    if (!Number.isSafeInteger(previousVersion) || previousVersion < 0 || previousVersion >= Number.MAX_SAFE_INTEGER) throw new Error('The saved Qwen parent has an invalid version.');
    return { ...request.lineage, version: previousVersion + 1 };
  }
  async retry(id: string) {
    const job = this.items.find(item => item.id === id); if (!job || !['failed', 'cancelled'].includes(job.status)) throw new Error('Only a failed or cancelled job can be retried.');
    if (isVideoJob(job)) {
      if (job.finalization) throw new Error('Retry saving this finished video instead of generating it again.');
      this.videoContext(job); return this.enqueueVideo({ ...structuredClone(job.video), seed: job.actualSeed });
    }
    const context = this.context(id);
    if (job.draft.hiresFix || context.advancedImage?.hires) this.outputs(job, context);
    if (job.draft.faceDetailer || context.faceDetailer) this.outputs(job, context);
    if (job.draft.ipAdapter || context.ipAdapter || context.ipAdapterSource) this.outputs(job, context);
    if (job.draft.regionalPrompts?.settings.enabled || context.regionalPrompts) this.outputs(job, context);
    if (job.draft.qwenEdit || context.qwenEdit) this.frozenQwenPlan(job, context);
    if (job.draft.imageInput?.crop) {
      this.outputs(job, context);
      if (!job.draft.imageInput.cropPlan) throw new Error('The saved job is missing its frozen crop recipe. Restore its source and mask as a new generation.');
    }
    return this.enqueue({ ...job.draft, ...(job.draft.hiresFix ? { hiresFix: restoreHiresSettings(job.draft.hiresFix, context.advancedImage?.workflowVersion ?? 'missing') } : {}), seed: job.actualSeed, triggerWords: job.draft.triggerWords ?? Object.fromEntries(context.loras.map(asset => [asset.id, asset.triggers])), assetHashes: job.draft.assetHashes ?? Object.fromEntries([...(context.checkpoint ? [context.checkpoint] : []), ...context.loras].filter(asset => asset.sha256).map(asset => [asset.id, asset.sha256!])) });
  }
  reorder(ids: string[]) {
    const queued = this.items.filter(job => job.status === 'queued').map(job => job.id);
    if (ids.length !== queued.length || new Set(ids).size !== ids.length || ids.some(id => !queued.includes(id))) throw new Error('The queue changed. Try moving the job again.');
    this.order = [...ids]; this.store.setState('queue-order', this.order); this.changed();
  }
  async cancel(id: string) {
    const job = this.items.find(item => item.id === id); if (!job) throw new Error('Job not found.');
    if (job.status === 'queued') { job.status = 'cancelled'; this.save(job); return; }
    if (job.status !== 'running') return;
    const context = isVideoJob(job) ? this.videoContext(job) : this.context(id); context.cancelRequested = true; this.saveTogether(job, context);
    if (isVideoJob(job) && job.finalization) { job.error = 'Cancellation recorded. Any finished video will be retained.'; this.save(job); return; }
    if (this.backend.status().state !== 'ready') { job.error = 'Cancellation saved. Waiting for the engine to reconnect.'; this.save(job); return; }
    await this.request(`/api/jobs/${job.promptId}/cancel`, {});
    if (job.status !== 'running' || isVideoJob(job) && job.finalization) return;
    job.error = 'Cancelling…'; this.save(job); void this.tick();
  }
  private connect() {
    const base = this.backend.getUrl();
    if (!base || this.backend.status().state !== 'ready') { this.socket?.terminate(); this.socket = undefined; this.socketUrl = undefined; return; }
    if (this.socket && this.socketUrl === base && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.socket?.terminate(); this.socketUrl = base;
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?clientId=${this.clientId}`, { maxPayload: 8 * 1024 * 1024 }); this.socket = ws;
    ws.on('error', () => {});
    ws.on('open', () => { if (!this.disposed && this.socket === ws) ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } })); });
    ws.on('message', (data, binary) => {
      if (this.disposed || this.socket !== ws) return;
      const job = this.items.find(item => item.status === 'running'); if (!job) return;
      try {
        if (binary) {
          if (isVideoJob(job) || !this.store.settings().showGenerationPreview) return;
          const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          const preview = job.promptId && ownedGenerationPreview(bytes, job.promptId);
          if (preview) { job.previewUrl = preview; job.queueState = 'running'; this.changed(); }
          return;
        }
        const event = JSON.parse(data.toString()); if (event.data?.prompt_id !== job.promptId) return;
        if (event.type === 'progress') { job.queueState = 'running'; job.progress = Math.max(0, Number(event.data.value) || 0); job.progressMax = Number(event.data.max) || (isVideoJob(job) ? this.videoContext(job).prepared.contract.plan.sampling.steps : job.draft.steps); this.save(job); }
        if (event.type === 'executing') { const node = typeof event.data.node === 'string' ? event.data.node : undefined; if (job.currentNode !== node) { job.progress = 0; job.progressMax = 0; } job.queueState = node ? 'running' : 'unknown'; job.currentNode = node; if (isVideoJob(job)) { const graph = this.videoContext(job).prepared.contract.workflow; const kind = node ? graph[node]?.class_type : undefined; job.phase = kind === 'SaveVideo' ? 'Writing video' : kind === 'SamplerCustomAdvanced' ? 'Generating video' : kind === 'VAEDecodeTiled' ? 'Decoding video' : kind === 'VAEDecodeAudio' ? 'Decoding audio' : 'Preparing video'; } else { const context = this.context(job.id); job.phase = generationPhase(context.workflow, node, context.advancedImage, context.faceDetailer?.plan); } this.save(job); }
        if (['execution_success', 'execution_error', 'execution_interrupted'].includes(event.type)) void this.tick();
      } catch { /* Malformed transient events cannot change durable job state. */ }
    });
  }
  private async preflight(context: ExecutionContext, job: GenerationJob) {
    context.workflow = canonicalModelPaths(context.workflow);
    const verifiedImages = new Map<string, Set<string>>();
    const verifiedImage = (className: string, filename: string) => { const files = verifiedImages.get(className) ?? new Set<string>(); files.add(path.relative(this.paths.inputs, filename).replaceAll('\\', '/')); verifiedImages.set(className, files); };
    if (context.imageInput) {
      const source = await this.sources.resolve(context.imageInput.source.id);
      if (source.source.normalized.sha256 !== context.imageInput.source.normalized.sha256) throw new Error('The queued source image changed. Import it again as a new source.');
      verifiedImage('LoadImage', source.normalizedPath);
      if (context.imageInput.mask) {
        const mask = await this.sources.resolveMask(context.imageInput.mask.id);
        if (mask.mask.sha256 !== context.imageInput.mask.sha256 || mask.mask.sourceId !== source.source.id) throw new Error('The queued mask changed. Save a new mask before retrying.');
        verifiedImage('LoadImageMask', mask.path);
        if (context.cropInpaint) {
          const frozen = cropInpaintPlanSchema.parse(context.cropInpaint);
          const decoded = await this.decodeVerifiedMask(mask);
          const current = await createCropInpaintPlan({ source: source.source, mask: mask.mask, maskRed: redMaskFromRgba(decoded.data, decoded.width, decoded.height), working: frozen.working, settings: { mode: frozen.settings.mode, contextPadding: frozen.settings.contextPadding }, denoise: frozen.settings.denoise });
          if (JSON.stringify(frozen) !== JSON.stringify(current.plan)) throw new Error('The queued crop recipe no longer matches its verified source, mask or geometry. Restore its original recipe before retrying.');
          validateFrozenCropInpaintWorkflow(context.workflow, job.draft, { sourceFilename: path.relative(this.paths.inputs, source.normalizedPath).replaceAll('\\', '/'), maskFilename: path.relative(this.paths.inputs, mask.path).replaceAll('\\', '/'), plan: frozen });
        }
      }
    }
    if (context.controlNet) {
      const source = await this.sources.resolve(context.controlNet.plan.source.id);
      if (source.source.normalized.sha256 !== context.controlNet.plan.settings.sourceSha256 || source.source.normalized.sha256 !== context.controlNet.plan.source.normalized.sha256) throw new Error('The queued control source changed. Import it again as a new source.');
      verifiedImage('LoadImage', source.normalizedPath);
      if (!this.controlNetService) throw new Error('The reviewed ControlNet service is unavailable.');
      const actual = await this.controlNetService.verify(); const expected = context.controlNet.plan.asset;
      if (actual.sha256 !== expected.sha256 || actual.filename !== expected.filename) throw new Error('The reviewed ControlNet model changed after this job was queued.');
    }
    if (context.checkpoint || context.loras.length) await this.models.refresh();
    if (context.checkpoint || context.loras.length) await this.models.verifyExternalModels?.([...(context.checkpoint ? [context.checkpoint.id] : []), ...context.loras.map(asset => asset.id)]);
    for (const expected of [...(context.checkpoint ? [context.checkpoint] : []), ...context.loras]) {
      const actual = this.models.assets.find(asset => asset.id === expected.id);
      if (!actual || actual.status !== 'ready' || actual.sha256 !== expected.sha256) throw new Error(`${expected.name} changed or is missing. Re-select the model and generate again.`);
    }
    if (context.faceDetailer) {
      const saved = this.frozenFaceRecipe(job, context);
      if (!this.faceDetailerService) throw new Error('The reviewed face refinement service is unavailable.');
      const current = await this.faceDetailerService.createRefinementPlan(job.draft.faceDetailer!.request, saved.plan.passes.map(pass => pass.seed));
      const receipt = await this.faceDetailerService.getDetection(saved.plan.detectionId);
      const source = await this.sources.resolve(saved.source.id);
      if (JSON.stringify(current) !== JSON.stringify(saved.plan) || JSON.stringify(receipt) !== JSON.stringify(saved.detection) || JSON.stringify(source.source) !== JSON.stringify(saved.source)) throw new Error('The queued face detection, source or masks changed. Restore the original recipe.');
      verifiedImage('LoadImage', source.normalizedPath);
      const maskFilenames: Record<string, string> = {};
      for (const pass of saved.plan.passes) { const mask = await this.sources.resolveMask(pass.crop.mask.id); verifiedImage('LoadImageMask', mask.path); maskFilenames[mask.mask.id] = path.relative(this.paths.inputs, mask.path).replaceAll('\\', '/'); }
      const prepared = await prepareDynamicPromptDraft(job.draft, job.actualSeed);
      const resolvedDraft = { ...job.draft, prompt: prepared.prompt, negativePrompt: prepared.negativePrompt };
      const assets = [context.checkpoint!, ...context.loras];
      if (resolvePrompt(resolvedDraft, assets) !== context.resolvedPrompt) throw new Error('The queued face prompts differ from their frozen recipe.');
      validateFrozenFaceRefinementWorkflow(context.workflow, buildWorkflow(resolvedDraft, assets, job.actualSeed, job.id), resolvedDraft, { plan: saved.plan, sourceFilename: path.relative(this.paths.inputs, source.normalizedPath).replaceAll('\\', '/'), maskFilenames });
    }
    if (context.ipAdapter) {
      const frozen = this.frozenIPAdapterPlan(job, context);
      if (!this.ipAdapterService) throw new Error('The reviewed IP Adapter service is unavailable.');
      const source = await this.sources.resolve(frozen.source.id);
      if (JSON.stringify(source.source) !== JSON.stringify(context.ipAdapterSource)) throw new Error('The queued IP Adapter reference changed. Restore its original source before retrying.');
      verifiedImage('LoadImage', source.normalizedPath);
      const assets = await this.ipAdapterService.verify();
      const prepared = await prepareDynamicPromptDraft(job.draft, job.actualSeed);
      const resolvedDraft = { ...job.draft, prompt: prepared.prompt, negativePrompt: prepared.negativePrompt };
      const models = [context.checkpoint!, ...context.loras];
      const baseline = buildWorkflow(resolvedDraft, models, job.actualSeed, job.id);
      const result = augmentIPAdapterWorkflow(baseline, resolvedDraft, frozen.settings, { source: source.source, sourceFilename: path.relative(this.paths.inputs, source.normalizedPath).replaceAll('\\', '/') }, assets, frozen);
      if (JSON.stringify(result.workflow) !== JSON.stringify(context.workflow) || resolvePrompt(resolvedDraft, models) !== context.resolvedPrompt) throw new Error('The saved IP Adapter graph differs from its frozen recipe. Restore the original recipe before retrying.');
    }
    if (context.regionalPrompts) {
      const frozen = regionalPromptPlanSchema.parse(context.regionalPrompts);
      const masks = frozen.regions.map(region => region.mask);
      await this.regionalMasks.prepare(frozen.settings, frozen.canvas, masks);
      for (const entry of frozen.regions) verifiedImage('LoadImageMask', await this.regionalMasks.verify(entry.mask, frozen.settings.regions.find(region => region.id === entry.regionId), frozen.canvas));
      const prepared = await prepareDynamicPromptDraft(job.draft, job.actualSeed);
      const resolvedDraft = { ...job.draft, prompt: prepared.prompt, negativePrompt: prepared.negativePrompt };
      const assets = [...(context.checkpoint ? [context.checkpoint] : []), ...context.loras];
      const baseline = buildWorkflow(resolvedDraft, assets, job.actualSeed, job.id);
      const result = await augmentRegionalPromptWorkflow(baseline, resolvedDraft, frozen.settings, masks, frozen);
      if (JSON.stringify(result.workflow) !== JSON.stringify(context.workflow) || resolvePrompt(resolvedDraft, assets) !== context.resolvedPrompt) throw new Error('The saved regional graph differs from its frozen recipe. Restore the original recipe before retrying.');
    }
    if (context.advancedImage?.upscaler) {
      if (!this.upscaler) throw new Error('The reviewed upscaler service is unavailable.');
      const actual = await this.upscaler.verify(); const expected = context.advancedImage.upscaler;
      if (actual.sha256 !== expected.sha256 || actual.filename !== expected.filename) throw new Error('The reviewed upscaler changed after this job was queued.');
    }
    const objects = await this.request<Record<string, { input?: { required?: Record<string, unknown[]> } }>>('/object_info');
    if (context.qwenEdit) {
      if (!this.qwenEditAssets) throw new Error('The reviewed Qwen edit asset service is unavailable.');
      const expected = this.frozenQwenPlan(job, context);
      const current = await this.qwenEditAssets.verify(expected.settings.profile);
      if (Object.entries(expected.bundle.assets).some(([role, asset]) => current.assets[role as keyof typeof current.assets]?.sha256 !== asset.sha256)) throw new Error('The Qwen assets changed after this edit was queued.');
      const source = await this.sources.resolve(expected.source.id);
      if (source.source.normalized.sha256 !== expected.source.normalized.sha256 || path.relative(this.paths.inputs, source.normalizedPath).replaceAll('\\', '/') !== expected.workflow['4'].inputs.image) throw new Error('The queued Qwen source differs from its frozen edit recipe.');
      const bound = bindQwenEditWorkflow(expected, objects); context.qwenEdit.plan = bound; context.workflow = bound.workflow;
    }
    if (context.advancedImage?.hires) validateHiresCapabilities(objects, context.advancedImage);
    if (context.controlNet) validateControlNetCapabilities(objects, context.controlNet.plan.asset);
    if (context.faceDetailer) validateFaceRefinementCapabilities(objects);
    if (context.ipAdapter?.applied) validateIPAdapterCapabilities(objects, context.ipAdapter.assets);
    context.workflow = bindModelPaths(context.workflow, objects);
    for (const node of Object.values(context.workflow)) {
      if (!objects[node.class_type]) throw new Error(`The engine does not provide the required ${node.class_type} node.`);
      for (const [name, value] of Object.entries(node.inputs)) {
        const definition = objects[node.class_type].input?.required?.[name];
        const allowed = definition?.[0] === 'COMBO' ? (definition?.[1] as { options?: unknown[] } | undefined)?.options : definition?.[0];
        // Comfy's upload dropdown lists only top-level files; VALIDATE_INPUTS also
        // accepts nested paths. Exempt only the exact independently verified input.
        if (name === 'image' && typeof value === 'string' && verifiedImages.get(node.class_type)?.has(value)) continue;
        if (Array.isArray(allowed) && !Array.isArray(value) && !allowed.includes(value)) throw new Error(`The engine does not offer ${String(value)} for ${node.class_type}.${name}. Refresh models and try again.`);
      }
    }
  }
  async tick() {
    if (this.polling || this.disposed || this.maintenance) return; this.polling = true;
    try {
      // Finished media needs no running backend, permission to infer again, or new GPU submission.
      const saving = this.items.find((job): job is VideoJob => isVideoJob(job) && job.finalization === 'pending');
      if (saving) { await this.finalizeVideo(saving); return; }
      this.connect(); const activity = this.activity ? await this.activity.refresh() : undefined;
      if (this.backend.status().state !== 'ready') {
        for (const item of this.items.filter(job => job.status === 'running')) if (item.queueState !== 'unknown' || item.previewUrl) { item.queueState = 'unknown'; item.previewUrl = undefined; this.save(item); }
        return;
      }
      if (this.runtimeBlockedReason?.()) return;
      const active = this.items.find(job => job.status === 'running');
      if (active) {
        if (activity) { const observed = activity.owned.find(item => item.promptId === active.promptId); const state = activity.state === 'ready' && observed?.state !== 'absent' ? observed?.state ?? 'unknown' : 'unknown'; if (active.queueState !== state) { active.queueState = state; if (state !== 'running') active.previewUrl = undefined; this.save(active); } }
        if (isVideoJob(active)) await this.reconcileVideo(active); else await this.reconcile(active); return;
      }
      if (activity && (activity.state !== 'ready' || activity.foreignRunning || activity.foreignPending)) return;
      const next = this.jobs().find(job => job.status === 'queued'); if (!next) return;
      const job = this.items.find(item => item.id === next.id)!;
      let context: ExecutionContext | VideoQueueContext;
      try { if (isVideoJob(job)) { context = await this.videoQueue!.revalidate(job, this.videoContext(job), this.shutdown.signal); } else { context = this.context(job.id); this.outputs(job, context); this.controlOutput(job, context); await this.preflight(context, job); } }
      catch (error) { if (this.disposed || job.status !== 'queued') return; job.status = 'failed'; job.error = message(error); this.save(job); this.completed(job); return; }
      if (this.activity) { const fresh = await this.activity.refresh(); if (fresh.state !== 'ready' || fresh.foreignRunning || fresh.foreignPending) return; }
      // A user may cancel or reorder while the capability request is in flight.
      if (job.status !== 'queued' || this.jobs().find(item => item.status === 'queued')?.id !== job.id || this.disposed || this.maintenance || this.runtimeBlockedReason?.()) return;
      try {
        if (isVideoJob(job)) this.videoQueue!.assertSubmission(job, context as VideoQueueContext, this.shutdown.signal);
        else if (this.backend.getRuntimeIdentity) { const identity = this.backend.getRuntimeIdentity(); if (!identity) throw new Error('The engine has no verified runtime identity. Restart it before submitting this job.'); (context as ExecutionContext).runtimeIdentity = runtimeIdentitySchema.parse(structuredClone(identity)); }
      } catch (error) { job.status = 'failed'; job.error = message(error); this.save(job); this.completed(job); return; }
      context.startedAt = Date.now();
      if (!isVideoJob(job)) (context as ExecutionContext).backendVersion = this.backend.status().version ?? 'unknown';
      job.promptId = randomUUID(); job.status = 'running'; job.queueState = 'submitting'; this.saveTogether(job, context);
      let prompt: ComfyWorkflow; let latent: unknown;
      if (isVideoJob(job)) { const video = context as VideoQueueContext; prompt = video.prepared.contract.workflow; latent = { kind: 'video', jobId: job.id, actualSeed: job.actualSeed, video: job.video, contract: video.prepared.contract, runtimeIdentity: video.prepared.runtimeIdentity, authorizationRecordId: video.prepared.authorizationRecordId }; }
      else { const image = context as ExecutionContext; prompt = image.workflow; latent = { jobId: job.id, draft: job.draft, actualSeed: job.actualSeed, workflowVersion: image.workflowVersion ?? WORKFLOW_VERSION, imageInput: image.imageInput, faceDetailer: image.faceDetailer, ipAdapter: image.ipAdapter, ipAdapterSource: image.ipAdapterSource, regionalPrompts: image.regionalPrompts, qwenEdit: image.qwenEdit, cropInpaint: image.cropInpaint, advancedImage: image.advancedImage, dynamicPromptRecipe: image.dynamicPromptRecipe, controlNet: image.controlNet, runtimeIdentity: image.runtimeIdentity }; }
      try { await this.request('/prompt', { prompt_id: job.promptId, client_id: this.clientId, prompt, extra_data: { extra_pnginfo: { latent } } }); }
      catch (error) {
        if (error instanceof EngineRequestError && error.status >= 400 && error.status < 500 && error.status !== 409) { job.status = 'failed'; job.error = message(error); this.save(job); this.completed(job); }
        else { job.error = `Checking whether the engine accepted this job: ${message(error)}`; this.save(job); }
      }
    } catch (error) {
      if (this.disposed) return;
      const active = this.items.find(job => job.status === 'running');
      if (active && active.error !== message(error)) { active.error = message(error); this.save(active); }
    } finally { this.polling = false; for (const resolve of this.drainWaiters.splice(0)) resolve(); }
  }
  async retryVideoSave(id: string): Promise<void> {
    this.assertQueueAvailable(); const job = this.items.find(item => item.id === id);
    if (!job || !isVideoJob(job) || job.finalization !== 'failed') throw new Error('Choose a finished video whose local saving needs attention.');
    const context = this.videoContext(job); if (!context.finalization) throw new Error('The finished video is missing its frozen saving receipt.');
    job.finalization = 'pending'; job.error = undefined; job.phase = 'Saving finished video'; this.saveTogether(job, context); void this.tick();
  }
  private finishVideo(job: VideoJob, context: VideoQueueContext, status: 'completed' | 'failed' | 'cancelled', error?: string) {
    context.cancelRequested ||= this.videoContext(job).cancelRequested;
    job.status = context.cancelRequested ? 'cancelled' : status; job.error = error; job.finalization = undefined; job.queueState = undefined; job.phase = undefined; job.previewUrl = undefined;
    this.saveTogether(job, context); this.missingSince.delete(job.id); this.completed(job);
  }
  private async finalizeVideo(job: VideoJob) {
    try {
      const context = this.videoContext(job); if (!context.finalization) throw new Error('The finished video is missing its saving receipt.');
      const record = await this.videoQueue!.finalize(job, context, this.shutdown.signal); if (this.disposed) return;
      // Cancellation may have been saved while the CPU decoder was working.
      const latest = this.videoContext(job); job.outputIds = [record.id];
      this.finishVideo(job, latest, context.finalization.terminalStatus, context.finalization.error);
    } catch (error) {
      if (this.disposed) return;
      if (error instanceof JobPersistenceError) throw error;
      job.status = 'failed'; job.finalization = 'failed'; job.queueState = undefined; job.phase = 'Video saving needs attention'; job.error = `Could not save the finished video: ${message(error)} Retry saving to reuse the existing output.`;
      this.save(job); this.completed(job);
    }
  }
  private async retainVideo(job: VideoJob, context: VideoQueueContext, outputs: unknown, status: 'completed' | 'failed' | 'cancelled', error?: string) {
    // History and directory reads can overlap cancellation. Freeze outputs against
    // the latest durable context so the cancellation intent cannot be overwritten.
    context = this.videoContext(job); if (context.cancelRequested) status = 'cancelled';
    const candidates = videoOutputCandidates(outputs, context.prepared.contract);
    const frozen = this.videoQueue!.completedOutputs(job, context, outputs, candidates.length ? status : status === 'completed' ? 'failed' : status, error ?? (!candidates.length && status === 'completed' ? 'The engine finished without an owned video output.' : undefined));
    if (!candidates.length) { this.finishVideo(job, frozen, status === 'completed' ? 'failed' : status, frozen.finalization?.error); return; }
    job.finalization = 'pending'; job.phase = 'Saving finished video'; job.queueState = undefined; this.saveTogether(job, frozen);
    await this.finalizeVideo(job);
  }
  private async reconcileVideo(job: VideoJob) {
    const context = this.videoContext(job); if (!job.promptId) throw new Error('The submitted video is missing its prompt identity.');
    const history = await this.request<Record<string, HistoryEntry>>(`/history/${job.promptId}`); const entry = history[job.promptId];
    if (entry) {
      this.missingSince.delete(job.id);
      const failed = entry.status?.status_str === 'error' || entry.status?.messages?.some(([kind]) => kind === 'execution_error');
      const interrupted = entry.status?.messages?.some(([kind]) => kind === 'execution_interrupted');
      if (!entry.status?.completed && !failed && !interrupted) return;
      const error = entry.status?.messages?.find(([kind]) => kind === 'execution_error')?.[1].exception_message;
      const terminal = interrupted || context.cancelRequested ? 'cancelled' : failed ? 'failed' : 'completed';
      try {
        let outputs: unknown = entry.outputs ?? {};
        if (Object.keys(entry.outputs ?? {}).some(node => node !== context.prepared.contract.output.nodeId)) throw new Error('The engine returned an unexpected video output node.');
        if (!videoOutputCandidates(outputs, context.prepared.contract).length) outputs = await this.videoQueue!.recoverOutputs(job, context);
        await this.retainVideo(job, context, outputs, terminal, error ?? (failed ? 'The engine reported a video generation error. Any finished output was retained.' : undefined));
      } catch (cause) { if (cause instanceof JobPersistenceError) throw cause; this.finishVideo(job, this.videoContext(job), terminal === 'cancelled' ? 'cancelled' : 'failed', `The video output could not be recovered: ${message(cause)}`); }
      return;
    }
    const queue = await this.request<QueueResponse>('/queue');
    if ([...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].some(row => row[1] === job.promptId)) {
      const state = (queue.queue_running ?? []).some(row => row[1] === job.promptId) ? 'running' : 'pending'; if (job.queueState !== state) { job.queueState = state; this.save(job); }
      this.missingSince.delete(job.id); if (this.videoContext(job).cancelRequested) await this.request(`/api/jobs/${job.promptId}/cancel`, {}); return;
    }
    const since = this.missingSince.get(job.id) ?? Date.now(); this.missingSince.set(job.id, since); if (Date.now() - since < 8000) return;
    try {
      const outputs = await this.videoQueue!.recoverOutputs(job, context); const found = videoOutputCandidates(outputs, context.prepared.contract).length > 0;
      await this.retainVideo(job, context, outputs, context.cancelRequested ? 'cancelled' : found ? 'completed' : 'failed', found ? undefined : 'The engine lost this video after a disconnect. No owned finished clip was found; retry generation when ready.');
    } catch (error) { if (error instanceof JobPersistenceError) throw error; this.finishVideo(job, this.videoContext(job), context.cancelRequested ? 'cancelled' : 'failed', `Could not recover the interrupted video: ${message(error)}`); }
    this.missingSince.delete(job.id);
  }
  private async reconcile(job: GenerationJob) {
    const context = this.context(job.id);
    let outputs: JobOutput[], controlOutput: ControlMapOutput | undefined;
    try { outputs = this.outputs(job, context); controlOutput = this.controlOutput(job, context); }
    catch (error) {
      // A rejected local recipe is not a connection outage. Preserve ownership
      // while the accepted prompt is active, then expose a terminal failure.
      const queue = await this.request<QueueResponse>('/queue');
      if (!Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending) || [...queue.queue_running, ...queue.queue_pending].some(row => !Array.isArray(row) || typeof row[1] !== 'string')) throw new Error('Could not confirm engine queue state while checking the saved recipe. Reconnecting before changing the job outcome.');
      if ([...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].some(row => row[1] === job.promptId)) { this.missingSince.delete(job.id); throw error; }
      const history = await this.request<Record<string, HistoryEntry>>(`/history/${job.promptId}`);
      const entry = history[job.promptId!];
      const terminal = entry?.status?.completed || entry?.status?.status_str === 'error' || entry?.status?.messages?.some(([kind]) => ['execution_error', 'execution_interrupted'].includes(kind));
      const since = this.missingSince.get(job.id) ?? Date.now(); this.missingSince.set(job.id, since);
      if (!terminal && Date.now() - since < 8000) throw error;
      job.status = 'failed'; job.error = `Could not validate the saved image recipe: ${message(error)} Any generated files remain in the studio output folder.`;
      job.previewUrl = undefined; job.queueState = undefined; job.phase = 'Saved recipe needs attention';
      this.save(job); this.missingSince.delete(job.id); this.completed(job); return;
    }
    const expectedCount = outputs.reduce((sum, output) => sum + output.batchSize, 0);
    const history = await this.request<Record<string, HistoryEntry>>(`/history/${job.promptId}`); const entry = history[job.promptId!];
    if (entry) {
      try {
        for (const [nodeId, output] of Object.entries(entry.outputs ?? {})) if (!outputs.some(expected => expected.nodeId === nodeId) && nodeId !== controlOutput?.nodeId && output.images?.some(image => image.type === 'output')) throw new Error('The engine returned an unexpected output node.');
        for (const output of outputs) for (const image of entry.outputs?.[output.nodeId]?.images ?? []) if (image.type === 'output') await this.record(job, context, path.join(image.subfolder ?? '', image.filename), output);
        // A cancelled prompt may omit a completed SaveImage from history. Once
        // terminal, recover only this job's frozen pass prefixes from disk.
        if ((context.faceDetailer || context.advancedImage?.hires) && (entry.status?.completed || entry.status?.status_str === 'error' || entry.status?.messages?.some(([kind]) => ['execution_error', 'execution_interrupted'].includes(kind)))) {
          const names = await fs.readdir(this.paths.outputs);
          for (const output of outputs) for (const name of names.filter(name => this.outputIdentity(output, name)).sort()) await this.record(job, context, name, output);
        }
        await this.linkBaseRecords(job, context);
        if (controlOutput) {
          const images = entry.outputs?.[controlOutput.nodeId]?.images?.filter(image => image.type === 'output') ?? [];
          if (images.length > 1) throw new Error('The engine returned duplicate control-map images.');
          if (images[0]) await this.recordControlMap(job, context, path.join(images[0].subfolder ?? '', images[0].filename));
          else if (context.controlNet?.map) await this.recordControlMap(job, context, context.controlNet.map.filename);
          await this.linkControlMap(job, context);
        }
      } catch (error) { job.status = 'failed'; job.error = `Could not save the finished image: ${message(error)}`; job.previewUrl = undefined; this.save(job); this.completed(job); return; }
      const error = entry.status?.messages?.find(([type]) => type === 'execution_error')?.[1].exception_message;
      const interrupted = entry.status?.messages?.some(([type]) => type === 'execution_interrupted');
      if (entry.status?.completed || entry.status?.status_str === 'error' || error || interrupted) {
        const missingMap = Boolean(controlOutput && !context.controlNet?.map);
        job.status = interrupted || context.cancelRequested ? 'cancelled' : error || entry.status?.status_str === 'error' || job.outputIds.length !== expectedCount || missingMap ? 'failed' : 'completed';
        job.error = error || (job.status === 'failed' ? entry.status?.status_str === 'error' ? 'The engine reported a generation error. Any completed images were saved.' : missingMap ? 'The engine did not retain the required Canny control map. Any completed images were saved.' : `The engine saved ${job.outputIds.length} of ${expectedCount} requested images.` : undefined); job.previewUrl = undefined; this.save(job); this.completed(job);
      }
      this.missingSince.delete(job.id); return;
    }
    const queue = await this.request<QueueResponse>('/queue');
    if ([...(queue.queue_running ?? []), ...(queue.queue_pending ?? [])].some(row => row[1] === job.promptId)) {
      const state = (queue.queue_running ?? []).some(row => row[1] === job.promptId) ? 'running' : 'pending'; if (job.queueState !== state) { job.queueState = state; if (state !== 'running') job.previewUrl = undefined; this.save(job); }
      this.missingSince.delete(job.id);
      if (context.cancelRequested) await this.request(`/api/jobs/${job.promptId}/cancel`, {});
      return;
    }
    const since = this.missingSince.get(job.id) ?? Date.now(); this.missingSince.set(job.id, since);
    if (Date.now() - since < 8000) return;
    // A backend restart loses Comfy's in-memory history. Recover only this job's
    // uniquely named outputs, and never automatically submit an uncertain job twice.
    const names = await fs.readdir(this.paths.outputs);
    try {
      for (const output of outputs) for (const name of names.filter(name => this.outputIdentity(output, name)).sort()) await this.record(job, context, name, output); await this.linkBaseRecords(job, context);
      if (controlOutput) { const maps = names.filter(name => this.controlFilename(controlOutput, name)); if (maps.length > 1) throw new Error('More than one control-map file matches this job.'); if (maps[0]) await this.recordControlMap(job, context, maps[0]); else if (context.controlNet?.map) await this.recordControlMap(job, context, context.controlNet.map.filename); await this.linkControlMap(job, context); }
    }
    catch (error) { job.status = 'failed'; job.error = `Could not recover the interrupted image: ${message(error)}`; job.previewUrl = undefined; this.save(job); this.completed(job); this.missingSince.delete(job.id); return; }
    job.status = job.outputIds.length === expectedCount && (!controlOutput || context.controlNet?.map) ? 'completed' : context.cancelRequested ? 'cancelled' : 'failed';
    job.error = job.status === 'failed' ? controlOutput && !context.controlNet?.map ? 'The engine lost the required Canny control map. Any completed images were recovered.' : 'The engine lost this job after a disconnect. Any completed images were recovered. Retry when ready.' : undefined;
    job.previewUrl = undefined; this.save(job); this.completed(job); this.missingSince.delete(job.id);
  }
  private frozenQwenPlan(job: Pick<GenerationJob, 'id' | 'draft'> & Partial<Pick<GenerationJob, 'actualSeed'>>, context: ExecutionContext) {
    const saved = context.qwenEdit; const request = qwenEditJobRequestSchema.parse(job.draft.qwenEdit);
    if (!saved || context.checkpoint || context.loras.length || context.advancedImage || context.controlNet || context.cropInpaint || context.dynamicPromptRecipe || job.draft.imageInput || job.draft.hiresFix || job.draft.upscale || job.draft.controlNet || job.draft.dynamicPrompts?.enabled || job.draft.regionalPrompts?.settings.enabled || job.draft.variationOfRecordId || job.draft.loras.length || job.draft.checkpointId || job.draft.batchSize !== 1 || context.imageInput?.mask || !context.imageInput?.source) throw new Error('The saved Qwen edit contains conflicting generation recipes.');
    if (request.settings.seed === 'random' || request.settings.seed !== job.draft.seed || job.actualSeed !== undefined && job.actualSeed !== request.settings.seed || !request.assetHashes || !request.workflowVersion) throw new Error('The saved Qwen edit is missing its frozen seed, asset hashes or workflow version.');
    const expected = buildQwenEditWorkflow({ source: saved.plan.source, sourceFilename: `source-images/${request.sourceId}/image.png`, instruction: request.instruction, negativePrompt: request.negativePrompt, settings: { ...request.settings, seed: request.settings.seed }, jobId: job.id, workflowVersion: request.workflowVersion }, saved.plan.bundle);
    if (request.sourceId !== expected.source.id || request.sourceSha256 !== expected.source.normalized.sha256 || JSON.stringify(context.imageInput.source) !== JSON.stringify(expected.source) || JSON.stringify(saved.lineage) !== JSON.stringify(this.qwenLineage(request, expected.source.originGenerationId))) throw new Error('The saved Qwen source or immutable parent/version lineage is inconsistent.');
    if (context.resolvedPrompt !== request.instruction || job.draft.prompt !== request.instruction || job.draft.negativePrompt !== (request.negativePrompt ?? '') || job.draft.width !== expected.settings.width || job.draft.height !== expected.settings.height || job.draft.steps !== expected.settings.steps || job.draft.cfg !== expected.settings.guidance || job.draft.sampler !== 'euler' || job.draft.scheduler !== 'simple' || context.workflowVersion !== expected.workflowVersion || request.workflowVersion !== expected.workflowVersion) throw new Error('The saved Qwen settings differ from its frozen recipe.');
    if (Object.keys(request.assetHashes).length !== Object.keys(expected.bundle.assets).length || Object.entries(expected.bundle.assets).some(([role, asset]) => request.assetHashes![role as keyof typeof request.assetHashes] !== asset.sha256)) throw new Error('The saved Qwen asset identities differ from its frozen recipe.');
    const canonical = (workflow: ComfyWorkflow) => { const value = structuredClone(workflow); for (const [id, field] of [['1', 'unet_name'], ['2', 'clip_name'], ['3', 'vae_name'], ['14', 'lora_name']]) if (value[id] && typeof value[id].inputs[field] === 'string') value[id].inputs[field] = value[id].inputs[field].replaceAll('\\', '/'); return value; };
    if (JSON.stringify(canonical(context.workflow)) !== JSON.stringify(expected.workflow) || JSON.stringify({ ...saved.plan, workflow: canonical(saved.plan.workflow) }) !== JSON.stringify(expected)) throw new Error('The saved Qwen graph or output descriptor differs from its frozen recipe.');
    return expected;
  }
  private frozenIPAdapterPlan(job: Pick<GenerationJob, 'id' | 'draft'>, context: ExecutionContext) {
    const plan = ipAdapterPlanSchema.parse(context.ipAdapter); const source = context.ipAdapterSource;
    if (!job.draft.ipAdapter?.frozen || JSON.stringify(plan) !== JSON.stringify(job.draft.ipAdapter.frozen) || JSON.stringify(plan.settings) !== JSON.stringify(job.draft.ipAdapter.settings) || !context.checkpoint || context.workflowVersion !== plan.version || context.imageInput || context.advancedImage || context.controlNet || context.qwenEdit || context.cropInpaint || context.regionalPrompts || job.draft.imageInput || job.draft.hiresFix || job.draft.upscale || job.draft.controlNet || job.draft.qwenEdit || job.draft.regionalPrompts?.settings.enabled || job.draft.batchSize !== 1 || !source || source.id !== plan.source.id || source.normalized.sha256 !== plan.source.sha256 || source.normalized.width !== plan.source.width || source.normalized.height !== plan.source.height || source.name !== plan.source.name || context.workflow['7']?.class_type !== 'SaveImage' || context.workflow['7'].inputs.filename_prefix !== `Latent_${job.id}`) throw new Error('The saved IP Adapter reference recipe is missing or inconsistent. Restore the original recipe.');
    return plan;
  }
  private frozenFaceRecipe(job: Pick<GenerationJob, 'id' | 'draft'> & Partial<Pick<GenerationJob, 'actualSeed'>>, context: ExecutionContext) {
    const saved = context.faceDetailer; const authored = job.draft.faceDetailer;
    if (!saved || !authored?.frozen || !context.checkpoint || context.imageInput || context.ipAdapter || context.regionalPrompts || context.qwenEdit || context.advancedImage || context.controlNet || context.cropInpaint) throw new Error('The saved face recipe is missing or has conflicting image workflows.');
    const request = faceRefinementRequestSchema.parse(authored.request); const plan = faceRefinementPlanSchema.parse(saved.plan);
    const seed = job.actualSeed ?? job.draft.seed;
    if (seed === 'random' || request.seed !== seed || job.draft.seed !== seed || JSON.stringify(plan) !== JSON.stringify(authored.frozen) || plan.detectionId !== request.detectionId || context.workflowVersion !== plan.version || JSON.stringify(faceSeeds(seed, plan.passes.length)) !== JSON.stringify(plan.passes.map(pass => pass.seed))) throw new Error('The saved face seed or frozen plan is inconsistent.');
    if (saved.source.id !== plan.source.id || saved.source.normalized.sha256 !== plan.source.sha256 || saved.source.normalized.width !== plan.source.width || saved.source.normalized.height !== plan.source.height || JSON.stringify(saved.detection.source) !== JSON.stringify(plan.source) || saved.detection.id !== plan.detectionId) throw new Error('The saved face source or detection identity is inconsistent.');
    const selected = saved.detection.faces.filter(face => request.faceIds.includes(face.id));
    if (selected.length !== request.faceIds.length || selected.length !== plan.passes.length || plan.passes.some((pass, index) => pass.faceId !== selected[index].id || pass.crop.mask.id !== selected[index].mask.id || pass.crop.mask.sha256 !== selected[index].mask.sha256 || pass.crop.settings.contextPadding !== request.contextPadding || pass.crop.settings.denoise !== request.denoise)) throw new Error('The saved face order, mask or refinement settings are inconsistent.');
    const sourceFilename = `source-images/${saved.source.id}/${saved.source.normalizedStoredSeparately ? 'image.png' : 'original.png'}`;
    const maskFilenames = Object.fromEntries(plan.passes.map(pass => [pass.crop.mask.id, `source-images/${pass.crop.mask.id}/mask.png`]));
    const resolved = { ...job.draft, prompt: context.dynamicPromptRecipe?.positive.resolved ?? job.draft.prompt, negativePrompt: context.dynamicPromptRecipe?.negative.resolved ?? job.draft.negativePrompt };
    const assets = [context.checkpoint, ...context.loras]; const baseline = buildWorkflow(resolved, assets, seed, job.id);
    const expected = buildFaceRefinementWorkflow(baseline, resolved, { plan, sourceFilename, maskFilenames });
    if (JSON.stringify(expected.outputs) !== JSON.stringify(saved.outputs) || resolvePrompt(resolved, assets) !== context.resolvedPrompt) throw new Error('The saved face outputs or prompts differ from the original recipe.');
    validateFrozenFaceRefinementWorkflow(context.workflow, baseline, resolved, { plan, sourceFilename, maskFilenames });
    return saved;
  }
  private outputs(job: Pick<GenerationJob, 'id' | 'draft'> & Partial<Pick<GenerationJob, 'actualSeed'>>, context: ExecutionContext): JobOutput[] {
    if (context.faceDetailer || job.draft.faceDetailer) return this.frozenFaceRecipe(job, context).outputs;
    if (context.ipAdapter || context.ipAdapterSource || job.draft.ipAdapter) this.frozenIPAdapterPlan(job, context);
    if (context.regionalPrompts || job.draft.regionalPrompts?.settings.enabled) {
      const plan = regionalPromptPlanSchema.parse(context.regionalPrompts);
      if (!plan.applied || !job.draft.regionalPrompts?.frozen || JSON.stringify(plan) !== JSON.stringify(job.draft.regionalPrompts.frozen) || JSON.stringify(plan.settings) !== JSON.stringify(job.draft.regionalPrompts.settings) || plan.canvas.width !== job.draft.width || plan.canvas.height !== job.draft.height || job.draft.batchSize !== 1 || context.workflowVersion !== plan.version || context.imageInput || context.advancedImage || context.controlNet || context.qwenEdit || context.workflow['7']?.class_type !== 'SaveImage' || context.workflow['7'].inputs.filename_prefix !== `Latent_${job.id}`) throw new Error('The saved regional recipe is missing or inconsistent. Restore the original recipe.');
    }
    if (context.qwenEdit || job.draft.qwenEdit) { const plan = this.frozenQwenPlan(job, context); return [{ ...plan.output, role: 'final' }]; }
    if (context.cropInpaint || job.draft.imageInput?.crop || job.draft.imageInput?.cropPlan) {
      const parsed = cropInpaintPlanSchema.safeParse(context.cropInpaint);
      const frozenDraft = cropInpaintPlanSchema.safeParse(job.draft.imageInput?.cropPlan);
      if (!parsed.success || !frozenDraft.success) throw new Error('The saved crop inpaint recipe is missing or invalid.');
      const plan = parsed.data; const input = job.draft.imageInput; const source = context.imageInput?.source; const mask = context.imageInput?.mask;
      if (context.advancedImage || context.controlNet || job.draft.hiresFix || job.draft.upscale || job.draft.controlNet || context.workflowVersion !== plan.version || input?.mode !== 'inpaint' || !input.crop || !source || !mask || job.draft.batchSize !== 1) throw new Error('The saved crop inpaint output recipe is inconsistent.');
      if (job.draft.width !== plan.working.width || job.draft.height !== plan.working.height || input.crop.mode !== plan.settings.mode || input.crop.contextPadding !== plan.settings.contextPadding || input.denoise !== plan.settings.denoise || JSON.stringify(plan) !== JSON.stringify(frozenDraft.data)) throw new Error('The saved crop inpaint settings differ from its frozen recipe.');
      if (input.sourceId !== plan.source.id || input.sourceSha256 !== plan.source.sha256 || input.maskId !== plan.mask.id || input.maskSha256 !== plan.mask.sha256 || source.id !== plan.source.id || source.normalized.sha256 !== plan.source.sha256 || source.normalized.width !== plan.source.width || source.normalized.height !== plan.source.height || mask.id !== plan.mask.id || mask.sha256 !== plan.mask.sha256 || mask.sourceId !== plan.source.id || mask.sourceSha256 !== plan.source.sha256 || mask.width !== plan.source.width || mask.height !== plan.source.height) throw new Error('The saved crop inpaint source or mask identity is inconsistent.');
      if (context.workflow['7']?.class_type !== 'SaveImage' || context.workflow['7']?.inputs.filename_prefix !== `Latent_${job.id}`) throw new Error('The saved crop inpaint output recipe is inconsistent.');
      return [{ nodeId: '7', role: 'final', width: plan.output.width, height: plan.output.height, batchSize: 1, filenamePrefix: `Latent_${job.id}` }];
    }
    if (!context.advancedImage) return [{ nodeId: '7', role: 'final', width: job.draft.width, height: job.draft.height, batchSize: job.draft.batchSize, filenamePrefix: `Latent_${job.id}` }];
    const plan = context.advancedImage;
    if (plan.hires || job.draft.hiresFix) {
      if (!plan.hires || !job.draft.hiresFix || context.workflowVersion !== plan.workflowVersion) throw new Error('The saved hires recipe is incomplete.');
      const recorded = restoreHiresSettings(job.draft.hiresFix, plan.workflowVersion);
      if (job.draft.hiresFix.workflowVersion && job.draft.hiresFix.workflowVersion !== recorded.workflowVersion || JSON.stringify(restoreHiresSettings(plan.hires, plan.workflowVersion)) !== JSON.stringify(recorded)) throw new Error('The saved hires version or settings differ from its frozen recipe.');
    }
    if (plan.expectedOutputCount !== plan.outputs.reduce((sum, output) => sum + output.batchSize, 0) || new Set(plan.outputs.map(output => output.nodeId)).size !== plan.outputs.length || !plan.outputs.length || plan.outputs.some(output => context.workflow[output.nodeId]?.class_type !== 'SaveImage' || context.workflow[output.nodeId]?.inputs.filename_prefix !== output.filenamePrefix || output.filenamePrefix !== `Latent_${job.id}_${output.role}_%batch_num%` || !Number.isInteger(output.batchSize) || output.batchSize < 1 || output.batchSize > 4 || !Number.isInteger(output.width) || !Number.isInteger(output.height) || output.width < 1 || output.height < 1 || output.width > 4096 || output.height > 4096)) throw new Error('The saved advanced image output recipe is inconsistent.');
    return [...plan.outputs].sort((a, b) => a.role === b.role ? 0 : a.role === 'base' ? -1 : 1);
  }
  private controlOutput(job: Pick<GenerationJob, 'id' | 'draft'>, context: ExecutionContext): ControlMapOutput | undefined {
    const output = context.controlNet?.plan.controlMap; if (!output) return undefined;
    if (output.role !== 'control-map' || output.kind !== context.controlNet?.plan.settings.kind || output.batchSize !== 1 || output.width !== job.draft.width || output.height !== job.draft.height || output.width * output.height > 4 * 1024 * 1024 || output.filenamePrefix !== `Latent_${job.id}_control_${output.kind}` || context.workflow[output.nodeId]?.class_type !== 'SaveImage' || context.workflow[output.nodeId]?.inputs.filename_prefix !== output.filenamePrefix || this.outputs(job, context).some(generation => generation.nodeId === output.nodeId)) throw new Error('The saved control-map output recipe is inconsistent.');
    return output;
  }
  private controlFilename(output: ControlMapOutput, filename: string) { return new RegExp(`^${output.filenamePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}_\\d{5,}_\\.png$`).test(path.basename(filename)); }
  private async inspectControlMap(output: ControlMapOutput, filename: string) {
    if (!this.controlFilename(output, filename)) throw new Error('The engine returned an unexpected control-map filename.');
    const normalized = filename.replaceAll('\\', '/'); const full = containedPath(this.paths.outputs, filename); const real = await fs.realpath(full);
    if (!inside(await fs.realpath(this.paths.outputs), real)) throw new Error('The control map resolves outside this studio.');
    for (let current = full; ; current = path.dirname(current)) { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Control-map paths cannot use symbolic links or junctions.'); if (current === path.resolve(this.paths.outputs)) break; }
    const stat = await fs.stat(full); if (stat.size > 64 * 1024 * 1024) throw new Error('The control map exceeds its supported file size.');
    const bytes = await fs.readFile(full);
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== output.width || bytes.readUInt32BE(20) !== output.height) throw new Error('The control map is incomplete or has unexpected dimensions.');
    PNG.sync.read(bytes, { checkCRC: true }); const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { full, normalized, sha256, bytes: bytes.length };
  }
  private async recordControlMap(job: GenerationJob, context: ExecutionContext, filename: string) {
    const output = this.controlOutput(job, context); if (!output || !context.controlNet) throw new Error('No control-map output was requested.');
    const { normalized, sha256, bytes } = await this.inspectControlMap(output, filename);
    if (context.controlNet.map && (context.controlNet.map.filename !== normalized || context.controlNet.map.sha256 !== sha256)) throw new Error('The retained control map changed or an additional map was returned.');
    context.controlNet.map = { filename: normalized, sha256, bytes, width: output.width, height: output.height, nodeId: output.nodeId }; this.saveContext(job.id, context);
  }
  private async linkControlMap(job: GenerationJob, context: ExecutionContext) {
    if (!context.controlNet?.map) return;
    for (const record of this.store.records().filter(record => record.jobId === job.id && job.outputIds.includes(record.id))) {
      if (record.controlNet?.map?.sha256 === context.controlNet.map.sha256 && record.controlNet.map.filename === context.controlNet.map.filename) continue;
      const linked = { ...record, controlNet: structuredClone(context.controlNet) }; await this.saveRecordFile(linked, containedPath(this.paths.outputs, record.filename)); this.store.saveRecord(linked);
    }
  }
  private outputIdentity(output: JobOutput, filename: string): { batchIndex?: number } | null {
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parts = output.filenamePrefix.split('%batch_num%'); if (parts.length > 2) return null;
    const match = new RegExp(`^${parts.map(escape).join('(\\d+)')}_\\d{5,}_\\.png$`).exec(path.basename(filename));
    if (!match) return null; if (parts.length === 1) return {};
    const batchIndex = Number(match[1]); return Number.isSafeInteger(batchIndex) && batchIndex >= 0 && batchIndex < output.batchSize ? { batchIndex } : null;
  }
  private async linkBaseRecords(job: GenerationJob, context: ExecutionContext) {
    await this.linkFaceRecords(job, context);
    if (!context.advancedImage?.outputs.some(output => output.role === 'base')) return;
    const records = this.store.records().filter(record => record.jobId === job.id && job.outputIds.includes(record.id));
    for (const final of records.filter(record => record.outputRole === 'final')) {
      const base = records.find(record => record.outputRole === 'base' && record.outputBatchIndex === final.outputBatchIndex);
      if (!base || final.baseRecordId === base.id) continue;
      const linked = { ...final, baseRecordId: base.id }; await this.saveRecordFile(linked, containedPath(this.paths.outputs, final.filename)); this.store.saveRecord(linked);
    }
  }
  private async linkFaceRecords(job: GenerationJob, context: ExecutionContext) {
    if (!context.faceDetailer) return;
    const records = this.store.records().filter(record => record.jobId === job.id && job.outputIds.includes(record.id));
    for (const record of records) {
      if (!record.facePass || record.facePass.index === 0) continue;
      const parent = records.find(item => item.facePass?.index === record.facePass!.index - 1);
      if (!parent || record.facePass.parentRecordId === parent.id) continue;
      const linked = { ...record, facePass: { ...record.facePass, parentRecordId: parent.id } };
      await this.saveRecordFile(linked, containedPath(this.paths.outputs, linked.filename)); this.store.saveRecord(linked);
    }
  }
  private async verifyFacePixels(context: ExecutionContext, output: FaceRefinementOutput, result: PNG) {
    const recipe = context.faceDetailer!; const source = await this.sources.resolve(recipe.source.id);
    const originalBytes = await fs.readFile(source.normalizedPath);
    if (source.source.normalized.sha256 !== recipe.plan.source.sha256 || createHash('sha256').update(originalBytes).digest('hex') !== recipe.plan.source.sha256) throw new Error('The original face source changed before output recovery.');
    const original = PNG.sync.read(originalBytes, { checkCRC: true });
    const union = new Uint8Array(original.width * original.height);
    for (const pass of recipe.plan.passes.slice(0, output.passIndex + 1)) {
      if (pass.crop.settings.denoise === 0) continue;
      const mask = await this.sources.resolveMask(pass.crop.mask.id);
      if (mask.mask.sha256 !== pass.crop.mask.sha256 || mask.mask.sourceId !== recipe.source.id || mask.mask.sourceSha256 !== recipe.plan.source.sha256) throw new Error('A face mask changed before output recovery.');
      const decoded = await this.decodeVerifiedMask(mask);
      for (let pixel = 0; pixel < union.length; pixel++) if (decoded.data[pixel * 4] > 0) union[pixel] = 1;
    }
    for (let pixel = 0; pixel < union.length; pixel++) {
      const i = pixel * 4;
      if (result.data[i + 3] !== original.data[i + 3] || !union[pixel] && (result.data[i] !== original.data[i] || result.data[i + 1] !== original.data[i + 1] || result.data[i + 2] !== original.data[i + 2])) throw new Error('The face result changed original alpha or pixels outside its completed masks. Its file is retained for inspection, but the result failed validation.');
    }
  }
  private async saveRecordFile(record: GenerationRecord, full: string) {
    const sidecar = `${full}.latent.json`; const staging = `${sidecar}.tmp`;
    await fs.writeFile(staging, JSON.stringify(record, null, 2)); await fs.rename(staging, sidecar);
  }
  private async preserveCropOutput(context: ExecutionContext, result: PNG, bytes: Buffer, full: string) {
    const plan = context.cropInpaint!;
    const source = await this.sources.resolve(plan.source.id);
    const originalBytes = await fs.readFile(source.normalizedPath);
    if (source.source.normalized.sha256 !== plan.source.sha256 || createHash('sha256').update(originalBytes).digest('hex') !== plan.source.sha256) throw new Error('The original crop source changed before output recovery.');
    const mask = await this.sources.resolveMask(plan.mask.id);
    if (mask.mask.sha256 !== plan.mask.sha256 || mask.mask.sourceId !== plan.source.id || mask.mask.sourceSha256 !== plan.source.sha256) throw new Error('The crop mask changed before output recovery.');
    const corrected = preserveCropPixels(result, PNG.sync.read(originalBytes, { checkCRC: true }), await this.decodeVerifiedMask(mask), plan.settings.denoise);
    if (!corrected) return;
    const encoded = encodePreservedCrop(bytes, result, corrected, plan.source.sha256);
    const staging = `${full}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(staging, encoded, { flag: 'wx' });
      if (!(await fs.readFile(full)).equals(bytes) || (await fs.lstat(full)).isSymbolicLink()) throw new Error('The crop output changed during alpha restoration.');
      await fs.rename(staging, full);
    } finally { await fs.rm(staging, { force: true }); }
  }
  private async record(job: GenerationJob, context: ExecutionContext, filename: string, output: JobOutput) {
    const normalized = filename.replaceAll('\\', '/');
    const identity = this.outputIdentity(output, filename); if (!identity) throw new Error('The engine returned an unexpected output filename or batch index.');
    const full = containedPath(this.paths.outputs, filename); const real = await fs.realpath(full);
    if (!inside(await fs.realpath(this.paths.outputs), real) || (await fs.lstat(full)).isSymbolicLink()) throw new Error('The output resolves outside this studio.');
    const stat = await fs.stat(full);
    if (stat.size > 100 * 1024 * 1024) throw new Error('The output exceeds the supported image file size.');
    const bytes = await fs.readFile(full);
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== output.width || bytes.readUInt32BE(20) !== output.height) throw new Error('The output image is incomplete or has unexpected dimensions.');
    const decoded = PNG.sync.read(bytes, { checkCRC: true });
    if (context.faceDetailer) await this.verifyFacePixels(context, output as FaceRefinementOutput, decoded);
    const id = createHash('sha256').update(`${job.id}:${normalized}`).digest('hex').slice(0, 32);
    if (job.outputIds.includes(id)) return;
    const previous = this.store.records().filter(record => record.jobId === job.id && job.outputIds.includes(record.id) && (record.outputNodeId ?? '7') === output.nodeId);
    if (previous.length >= output.batchSize || identity.batchIndex !== undefined && previous.some(record => record.outputBatchIndex === identity.batchIndex)) throw new Error('The engine returned duplicate images for a single output batch position.');
    if (context.cropInpaint) await this.preserveCropOutput(context, decoded, bytes, full);
    const faceOutput = context.faceDetailer ? output as FaceRefinementOutput : undefined;
    const record: GenerationRecord = { faceDetailer: context.faceDetailer, facePass: faceOutput ? { index: faceOutput.passIndex, faceId: faceOutput.faceId, seed: faceOutput.seed, parentOutputNodeId: context.faceDetailer!.outputs[faceOutput.passIndex - 1]?.nodeId, parentRecordId: faceOutput.passIndex === 0 ? context.faceDetailer!.source.originGenerationId : undefined } : undefined, ipAdapter: context.ipAdapter, ipAdapterSource: context.ipAdapterSource, regionalPrompts: context.regionalPrompts, qwenEdit: context.qwenEdit, cropInpaint: context.cropInpaint, runtimeIdentity: context.runtimeIdentity, controlNet: context.controlNet, advancedImage: context.advancedImage, outputRole: context.advancedImage || context.qwenEdit || context.faceDetailer ? output.role : undefined, outputNodeId: context.advancedImage || context.qwenEdit || context.faceDetailer ? output.nodeId : undefined, outputBatchIndex: identity.batchIndex, dynamicPromptRecipe: context.dynamicPromptRecipe, imageInput: context.imageInput, id, jobId: job.id, createdAt: stat.mtime.toISOString(), filename: normalized, imageUrl: `latent-asset://output/${id}`, draft: structuredClone(job.draft), actualSeed: job.actualSeed, resolvedPrompt: context.resolvedPrompt, width: decoded.width, height: decoded.height, checkpoint: context.checkpoint, loras: context.loras, workflow: context.workflow, workflowVersion: context.workflowVersion ?? WORKFLOW_VERSION, backendVersion: context.backendVersion, appVersion: context.appVersion, durationMs: Math.max(0, stat.mtimeMs - (context.startedAt ?? Date.parse(job.createdAt))) };
    await this.saveRecordFile(record, full);
    this.store.saveRecord(record); job.outputIds.push(id); this.save(job);
  }
  async dispose() {
    this.disposed = true; if (this.timer) clearInterval(this.timer); this.socket?.terminate(); this.shutdown.abort();
    if (this.polling) await new Promise<void>(resolve => this.drainWaiters.push(resolve));
  }
}

import { z } from 'zod';
import type { ComfyWorkflow, GenerationDraft } from './types';
import type { AdvancedImageOutput, AdvancedImagePlan, AdvancedSamplingPass, HiresFixSettings, ReviewedUpscalerAsset, UpscaleWorkflowInput } from './advanced-image-types';
import { draftSchema } from './validation';
import { SAMPLERS, SCHEDULERS } from './defaults';

const UPSCALER_SHA = 'f872d837d3c90ed2e05227bed711af5671a6fd1c9f7d7e91c911a61f155e99da';
const pixelDimension = z.number().int().min(1).max(4096);
const seed = z.string().regex(/^(random|\d+)$/).refine(value => value === 'random' || BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), 'Seed exceeds the supported integer range.');
const settingsSchema = z.object({ mode: z.enum(['resize', 'learned']), width: pixelDimension, height: pixelDimension, resize: z.enum(['stretch', 'center-crop']) }).strict();
export type LatentHiresWorkflowVersion = 'sdxl-hires-latent@1' | 'sdxl-hires-latent@2';
const latentHiresVersion = z.enum(['sdxl-hires-latent@1', 'sdxl-hires-latent@2']);
const hiresSchema = z.object({ workflowVersion: latentHiresVersion.optional(), method: z.enum(['latent', 'image']), interpolation: z.enum(['nearest-exact', 'bilinear', 'area', 'bicubic']).optional(), width: pixelDimension.min(64).multipleOf(8), height: pixelDimension.min(64).multipleOf(8), steps: z.number().int().min(1).max(100), cfg: z.number().finite().min(0).max(30), sampler: z.string().refine(value => SAMPLERS.includes(value)), scheduler: z.string().refine(value => SCHEDULERS.includes(value)), denoise: z.number().finite().min(0).max(1), seed }).strict();
export function restoreHiresSettings(settings: HiresFixSettings, recordedVersion: string): HiresFixSettings {
  if (settings.method === 'latent') {
    const version = latentHiresVersion.parse(recordedVersion);
    if (settings.workflowVersion && settings.workflowVersion !== version) throw new Error('The saved hires version differs from its frozen recipe.');
    return { ...structuredClone(settings), workflowVersion: version };
  }
  if (recordedVersion !== 'sdxl-hires-image@1' || settings.workflowVersion !== undefined) throw new Error('The saved hires method and workflow version differ.');
  return structuredClone(settings);
}
/** A deliberate edit to hires settings chooses the current authored workflow. */
export function editHiresSettings(settings: HiresFixSettings, change: Partial<HiresFixSettings>): HiresFixSettings {
  return { ...structuredClone(settings), ...change, workflowVersion: undefined };
}
/** Scale both axes together; rounding down to latent pixels keeps the area within budget. */
export function suggestedHiresDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1.5, Math.sqrt(4 * 1024 * 1024 / (width * height)), 4096 / Math.max(width, height));
  return { width: Math.floor(width * scale / 8) * 8, height: Math.floor(height * scale / 8) * 8 };
}
/** Start at 2x where possible without stretching sources that meet the output side limit. */
export function suggestedUpscaleDimensions(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(2, 4096 / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
/** The learned model creates a 4x intermediate before resizing to the requested output. */
export function learnedUpscaleSourceError(width: number, height: number): string | undefined {
  if (width * height > 1024 * 1024 || Math.max(width, height) > 2048) return 'Learned enhancement supports sources up to 1 megapixel and 2048 pixels per side; its intermediate image is four times wider and taller. Choose a smaller source or use simple resize.';
}
function filename(value: string) {
  if (typeof value !== 'string' || value.length > 512 || !/\.(png|jpe?g|webp)$/i.test(value) || value.split('/').some(segment => !/^[a-z0-9][a-z0-9_. -]{0,239}$/i.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error('Use a verified relative source image inside studio inputs.');
  return value;
}
function resolvedSeed(value: string) { if (typeof value !== 'string' || !/^\d+$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Resolve and save the sampling seed before compiling this workflow.'); return BigInt(value).toString(); }
function allocator(graph: ComfyWorkflow) {
  let next = Math.max(7, ...Object.keys(graph).filter(id => /^\d+$/.test(id)).map(Number)) + 1;
  if (!Number.isSafeInteger(next)) throw new Error('Workflow node identifiers are invalid.');
  return (class_type: string, inputs: ComfyWorkflow[string]['inputs']) => { while (graph[String(next)]) next += 1; const id = String(next++); graph[id] = { class_type, inputs }; return id; };
}
function plan(workflow: ComfyWorkflow, workflowVersion: string, outputs: AdvancedImageOutput[], passes: AdvancedSamplingPass[], extras: Partial<AdvancedImagePlan> = {}): AdvancedImagePlan {
  const actual = Object.entries(workflow).filter(([, node]) => node.class_type === 'SaveImage').map(([id]) => id).sort();
  if (JSON.stringify(actual) !== JSON.stringify(outputs.map(output => output.nodeId).sort()) || new Set(outputs.map(output => output.nodeId)).size !== outputs.length) throw new Error('Every saved image requires exactly one output descriptor.');
  return { workflow, workflowVersion, outputs, passes, expectedOutputCount: outputs.reduce((sum, output) => sum + output.batchSize, 0), ...extras };
}

/** A model-free resize is distinct from learned enhancement followed by explicit target resizing. */
export function buildUpscaleWorkflow(input: UpscaleWorkflowInput, asset?: ReviewedUpscalerAsset): AdvancedImagePlan {
  const settings = settingsSchema.parse(input.settings); const sourceFilename = filename(input.sourceFilename);
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(input.jobId)) throw new Error('Invalid upscale job identity.');
  if (!Number.isSafeInteger(input.sourceWidth) || !Number.isSafeInteger(input.sourceHeight) || input.sourceWidth < 1 || input.sourceHeight < 1 || Math.max(input.sourceWidth, input.sourceHeight) > 8192 || input.sourceWidth * input.sourceHeight > 32 * 1024 * 1024) throw new Error('Invalid normalized source dimensions.');
  const graph: ComfyWorkflow = { '1': { class_type: 'LoadImage', inputs: { image: sourceFilename } } };
  let image: [string, number] = ['1', 0];
  if (settings.mode === 'learned') {
    if (!asset || asset.id !== 'realesrgan-anime-6b-x4' || asset.filename !== 'RealESRGAN_x4plus_anime_6B.pth' || asset.sha256 !== UPSCALER_SHA || asset.status !== 'ready' || asset.loaderPolicy !== 'pinned-publisher-weights-only' || asset.scale !== 4 || asset.architecture !== 'ESRGAN') throw new Error('Verify the reviewed Real-ESRGAN upscaler before compiling learned enhancement.');
    const sourceError = learnedUpscaleSourceError(input.sourceWidth, input.sourceHeight);
    if (sourceError) throw new Error(sourceError);
    graph['2'] = { class_type: 'UpscaleModelLoader', inputs: { model_name: asset.filename } };
    graph['3'] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image } }; image = ['3', 0];
  }
  graph['4'] = { class_type: 'ImageScale', inputs: { image, upscale_method: 'lanczos', width: settings.width, height: settings.height, crop: settings.resize === 'center-crop' ? 'center' : 'disabled' } };
  const prefix = `Latent_${input.jobId}_final_%batch_num%`;
  graph['7'] = { class_type: 'SaveImage', inputs: { images: ['4', 0], filename_prefix: prefix } };
  return plan(graph, settings.mode === 'resize' ? 'image-resize@1' : 'image-realesrgan-anime-6b@1', [{ nodeId: '7', role: 'final', width: settings.width, height: settings.height, batchSize: 1, filenamePrefix: prefix }], [], settings.mode === 'learned' ? { upscaler: structuredClone(asset!) } : {});
}

/** Preserves the base SaveImage output and adds an independently seeded second pass. */
export function augmentHiresWorkflow(workflow: ComfyWorkflow, draft: GenerationDraft, requested: HiresFixSettings, resolvedSecondSeed: string, frozenWorkflowVersion?: LatentHiresWorkflowVersion): AdvancedImagePlan {
  draftSchema.parse(draft); const settings = hiresSchema.parse(requested); const secondSeed = resolvedSeed(resolvedSecondSeed);
  if (frozenWorkflowVersion !== undefined) latentHiresVersion.parse(frozenWorkflowVersion);
  if (settings.method === 'image' && (settings.workflowVersion !== undefined || frozenWorkflowVersion !== undefined)) throw new Error('A latent hires workflow version cannot be used for image refinement.');
  if (settings.workflowVersion && frozenWorkflowVersion && settings.workflowVersion !== frozenWorkflowVersion) throw new Error('The saved hires workflow version differs from its requested version.');
  const workflowVersion = settings.method === 'latent' ? frozenWorkflowVersion ?? settings.workflowVersion ?? 'sdxl-hires-latent@2' : 'sdxl-hires-image@1';
  if (settings.seed !== 'random' && resolvedSeed(settings.seed) !== secondSeed) throw new Error('The resolved second seed differs from the requested seed.');
  if (draft.imageInput?.mode === 'inpaint' || Object.values(workflow).some(node => node.class_type === 'VAEEncodeForInpaint' || node.class_type === 'ImageCompositeMasked')) throw new Error('Hires fix with masked inpainting is not yet a tested combination. Disable one of these modes.');
  if (settings.width < draft.width || settings.height < draft.height || settings.width * settings.height <= draft.width * draft.height || settings.width * settings.height > 4 * 1024 * 1024) throw new Error('Hires dimensions must enlarge the base image and stay within the initial 4 megapixel bound.');
  if (workflow['5']?.class_type !== 'KSampler' || workflow['6']?.class_type !== 'VAEDecode' || workflow['7']?.class_type !== 'SaveImage' || Object.values(workflow).filter(node => node.class_type === 'SaveImage').length !== 1) throw new Error('Hires fix requires the base sampler, decoder, and a single base SaveImage at node 7.');
  const graph = structuredClone(workflow); const add = allocator(graph);
  const baseImage = graph['7'].inputs.images;
  if (!Array.isArray(baseImage) || typeof baseImage[0] !== 'string' || !graph[baseImage[0]]) throw new Error('The base image output is missing.');
  const rawPrefix = graph['7'].inputs.filename_prefix;
  if (typeof rawPrefix !== 'string' || !/^Latent_[a-zA-Z0-9-]{1,80}$/.test(rawPrefix)) throw new Error('The base workflow must use its own Latent job output prefix.');
  const basePrefix = `${rawPrefix}_base_%batch_num%`; const finalPrefix = `${rawPrefix}_final_%batch_num%`; graph['7'].inputs.filename_prefix = basePrefix;
  const baseInputs = graph['5'].inputs;
  if (typeof baseInputs.seed !== 'number' || !Number.isSafeInteger(baseInputs.seed) || baseInputs.seed < 0) throw new Error('The base sampler has no valid resolved seed.');
  for (const link of [baseInputs.model, baseInputs.positive, baseInputs.negative, graph['6'].inputs.vae]) if (!Array.isArray(link) || typeof link[0] !== 'string' || !graph[link[0]] || !Number.isInteger(link[1]) || link[1] < 0) throw new Error('The base workflow has an invalid model, conditioning, or VAE link.');
  const baseSettings = hiresSchema.omit({ method: true, width: true, height: true, seed: true }).parse({ steps: baseInputs.steps, cfg: baseInputs.cfg, sampler: baseInputs.sampler_name, scheduler: baseInputs.scheduler, denoise: baseInputs.denoise });
  const basePass: AdvancedSamplingPass = { role: 'base', nodeId: '5', enabled: baseSettings.denoise > 0, width: draft.width, height: draft.height, seed: String(baseInputs.seed), ...baseSettings };
  let finalImage: [string, number]; let refineNode: string | null = null;
  if (settings.denoise === 0) {
    // Zero refinement strength means a direct resize of the retained base pixels, for either method.
    const resized = add('ImageScale', { image: ['7', 0], upscale_method: settings.interpolation ?? 'lanczos', width: settings.width, height: settings.height, crop: 'disabled' }); finalImage = [resized, 0];
  } else {
    let latent: [string, number];
    if (settings.method === 'latent') {
      let originalLatent: [string, number] = ['5', 0];
      if (workflowVersion === 'sdxl-hires-latent@2') {
        // Pinned SaveImage returns IMAGE only after writing every base PNG.
        // Its observed batch length gates an exact full-batch latent slice;
        // refinement keeps latent values and does not re-encode saved pixels.
        const size = add('GetImageSize', { image: ['7', 0] });
        const retained = add('LatentFromBatch', { samples: originalLatent, batch_index: 0, length: [size, 2] });
        originalLatent = [retained, 0];
      }
      const resized = add('LatentUpscale', { samples: originalLatent, upscale_method: settings.interpolation ?? 'bislerp', width: settings.width, height: settings.height, crop: 'disabled' }); latent = [resized, 0];
    } else {
      const resized = add('ImageScale', { image: ['7', 0], upscale_method: settings.interpolation ?? 'lanczos', width: settings.width, height: settings.height, crop: 'disabled' });
      const encoded = add('VAEEncode', { pixels: [resized, 0], vae: graph['6'].inputs.vae }); latent = [encoded, 0];
    }
    refineNode = add('KSampler', { model: baseInputs.model, positive: baseInputs.positive, negative: baseInputs.negative, latent_image: latent, seed: Number(secondSeed), steps: settings.steps, cfg: settings.cfg, sampler_name: settings.sampler, scheduler: settings.scheduler, denoise: settings.denoise });
    const decoded = add('VAEDecode', { samples: [refineNode, 0], vae: graph['6'].inputs.vae }); finalImage = [decoded, 0];
  }
  const finalNode = add('SaveImage', { images: finalImage, filename_prefix: finalPrefix });
  const outputs: AdvancedImageOutput[] = [{ nodeId: '7', role: 'base', width: draft.width, height: draft.height, batchSize: draft.batchSize, filenamePrefix: basePrefix }, { nodeId: finalNode, role: 'final', width: settings.width, height: settings.height, batchSize: draft.batchSize, filenamePrefix: finalPrefix }];
  const refinePass: AdvancedSamplingPass = { role: 'refine', nodeId: refineNode, enabled: settings.denoise > 0, width: settings.width, height: settings.height, seed: secondSeed, steps: settings.steps, cfg: settings.cfg, sampler: settings.sampler, scheduler: settings.scheduler, denoise: settings.denoise };
  return plan(graph, workflowVersion, outputs, [basePass, refinePass], { hires: { ...settings, seed: secondSeed } });
}

/** Validate the pinned dependency ABI before promising save-before-refine. */
export function validateHiresCapabilities(objects: Record<string, any>, value: AdvancedImagePlan) {
  if (!['sdxl-hires-latent@1', 'sdxl-hires-latent@2', 'sdxl-hires-image@1'].includes(value.workflowVersion)) throw new Error('The saved hires workflow version is unsupported.');
  if (value.workflowVersion === 'sdxl-hires-latent@1' && value.hires?.denoise !== 0) return; // Explicit historical replay has no durability claim.
  if (objects.SaveImage?.output?.[0] !== 'IMAGE' || objects.SaveImage?.output_node !== true) throw new Error('The engine cannot guarantee saving base images before refinement. Restore the reviewed SaveImage interface.');
  if (value.workflowVersion !== 'sdxl-hires-latent@2' || value.hires?.denoise === 0) return;
  const required: Record<string, Record<string, string>> = { GetImageSize: { image: 'IMAGE' }, LatentFromBatch: { samples: 'LATENT', batch_index: 'INT', length: 'INT' } };
  for (const [name, inputs] of Object.entries(required)) for (const [input, kind] of Object.entries(inputs)) if (objects[name]?.input?.required?.[input]?.[0] !== kind) throw new Error(`The engine changed the required latent hires input ${name}.${input}.`);
  if (JSON.stringify(objects.GetImageSize?.output) !== JSON.stringify(['INT', 'INT', 'INT']) || JSON.stringify(objects.LatentFromBatch?.output) !== JSON.stringify(['LATENT'])) throw new Error('The engine changed the required latent hires batch outputs.');
}

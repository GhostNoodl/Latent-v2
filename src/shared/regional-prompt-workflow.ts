import type { ComfyWorkflow, GenerationDraft } from './types';
import { draftSchema } from './validation';
import { activeRegionalPromptRegions, REGIONAL_PROMPT_LIMITS, regionalMaskAssetSchema, regionalPromptPlanSchema, regionalPromptRegionSchema, regionalPromptSettingsSchema, type RegionalMaskAsset, type RegionalPromptPlan, type RegionalPromptRegion, type RegionalPromptSettings, type RegionalPromptWorkflowResult } from './regional-prompt-types';

export interface RegionalCanvas { width: number; height: number; }
export interface RegionalMaskGeometry { pixelBounds: { x: number; y: number; width: number; height: number }; featherPixels: number; }
function canvas(value: RegionalCanvas) {
  if (![value.width, value.height].every(side => Number.isSafeInteger(side) && side >= 256 && side <= 2048 && side % 64 === 0) || value.width * value.height > REGIONAL_PROMPT_LIMITS.maxCanvasPixels) throw new Error('Regional prompting requires a 256–2048 canvas in multiples of 64, up to 4 megapixels.');
}
export function regionalMaskGeometry(region: RegionalPromptRegion, dimensions: RegionalCanvas): RegionalMaskGeometry {
  region = regionalPromptRegionSchema.parse(region); canvas(dimensions);
  const left = Math.floor(region.x * dimensions.width); const top = Math.floor(region.y * dimensions.height);
  const right = Math.min(dimensions.width, Math.ceil(Math.min(1, region.x + region.width) * dimensions.width)); const bottom = Math.min(dimensions.height, Math.ceil(Math.min(1, region.y + region.height) * dimensions.height));
  return { pixelBounds: { x: left, y: top, width: right - left, height: bottom - top }, featherPixels: Math.min(region.feather, Math.floor(Math.min(right - left, bottom - top) / 2)) };
}
/** Exact u8 mask: outward pixel bounds, inward minimum-edge-distance ramp. */
export function rasterizeRegionalMaskPixels(region: RegionalPromptRegion, dimensions: RegionalCanvas): RegionalMaskGeometry & { pixels: Uint8Array } {
  const geometry = regionalMaskGeometry(region, dimensions); const { pixelBounds: box, featherPixels: feather } = geometry;
  const pixels = new Uint8Array(dimensions.width * dimensions.height);
  for (let y = 0; y < box.height; y++) for (let x = 0; x < box.width; x++) {
    const distance = Math.min(x + 1, box.width - x, y + 1, box.height - y);
    pixels[(box.y + y) * dimensions.width + box.x + x] = feather === 0 ? 255 : Math.round(255 * Math.min(1, distance / feather));
  }
  return { ...geometry, pixels };
}
export async function regionalSha256(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer)), value => value.toString(16).padStart(2, '0')).join('');
}
export async function rasterizeRegionalMask(region: RegionalPromptRegion, dimensions: RegionalCanvas) {
  const result = rasterizeRegionalMaskPixels(region, dimensions);
  return { ...result, rawMaskSha256: await regionalSha256(result.pixels) };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  return JSON.stringify(value);
}
const linkEquals = (value: unknown, expected: [string, number]) => JSON.stringify(value) === JSON.stringify(expected);
function validateBase(workflow: ComfyWorkflow, draft: GenerationDraft): [string, number] {
  const expected: Record<string, string> = { '1': 'CheckpointLoaderSimple', '2': 'CLIPTextEncode', '3': 'CLIPTextEncode', '4': 'EmptyLatentImage', '5': 'KSampler', '6': 'VAEDecode', '7': 'SaveImage' };
  for (const [id, type] of Object.entries(expected)) if (workflow[id]?.class_type !== type) throw new Error('Regional prompting requires the baseline workflow at nodes 1–7.');
  for (const [id, node] of Object.entries(workflow)) if (!/^\d{1,6}$/.test(id) || !expected[id] && node.class_type !== 'LoraLoader') throw new Error('Regional prompting cannot yet combine with another advanced workflow.');
  for (const [actual, expectedLink] of [[workflow['5'].inputs.positive, ['2', 0]], [workflow['5'].inputs.negative, ['3', 0]], [workflow['5'].inputs.latent_image, ['4', 0]], [workflow['6'].inputs.samples, ['5', 0]], [workflow['6'].inputs.vae, ['1', 2]], [workflow['7'].inputs.images, ['6', 0]]] as Array<[unknown, [string, number]]>) if (!linkEquals(actual, expectedLink)) throw new Error('The baseline conditioning, latent or output links were changed.');
  if (workflow['4'].inputs.width !== draft.width || workflow['4'].inputs.height !== draft.height || workflow['4'].inputs.batch_size !== 1) throw new Error('The regional canvas differs from the base latent.');
  const clip = workflow['2'].inputs.clip;
  if (!Array.isArray(clip) || clip.length !== 2 || typeof clip[0] !== 'string' || clip[1] !== 1 || !linkEquals(workflow['3'].inputs.clip, clip as [string, number]) || !linkEquals(workflow['5'].inputs.model, [clip[0], 0])) throw new Error('Regions require the same post-LoRA CLIP and model chain as the global prompts.');
  let current = clip[0]; const visited = new Set<string>();
  while (current !== '1') {
    if (visited.has(current)) throw new Error('The regional model chain contains a cycle.'); visited.add(current);
    const node = workflow[current]; const previous = node?.inputs.clip;
    if (node?.class_type !== 'LoraLoader' || !Array.isArray(previous) || typeof previous[0] !== 'string' || previous[1] !== 1 || !linkEquals(node.inputs.model, [previous[0], 0])) throw new Error('The regional model chain is not a baseline LoRA chain.');
    current = previous[0];
  }
  if (Object.entries(workflow).some(([id, node]) => node.class_type === 'LoraLoader' && !visited.has(id))) throw new Error('The regional graph contains an unused or disconnected LoRA.');
  return [clip[0], 1];
}

/** Main provides only immutable mask PNGs it independently verified. */
export async function augmentRegionalPromptWorkflow(workflow: ComfyWorkflow, draft: GenerationDraft, input: RegionalPromptSettings, suppliedMasks: RegionalMaskAsset[], frozenPlan?: RegionalPromptPlan): Promise<RegionalPromptWorkflowResult> {
  draftSchema.parse(draft); const settings = regionalPromptSettingsSchema.parse(input); const dimensions = { width: draft.width, height: draft.height }; canvas(dimensions);
  if (!['sdxl', 'illustrious'].includes(draft.family) || draft.batchSize !== 1 || draft.imageInput || draft.hiresFix || draft.upscale || draft.controlNet) throw new Error('Initial regional prompting supports one baseline SDXL or Illustrious image without img2img, inpainting, hires, upscale or ControlNet.');
  const clip = validateBase(workflow, draft); const regions = activeRegionalPromptRegions(settings);
  if (settings.enabled && !regions.length) throw new Error('Enter a positive or negative prompt in at least one region with strength above zero, or turn regional prompting off.');
  const masks = suppliedMasks.map(asset => regionalMaskAssetSchema.parse(asset));
  if (masks.length !== regions.length || new Set(masks.map(asset => asset.regionId)).size !== masks.length) throw new Error('The saved masks do not match the active regional prompts.');
  const entries: RegionalPromptPlan['regions'] = [];
  for (const region of regions) {
    const mask = masks.find(asset => asset.regionId === region.id);
    if (!mask || mask.width !== dimensions.width || mask.height !== dimensions.height) throw new Error(`The saved mask for ${region.name} has different dimensions or is missing.`);
    const raster = await rasterizeRegionalMask(region, dimensions);
    if (raster.rawMaskSha256 !== mask.rawMaskSha256) throw new Error(`The saved mask for ${region.name} differs from its recorded rectangle or feather.`);
    entries.push({ regionId: region.id, pixelBounds: raster.pixelBounds, featherPixels: raster.featherPixels, mask });
  }
  const data = { version: 'sdxl-regional-conditioning@1' as const, canvas: dimensions, settings, regions: entries, maskPolicy: 'outward-pixels-inward-linear-u8@1' as const, promptPolicy: 'literal-regions-global-separate@1' as const, conditioningPolicy: 'ordered-mask-combine-default-area@1' as const, clip, applied: regions.length > 0 };
  const computed = regionalPromptPlanSchema.parse({ ...data, sha256: await regionalSha256(new TextEncoder().encode(canonical(data))) });
  const plan = frozenPlan ? regionalPromptPlanSchema.parse(frozenPlan) : computed;
  if (canonical(plan) !== canonical(computed)) throw new Error('The frozen regional recipe differs from its prompts, order, geometry, masks or model chain. Restore its original recipe or deliberately start a new layout.');
  const graph = structuredClone(workflow); let next = Math.max(...Object.keys(graph).map(Number)) + 1;
  const add = (class_type: string, inputs: ComfyWorkflow[string]['inputs']) => { const id = String(next++); graph[id] = { class_type, inputs }; return id; };
  const conditioning: Record<'positive' | 'negative', [string, number]> = { positive: ['2', 0], negative: ['3', 0] };
  for (let index = 0; index < regions.length; index++) {
    const region = regions[index]; const mask = add('LoadImageMask', { image: entries[index].mask.filename, channel: 'red' });
    for (const side of ['positive', 'negative'] as const) {
      const text = side === 'positive' ? region.positivePrompt : region.negativePrompt; if (!text.trim()) continue;
      const encoded = add('CLIPTextEncode', { text, clip: [...clip] });
      const masked = add('ConditioningSetMask', { conditioning: [encoded, 0], mask: [mask, 0], strength: region.strength, set_cond_area: 'default' });
      const combined = add('ConditioningCombine', { conditioning_1: conditioning[side], conditioning_2: [masked, 0] }); conditioning[side] = [combined, 0];
    }
  }
  if (regions.length) { graph['5'].inputs.positive = conditioning.positive; graph['5'].inputs.negative = conditioning.negative; }
  return { workflow: graph, workflowVersion: 'sdxl-regional-conditioning@1', plan: structuredClone(plan) };
}

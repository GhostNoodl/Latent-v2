import { z } from 'zod';
import { SAMPLERS, SCHEDULERS } from './defaults';
import { dynamicPromptAuthoringSchema } from './dynamic-prompt-recipe';
import { controlNetSettingsSchema } from './controlnet-types';
import { cropInpaintSettingsSchema, cropInpaintPlanSchema } from './crop-inpaint-types';
import { qwenEditJobRequestSchema } from './qwen-edit-types';
import { regionalPromptPlanSchema, regionalPromptSettingsSchema } from './regional-prompt-types';
import { ipAdapterPlanSchema, ipAdapterSettingsSchema } from './ipadapter-types';
import { faceRefinementRequestSchema, faceRefinementPlanSchema } from './face-detailer-types';
const advancedDimension = z.number().int().min(1).max(4096);
export const draftSchema = z.object({
  faceDetailer: z.object({ request: faceRefinementRequestSchema, frozen: faceRefinementPlanSchema.optional() }).strict().optional(),
  ipAdapter: z.object({ settings: ipAdapterSettingsSchema, frozen: ipAdapterPlanSchema.optional() }).strict().optional(),
  regionalPrompts: z.object({ settings: regionalPromptSettingsSchema, frozen: regionalPromptPlanSchema.optional() }).strict().optional(),
  qwenEdit: qwenEditJobRequestSchema.optional(),
  variationOfRecordId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  controlNet: controlNetSettingsSchema.optional(),
  dynamicPrompts: dynamicPromptAuthoringSchema.optional(),
  upscale: z.object({ mode: z.enum(['resize', 'learned']), width: advancedDimension, height: advancedDimension, resize: z.enum(['stretch', 'center-crop']) }).strict().optional(),
  hiresFix: z.object({ workflowVersion: z.enum(['sdxl-hires-latent@1', 'sdxl-hires-latent@2']).optional(), method: z.enum(['latent', 'image']), interpolation: z.enum(['nearest-exact', 'bilinear', 'area', 'bicubic']).optional(), width: advancedDimension.min(64).multipleOf(8), height: advancedDimension.min(64).multipleOf(8), steps: z.number().int().min(1).max(100), cfg: z.number().min(0).max(30), sampler: z.enum(SAMPLERS as [string, ...string[]]), scheduler: z.enum(SCHEDULERS as [string, ...string[]]), denoise: z.number().min(0).max(1), seed: z.string().refine(value => value === 'random' || (/^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER))) }).strict().refine(value => value.workflowVersion === undefined || value.method === 'latent', 'A latent hires version cannot be used for image refinement.').optional(),
  imageInput: z.object({ cropPlan: cropInpaintPlanSchema.optional(), crop: cropInpaintSettingsSchema.optional(), mode: z.enum(['img2img', 'inpaint']), sourceId: z.string().regex(/^src_[a-f0-9-]{36}$/), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), maskId: z.string().regex(/^mask_[a-f0-9-]{36}$/).optional(), maskSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), denoise: z.number().min(0).max(1), resize: z.enum(['stretch', 'center-crop']) }).strict().optional(),
  family: z.enum(['sdxl', 'illustrious']), checkpointId: z.string().max(500),
  prompt: z.string().max(16000), negativePrompt: z.string().max(16000),
  width: z.number().int().min(256).max(2048).multipleOf(64), height: z.number().int().min(256).max(2048).multipleOf(64),
  steps: z.number().int().min(1).max(100), cfg: z.number().min(0).max(30),
  sampler: z.enum(SAMPLERS as [string, ...string[]]), scheduler: z.enum(SCHEDULERS as [string, ...string[]]),
  seed: z.string().refine(value => value === 'random' || (/^\d+$/.test(value) && BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)), 'Use random or an integer seed between 0 and 9007199254740991.'),
  batchSize: z.number().int().min(1).max(4), autoTriggers: z.boolean(),
  triggerResolutionVersion: z.enum(['legacy@1', 'punctuation@2']).optional(),
  loras: z.array(z.object({ modelId: z.string().min(1).max(500), weight: z.number().min(-2).max(2), clipWeight: z.number().min(-2).max(2) }).strict()).max(8),
  triggerWords: z.record(z.string().max(500), z.array(z.string().max(200)).max(50)).refine(value => Object.keys(value).length <= 9).optional(),
  assetHashes: z.record(z.string().max(500), z.string().regex(/^[a-f0-9]{64}$/i)).refine(value => Object.keys(value).length <= 9).optional(),
}).strict();
export const settingsSchema = z.object({
  showGenerationPreview: z.boolean(),
  theme: z.enum(['system', 'dark', 'light']), accent: z.enum(['iris', 'sea-glass', 'rose']),
  rememberPositivePrompt: z.boolean(), rememberNegativePrompt: z.boolean(),
  civitaiAutoMetadata: z.boolean().default(false), civitaiDisplayMetadata: z.boolean().default(true), desktopNotifications: z.boolean().default(false), notifyGeneration: z.boolean(), notifyDownload: z.boolean(), notifyError: z.boolean(),
  backendAutoStart: z.boolean(), deviceMode: z.enum(['auto', 'lowvram', 'cpu']),
}).strict();
const httpsUrl = z.url().max(4000).refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }, 'Use an HTTPS URL without embedded credentials.');
export const downloadSchema = z.object({
  civitai: z.object({ creator: z.string().max(150).optional(), description: z.string().max(8000).optional(), trainedWords: z.array(z.string().max(200)).max(50).optional(), previewUrl: httpsUrl.refine(value => ['image.civitai.com','imagecache.civitai.com'].includes(new URL(value).hostname)).optional(), fetchedAt: z.iso.datetime().optional(), modelId: z.number().int().positive(), versionId: z.number().int().positive(), fileId: z.number().int().positive(), modelName: z.string().max(500), versionName: z.string().max(500), baseModel: z.string().max(100), sourceUrl: httpsUrl.refine(value => { const url = new URL(value); return url.origin === 'https://civitai.com' && /^\/models\/\d+$/.test(url.pathname) && [...url.searchParams.keys()].every(key => key === 'modelVersionId'); }), permissions: z.object({ allowNoCredit: z.boolean().nullable(), allowDerivatives: z.boolean().nullable(), allowDifferentLicense: z.boolean().nullable(), allowCommercialUse: z.array(z.string().max(100)).max(20).nullable() }).strict() }).strict().optional(),
  url: httpsUrl,
  filename: z.string().regex(/^[\w .()-]+\.safetensors$/i, 'Use a simple .safetensors filename.').max(180),
  kind: z.enum(['checkpoint', 'lora']), family: z.enum(['sdxl', 'illustrious']),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), triggers: z.array(z.string().min(1).max(200)).max(50).optional(),
  sourceUrl: httpsUrl.optional(), licenseUrl: httpsUrl.optional(),
  provenance: z.object({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200), revision: z.string().regex(/^[a-f0-9]{40}$/i), licenseName: z.string().trim().min(1).max(200), version: z.string().trim().min(1).max(100).optional(), baseModel: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200).optional() }).strict().optional(),
}).strict();

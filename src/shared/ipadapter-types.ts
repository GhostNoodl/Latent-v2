import { z } from 'zod';
import type { ComfyWorkflow } from './types';
import { IPADAPTER_RELEASE } from './ipadapter-release';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ipAdapterSettingsSchema = z.object({
  sourceId: z.string().regex(/^src_[a-f0-9-]{36}$/), sourceSha256: hash,
  mode: z.enum(['balanced', 'style', 'composition']), framing: z.enum(['center-crop', 'stretch']),
  weight: z.number().finite().min(0).max(1.5), startPercent: z.number().finite().min(0).max(1), endPercent: z.number().finite().min(0).max(1),
}).strict().refine(settings => settings.startPercent < settings.endPercent, 'Reference influence must start before it ends.');
export type IPAdapterSettings = z.infer<typeof ipAdapterSettingsSchema>;
const file = z.object({ filename: z.string().min(1).max(160), bytes: z.number().int().positive(), sha256: hash, url: z.string().url() }).strict();
const validation = z.object({ format: z.literal('safetensors'), architecture: z.enum(['ipadapter-plus-sdxl-vit-h', 'clip-vision-vit-h-14']), headerBytes: z.number().int().positive(), tensorCount: z.number().int().positive(), dtypes: z.array(z.string().max(16)).max(8), parameters: z.string().regex(/^\d{1,20}$/) }).strict();
const model = file.extend({ role: z.enum(['adapter', 'clip-vision']), directory: z.enum(['ipadapter', 'clip_vision']), validation }).strict();
export const ipAdapterBundleSchema = z.object({
  id: z.literal('ipadapter-plus-sdxl-vit-h-v1'), family: z.literal('sdxl'), validationScope: z.literal('file-integrity-only'),
  models: z.tuple([model, model]),
  code: z.object({ repository: z.literal('cubiq/ComfyUI_IPAdapter_plus'), revision: z.literal('a0f451a5113cf9becb0847b92884cb10cbdec0ef'), directory: z.literal('latent_ipadapter_plus'), license: z.literal('GPL-3.0'), files: z.array(file).length(9) }).strict(),
  provenance: z.object({ repository: z.literal('h94/IP-Adapter'), revision: z.literal('018e402774aeeddd60609b4ecdb7e298259dc729'), modelLicense: z.literal('Apache-2.0'), encoderOriginLicense: z.literal('MIT'), encoderOriginRevision: z.literal('1c2b8495b28150b8a4922ee1c8edee224c284c0c'), supportFiles: z.array(file).length(3) }).strict(),
  dependencies: z.object({ torch: z.string().min(1).max(80), torchvision: z.string().min(1).max(80), einops: z.string().min(1).max(80), Pillow: z.string().min(1).max(80), safetensors: z.string().min(1).max(80) }).strict(),
  verifiedAt: z.string().datetime(),
}).strict().superRefine((bundle, ctx) => {
  const fail = () => ctx.addIssue({ code: 'custom', message: 'IP Adapter metadata differs from the reviewed pinned bundle.' });
  const sameFile = (actual: z.infer<typeof file>, expected: { filename: string; bytes: number; sha256: string; url: string }) => actual.filename === expected.filename && actual.bytes === expected.bytes && actual.sha256 === expected.sha256 && actual.url === expected.url;
  bundle.models.forEach((actual, index) => { const expected = IPADAPTER_RELEASE.models[index]; if (!sameFile(actual, expected) || actual.role !== expected.role || actual.directory !== expected.directory || actual.validation.architecture !== (index === 0 ? 'ipadapter-plus-sdxl-vit-h' : 'clip-vision-vit-h-14') || actual.validation.headerBytes !== (index === 0 ? 19776 : 64184) || actual.validation.tensorCount !== (index === 0 ? 191 : 521) || actual.validation.parameters !== (index === 0 ? '423748864' : '632077057') || JSON.stringify(actual.validation.dtypes) !== JSON.stringify(index === 0 ? ['F16'] : ['F32', 'I64'])) fail(); });
  bundle.code.files.forEach((actual, index) => { if (!sameFile(actual, IPADAPTER_RELEASE.codeFiles[index])) fail(); });
  bundle.provenance.supportFiles.forEach((actual, index) => { if (!sameFile(actual, IPADAPTER_RELEASE.supportFiles[index])) fail(); });
  for (const [name, version] of Object.entries(IPADAPTER_RELEASE.runtimeTarget.dependencies)) if (bundle.dependencies[name as keyof typeof bundle.dependencies] !== version) fail();
});
export type ReviewedIPAdapterBundle = z.infer<typeof ipAdapterBundleSchema>;
export type IPAdapterModelValidation = z.infer<typeof validation>;
export interface IPAdapterStatus { state: 'not-installed' | 'staging' | 'staged' | 'activating' | 'ready' | 'error'; message: string; progress?: number; bundle?: ReviewedIPAdapterBundle; }
const sourceSide = z.number().int().min(1).max(8192);
export const ipAdapterPlanSchema = z.object({
  version: z.literal('sdxl-ipadapter-reference@1'), settings: ipAdapterSettingsSchema,
  source: z.object({ id: z.string().regex(/^src_[a-f0-9-]{36}$/), sha256: hash, name: z.string().max(240), width: sourceSide, height: sourceSide }).strict(),
  assets: ipAdapterBundleSchema,
  preprocessing: z.object({ version: z.literal('explicit-square-then-upstream-clip224@1'), sourceRectangle: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), width: sourceSide, height: sourceSide }).strict(), cropNode: z.enum(['ImageCrop', 'none']), explicitResize: z.enum(['none', 'bicubic-224-stretch']), upstream: z.literal('clip_preprocess-bicubic-antialias-round-u8-normalize'), encoderSize: z.literal(224), alpha: z.literal('RGB-encoder-ignores-alpha') }).strict(),
  conditioning: z.object({ weightType: z.enum(['linear', 'style transfer', 'composition']), combineEmbeds: z.literal('concat'), embedsScaling: z.literal('V only'), inputModel: z.tuple([z.string().regex(/^\d{1,6}$/), z.literal(0)]) }).strict(),
  samplerNodeId: z.literal('5'), applied: z.boolean(), adapterNodeId: z.string().regex(/^\d{1,6}$/).optional(),
}).strict();
export type IPAdapterPlan = z.infer<typeof ipAdapterPlanSchema>;
export interface IPAdapterWorkflowResult { workflow: ComfyWorkflow; workflowVersion: 'sdxl-ipadapter-reference@1'; plan: IPAdapterPlan; }

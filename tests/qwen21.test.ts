import { expect, it } from 'vitest';
import { buildQwenEditWorkflow, validateQwenEditBundle } from '../src/shared/qwen-edit-workflow';
import { QWEN21_RUNTIME } from '../src/shared/qwen21-release';
import { QWEN21_ASSETS, selectedQwenAssets, qwenEditAssetPath } from '../src/main/qwen-edit-assets';
import { qwenEditSettingsSchema, type QwenEditBundle, type QwenEditWorkflowInput } from '../src/shared/qwen-edit-types';
import { qwenConversationSchema, createQwenConversationDraft } from '../src/shared/qwen-conversation';
import { qwenReplayDraft } from '../src/renderer/QwenEditor';
import { latestReviewedRuntimeSet, reviewedRuntimeSet } from '../src/main/reviewed-runtime-channel';
import type { GenerationRecord, AppPaths } from '../src/shared/types';
import type { SourceImageAsset } from '../src/shared/source-types';
import { JobService } from '../src/main/jobs';
import path from 'node:path';

export const bundle: QwenEditBundle = {
  id: 'qwen-image-2.1-int8', profile: 'qwen21', runtime: { ...QWEN21_RUNTIME, customNodes: [] }, totalBytes: 17283091112, verifiedAt: '2026-09-21T00:00:00.000Z',
  assets: Object.fromEntries(QWEN21_ASSETS.map(pin => [pin.role, { ...pin, filename: `qwen-image-2.1/${pin.filename}`, format: 'safetensors', status: 'ready' }])) as unknown as QwenEditBundle['assets'],
};
const source = { id: 'src_11111111-1111-1111-1111-111111111111', normalized: { sha256: 'a'.repeat(64), width: 1664, height: 2432, mimeType: 'image/png' } } as SourceImageAsset;
const input: QwenEditWorkflowInput = { source, sourceFilename: `source-images/${source.id}/image.png`, instruction: 'Smile without changing the scars.', jobId: 'qwen21-test', settings: { profile: 'qwen21', width: 704, height: 1024, seed: '17092026', resize: 'stretch' } };

it('uses 2.1 conditioning, fresh noise and its own VAE without a Lightning adapter', () => {
  const plan = buildQwenEditWorkflow(input, bundle);
  expect(plan.workflowVersion).toBe('qwen-image-2.1@1');
  expect(plan.settings).toMatchObject({ steps: 25, guidance: 1 });
  expect(plan.workflow['8'].inputs['images.image_1']).toEqual(['5',0]);
  expect(plan.workflow['15'].inputs.latent_image).toEqual(['8',2]);
  expect(Object.values(plan.workflow).some(node => node.class_type === 'LoraLoaderModelOnly')).toBe(false);
  expect(plan.canvas?.inference).toEqual({ width: 832, height: 1216 });
});
it('creates transparent rectangular images without inventing a source or parent', () => {
  const plan = buildQwenEditWorkflow({ ...input, source: undefined, sourceFilename: undefined, operation: 'create', transparent: true }, bundle);
  expect(plan.source).toBeUndefined(); expect(plan.workflow['4']).toBeUndefined();
  expect(plan.workflow['6'].inputs).toMatchObject({ samples: ['8',2], width: 416, height: 608 });
  expect(plan.workflow['8'].inputs.prompt).toContain('alpha channel');
  expect(plan.instruction).toBe(input.instruction);
  expect(plan.output).toMatchObject({ width: 704, height: 1024 });
});
it('retains the second reference identity and bounds its conditioning size', () => {
  const plan = buildQwenEditWorkflow({ ...input, references: [{ source, filename: input.sourceFilename! }] }, bundle);
  expect(plan.workflow['8'].inputs['images.image_2']).toEqual(['21',0]);
  expect(plan.references?.[0].source.normalized.sha256).toBe(source.normalized.sha256);
  expect(Number(plan.workflow['21'].inputs.width) * Number(plan.workflow['21'].inputs.height)).toBeLessThan(1100000);
});
it('rejects route, model and operation mismatches before submitting', () => {
  expect(() => buildQwenEditWorkflow({ ...input, workflowVersion: 'qwen-image-edit-2511-int8@2' }, bundle)).toThrow();
  expect(() => buildQwenEditWorkflow({ ...input, source: undefined }, bundle)).toThrow();
  expect(() => buildQwenEditWorkflow({ ...input, operation: 'create' }, bundle)).toThrow();
  expect(() => buildQwenEditWorkflow({ ...input, settings: { ...input.settings, guidance: 4 } }, bundle)).toThrow();
  const changed = structuredClone(bundle); changed.assets.vae.sha256 = 'b'.repeat(64);
  expect(() => validateQwenEditBundle(changed)).toThrow();
  expect(selectedQwenAssets('qwen21')).toHaveLength(3);
  expect(qwenEditAssetPath({ models: '/models' } as AppPaths, QWEN21_ASSETS[0]).replaceAll('\\','/')).toContain('/qwen-image-2.1/');
});
it('replays creation and references without turning them into Lightning edits', () => {
  for (const create of [true, false]) {
    const plan = buildQwenEditWorkflow(create ? { ...input, source: undefined, sourceFilename: undefined, operation: 'create', transparent: true } : { ...input, references: [{ source, filename: input.sourceFilename! }] }, bundle);
    const draft = createQwenConversationDraft();
    const record = { id: 'a'.repeat(32), actualSeed: '123', qwenEdit: { plan, lineage: { conversationId: draft.id, branchId: draft.branchId, version: 1 } } } as GenerationRecord;
    const replay = qwenReplayDraft(record);
    expect(qwenConversationSchema.safeParse({ schemaVersion: 1, activeConversationId: replay.id, conversations: [replay] }).success).toBe(true);
    expect(replay.settings.profile).toBe('qwen21'); expect(replay.settings.seed).toBe('123');
    expect(replay.source === undefined).toBe(create); expect(replay.transparent).toBe(create);
  }
});
it('keeps the engine update opt-in while retaining the old channel and Lightning recipes', () => {
  expect(latestReviewedRuntimeSet().backend.version).toBe('0.34.0');
  const set = reviewedRuntimeSet('comfy-0-37-0-qwen21-1');
  expect(set.optional).toBe(true); expect(set.workflowVersions).toContain('qwen-image-edit-2511-int8@2');
  expect(set.mandatoryNodes).toContain('TextEncodeQwenImage21');
  expect(new Set(set.packages.map(p=>p.name)).size).toBe(set.packages.length);
  expect(qwenEditSettingsSchema.parse(input.settings).profile).toBe('qwen21');
});

it('freezes queued creation and reference edits, and rejects reference substitution on recovery', async () => {
  const service = Object.create(JobService.prototype) as any;
  service.paths = { inputs: path.resolve('test-inputs') };
  service.store = { records: () => [] };
  service.sources = { resolve: async () => ({ source, normalizedPath: path.join(service.paths.inputs, 'source-images', source.id, 'image.png') }) };
  service.qwenEditAssets = { verify: async () => bundle };
  service.backend = { status: () => ({ version: '0.37.0' }) };
  service.tick = async () => {};
  let context: any;
  service.accept = (_job: unknown, accepted: unknown) => { context = accepted; };
  for (const create of [true, false]) {
    const draft = createQwenConversationDraft();
    const request = { mode: 'qwen-edit', operation: create ? 'create' : 'edit', instruction: input.instruction, settings: { ...input.settings, seed: 'random' }, lineage: { conversationId: draft.id, branchId: draft.branchId }, ...(create ? { transparent: true } : { sourceId: source.id, sourceSha256: source.normalized.sha256, references: [{ sourceId: source.id, sha256: source.normalized.sha256 }] }) };
    const job = await service.prepareQwenEdit(request);
    expect(service.frozenQwenPlan(job, context).operation).toBe(create ? 'create' : 'edit');
    if (!create) { job.draft.qwenEdit.references[0].sha256 = 'b'.repeat(64); expect(() => service.frozenQwenPlan(job, context)).toThrow('references'); }
  }
});

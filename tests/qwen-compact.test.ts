import { expect, it } from 'vitest';
import { QWEN_GGUF_RELEASE } from '../src/shared/qwen-gguf-release';
import { buildQwenEditWorkflow, validateQwenEditBundle } from '../src/shared/qwen-edit-workflow';
import { qwenEditSettingsSchema } from '../src/shared/qwen-edit-types';
import { qwenEditorSettingsSchema } from '../src/shared/qwen-conversation';
import { selectedQwenAssets, QWEN_EDIT_RUNTIME, qwenEditBytes } from '../src/main/qwen-edit-assets';
import type { QwenEditAsset, QwenEditBundle, QwenEditProfile } from '../src/shared/qwen-edit-types';
import type { SourceImageAsset } from '../src/shared/source-types';
export function qwenBundle(profile: QwenEditProfile = 'base'): QwenEditBundle {
  const assets = Object.fromEntries(selectedQwenAssets(profile).map(pin => [pin.role, {
    role: pin.role, filename: `qwen-edit-2511/${pin.filename}`, directory: pin.directory, bytes: pin.bytes, sha256: pin.sha256, format: pin.format ?? 'safetensors', status: 'ready',
    provenance: { repository: pin.repository, revision: pin.revision, sourceFile: pin.sourceFile, sourceUrl: pin.url, modelCardUrl: `https://huggingface.co/${pin.repository}/resolve/${pin.revision}/README.md`, licenseName: 'Apache-2.0', licenseUrl: 'https://www.apache.org/licenses/LICENSE-2.0.txt' },
    validation: { headerBytes: pin.headerBytes, headerSha256: pin.headerSha256, tensorCount: pin.tensorCount, dtypes: [...pin.dtypes] }, verifiedAt: '2026-09-05T01:00:00.000Z',
  } satisfies QwenEditAsset])) as unknown as QwenEditBundle['assets'];
  return { id: profile === 'compact' ? 'qwen-edit-2511-gguf-q4ks' : 'qwen-edit-2511-native-int8', profile, assets, totalBytes: qwenEditBytes(profile), runtime: { ...structuredClone(QWEN_EDIT_RUNTIME), ...(profile === 'compact' ? { route: 'gguf-q4ks' as const, customNodes: [QWEN_GGUF_RELEASE.revision] } : {}) }, verifiedAt: '2026-09-05T01:00:00.000Z' };
}
export const qwenSource = { id: 'src_11111111-1111-1111-1111-111111111111', normalized: { sha256: 'a'.repeat(64), width: 2048, height: 1536, bytes: 100, mimeType: 'image/png' } } as SourceImageAsset;

const input = (profile: QwenEditProfile) => ({ settings: { profile, width: 512, height: 512, seed: '12345', resize: 'center-crop' as const }, source: qwenSource, sourceFilename: 'sources/test.png', instruction: 'Make the teapot green.', jobId: 'compact-test' });
it('keeps native historical recipes and loaders unchanged', () => {
 for (const profile of ['base','fast'] as const) {
  const bundle=qwenBundle(profile);const before=JSON.stringify(bundle);const plan=buildQwenEditWorkflow(input(profile),bundle);
  expect(plan.workflowVersion).toBe('qwen-image-edit-2511-int8@2');expect(plan.workflow['1'].class_type).toBe('UNETLoader');expect(plan.settings.steps).toBe(profile==='base'?40:4);expect(JSON.stringify(bundle)).toBe(before);
  const legacy=buildQwenEditWorkflow({...input(profile),workflowVersion:'qwen-image-edit-2511-int8@1'},bundle);expect(legacy.canvas).toBeUndefined();expect(legacy.workflow['5'].inputs.width).toBe(512);
 }
});
it('uses the smaller pinned GGUF with Lightning and the aligned reference canvas', () => {
 const plan=buildQwenEditWorkflow(input('compact'),qwenBundle('compact'));
 expect(plan.workflowVersion).toBe('qwen-image-edit-2511-gguf-q4ks@1');expect(plan.workflow['1']).toEqual({class_type:'UnetLoaderGGUF',inputs:{unet_name:'qwen-edit-2511/qwen-image-edit-2511-Q4_K_S.gguf'}});
 expect(plan.workflow['14'].class_type).toBe('LoraLoaderModelOnly');expect(plan.settings).toMatchObject({steps:4,guidance:1});expect(plan.workflow['2'].inputs.device).toBe('cpu');expect(plan.canvas?.inference).toEqual({width:1024,height:1024});expect(plan.output).toMatchObject({width:512,height:512});
 expect(plan.bundle.totalBytes).toBe(22898832710);expect(plan.bundle.assets.encoder.sha256).toBe(qwenBundle().assets.encoder.sha256);
});
it('rejects route swaps and changed weights in a frozen recipe', () => {
 expect(()=>buildQwenEditWorkflow({...input('compact'),workflowVersion:'qwen-image-edit-2511-int8@2'},qwenBundle('compact'))).toThrow('route');
 expect(()=>buildQwenEditWorkflow({...input('fast'),workflowVersion:'qwen-image-edit-2511-gguf-q4ks@1'},qwenBundle('fast'))).toThrow('route');
 const b=qwenBundle('compact');b.assets.diffusion.sha256='0'.repeat(64);expect(()=>validateQwenEditBundle(b)).toThrow('diffusion');
 const c=qwenBundle('compact');c.runtime.customNodes=[];expect(()=>validateQwenEditBundle(c)).toThrow('runtime');
});
it('persists Compact and enforces four steps and CFG one', () => {
 for(const schema of [qwenEditSettingsSchema,qwenEditorSettingsSchema]) {
 expect(schema.safeParse(input('compact').settings).success).toBe(true);
 expect(schema.safeParse({...input('compact').settings,steps:40}).success).toBe(false);
 expect(schema.safeParse({...input('compact').settings,guidance:4}).success).toBe(false);
 }
});

it('keeps Compact storage inventory separate while sharing encoder and VAE identities', async () => {
 const {builtInStorageCatalog}=await import('../src/main/storage-catalog');const {createPaths}=await import('../src/main/paths');const fs=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'latent-qwen-compact-'));
 try { const entries=builtInStorageCatalog(createPaths(root));const compact=entries.find(e=>e.id==='qwen-compact')!;const fast=entries.find(e=>e.id==='qwen-fast')!;
 expect(compact.artifacts).toHaveLength(4);expect(compact.artifacts.reduce((s,a)=>s+a.bytes,0)).toBe(22898832710);expect(compact.artifacts.filter(a=>fast.artifacts.some(b=>b.sha256===a.sha256))).toHaveLength(3);
 } finally { await fs.rm(root,{recursive:true,force:true}); }
});
it('rejects an absent loader promptly with normalized forward-slash studio paths', async () => {
 const {verifyQwenGGUFRuntime}=await import('../src/main/qwen-gguf-runtime');const {createPaths}=await import('../src/main/paths');const fs=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const root=await fs.mkdtemp(path.join(os.tmpdir(),'latent-qwen-loader-'));
 try { await expect(verifyQwenGGUFRuntime(createPaths(root.replaceAll('\\','/')))).rejects.toThrow(); }
 finally { await fs.rm(root,{recursive:true,force:true}); }
});

it('requires the retained Compact loader when checking an engine update', async () => {
 const {validateRuntimeUpdateCapabilities}=await import('../src/shared/runtime-update-capabilities');
 const set={mandatoryNodes:[]} as any;
 expect(()=>validateRuntimeUpdateCapabilities({},set,['latent_qwen_gguf'])).toThrow('Compact Qwen loader');
 expect(()=>validateRuntimeUpdateCapabilities({UnetLoaderGGUF:{output:['IMAGE'],input:{required:{unet_name:[[]]}}}},set,['latent_qwen_gguf'])).toThrow('Compact Qwen loader');
});

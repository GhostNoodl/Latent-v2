import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AppPaths, BackendStatus } from '../shared/types';
import type { VideoDraft, VideoWorkflowContract } from '../shared/video-types';
import type { VideoAssetBundle } from '../shared/video-assets';
import { videoProfileAssets, videoDraftSchema } from '../shared/video-plan';
import { parseVideoHistoryContract } from '../shared/video-history';
import { bindVideoWorkflow, buildVideoWorkflow, safeVideoRelativeFilename } from '../shared/video-workflow';
import { canonicalRuntimeJson, runtimeIdentitySchema, type RuntimeIdentitySnapshot } from '../shared/runtime-identity';
import type { VideoAssetsService } from './video-assets';
import { videoAssetBinding } from './video-assets';
import type { SourceImageService } from './source-images';
import { containedPath, validateRuntimePaths } from './runtime-config';
import { VIDEO_PLAYBACK_FIXTURE_ID } from './video-playback-fixture';

/** Versioned candidate configuration, not a hardware-support or inference-success declaration. */
export const VIDEO_RUNTIME_CANDIDATE = Object.freeze({
  schema: 1, id: 'h3-native-windows-int8@1', platform: 'win32', arch: 'x64', python: '3.12.13', comfy: '0.34.0',
  comfyCommit: '12d5279438bfefc058a269eae805ceab6047777f', cudaBuild: '13.0',
  packages: { torch: '2.11.0+cu130', torchaudio: '2.11.0+cu130', 'comfy-kitchen': '0.2.31', 'comfy-aimdo': '0.4.15', safetensors: '0.8.0', av: '18.1.0', transformers: '5.16.1', tokenizers: '0.23.2' },
});
const normalizePackage = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
export function validateVideoRuntime(value: unknown): RuntimeIdentitySnapshot {
  const identity = runtimeIdentitySchema.parse(value); const data = identity.data; const candidate = VIDEO_RUNTIME_CANDIDATE;
  if (createHash('sha256').update(canonicalRuntimeJson(data)).digest('hex') !== identity.sha256) throw new Error('The video runtime identity is inconsistent. Restart the private engine to observe it again.');
  if (data.platform !== candidate.platform || data.arch !== candidate.arch || data.python.implementation !== 'CPython' || data.python.version !== candidate.python) throw new Error('This runtime is outside the recorded Windows x64 H3 candidate configuration.');
  if (data.comfy.observedVersion !== candidate.comfy || data.comfy.baseline?.commit !== candidate.comfyCommit || data.comfy.observedGitCommit !== null && data.comfy.observedGitCommit !== candidate.comfyCommit) throw new Error('The current Comfy source/version is outside the H3 candidate baseline. Review the changed runtime before video use.');
  if (data.python.torchVersion !== candidate.packages.torch || data.python.torchCudaBuild !== candidate.cudaBuild || data.launch.deviceMode === 'cpu') throw new Error('The H3 candidate requires its recorded CUDA runtime and an Auto or Low VRAM engine. CPU-only inference is not validated.');
  const seen = new Map<string, string>();
  for (const item of data.packages) { const name = normalizePackage(item.name); if (seen.has(name)) throw new Error(`The private runtime has ambiguous ${name} package metadata.`); seen.set(name, item.version); }
  for (const [name, version] of Object.entries(candidate.packages)) if (seen.get(name) !== version) throw new Error(`Video runtime dependency ${name} differs from the recorded candidate (${version}). Review the private runtime before video use.`);
  // A baseline marker is not proof that source bytes are unmodified. The complete observed identity is frozen below.
  return structuredClone(identity);
}

export interface VideoPreparedExecution {
  schema: 1; kind: 'video'; candidateId: typeof VIDEO_RUNTIME_CANDIDATE.id; jobId: string; preparedAt: string;
  contract: VideoWorkflowContract; runtimeIdentity: RuntimeIdentitySnapshot; authorizationRecordId: string;
  /** Describes schemas used for this observation only; submission must bind fresh engine capabilities. */
  capabilitiesSha256: string;
}
interface Engine {
  status(): BackendStatus; getUrl(): string | null; getRuntimeIdentity(): RuntimeIdentitySnapshot | undefined;
}
export interface VideoPreflightOptions {
  blockedReason?(): string | undefined;
  objectInfo?(address: string, signal: AbortSignal): Promise<Record<string, unknown>>;
}
const requestSchema = z.object({ jobId: z.string().regex(/^[a-f0-9]{32}$/).refine(id => id !== VIDEO_PLAYBACK_FIXTURE_ID, 'The playback diagnostic ID is reserved.'), draft: videoDraftSchema.refine(draft => !!draft.prompt.trim(), 'Describe the video before preflight.'), actualSeed: z.string().regex(/^(0|[1-9][0-9]{0,15})$/).refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER), 'A safe resolved seed is required.') }).strict().refine(value => value.draft.seed === 'random' || value.draft.seed === value.actualSeed, 'The resolved seed differs from the fixed draft seed.');
const preparedSchema = z.object({ schema: z.literal(1), kind: z.literal('video'), candidateId: z.literal(VIDEO_RUNTIME_CANDIDATE.id), jobId: requestSchema.shape.jobId, preparedAt: z.string().datetime(), contract: z.unknown(), runtimeIdentity: runtimeIdentitySchema, authorizationRecordId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), capabilitiesSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
function ownedAddress(address: string | null) {
  if (!address) throw new Error('Start the private engine before video preflight.');
  const url = new URL(address);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1024 || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Video preflight requires the owned loopback engine address.');
  return url.origin;
}
async function readObjectInfo(address: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${address}/object_info`, { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: 'error', headers: { Accept: 'application/json' } });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`The engine could not report video capabilities (HTTP ${response.status}).`); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try { while (true) { signal.throwIfAborted(); const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 16 * 1024 * 1024) throw new Error('Engine capability metadata exceeds the video preflight bound.'); chunks.push(part.value); } }
  catch (error) { await reader.cancel().catch(() => undefined); throw error; } finally { reader.releaseLock(); }
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The engine returned invalid video capability metadata.');
  return value;
}
function normalizedContract(value: VideoWorkflowContract) {
  const result = structuredClone(value);
  for (const node of Object.values(result.workflow)) for (const field of ['unet_name', 'clip_name', 'vae_name', 'lora_name', 'image']) if (typeof node.inputs[field] === 'string') node.inputs[field] = (node.inputs[field] as string).replaceAll('\\', '/');
  return result;
}

/** Internal queue preflight only. No timer, submission, model acquisition, source write or engine launch. */
export class VideoPreflightService {
  constructor(private paths: AppPaths, private assets: Pick<VideoAssetsService, 'verify' | 'authorizationRecordId'>, private sources: Pick<SourceImageService, 'resolve'>, private engine: Engine, private options: VideoPreflightOptions = {}) {}
  private observe(signal: AbortSignal) {
    signal.throwIfAborted(); const blocked = this.options.blockedReason?.(); if (blocked) throw new Error(blocked);
    validateRuntimePaths(this.paths);
    if (this.engine.status().state !== 'ready') throw new Error('Start the private engine before video preflight.');
    const address = ownedAddress(this.engine.getUrl()); const runtimeIdentity = validateVideoRuntime(this.engine.getRuntimeIdentity());
    return { address, runtimeIdentity };
  }
  private unchanged(previous: ReturnType<VideoPreflightService['observe']>, signal: AbortSignal) {
    const current = this.observe(signal);
    if (current.address !== previous.address || current.runtimeIdentity.sha256 !== previous.runtimeIdentity.sha256 || current.runtimeIdentity.observedAt !== previous.runtimeIdentity.observedAt) throw new Error('The private engine changed during video preflight. Retry against its current runtime.');
  }
  private checkBundle(bundle: VideoAssetBundle, profile: VideoDraft['profile']) {
    const pins = videoProfileAssets(profile);
    if (bundle.schema !== 1 || bundle.profile !== profile || bundle.runtimeVerified !== false || typeof bundle.authorizationRecordId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(bundle.authorizationRecordId) || bundle.assets.length !== pins.length) throw new Error('The verified video asset bundle differs from the selected profile.');
    for (const pin of pins) {
      const matches = bundle.assets.filter(receipt => receipt.asset.role === pin.role);
      if (matches.length !== 1 || !isDeepStrictEqual(matches[0].asset, pin) || !isDeepStrictEqual(matches[0].binding, videoAssetBinding(pin))) throw new Error(`The verified video ${pin.role} differs from its private candidate binding.`);
    }
    return bundle;
  }
  async prepare(input: { jobId: string; draft: VideoDraft; actualSeed: string }, signal: AbortSignal = new AbortController().signal): Promise<VideoPreparedExecution> {
    const request = requestSchema.parse(structuredClone(input)); const observed = this.observe(signal); const authorizationRecordId = this.assets.authorizationRecordId();
    // The main-owned operation policy and verified file identities cannot be supplied by IPC callers.
    const bundle = this.checkBundle(await this.assets.verify(request.draft.profile), request.draft.profile); this.unchanged(observed, signal);
    if (bundle.authorizationRecordId !== authorizationRecordId) throw new Error('Video authorization changed during preflight. Prepare the job again.');
    const references = [...new Set([request.draft.firstFrame?.sourceId, request.draft.lastFrame?.sourceId].filter((id): id is string => !!id))];
    const sources = []; const sourceFilenames: Record<string, string> = {};
    for (const id of references) {
      const resolved = await this.sources.resolve(id); this.unchanged(observed, signal);
      const filename = containedPath(this.paths.inputs, resolved.normalizedPath);
      sources.push(resolved.source); sourceFilenames[id] = safeVideoRelativeFilename(path.relative(this.paths.inputs, filename).replaceAll('\\', '/'), '.png');
    }
    const contract = buildVideoWorkflow({ ...request, sources, sourceFilenames }, bundle.assets.map(receipt => receipt.binding));
    const objects = await (this.options.objectInfo ?? readObjectInfo)(observed.address, signal); this.unchanged(observed, signal);
    const bound = bindVideoWorkflow(contract, objects);
    const finalBundle = this.checkBundle(await this.assets.verify(request.draft.profile), request.draft.profile); this.unchanged(observed, signal);
    if (finalBundle.authorizationRecordId !== bundle.authorizationRecordId) throw new Error('Video authorization changed during preflight. Prepare the job again.');
    // Resolve source pixels after the final potentially long model check, immediately before returning to the queue.
    for (const source of sources) {
      const current = await this.sources.resolve(source.id); this.unchanged(observed, signal);
      if (!isDeepStrictEqual(current.source, source) || path.relative(this.paths.inputs, containedPath(this.paths.inputs, current.normalizedPath)).replaceAll('\\', '/') !== sourceFilenames[source.id]) throw new Error('A video source changed during preflight. Restore its original pixels and binding.');
    }
    const used = Object.fromEntries([...new Set(Object.values(bound.workflow).map(node => node.class_type))].map(name => [name, objects[name]]));
    this.unchanged(observed, signal);
    if (this.assets.authorizationRecordId() !== authorizationRecordId) throw new Error('Video authorization changed during preflight. Prepare the job again.');
    return { schema: 1, kind: 'video', candidateId: VIDEO_RUNTIME_CANDIDATE.id, jobId: request.jobId, preparedAt: new Date().toISOString(), contract: bound,
      runtimeIdentity: observed.runtimeIdentity, authorizationRecordId: bundle.authorizationRecordId, capabilitiesSha256: createHash('sha256').update(canonicalRuntimeJson(used)).digest('hex') };
  }
  /** Reopen/retry/submission may never trust cached receipts in place of fresh verification. */
  assertCurrent(prepared: VideoPreparedExecution, signal: AbortSignal = new AbortController().signal): void {
    const current = this.observe(signal);
    if (current.runtimeIdentity.sha256 !== prepared.runtimeIdentity.sha256 || current.runtimeIdentity.observedAt !== prepared.runtimeIdentity.observedAt || this.assets.authorizationRecordId() !== prepared.authorizationRecordId) throw new Error('The video runtime or authorization changed before submission. Prepare the job again.');
  }
  async revalidate(input: unknown, signal: AbortSignal = new AbortController().signal): Promise<VideoPreparedExecution> {
    const saved = preparedSchema.parse(structuredClone(input)); const contract = parseVideoHistoryContract(saved.contract, saved.jobId);
    validateVideoRuntime(saved.runtimeIdentity); const observed = this.observe(signal);
    if (observed.runtimeIdentity.sha256 !== saved.runtimeIdentity.sha256) throw new Error('The video was prepared for a different runtime. Restore its recipe as a new job after reviewing that change.');
    const current = await this.prepare({ jobId: saved.jobId, draft: contract.plan.draft, actualSeed: contract.plan.actualSeed }, signal);
    if (current.runtimeIdentity.sha256 !== saved.runtimeIdentity.sha256 || current.authorizationRecordId !== saved.authorizationRecordId || !isDeepStrictEqual(normalizedContract(current.contract), normalizedContract(contract))) throw new Error('The queued video runtime, assets, sources or authorization changed. Restore the original inputs or prepare a new job.');
    return current;
  }
}

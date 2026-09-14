import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { AppPaths } from '../shared/types';
import { IPADAPTER_RELEASE } from '../shared/ipadapter-release';
import { ipAdapterBundleSchema, type IPAdapterModelValidation, type IPAdapterStatus, type ReviewedIPAdapterBundle } from '../shared/ipadapter-types';
import { assistantHash, downloadAssistantAsset, type AssistantAsset } from './assistant-download';
import { inspectSafeTensors } from './models';
import { withReviewedAssetLock } from './reviewed-asset-lock';
import { containedPath, runtimeEnvironment, validateRuntimePaths } from './runtime-config';

export function ipAdapterPaths(paths: AppPaths) {
  const cache = path.join(paths.cache, 'ipadapter'); const runtime = path.join(paths.runtime, 'ipadapter');
  return { cache, weights: path.join(cache, 'weights'), code: path.join(cache, 'code'), licenses: path.join(cache, 'licenses'), stageMarker: path.join(cache, 'staged.json'), runtime, marker: path.join(runtime, 'installed.json'), liveCode: path.join(paths.root, 'custom_nodes', IPADAPTER_RELEASE.customNodeDirectory) };
}
function guard(paths: AppPaths, target: string) {
  validateRuntimePaths(paths); containedPath(storageBoundary(paths, target), target);
  for (let current = path.resolve(target); current !== storageBoundary(paths, target); current = path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('IP Adapter storage cannot use symbolic links or junctions.'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function directory(paths: AppPaths, filename: string) { guard(paths, filename); await fs.promises.mkdir(filename, { recursive: true }); guard(paths, filename); }
async function verifyFile(paths: AppPaths, filename: string, expected: Pick<AssistantAsset, 'bytes' | 'sha256'>, signal?: AbortSignal, allowOwnedLink = false) {
  guard(paths, filename); const stat = await fs.promises.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || !allowOwnedLink && stat.nlink !== 1 || stat.size !== expected.bytes || await assistantHash(filename, signal) !== expected.sha256) throw new Error(`Reviewed IP Adapter file changed or is incomplete: ${path.basename(filename)}. The original was preserved.`);
}

export function inspectIPAdapterHeader(header: Record<string, any>, headerBytes: number, role: 'adapter' | 'clip-vision'): IPAdapterModelValidation {
  const tensors = Object.entries(header).filter(([name]) => name !== '__metadata__');
  const adapter = role === 'adapter'; const shapes: Record<string, number[]> = adapter ? { 'image_proj.latents': [1, 16, 1280], 'image_proj.proj_in.weight': [1280, 1280], 'image_proj.proj_out.weight': [2048, 1280], 'ip_adapter.1.to_k_ip.weight': [640, 2048] } : { 'vision_model.embeddings.patch_embedding.weight': [1280, 3, 14, 14], 'vision_model.embeddings.position_embedding.weight': [257, 1280], 'vision_model.encoder.layers.31.layer_norm1.weight': [1280], 'visual_projection.weight': [1024, 1280] };
  if (headerBytes !== (adapter ? 19776 : 64184) || tensors.length !== (adapter ? 191 : 521) || Object.entries(shapes).some(([name, shape]) => JSON.stringify(header[name]?.shape) !== JSON.stringify(shape))) throw new Error(`The reviewed ${role} file is not the expected ${adapter ? 'SDXL Plus adapter' : 'ViT-H encoder'} architecture.`);
  if (tensors.some(([, tensor]) => !Array.isArray(tensor.shape) || tensor.shape.some((value: unknown) => !Number.isSafeInteger(value) || (value as number) < 1) || typeof tensor.dtype !== 'string')) throw new Error('The reviewed IP Adapter tensor metadata is invalid.');
  const dtypes = [...new Set(tensors.map(([, tensor]) => tensor.dtype as string))].sort(); const parameters = tensors.reduce((sum, [, tensor]) => sum + tensor.shape.reduce((count: bigint, size: number) => count * BigInt(size), 1n), 0n).toString();
  if (JSON.stringify(dtypes) !== JSON.stringify(adapter ? ['F16'] : ['F32', 'I64']) || parameters !== (adapter ? '423748864' : '632077057')) throw new Error('The reviewed IP Adapter tensor counts or data types differ.');
  return { format: 'safetensors', architecture: adapter ? 'ipadapter-plus-sdxl-vit-h' : 'clip-vision-vit-h-14', headerBytes, tensorCount: tensors.length, dtypes, parameters };
}
export async function inspectIPAdapterFile(filename: string, role: 'adapter' | 'clip-vision') {
  await inspectSafeTensors(filename); const file = await fs.promises.open(filename, 'r');
  try { const initial = Buffer.alloc(8); await file.read(initial, 0, 8, 0); const headerBytes = Number(initial.readBigUInt64LE()); if (!Number.isSafeInteger(headerBytes) || headerBytes < 1 || headerBytes > 1024 * 1024) throw new Error('Unbounded IP Adapter tensor header.'); const bytes = Buffer.alloc(headerBytes); await file.read(bytes, 0, headerBytes, 8); return inspectIPAdapterHeader(JSON.parse(bytes.toString()), headerBytes, role); }
  finally { await file.close(); }
}

export async function probeIPAdapterDependencies(paths: AppPaths, signal?: AbortSignal): Promise<ReviewedIPAdapterBundle['dependencies']> {
  guard(paths, paths.python);
  const source = "import importlib.metadata as m,json; print(json.dumps({n:m.version(n) for n in ('torch','torchvision','einops','Pillow','safetensors')}))";
  const checked = await new Promise<Record<string, string>>((resolve, reject) => {
    const child = spawn(paths.python, ['-I', '-B', '-c', source], { cwd: paths.root, env: runtimeEnvironment(paths), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); let text = ''; let done = false;
    const finish = (error?: Error, result?: Record<string, string>) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(result!); };
    const abort = () => { child.kill(); finish(new Error('IP Adapter dependency check canceled.')); }; const timer = setTimeout(() => { child.kill(); finish(new Error('The private dependency check timed out.')); }, 15000);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    child.stdout.on('data', chunk => { text += chunk.toString(); if (text.length > 8192) { child.kill(); finish(new Error('Unexpected dependency metadata size.')); } });
    child.once('error', error => finish(error)); child.once('close', code => { if (code !== 0) finish(new Error('The private runtime is missing an IP Adapter dependency. Reinstall the reviewed engine bundle; no packages were changed.')); else { try { finish(undefined, JSON.parse(text)); } catch { finish(new Error('Invalid private dependency metadata.')); } } });
  });
  for (const [name, version] of Object.entries(IPADAPTER_RELEASE.runtimeTarget.dependencies)) if (checked[name] !== version) throw new Error(`The reviewed IP Adapter route requires ${name} ${version}; the installed version is ${checked[name] ?? 'missing'}. No packages were changed.`);
  return checked as ReviewedIPAdapterBundle['dependencies'];
}

/** Exclusive same-volume publication with recovery for our own interrupted link. */
export async function publishIPAdapterModel(paths: AppPaths, staging: string, target: string, asset: Pick<AssistantAsset, 'bytes' | 'sha256'>, isStopped: () => boolean, signal?: AbortSignal) {
  const stopped = () => { signal?.throwIfAborted(); if (!isStopped()) throw new Error('Stop the managed image engine before activating IP Adapter files.'); }; stopped(); guard(paths, staging); await directory(paths, path.dirname(target)); guard(paths, target);
  const sourceStat = await fs.promises.lstat(staging).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  const targetStat = await fs.promises.lstat(target).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
  if (targetStat) {
    const ownedPair = Boolean(sourceStat && sourceStat.nlink === 2 && targetStat.nlink === 2 && sourceStat.dev === targetStat.dev && sourceStat.ino === targetStat.ino);
    await verifyFile(paths, target, asset, signal, ownedPair);
    if (sourceStat) { await verifyFile(paths, staging, asset, signal, ownedPair); stopped(); await fs.promises.unlink(staging); }
    return;
  }
  await verifyFile(paths, staging, asset, signal); stopped(); await fs.promises.link(staging, target); await fs.promises.unlink(staging);
}

export class IPAdapterService {
  private files; private current: IPAdapterStatus; private pending?: Promise<ReviewedIPAdapterBundle>; private controller?: AbortController; private disposed = false;
  constructor(private paths: AppPaths, private changed: () => void, private isEngineStopped: () => boolean) {
    this.files = ipAdapterPaths(paths); for (const filename of Object.values(this.files)) guard(paths, filename);
    const active = this.receipt(this.files.marker, 'active'); const staged = this.receipt(this.files.stageMarker, 'staged');
    this.current = { state: active ? 'ready' : staged ? 'staged' : 'not-installed', message: active ? 'Image reference tools are ready. Results vary with the checkpoint and reference image.' : staged ? 'Reference files staged. Stop the image engine to activate this reviewed package.' : 'Optional image reference: 3.38 GB of reviewed adapter and vision weights, plus a small custom-node package.', bundle: active ?? staged };
  }
  status(): IPAdapterStatus { return structuredClone(this.current); }
  private update(value: Partial<IPAdapterStatus>) { this.current = { ...this.current, ...value }; this.changed(); }
  private receipt(filename: string, location?: 'staged' | 'active') {
    try {
      guard(this.paths, filename); const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024) return undefined; const receipt = ipAdapterBundleSchema.parse(JSON.parse(fs.readFileSync(filename, 'utf8')));
      if (location) {
        const present = (filename: string, bytes: number, links = 1) => { try { guard(this.paths, filename); const stat = fs.lstatSync(filename); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink <= links && stat.size === bytes; } catch { return false; } };
        for (const file of receipt.code.files) if (!present(path.join(location === 'active' ? this.files.liveCode : this.files.code, file.filename), file.bytes)) return undefined;
        for (const file of receipt.provenance.supportFiles) if (!present(path.join(this.files.licenses, file.filename), file.bytes)) return undefined;
        for (const model of receipt.models) {
          const live = path.join(this.paths.models, model.directory, model.filename); const staged = path.join(this.files.weights, model.filename);
          if (location === 'active' ? !present(live, model.bytes) : !present(staged, model.bytes, 2) && !present(live, model.bytes, 2)) return undefined;
        }
      }
      return receipt;
    } catch { return undefined; }
  }
  private async marker(filename: string, bundle: ReviewedIPAdapterBundle) {
    guard(this.paths, filename); if (fs.existsSync(filename) && !this.receipt(filename)) throw new Error('Existing IP Adapter metadata is invalid and was preserved.');
    await directory(this.paths, path.dirname(filename)); const pending = `${filename}.${randomUUID()}.pending`; await fs.promises.writeFile(pending, JSON.stringify(bundle, null, 2), { flag: 'wx' });
    try { guard(this.paths, filename); await fs.promises.rename(pending, filename); } finally { await fs.promises.unlink(pending).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  }
  private async checkCode(directoryName: string, signal?: AbortSignal, live = false) {
    guard(this.paths, directoryName);
    for (const asset of IPADAPTER_RELEASE.codeFiles) await verifyFile(this.paths, path.join(directoryName, asset.filename), asset, signal);
    if (live) {
      const allowed = new Set([...IPADAPTER_RELEASE.codeFiles.map(file => file.filename), '__pycache__']);
      for (const name of await fs.promises.readdir(directoryName)) { if (!allowed.has(name)) throw new Error('The installed IP Adapter package contains an unreviewed extra file.'); guard(this.paths, path.join(directoryName, name)); }
    }
  }
  private async inspect(location: 'staged' | 'active', signal?: AbortSignal): Promise<ReviewedIPAdapterBundle> {
    const dependencies = await probeIPAdapterDependencies(this.paths, signal);
    await this.checkBaseline();
    await this.checkCode(location === 'active' ? this.files.liveCode : this.files.code, signal, location === 'active');
    for (const file of IPADAPTER_RELEASE.supportFiles) await verifyFile(this.paths, path.join(this.files.licenses, file.filename), file, signal);
    const models: ReviewedIPAdapterBundle['models'][number][] = [];
    for (const asset of IPADAPTER_RELEASE.models) {
      const filename = location === 'active' ? path.join(this.paths.models, asset.directory, asset.filename) : path.join(this.files.weights, asset.filename);
      await verifyFile(this.paths, filename, asset, signal); models.push({ ...asset, validation: await inspectIPAdapterFile(filename, asset.role) });
    }
    return ipAdapterBundleSchema.parse({ id: IPADAPTER_RELEASE.id, family: 'sdxl', validationScope: 'file-integrity-only', models: [models[0], models[1]], code: { repository: IPADAPTER_RELEASE.codeRepository, revision: IPADAPTER_RELEASE.codeRevision, directory: IPADAPTER_RELEASE.customNodeDirectory, license: IPADAPTER_RELEASE.codeLicense, files: IPADAPTER_RELEASE.codeFiles }, provenance: { repository: IPADAPTER_RELEASE.modelRepository, revision: IPADAPTER_RELEASE.modelRevision, modelLicense: IPADAPTER_RELEASE.modelLicense, encoderOriginLicense: IPADAPTER_RELEASE.encoderOriginLicense, encoderOriginRevision: IPADAPTER_RELEASE.encoderOriginRevision, supportFiles: IPADAPTER_RELEASE.supportFiles }, dependencies, verifiedAt: new Date().toISOString() });
  }
  private async checkBaseline() {
    const filename = path.join(this.paths.runtime, 'installed.json'); guard(this.paths, filename); const stat = await fs.promises.lstat(filename);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('The private runtime baseline marker is invalid.');
    const baseline = JSON.parse(await fs.promises.readFile(filename, 'utf8'));
    if (baseline.comfyCommit !== IPADAPTER_RELEASE.runtimeTarget.comfyCommit || baseline.comfyVersion !== IPADAPTER_RELEASE.runtimeTarget.comfyVersion) throw new Error('IP Adapter requires the reviewed ComfyUI baseline. Use compatible-set updates to review another engine version.');
  }
  private async prepareRepair(signal: AbortSignal) {
    const stopped = () => { signal.throwIfAborted(); if (!this.isEngineStopped()) throw new Error('Stop the image engine before repairing reference tools.'); };
    stopped();
    const changed: string[] = [];
    const inspect = async (filename: string, asset?: AssistantAsset) => {
      guard(this.paths, filename);
      if (!fs.existsSync(filename)) return;
      const stat = await fs.promises.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Reference-tool repair requires independent regular files. Existing files were preserved.');
      if (!asset || stat.size !== asset.bytes || await assistantHash(filename, signal) !== asset.sha256) changed.push(filename);
    };
    // Validate the entire plan before moving anything. Unknown custom code is
    // not part of the repair plan and remains untouched.
    for (const asset of IPADAPTER_RELEASE.models) {
      await inspect(path.join(this.paths.models, asset.directory, asset.filename), asset);
      await inspect(path.join(this.files.weights, asset.filename), asset);
    }
    for (const asset of IPADAPTER_RELEASE.codeFiles) {
      await inspect(path.join(this.files.liveCode, asset.filename), asset);
      await inspect(path.join(this.files.code, asset.filename), asset);
    }
    for (const asset of IPADAPTER_RELEASE.supportFiles) await inspect(path.join(this.files.licenses, asset.filename), asset);
    await inspect(this.files.marker); await inspect(this.files.stageMarker);
    const retained = path.join(this.files.cache, `repair-${randomUUID()}`);
    await directory(this.paths, retained);
    const moves = changed.map((filename, index) => ({ from: filename, to: path.join(retained, `${index}-${path.basename(filename)}`) }));
    await fs.promises.writeFile(path.join(retained, 'preserved-files.json'), JSON.stringify(moves, null, 2), { flag: 'wx' });
    for (const move of moves) { stopped(); guard(this.paths, move.from); guard(this.paths, move.to); await fs.promises.rename(move.from, move.to); }
    this.update({ bundle: undefined, message: 'Changed reference files preserved. Staging reviewed replacements…' });
  }
  stage(repair = false): Promise<ReviewedIPAdapterBundle> { return this.operation('staging', async signal => {
    if (repair) await this.prepareRepair(signal);
    if (this.receipt(this.files.marker)) return this.verify();
    const total = [...IPADAPTER_RELEASE.models, ...IPADAPTER_RELEASE.codeFiles, ...IPADAPTER_RELEASE.supportFiles].reduce((sum, asset) => sum + asset.bytes, 0); let completed = 0;
    for (const [folder, assets] of [[this.files.code, IPADAPTER_RELEASE.codeFiles], [this.files.licenses, IPADAPTER_RELEASE.supportFiles], [this.files.weights, IPADAPTER_RELEASE.models]] as const) {
      await directory(this.paths, folder);
      for (const asset of assets) {
        signal.throwIfAborted();
        const staged = path.join(folder, asset.filename);
        if (repair && folder === this.files.weights && !fs.existsSync(staged)) {
          const model = IPADAPTER_RELEASE.models.find(model => model.filename === asset.filename)!;
          const live = path.join(this.paths.models, model.directory, asset.filename);
          if (fs.existsSync(live)) {
            await verifyFile(this.paths, live, asset, signal);
            const free = await fs.promises.statfs(folder);
            if (free.bavail * free.bsize < asset.bytes + 256 * 1024 * 1024) throw new Error('Free space before staging the retained reference model. The installed file is preserved.');
            signal.throwIfAborted(); await fs.promises.copyFile(live, staged, fs.constants.COPYFILE_EXCL);
          }
        }
        await downloadAssistantAsset(asset, folder, signal, (bytes, _total, verifying) => this.update({ progress: (completed + bytes) / total * 100, message: `${verifying ? 'Verifying' : 'Staging'} ${asset.filename}` })); completed += asset.bytes;
      }
    }
    const bundle = await this.inspect('staged', signal); await this.marker(this.files.stageMarker, bundle); this.update({ state: 'staged', progress: 100, bundle, message: 'Reviewed reference files are staged. Stop the managed engine before activation.' }); return bundle;
  }); }
  activate(): Promise<ReviewedIPAdapterBundle> { return this.operation('activating', async signal => {
    const stopped = () => { signal.throwIfAborted(); if (!this.isEngineStopped()) throw new Error('Stop the managed image engine before activating the reviewed IP Adapter package.'); }; stopped();
    if (this.receipt(this.files.marker)) { const bundle = await this.inspect('active', signal); this.update({ state: 'ready', bundle, message: 'Reviewed reference files are installed.' }); return bundle; }
    // No fetch or package installation occurs in the activation phase.
    await this.checkCode(this.files.code, signal); await this.checkBaseline(); await probeIPAdapterDependencies(this.paths, signal);
    for (const asset of IPADAPTER_RELEASE.supportFiles) await verifyFile(this.paths, path.join(this.files.licenses, asset.filename), asset, signal);
    for (const asset of IPADAPTER_RELEASE.models) { stopped(); await publishIPAdapterModel(this.paths, path.join(this.files.weights, asset.filename), path.join(this.paths.models, asset.directory, asset.filename), asset, this.isEngineStopped, signal); }
    if (fs.existsSync(this.files.liveCode)) {
      for (const asset of IPADAPTER_RELEASE.codeFiles) {
        const live = path.join(this.files.liveCode, asset.filename);
        if (!fs.existsSync(live)) { await verifyFile(this.paths, path.join(this.files.code, asset.filename), asset, signal); stopped(); guard(this.paths, live); await fs.promises.copyFile(path.join(this.files.code, asset.filename), live, fs.constants.COPYFILE_EXCL); }
      }
      await this.checkCode(this.files.liveCode, signal, true);
    }
    else {
      const pending = path.join(this.files.cache, `activation-${randomUUID()}`); await directory(this.paths, pending);
      for (const asset of IPADAPTER_RELEASE.codeFiles) { await verifyFile(this.paths, path.join(this.files.code, asset.filename), asset, signal); await fs.promises.copyFile(path.join(this.files.code, asset.filename), path.join(pending, asset.filename), fs.constants.COPYFILE_EXCL); }
      await this.checkCode(pending, signal); await directory(this.paths, path.dirname(this.files.liveCode)); stopped(); guard(this.paths, this.files.liveCode);
      if (fs.existsSync(this.files.liveCode)) throw new Error('The IP Adapter package destination already exists and was preserved.');
      await fs.promises.rename(pending, this.files.liveCode);
    }
    stopped(); const bundle = await this.inspect('active', signal); await this.marker(this.files.marker, bundle); this.update({ state: 'ready', progress: 100, bundle, message: 'Reviewed reference files activated. Start the engine to load its IP Adapter nodes.' }); return bundle;
  }); }
  private operation(state: 'staging' | 'activating', task: (signal: AbortSignal) => Promise<ReviewedIPAdapterBundle>): Promise<ReviewedIPAdapterBundle> {
    if (this.disposed) return Promise.reject(new Error('The IP Adapter service was disposed.')); if (this.pending) return Promise.reject(new Error('Wait for the current IP Adapter operation to finish.'));
    if (state === 'activating' && !this.isEngineStopped()) return Promise.reject(new Error('Stop the managed image engine before activating IP Adapter.'));
    const controller = new AbortController(); this.controller = controller; this.update({ state, progress: 0, message: state === 'staging' ? 'Staging reviewed IP Adapter files…' : 'Activating reviewed IP Adapter files…' });
    this.pending = withReviewedAssetLock(this.paths, 'ipadapter-plus-sdxl-vit-h', controller.signal, task).catch(error => { this.update({ state: 'error', message: controller.signal.aborted ? 'IP Adapter setup canceled. Verified files and resumable partials were retained.' : error instanceof Error ? error.message : String(error) }); throw error; }).finally(() => { this.pending = undefined; this.controller = undefined; }); return this.pending;
  }
  async verify(): Promise<ReviewedIPAdapterBundle> {
    if (this.disposed) throw new Error('The IP Adapter service was disposed.');
    try { const bundle = await this.inspect('active'); this.update({ state: 'ready', bundle, message: 'Reviewed IP Adapter model and code files verified.' }); return bundle; }
    catch (error) { this.update({ state: 'error', bundle: undefined, message: error instanceof Error ? error.message : String(error) }); throw error; }
  }
  cancel() { this.controller?.abort(); }
  async dispose() { this.disposed = true; this.cancel(); await this.pending?.catch(() => undefined); }
}

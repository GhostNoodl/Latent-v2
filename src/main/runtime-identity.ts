import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { AppPaths, AppSettings } from '../shared/types';
import { canonicalRuntimeJson, runtimeIdentityDataSchema, runtimeIdentitySchema, type RuntimeIdentitySnapshot } from '../shared/runtime-identity';
import { runtimeEnvironment, validateRuntimePaths } from './runtime-config';

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_IDENTITY_BYTES = 1024 * 1024;
const excludedDirectories = new Set(['.git', '.hg', '.svn', '__pycache__', '.pytest_cache', '.mypy_cache', 'node_modules', 'models', 'model', 'weights', 'checkpoints', 'loras', 'input', 'inputs', 'output', 'outputs', 'cache', '.cache', 'temp', 'tmp', 'user', 'runtime', 'venv', '.venv']);
const excludedFile = (name: string) => /^\.env(?:\.|$)/i.test(name) || /\.(?:pyc|pyo|safetensors|ckpt|pt|pth|gguf|onnx|log)$/i.test(name);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const pythonProbeSchema = runtimeIdentityDataSchema.pick({ packages: true }).extend({
  version: runtimeIdentityDataSchema.shape.python.shape.version,
  implementation: runtimeIdentityDataSchema.shape.python.shape.implementation,
  torchVersion: runtimeIdentityDataSchema.shape.python.shape.torchVersion,
  torchCudaBuild: runtimeIdentityDataSchema.shape.python.shape.torchCudaBuild,
}).strict();
type PythonProbe = z.infer<typeof pythonProbeSchema>;
export interface RuntimeSourceManifest { schema: 1; policy: 'runtime-source-v1'; files: Array<{ path: string; bytes: number; sha256: string }> }

// Fixed code only. No pip configuration, environment dump, URLs, credentials, CUDA
// initialization or application/custom-node imports are part of this observation.
export const RUNTIME_IDENTITY_PYTHON = `import importlib.metadata, json, platform, torch
packages = [{'name': d.metadata['Name'], 'version': d.version} for d in importlib.metadata.distributions()]
if len(packages) > 2048: raise RuntimeError('Too many installed distributions for runtime identity')
print('LATENT_RUNTIME_IDENTITY=' + json.dumps({'version': platform.python_version(), 'implementation': platform.python_implementation(), 'torchVersion': str(torch.__version__), 'torchCudaBuild': torch.version.cuda, 'packages': packages}, separators=(',', ':')))
`;

function check(signal?: AbortSignal) { signal?.throwIfAborted(); }
function within(root: string, filename: string) { const relative = path.relative(root, filename); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
async function verifyPath(root: string, filename: string) {
  root = path.resolve(root); filename = path.resolve(filename);
  if (!within(root, filename)) throw new Error('Runtime identity path escaped its managed directory.');
  for (let current = filename; ; current = path.dirname(current)) {
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Runtime identity cannot follow a symbolic link or junction.');
    if (current === root) break;
  }
  if (!within(await fs.realpath(root), await fs.realpath(filename))) throw new Error('Runtime identity path escaped its managed directory.');
}

async function hashFile(root: string, filename: string, maximum: number, signal?: AbortSignal): Promise<{ sha256: string; bytes: number }> {
  check(signal); await verifyPath(root, filename);
  const handle = await fs.open(filename, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum) throw new Error('A runtime source file exceeds the supported inventory limit.');
    const hash = createHash('sha256'); let bytes = 0; const buffer = Buffer.alloc(256 * 1024);
    while (true) { check(signal); const part = await handle.read(buffer); if (!part.bytesRead) break; bytes += part.bytesRead; if (bytes > maximum) throw new Error('Runtime file changed or exceeded its inventory limit.'); hash.update(buffer.subarray(0, part.bytesRead)); }
    const after = await handle.stat(); const current = await fs.stat(filename); await verifyPath(root, filename);
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== current.ino || before.mtimeMs !== current.mtimeMs) throw new Error('Runtime files changed during inventory. Finish maintenance and restart the backend.');
    return { sha256: hash.digest('hex'), bytes };
  } finally { await handle.close(); }
}

export async function inventoryRuntimeSource(root: string, signal?: AbortSignal): Promise<RuntimeSourceManifest> {
  root = path.resolve(root); await verifyPath(root, root);
  const manifest: RuntimeSourceManifest = { schema: 1, policy: 'runtime-source-v1', files: [] }; let total = 0;
  async function walk(folder: string, depth: number): Promise<void> {
    if (depth > 32) throw new Error('Runtime source directory nesting exceeds 32 levels.');
    check(signal);
    for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
      const name = entry.name.toLowerCase();
      if (excludedDirectories.has(name) || excludedFile(name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Runtime source contains an unsupported symbolic link or junction.');
      const filename = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(filename, depth + 1);
      else if (entry.isFile()) {
        if (manifest.files.length >= 30000) throw new Error('Runtime source inventory exceeds 30,000 files.');
        const relative = path.relative(root, filename).replaceAll('\\', '/');
        if (relative.length > 512 || /[\x00-\x1f]/.test(relative)) throw new Error('Runtime source filename is not supported by the identity format.');
        const file = await hashFile(root, filename, 64 * 1024 * 1024, signal); total += file.bytes;
        if (total > 512 * 1024 * 1024) throw new Error('Runtime source inventory exceeds 512 MiB; model weights belong in managed model directories.');
        manifest.files.push({ path: relative, ...file });
      } else throw new Error('Runtime source contains a non-regular filesystem entry.');
    }
  }
  await walk(root, 0);
  if (Buffer.byteLength(canonicalRuntimeJson(manifest)) > MAX_MANIFEST_BYTES) throw new Error('Runtime source manifest exceeds its 8 MiB limit.');
  return manifest;
}

async function smallText(root: string, filename: string, limit = 64 * 1024): Promise<string | null> {
  try { await verifyPath(root, filename); const stat = await fs.stat(filename); if (!stat.isFile() || stat.size > limit) throw new Error('Runtime metadata exceeds its supported size.'); return await fs.readFile(filename, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function gitCommit(root: string): Promise<string | null> {
  const git = path.join(root, '.git'); const head = (await smallText(root, path.join(git, 'HEAD'), 1024))?.trim();
  if (!head) return null;
  if (/^[a-f0-9]{40,64}$/.test(head)) return head;
  const ref = /^ref: (refs\/[A-Za-z0-9_./-]+)$/.exec(head)?.[1];
  if (!ref || ref.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('The managed Git HEAD reference is invalid.');
  const direct = (await smallText(root, path.join(git, ref), 1024))?.trim();
  if (direct && /^[a-f0-9]{40,64}$/.test(direct)) return direct;
  const packed = await smallText(root, path.join(git, 'packed-refs'));
  return packed?.split(/\r?\n/).map(line => line.split(' ')).find(parts => parts[1] === ref && /^[a-f0-9]{40,64}$/.test(parts[0]))?.[0] ?? null;
}

export async function probeRuntimePython(paths: AppPaths, signal?: AbortSignal): Promise<PythonProbe> {
  await verifyPath(path.resolve(paths.root), path.resolve(paths.python)); check(signal);
  return new Promise((resolve, reject) => {
    const env = { ...runtimeEnvironment(paths), CUDA_VISIBLE_DEVICES: '-1', PYTHONDONTWRITEBYTECODE: '1' };
    const child = spawn(paths.python, ['-I', '-B', '-c', RUNTIME_IDENTITY_PYTHON], { cwd: paths.runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let size = 0; let reason: Error | undefined;
    const stop = (error: Error) => {
      if (reason) return; reason = error;
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => child.kill());
      } else child.kill();
    };
    const timer = setTimeout(() => stop(new Error('Runtime identity inspection timed out after 45 seconds.')), 45000);
    const abort = () => stop(new Error('Runtime identity inspection was cancelled.')); signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (part: Buffer) => { size += part.length; if (size > 512 * 1024) stop(new Error('Runtime package inventory exceeded its output limit.')); else stdout += part.toString('utf8'); });
    // Never forward stderr: imported packages can print arbitrary metadata.
    child.stderr?.on('data', (part: Buffer) => { size += part.length; if (size > 512 * 1024) stop(new Error('Runtime inspection exceeded its output limit.')); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', () => { cleanup(); reject(new Error('Could not run the private Python runtime identity inspector.')); });
    child.once('close', code => {
      cleanup(); if (reason) return reject(reason);
      if (code !== 0) return reject(new Error('Private Python could not inspect its installed packages and PyTorch version. Repair the private runtime and retry.'));
      try {
        const lines = stdout.split(/\r?\n/).filter(line => line.startsWith('LATENT_RUNTIME_IDENTITY='));
        if (lines.length !== 1) throw new Error();
        resolve(pythonProbeSchema.parse(JSON.parse(lines[0].slice('LATENT_RUNTIME_IDENTITY='.length))));
      } catch { reject(new Error('Private Python returned an invalid runtime package inventory.')); }
    });
    if (signal?.aborted) abort();
  });
}

async function persistContent(root: string, value: unknown, maximum: number, signal?: AbortSignal): Promise<string> {
  check(signal); const content = canonicalRuntimeJson(value);
  if (Buffer.byteLength(content) > maximum) throw new Error('Runtime identity snapshot exceeds its size limit.');
  const sha256 = digest(content); const filename = path.join(root, `${sha256}.json`); const staging = path.join(root, `.identity-${randomUUID()}.partial`);
  const existing = await smallText(root, filename, maximum);
  if (existing !== null) { if (existing !== content) throw new Error('An existing runtime identity artifact is corrupt. Preserve it and repair the identity store before restarting.'); return sha256; }
  const handle = await fs.open(staging, 'wx');
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try { check(signal); await fs.link(staging, filename); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await smallText(root, filename, maximum) !== content) throw error; }
  finally { await fs.unlink(staging); }
  return sha256;
}

/** Fixed private observation only; injected probe is a test seam, never an IPC input. */
export async function captureRuntimeIdentity(paths: AppPaths, settings: Pick<AppSettings, 'deviceMode'>, signal?: AbortSignal, probe = probeRuntimePython): Promise<RuntimeIdentitySnapshot> {
  const cancellation = new AbortController();
  const bounded = AbortSignal.any([cancellation.signal, AbortSignal.timeout(60000), ...(signal ? [signal] : [])]);
  try { return await captureObservedIdentity(paths, settings, bounded, probe); }
  finally { cancellation.abort(); }
}

async function captureObservedIdentity(paths: AppPaths, settings: Pick<AppSettings, 'deviceMode'>, signal: AbortSignal, probe: typeof probeRuntimePython): Promise<RuntimeIdentitySnapshot> {
  validateRuntimePaths(paths); check(signal);
  const destination = path.join(paths.runtime, 'identities'); await fs.mkdir(destination, { recursive: true }); await verifyPath(path.resolve(paths.root), destination);
  const [pythonResult, source, observedGitCommit, versionText, markerText, executable] = await Promise.all([
    probe(paths, signal), inventoryRuntimeSource(paths.backend, signal), gitCommit(paths.backend), smallText(paths.backend, path.join(paths.backend, 'comfyui_version.py')),
    smallText(paths.root, path.join(paths.runtime, 'installed.json')), hashFile(paths.root, paths.python, 64 * 1024 * 1024, signal),
  ]);
  const checkedPython = pythonProbeSchema.parse(pythonResult);
  const summary = async (manifest: RuntimeSourceManifest) => ({ manifestSha256: await persistContent(destination, manifest, MAX_MANIFEST_BYTES, signal), fileCount: manifest.files.length, totalBytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0) });
  let baseline = null;
  if (markerText !== null) {
    try { const marker = JSON.parse(markerText); baseline = runtimeIdentityDataSchema.shape.comfy.shape.baseline.parse({ commit: marker.comfyCommit, archiveSha256: marker.sourceSha256, version: marker.comfyVersion }); }
    catch { throw new Error('Installed baseline marker is invalid. Runtime identity cannot label its provenance.'); }
  }
  const customNodes: RuntimeIdentitySnapshot['data']['customNodes'] = [];
  for (const [scope, directory] of [['studio', path.join(paths.root, 'custom_nodes')], ['bundled', path.join(paths.backend, 'custom_nodes')]] as const) {
    let entries; try { await verifyPath(paths.root, directory); entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      if (excludedDirectories.has(entry.name.toLowerCase()) || excludedFile(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('Custom-node inventory cannot follow a symbolic link or junction.');
      if (customNodes.length >= 1024) throw new Error('Custom-node inventory exceeds 1,024 entries.');
      const filename = path.join(directory, entry.name);
      const manifest = entry.isDirectory() ? await inventoryRuntimeSource(filename, signal) : { schema: 1 as const, policy: 'runtime-source-v1' as const, files: [{ path: entry.name, ...await hashFile(directory, filename, 64 * 1024 * 1024, signal) }] };
      customNodes.push({ scope, name: entry.name, source: await summary(manifest) });
    }
  }
  const data = runtimeIdentityDataSchema.parse({
    platform: process.platform, arch: process.arch,
    python: { version: checkedPython.version, implementation: checkedPython.implementation, torchVersion: checkedPython.torchVersion, torchCudaBuild: checkedPython.torchCudaBuild, executableSha256: executable.sha256 },
    packages: checkedPython.packages.sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version)),
    comfy: { observedGitCommit, observedVersion: /^__version__\s*=\s*["']([A-Za-z0-9+!_.-]+)["']/m.exec(versionText ?? '')?.[1] ?? null, source: await summary(source), baseline },
    customNodes, launch: { deviceMode: settings.deviceMode }, inventoryPolicy: 'runtime-source-v1',
  });
  const sha256 = await persistContent(destination, data, MAX_IDENTITY_BYTES - 256, signal);
  return runtimeIdentitySchema.parse({ schema: 1, sha256, observedAt: new Date().toISOString(), data });
}

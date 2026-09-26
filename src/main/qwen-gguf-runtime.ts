import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeCommandFailure } from './runtime-command-error';
import type { AppPaths } from '../shared/types';
import { QWEN_GGUF_RELEASE as defaultRelease } from '../shared/qwen-gguf-release';
import type { AssistantAsset } from './assistant-download';
interface LoaderRelease { revision: string; directory: string; packageVersion: string; wheel: AssistantAsset; files: readonly (AssistantAsset & { subdirectory?: string; source?: string })[]; }
import { preserveChangedReviewedAsset } from './reviewed-asset-repair';
import { assistantHash, downloadAssistantAsset } from './assistant-download';
import { containedPath, runtimeEnvironment, validateRuntimePaths } from './runtime-config';

async function guard(paths: AppPaths, target: string) {
  validateRuntimePaths(paths); containedPath(paths.root, target);
  for (let current = path.resolve(target); current !== path.resolve(paths.root); current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Compact editing cannot use linked runtime files.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
async function command(paths: AppPaths, executable: string, args: string[], signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try { return await commandOnce(paths, executable, args, signal); }
    catch (error) {
      if (!(error instanceof RuntimeCommandFailure) || !error.retryableLauncherFailure || attempt >= 2) throw error;
      await delay(500 * (attempt + 1), undefined, { signal });
    }
  }
}
async function commandOnce(paths: AppPaths, executable: string, args: string[], signal?: AbortSignal) {
  await guard(paths, executable); signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: paths.root, env: runtimeEnvironment(paths), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let error = ''; let settled = false; let failure: Error | undefined;
    const finish = (e?: Error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); e ? reject(e) : resolve(output); };
    const stop = (reason: string) => { failure = new Error(reason); if (process.platform === 'win32' && child.pid) { const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => child.kill()); } else child.kill(); };
    const abort = () => stop('Compact editing setup was cancelled. Retry setup to finish.');
    const timer = setTimeout(() => stop('Compact editing dependency setup timed out. Retry setup.'), 120_000);
    child.stdout.on('data', b => { output = (output + b.toString()).slice(-16000); });
    child.stderr.on('data', b => { error = (error + b.toString()).slice(-4000); });
    child.on('error', finish); child.on('close', code => finish(failure ?? (code === 0 ? undefined : new RuntimeCommandFailure(path.basename(executable), code, error || output))));
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  });
}
async function packageVersion(paths: AppPaths, signal?: AbortSignal) {
  return (await command(paths, paths.python, ['-I', '-B', '-c', "import importlib.metadata as m; print(next((d.version for d in m.distributions() if d.metadata['Name'].lower() == 'gguf'), 'missing'))"], signal)).trim();
}
async function verifyCode(paths: AppPaths, directory: string, signal?: AbortSignal, release: LoaderRelease = defaultRelease) {
  await guard(paths, directory);
  const names = await fs.readdir(directory, { recursive: true });
  const allowed = new Set(release.files.flatMap(f => [path.join(f.subdirectory ?? '', f.filename), ...(f.subdirectory ? [f.subdirectory] : [])]));
  if (names.some(n => !n.split(path.sep).includes('__pycache__') && !allowed.has(n))) throw new Error('Compact loader contains unreviewed files. Existing files were preserved.');
  for (const asset of release.files) {
    const filename = path.join(directory, asset.subdirectory ?? '', asset.filename); await guard(paths, filename); const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== asset.bytes || await assistantHash(filename, signal) !== asset.sha256) throw new Error('Compact loader files changed. Existing files were preserved; restore the reviewed loader before editing.');
  }
}
export async function verifyQwenGGUFRuntime(paths: AppPaths, signal?: AbortSignal, release: LoaderRelease = defaultRelease) {
  await verifyCode(paths, path.join(paths.root, 'custom_nodes', release.directory), signal, release);
  if (await packageVersion(paths, signal) !== release.packageVersion) throw new Error('Install the reviewed Compact editing dependency before editing.');
}
/** Called only under stopped-engine maintenance. An explicit repair preserves changed loader code before replacement; unrelated dependencies stay untouched. */
export async function installQwenGGUFRuntime(paths: AppPaths, signal: AbortSignal, repair = false, release: LoaderRelease = defaultRelease) {
  const cache = path.join(paths.cache, release === defaultRelease ? 'qwen-gguf-loader' : release.directory + '-cache'); await guard(paths, cache); await fs.mkdir(cache, { recursive: true });
  const environment = runtimeEnvironment(paths);
  for (const key of ['TEMP', 'UV_CACHE_DIR']) { const directory = environment[key]!; await guard(paths, directory); await fs.mkdir(directory, { recursive: true }); }
  const version = await packageVersion(paths, signal);
  if (!['missing', release.packageVersion].includes(version)) throw new Error('Another GGUF dependency version is installed. It was preserved; use a matching reviewed environment.');
  const live = path.join(paths.root, 'custom_nodes', release.directory); await guard(paths, live);
  let existing = false; let replace = false;
  try { await fs.lstat(live); existing = true; await verifyCode(paths, live, signal, release); } catch (e) { if (existing && repair) replace = true; else { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; if (existing) throw new Error('Compact loader is incomplete. Run Verify / repair; existing files will be preserved.'); } }
  const stage = path.join(cache, release.revision); await guard(paths, stage); await fs.mkdir(stage, { recursive: true });
  for (const asset of release.files) { if (repair) { const old = await preserveChangedReviewedAsset(paths, path.join(stage, asset.subdirectory ?? '', asset.filename), asset, signal); if (old) { const retainedFile = path.join(cache, path.basename(old)); await guard(paths, retainedFile); await fs.rename(old, retainedFile); } } const targetDirectory = path.join(stage, asset.subdirectory ?? ''); await guard(paths, targetDirectory); await fs.mkdir(targetDirectory, { recursive: true }); if (asset.source !== undefined) { const target = path.join(targetDirectory, asset.filename); await guard(paths, target); try { await fs.writeFile(target, asset.source, { flag: 'wx' }); } catch(e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } } else await downloadAssistantAsset(asset, targetDirectory, signal, () => {}); }
  await verifyCode(paths, stage, signal, release);
  if (version === 'missing' || repair) {
    if (repair) await preserveChangedReviewedAsset(paths, path.join(cache, release.wheel.filename), release.wheel, signal);
    const wheel = await downloadAssistantAsset(release.wheel, cache, signal, () => {});
    await command(paths, path.join(paths.runtime, 'tools', 'uv.exe'), ['pip', 'install', '--python', paths.python, '--no-deps', '--no-index', '--offline', ...(repair ? ['--reinstall-package', 'gguf'] : []), wheel], signal);
  }
  // Verify imports before exposing the custom node on the next engine start.
  await command(paths, paths.python, ['-I', '-B', '-c', 'import gguf,numpy,yaml,requests,tqdm; import importlib.metadata as m; assert m.version("gguf") == "0.19.0"'], signal);
  if (!existing || replace) {
    const parent = path.dirname(live); await guard(paths, parent); await fs.mkdir(parent, { recursive: true });
    const temporary = path.join(cache, `publish-${randomUUID()}`); await fs.mkdir(temporary);
    for (const asset of release.files) { signal.throwIfAborted(); const targetDirectory = path.join(temporary, asset.subdirectory ?? ''); await fs.mkdir(targetDirectory, { recursive: true }); await fs.copyFile(path.join(stage, asset.subdirectory ?? '', asset.filename), path.join(targetDirectory, asset.filename), 1); }
    await verifyCode(paths, temporary, signal, release); signal.throwIfAborted();
    const retained = path.join(cache, `retained-${randomUUID()}`); await guard(paths, retained);
    if (replace) { await guard(paths, live); await fs.rename(live, retained); }
    try { await fs.rename(temporary, live); } catch (error) { if (replace) { try { await fs.lstat(live); } catch (absent) { if ((absent as NodeJS.ErrnoException).code === 'ENOENT') await fs.rename(retained, live); } } throw error; }
  }
  await verifyQwenGGUFRuntime(paths, signal, release);
}

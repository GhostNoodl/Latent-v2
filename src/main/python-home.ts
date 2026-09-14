import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import type { AppPaths } from '../shared/types';
import { RUNTIME_RELEASE, validateRuntimePaths, containedPath, runtimeEnvironment } from './runtime-config';
import { withStoppedBackendLock } from './reviewed-asset-lock';

const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function safeFile(paths: AppPaths, filename: string, max = 4096) {
  validateRuntimePaths({ ...paths, python: filename });
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) throw new Error('Private Python configuration requires a bounded, unlinked file.');
  return fs.readFileSync(filename);
}
function durableNew(filename: string, data: string | Buffer) {
  const fd = fs.openSync(filename, 'wx');
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Called only by stopped ManagedBackend startup, never by read-only runtime/hardware inspection. */
export async function normalizePrivatePythonHome(paths: AppPaths, signal: AbortSignal, isStopped: () => boolean) {
  if (process.platform !== 'win32') return { changed: false };
  const config = path.join(path.dirname(path.dirname(paths.python)), 'pyvenv.cfg');
  const exactHome = path.join(paths.cache, 'runtime', 'python', `cpython-${RUNTIME_RELEASE.pythonVersion}-windows-x86_64-none`);
  const exactPython = path.join(exactHome, 'python.exe');
  // The helper must run the pinned base interpreter; the venv may still contain a stale alias.
  validateRuntimePaths({ ...paths, python: exactPython });
  const executable = fs.lstatSync(exactPython);
  if (!executable.isFile() || executable.nlink !== 1) throw new Error('The pinned private Python interpreter is unavailable or linked.');
  if (!isStopped()) throw new Error('Stop the owned backend before normalizing private Python paths.');
  return withStoppedBackendLock({ ...paths, python: exactPython }, signal, async ownedSignal => {
    ownedSignal.throwIfAborted(); if (!isStopped()) throw new Error('Backend startup was cancelled before Python path normalization.');
    const before = safeFile(paths, config), text = before.toString('utf8');
    const fields = new Map<string, string>();
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const match = /^([a-z_-]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match || fields.has(match[1]) || !['home', 'implementation', 'version_info', 'uv', 'include-system-site-packages', 'prompt'].includes(match[1])) throw new Error('Unrecognized private pyvenv.cfg; no configuration was changed.');
      fields.set(match[1], match[2]);
    }
    // uv can record only major.minor when reusing its private version alias.
    // The live exact interpreter below remains the patch-version authority.
    const versions = [RUNTIME_RELEASE.pythonVersion, RUNTIME_RELEASE.pythonVersion.split('.').slice(0, 2).join('.')];
    if (fields.get('implementation') !== 'CPython' || !versions.includes(fields.get('version_info') ?? '') || fields.get('uv') !== RUNTIME_RELEASE.uvVersion || fields.get('include-system-site-packages') !== 'false') throw new Error('Private Python configuration does not match the reviewed environment.');
    const oldHome = fields.get('home'); if (!oldHome || !path.isAbsolute(oldHome)) throw new Error('Private Python home is not an absolute path.');
    const physicalHome = fs.realpathSync.native(exactHome);
    let oldPhysical: string;
    try { oldPhysical = fs.realpathSync.native(oldHome); }
    catch { throw new Error('The previous private Python home is unavailable. Open this portable app once in the original launch environment to verify its physical location; no home path was guessed or changed.'); }
    if (path.relative(physicalHome, oldPhysical) !== '') throw new Error('The previous Python home does not resolve to the exact pinned private interpreter. No configuration was changed.');
    containedPath(fs.realpathSync.native(paths.root), oldPhysical);
    const version = await new Promise<string>((resolve, reject) => {
      execFile(exactPython, ['-I', '-B', '-c', 'import sys; print(sys.version.split()[0])'], { cwd: paths.runtime, env: runtimeEnvironment(paths), windowsHide: true, timeout: 10_000, maxBuffer: 8192, signal: ownedSignal }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()));
    });
    if (version !== RUNTIME_RELEASE.pythonVersion) throw new Error('The private interpreter does not report the pinned Python version. No configuration was changed.');
    ownedSignal.throwIfAborted(); if (!isStopped()) throw new Error('Backend startup was cancelled during Python version verification.');
    if (path.relative(physicalHome, oldHome) === '') return { changed: false };
    const after = Buffer.from(text.replace(/^(home\s*=\s*)[^\r\n]+/m, (_line, prefix: string) => `${prefix}${physicalHome}`));
    const directory = path.join(paths.runtime, 'config-backups'); validateRuntimePaths({ ...paths, python: path.join(directory, 'probe') }); fs.mkdirSync(directory, { recursive: true });
    const id = randomUUID(), backup = path.join(directory, `pyvenv-${id}.cfg`), receipt = path.join(directory, `pyvenv-${id}.json`), temporary = `${config}.${id}.tmp`;
    const evidence = { schema: 1, kind: 'private-python-home-normalization', status: 'prepared', createdAt: new Date().toISOString(), config, backup, previousHome: oldHome, physicalHome, beforeSha256: sha(before), afterSha256: sha(after), changedKeys: ['home'], packagesChanged: false };
    durableNew(backup, before); durableNew(receipt, JSON.stringify(evidence, null, 2)); durableNew(temporary, after);
    ownedSignal.throwIfAborted(); if (!isStopped() || !safeFile(paths, config).equals(before)) throw new Error('Private Python configuration changed during preparation. Original backup and prepared receipt were retained.');
    fs.renameSync(temporary, config);
    const receiptTemporary = `${receipt}.tmp`; durableNew(receiptTemporary, JSON.stringify({ ...evidence, status: 'applied', appliedAt: new Date().toISOString() }, null, 2)); fs.renameSync(receiptTemporary, receipt);
    return { changed: true, backup, receipt };
  });
}

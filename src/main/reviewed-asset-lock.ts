import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AppPaths } from '../shared/types';
import { runtimeEnvironment, validateRuntimePaths } from './runtime-config';

async function stopOwnedHelper(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform !== 'win32') { child.kill('SIGKILL'); return; }
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.once('close', () => resolve()); killer.once('error', reject);
  });
}

/** The OS releases this asset lease on process exit; no stale lock-file takeover race. */
export async function withReviewedAssetLock<T>(paths: AppPaths, identity: string, signal: AbortSignal, operation: (ownedSignal: AbortSignal) => Promise<T>): Promise<T> {
  return withOwnedLock(paths, identity, signal, operation, false);
}

/** Holds the backend launcher's exact owner mutex while a stopped-runtime config is changed. */
export async function withStoppedBackendLock<T>(paths: AppPaths, signal: AbortSignal, operation: (ownedSignal: AbortSignal) => Promise<T>): Promise<T> {
  return withOwnedLock(paths, 'backend-owner', signal, operation, true);
}

async function withOwnedLock<T>(paths: AppPaths, identity: string, signal: AbortSignal, operation: (ownedSignal: AbortSignal) => Promise<T>, backendOwner: boolean): Promise<T> {
  validateRuntimePaths(paths); signal.throwIfAborted();
  if (!/^[a-z0-9-]{1,100}$/.test(identity)) throw new Error('Invalid reviewed asset lock identity.');
  const resolved = fs.realpathSync.native(path.resolve(paths.root)); const canonical = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  const key = createHash('sha256').update(backendOwner ? canonical : `${canonical}\n${identity}`).digest('hex');
  const source = `import sys, os, ctypes
if os.name == 'nt':
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    k.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    k.CreateMutexW.restype = ctypes.c_void_p
    prefix = 'Global\\\\LatentV2Backend-' if sys.argv[3] == 'backend' else 'Global\\\\Latentv2ReviewedAsset_'
    handle = k.CreateMutexW(None, True, prefix + sys.argv[1])
    if not handle: raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183: sys.exit(42)
else:
    import fcntl
    name = 'backend-owner.lock' if sys.argv[3] == 'backend' else '.asset-' + sys.argv[1] + '.lock'
    file = open(os.path.join(sys.argv[2], name), 'a+b')
    try: fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError: sys.exit(42)
print('LOCKED', flush=True)
sys.stdin.buffer.read()
`;
  const child = spawn(paths.python, ['-I', '-B', '-u', '-c', source, key, paths.runtime, backendOwner ? 'backend' : 'asset'], { cwd: paths.root, env: runtimeEnvironment(paths), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr?.on('data', data => { stderr = (stderr + data).slice(-3000); }); child.stdin?.on('error', () => {});
  const closed = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); }); void closed.catch(() => undefined);
  const lost = new AbortController(); const ownedSignal = AbortSignal.any([signal, lost.signal]);
  let releasing = false;
  void closed.then(() => { if (!releasing) lost.abort(new Error('Reviewed asset ownership was lost. The partial download is preserved.')); }, error => lost.abort(error));
  const release = () => { child.stdin?.end(); };
  signal.addEventListener('abort', release, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { release(); void stopOwnedHelper(child).catch(() => {}); reject(new Error('Reviewed asset ownership check timed out.')); }, 15_000);
      let response = ''; const cleanup = () => { clearTimeout(timeout); child.stdout?.off('data', onData); };
      const onData = (data: Buffer) => { response += data.toString(); if (/LOCKED\r?\n/.test(response)) { cleanup(); resolve(); } else if (response.length > 1000) { cleanup(); release(); reject(new Error('Invalid reviewed asset ownership response.')); } };
      child.stdout?.on('data', onData);
    void closed.then(code => { cleanup(); reject(new Error(code === 42 ? (backendOwner ? 'Another Latent process owns this studio backend. Stop it before changing private Python configuration.' : 'Another Latent process is already setting up this reviewed asset. Wait for it to finish, then retry.') : `Reviewed asset ownership helper exited (${code}): ${stderr}`)); }, error => { cleanup(); reject(error); });
    });
    // Keep the lease until the aborted operation has actually stopped writing.
    signal.removeEventListener('abort', release); ownedSignal.throwIfAborted();
    const result = await operation(ownedSignal); ownedSignal.throwIfAborted(); return result;
  } finally {
    signal.removeEventListener('abort', release); releasing = true; release();
    const timer = setTimeout(() => { void stopOwnedHelper(child).catch(() => {}); }, 3000);
    try { await closed.catch(() => undefined); } finally { clearTimeout(timer); }
  }
}

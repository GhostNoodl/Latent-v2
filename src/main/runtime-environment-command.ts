import path from 'node:path';
import { spawn } from 'node:child_process';
import { runtimeEnvironment, validateRuntimePaths } from './runtime-config';
import { safeUpdatePath } from './runtime-update-storage';
import { RuntimeCommandFailure } from './runtime-command-error';
import type { EnvironmentCommand } from './runtime-environments';

/** Owned, bounded preparation commands; never run in a shell or inherit Python configuration. */
export const runEnvironmentCommand: EnvironmentCommand = async (executable, args, paths, signal) => {
  validateRuntimePaths(paths); await safeUpdatePath(paths.root, executable, false); signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: paths.runtime, env: runtimeEnvironment(paths), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let timedOut = false; let stopping = false;
    const stop = () => {
      if (stopping || !child.pid || child.exitCode !== null) return;
      stopping = true;
      if (process.platform === 'win32') {
        const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, 30 * 60_000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    const capture = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (signal.aborted) reject(signal.reason ?? new Error('Environment preparation cancelled.'));
      else if (timedOut) reject(new Error('Private environment preparation timed out. The prior environment was preserved.'));
      else if (code !== 0) {
        const error = new RuntimeCommandFailure(path.basename(executable), code, output);
        error.message = `Private environment preparation failed (${code}): ${output}`;
        reject(error);
      }
      else resolve();
    });
  });
};

import path from 'node:path';
import { spawn } from 'node:child_process';
import { runtimeEnvironment, validateRuntimePaths } from './runtime-config';
import type { AppPaths } from '../shared/types';
import type { ReviewedRuntimeSet } from '../shared/runtime-update-types';
async function privateProbe(paths: AppPaths, source: string, args: string[], signal?: AbortSignal): Promise<any> {
  validateRuntimePaths(paths); signal?.throwIfAborted(); const child = spawn(paths.python, ['-I', '-B', '-c', source, ...args], { cwd: paths.runtime, env: runtimeEnvironment(paths), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; let stopped = false;
  const stop = () => { if (stopped || !child.pid || child.exitCode !== null) return; stopped = true; if (process.platform === 'win32') { const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.on('error', () => {}); } else child.kill('SIGKILL'); };
  const timeout = setTimeout(stop, 60000); signal?.addEventListener('abort', stop, { once: true });
  try { return await new Promise((resolve, reject) => { child.stdout?.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 512 * 1024) stop(); }); child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1000); }); child.once('error', reject); child.once('close', code => { try { signal?.throwIfAborted(); if (code !== 0 || stopped) throw new Error(`The private runtime compatibility probe failed (${code}): ${stderr}`); resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }); }); } finally { clearTimeout(timeout); signal?.removeEventListener('abort', stop); }
}
const packagesSource = `import importlib.metadata,json,platform,re
packages=sorted([{'name':re.sub('[-_.]+','-',d.metadata['Name']).lower(),'version':d.version} for d in importlib.metadata.distributions()],key=lambda x:x['name'])
print(json.dumps({'pythonVersion':platform.python_version(),'packages':packages}))`;
export function reviewedPackagesForObservation(set: Pick<ReviewedRuntimeSet, 'packages' | 'optionalPackageSets'>, observed: Array<{ name: string; version: string }>) {
  const optional = (set.optionalPackageSets ?? []).filter(group => group.length > 0 && group.every(pin => observed.some(item => item.name === pin.name && item.version === pin.version))).flat();
  return [...set.packages, ...optional].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
export function describeEnvironmentDifference(observed: { pythonVersion: string; packages: { name: string; version: string }[] }, expected: Pick<ReviewedRuntimeSet, 'pythonVersion' | 'packages' | 'optionalPackageSets'>): string {
  const differences: string[] = [];
  if (observed.pythonVersion !== expected.pythonVersion) differences.push(`Python: installed ${observed.pythonVersion}, required ${expected.pythonVersion}`);
  const installed = new Map(observed.packages.map(item => [item.name, item.version]));
  const required = new Map(reviewedPackagesForObservation(expected, observed.packages).map(item => [item.name, item.version]));
  for (const name of [...new Set([...installed.keys(), ...required.keys()])].sort()) {
    const actual = installed.get(name), target = required.get(name);
    if (actual !== target) differences.push(`${name}: installed ${actual ?? 'missing'}, required ${target ?? 'not in reviewed set'}`);
  }
  return differences.slice(0, 8).join('; ') + (differences.length > 8 ? `; ${differences.length - 8} more differences` : '');
}
export class RuntimeEnvironmentMismatch extends Error {
  constructor(message: string) { super(message); this.name = 'RuntimeEnvironmentMismatch'; }
}
export async function verifyUpdateEnvironment(paths: AppPaths, set: Pick<ReviewedRuntimeSet, 'pythonVersion' | 'packages' | 'optionalPackageSets'>, signal?: AbortSignal, purpose: 'update' | 'setup' = 'update') {
  const observed = await privateProbe(paths, packagesSource, [], signal); const expected = reviewedPackagesForObservation(set, observed.packages);
  if (observed.pythonVersion !== set.pythonVersion || JSON.stringify(observed.packages) !== JSON.stringify(expected)) throw new RuntimeEnvironmentMismatch(purpose === 'setup'
    ? 'The installed Python/package versions differ from the reviewed setup requirements. Setup is incomplete; check the backend log before retrying.'
    : `The private environment differs from the reviewed runtime. ${describeEnvironmentDifference(observed, set)}. No packages were changed. A separately prepared reviewed environment is required before this runtime can start.`); return observed;
}
const syntaxSource = `import ast,json,pathlib,sys
count=0
for root in sys.argv[1:]:
 for file in pathlib.Path(root).rglob('*.py'):
  if '__pycache__' in file.parts: continue
  ast.parse(file.read_bytes(),filename=str(file)); count+=1
print(json.dumps({'pythonFiles':count}))`;
export async function verifyUpdateSyntax(paths: AppPaths, directories: string[], signal?: AbortSignal) { return privateProbe(paths, syntaxSource, directories, signal) as Promise<{ pythonFiles: number }>; }

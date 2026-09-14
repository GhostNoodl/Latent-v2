import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeCommandFailure } from './runtime-command-error';
import type { AppPaths } from '../shared/types';
import type { ReviewedRuntimeSet } from '../shared/runtime-update-types';
import { RUNTIME_RELEASE, validateRuntimePaths } from './runtime-config';
import { verifyUpdateEnvironment } from './runtime-update-probe';
import { readUpdateJson, safeUpdatePath, writeUpdateJson } from './runtime-update-storage';

const receiptSchema = z.object({
  schema: z.literal(1), id: z.uuid(), setId: z.string().min(1).max(100),
  envelopeSha256: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['preparing', 'ready', 'failed']), createdAt: z.iso.datetime(),
  verifiedAt: z.iso.datetime().optional(), error: z.string().max(1000).optional(),
}).strict();
export type RuntimeEnvironmentReceipt = z.infer<typeof receiptSchema>;
type Envelope = Pick<ReviewedRuntimeSet, 'id' | 'pythonVersion' | 'packages' | 'environmentPreparationBytes'>;
export type EnvironmentCommand = (executable: string, args: string[], paths: AppPaths, signal: AbortSignal) => Promise<unknown>;

function envelope(set: Envelope) {
  if (!/^\d+\.\d+\.\d+$/.test(set.pythonVersion)) throw new Error('Invalid reviewed Python version.');
  if (!set.packages.length || set.packages.length > 2048) throw new Error('Invalid reviewed package envelope.');
  const packages = set.packages.map(item => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.name) || !/^[a-zA-Z0-9][a-zA-Z0-9.+!_-]{0,99}$/.test(item.version)) throw new Error('Invalid reviewed package pin.');
    return { name: item.name, version: item.version };
  }).sort((a, b) => a.name.localeCompare(b.name));
  if (new Set(packages.map(item => item.name)).size !== packages.length) throw new Error('Duplicate reviewed package pin.');
  return { pythonVersion: set.pythonVersion, packages };
}

function identity(set: Envelope) { return createHash('sha256').update(JSON.stringify(envelope(set))).digest('hex'); }

/** Environments stay at their creation paths: Windows venv launchers are not relocatable. */
export function runtimeEnvironmentPaths(paths: AppPaths, id: string) {
  z.uuid().parse(id);
  const directory = path.join(paths.runtime, 'environments', id);
  const venv = path.join(directory, 'venv');
  const selected = { ...paths, python: path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') };
  validateRuntimePaths(selected);
  return { directory, venv, receipt: path.join(directory, 'environment.json'), requirements: path.join(directory, 'requirements.txt'), paths: selected };
}

/** Prepare independently; callers must hold the runtime maintenance/download lease. Never activates. */
export async function prepareRuntimeEnvironment(
  paths: AppPaths, set: Envelope, upstreamRequirements: string, run: EnvironmentCommand, signal: AbortSignal,
  report: (message: string) => void = () => {},
): Promise<RuntimeEnvironmentReceipt> {
  validateRuntimePaths(paths); signal.throwIfAborted();
  const desired = envelope(set); const envelopeSha256 = identity(set);
  const budget = set.environmentPreparationBytes;
  if (!Number.isSafeInteger(budget) || budget! <= 0) throw new Error('This runtime has no reviewed environment preparation space budget.');
  const volume = await fs.statfs(paths.runtime);
  if (volume.bavail * volume.bsize < budget!) throw new Error(`Preparing this runtime requires ${(budget! / 1024 ** 3).toFixed(1)} GiB of free workspace under its reviewed storage budget. Free space and retry; the active runtime was preserved.`);
  await safeUpdatePath(paths.root, upstreamRequirements, false);
  const upstream = await fs.stat(upstreamRequirements);
  if (!upstream.isFile() || upstream.nlink !== 1 || upstream.size > 1024 * 1024) throw new Error('Invalid staged upstream requirements.');
  await safeUpdatePath(paths.root, paths.python, false);
  const uv = path.join(paths.runtime, 'tools', process.platform === 'win32' ? 'uv.exe' : 'uv');
  await safeUpdatePath(paths.root, uv, false);
  const id = randomUUID(); const location = runtimeEnvironmentPaths(paths, id);
  await fs.mkdir(path.dirname(location.directory), { recursive: true });
  await fs.mkdir(location.directory); // A new reservation; never reuse a partial environment.
  const receipt: RuntimeEnvironmentReceipt = { schema: 1, id, setId: set.id, envelopeSha256, state: 'preparing', createdAt: new Date().toISOString() };
  await writeUpdateJson(paths.root, location.receipt, receipt);
  const install = async (args: string[]) => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try { return await run(uv, args, location.paths, signal); }
      catch (error) {
        if (!(error instanceof RuntimeCommandFailure) || !error.retryableLauncherFailure || attempt >= 2) throw error;
        await delay(500 * (attempt + 1), undefined, { signal });
      }
    }
  };
  try {
    await fs.writeFile(location.requirements, desired.packages.map(item => `${item.name}==${item.version}`).join('\n') + '\n', { flag: 'wx' });
    // Use only the studio's existing interpreter. Exact target version is checked
    // before package installation; a Python-version migration needs its own acquisition.
    report('Creating the separate Python environment…');
    await run(uv, ['venv', '--python', paths.python, '--no-project', location.venv], location.paths, signal);
    signal.throwIfAborted();
    await verifyUpdateEnvironment(location.paths, { pythonVersion: set.pythonVersion, packages: [] }, signal);
    const torch = desired.packages.filter(item => ['torch', 'torchvision', 'torchaudio'].includes(item.name));
    if (torch.length) {
      report('Installing GPU libraries in the separate environment. This can take several minutes…');
      await install(['pip', 'install', '--python', location.paths.python, '--default-index', RUNTIME_RELEASE.torchIndex, '--no-deps', ...torch.map(item => `${item.name}==${item.version}`)]);
    }
    signal.throwIfAborted();
    report('Installing the reviewed packages in the separate environment…');
    await install(['pip', 'install', '--python', location.paths.python, '--default-index', 'https://pypi.org/simple', '--index', RUNTIME_RELEASE.torchIndex, '--index-strategy', 'unsafe-best-match', '--constraint', pathToFileURL(location.requirements).href, '--requirements', location.requirements, '--requirements', upstreamRequirements]);
    signal.throwIfAborted();
    report('Verifying the prepared Python and package versions…');
    await verifyUpdateEnvironment(location.paths, set, signal);
    signal.throwIfAborted();
    const ready = { ...receipt, state: 'ready' as const, verifiedAt: new Date().toISOString() };
    await writeUpdateJson(paths.root, location.receipt, ready);
    return ready;
  } catch (error) {
    await writeUpdateJson(paths.root, location.receipt, { ...receipt, state: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) });
    throw error;
  }
}

/** Reopen by identity and recheck packages before a transaction may select it. */
export async function verifiedRuntimeEnvironment(paths: AppPaths, id: string, set: Envelope, signal?: AbortSignal): Promise<AppPaths> {
  const location = runtimeEnvironmentPaths(paths, id);
  const receipt = receiptSchema.parse(await readUpdateJson(paths.root, location.receipt));
  if (receipt.id !== id || receipt.setId !== set.id || receipt.state !== 'ready' || !receipt.verifiedAt || receipt.envelopeSha256 !== identity(set)) throw new Error('The retained runtime environment is incomplete or belongs to another reviewed set.');
  await safeUpdatePath(paths.root, location.paths.python, false);
  await verifyUpdateEnvironment(location.paths, set, signal);
  return location.paths;
}

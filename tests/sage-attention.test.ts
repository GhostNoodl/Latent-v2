import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SageAttentionService } from '../src/main/sage-attention';
import { SAGE_ATTENTION_PACKAGES, SAGE_ATTENTION_WHEELS } from '../src/main/runtime-config';
import type { AppPaths } from '../src/shared/types';

let paths: AppPaths;
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latent sage '));
  paths = {
    root,
    runtime: path.join(root, 'runtime'),
    backend: path.join(root, 'runtime', 'ComfyUI'),
    python: path.join(root, 'runtime', 'venv', 'Scripts', 'python.exe'),
    models: path.join(root, 'models'),
    outputs: path.join(root, 'outputs'),
    inputs: path.join(root, 'inputs'),
    temp: path.join(root, 'temp'),
    user: path.join(root, 'user'),
    cache: path.join(root, 'cache'),
    logs: path.join(root, 'logs'),
    database: path.join(root, 'latent.db'),
  };
  fs.mkdirSync(path.dirname(paths.python), { recursive: true });
  fs.writeFileSync(paths.python, 'fixture');
});
afterEach(() => fs.rmSync(paths.root, { recursive: true, force: true }));

const base = [{ name: 'torch', version: '2.11.0+cu130' }];
const installed = [...base, ...SAGE_ATTENTION_PACKAGES.map(pin => ({ ...pin }))];
const stoppedLock = async <T>(_p: AppPaths, signal: AbortSignal, operation: (s: AbortSignal) => Promise<T>) =>
  operation(signal);

it('reports the add-on as installed only when both pinned packages are present', async () => {
  const probe = vi
    .fn()
    .mockResolvedValueOnce({ pythonVersion: '3.12.13', packages: base })
    .mockResolvedValueOnce({ pythonVersion: '3.12.13', packages: installed });
  const service = new SageAttentionService(paths, () => {}, { probe, platform: 'win32' });
  expect((await service.refresh()).state).toBe('missing');
  expect((await service.refresh()).state).toBe('installed');
});

it('asks for engine setup before the private Python exists', async () => {
  fs.rmSync(paths.python);
  const probe = vi.fn();
  const service = new SageAttentionService(paths, () => {}, { probe, platform: 'win32' });
  expect((await service.refresh()).state).toBe('unavailable');
  expect(probe).not.toHaveBeenCalled();
});

it('is unsupported away from Windows', async () => {
  const service = new SageAttentionService(paths, () => {}, { probe: vi.fn(), platform: 'linux' });
  expect((await service.refresh()).state).toBe('unsupported');
  await expect(service.install()).rejects.toThrow('only available on Windows');
});

it('installs the pinned wheels offline into the private Python', async () => {
  const download = vi.fn(async (asset: { filename: string }, directory: string) =>
    path.join(directory, asset.filename),
  );
  const command = vi.fn(async () => {});
  const probe = vi.fn().mockResolvedValue({ pythonVersion: '3.12.13', packages: installed });
  const service = new SageAttentionService(paths, () => {}, {
    probe,
    download,
    command,
    stoppedLock,
    platform: 'win32',
  });
  await service.install();
  expect(download.mock.calls.map(call => call[0])).toEqual([...SAGE_ATTENTION_WHEELS]);
  const cache = path.join(paths.cache, 'sage-attention');
  expect(command).toHaveBeenCalledWith(
    path.join(paths.runtime, 'tools', 'uv.exe'),
    [
      'pip',
      'install',
      '--python',
      paths.python,
      '--no-deps',
      '--no-index',
      '--offline',
      ...SAGE_ATTENTION_WHEELS.map(wheel => path.join(cache, wheel.filename)),
    ],
    paths,
    expect.any(AbortSignal),
  );
  expect(service.status().state).toBe('installed');
});

it('reports a failed install when the packages still are not there', async () => {
  const service = new SageAttentionService(paths, () => {}, {
    probe: vi.fn().mockResolvedValue({ pythonVersion: '3.12.13', packages: base }),
    download: vi.fn(async (_a, directory: string) => directory),
    command: vi.fn(async () => {}),
    stoppedLock,
    platform: 'win32',
  });
  await expect(service.install()).rejects.toThrow("didn't install correctly");
  expect(service.status().state).toBe('error');
});

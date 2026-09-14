import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ManagedBackend } from '../src/main/managed-backend';
import { RUNTIME_RELEASE } from '../src/main/runtime-config';
import { REVIEWED_RUNTIME_PACKAGES } from '../src/main/runtime-update-packages';
import { verifyUpdateEnvironment } from '../src/main/runtime-update-probe';
import { RuntimeCommandFailure } from '../src/main/runtime-command-error';
import type { AppPaths } from '../src/shared/types';

vi.mock('../src/main/runtime-update-probe', () => ({ verifyUpdateEnvironment: vi.fn() }));
let paths: AppPaths;
let backend: ManagedBackend;
let command: ReturnType<typeof vi.fn>;
beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latent install pins '));
  paths = { root, runtime: path.join(root, 'runtime'), backend: path.join(root, 'runtime', 'ComfyUI'), python: path.join(root, 'runtime', 'venv', 'Scripts', 'python.exe'), models: path.join(root, 'models'), outputs: path.join(root, 'outputs'), inputs: path.join(root, 'inputs'), temp: path.join(root, 'temp'), user: path.join(root, 'user'), cache: path.join(root, 'cache'), logs: path.join(root, 'logs'), database: path.join(root, 'latent.db') };
  fs.mkdirSync(paths.backend, { recursive: true });
  fs.mkdirSync(path.dirname(paths.python), { recursive: true });
  fs.writeFileSync(paths.python, 'fixture');
  fs.writeFileSync(path.join(paths.backend, 'main.py'), '# fixture');
  backend = new ManagedBackend(paths, () => {});
  // Keep real setup orchestration and disk writes; replace network/process boundaries.
  const internals = backend as unknown as { installUv(): Promise<string>; installPython(uv: string): Promise<void>; installSource(): Promise<void>; command(executable: string, args: string[]): Promise<string> };
  vi.spyOn(internals, 'installUv').mockResolvedValue('fixture-uv');
  vi.spyOn(internals, 'installPython').mockResolvedValue();
  vi.spyOn(internals, 'installSource').mockResolvedValue();
  command = vi.spyOn(internals, 'command').mockImplementation(async executable => executable === paths.python
    ? 'LATENT_VERIFY=' + JSON.stringify({ python: RUNTIME_RELEASE.pythonVersion, torch: RUNTIME_RELEASE.torchVersion, cuda: true, gpu: 'fixture GPU' }) : '');
  vi.mocked(verifyUpdateEnvironment).mockReset().mockResolvedValue({});
});
afterEach(async () => {
  await backend.dispose();
  vi.restoreAllMocks();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

it('installs every reviewed package, including transitive pins, and verifies before declaring success', async () => {
  vi.mocked(verifyUpdateEnvironment).mockImplementationOnce(async () => {
    expect(fs.existsSync(path.join(paths.runtime, 'installed.json'))).toBe(false);
    expect(command.mock.calls.some(([, args]) => args.includes('check'))).toBe(true);
    return {};
  });
  await backend.setup();
  const manifest = path.join(paths.runtime, 'reviewed-runtime-requirements.txt');
  expect(fs.readFileSync(manifest, 'utf8').trim().split('\n')).toEqual(REVIEWED_RUNTIME_PACKAGES.map(item => `${item.name}==${item.version}`));
  const installs = command.mock.calls.filter(([, args]) => args.includes('install'));
  expect(installs).toHaveLength(2);
  expect(installs[0][1]).toContain('--no-deps');
  expect(installs[1][1]).toEqual(expect.arrayContaining(['--constraint', pathToFileURL(manifest).href, '--requirements', manifest, path.join(paths.backend, 'requirements.txt')]));
  expect(verifyUpdateEnvironment).toHaveBeenCalledWith(paths, { pythonVersion: RUNTIME_RELEASE.pythonVersion, packages: REVIEWED_RUNTIME_PACKAGES }, expect.any(AbortSignal), 'setup');
  expect(backend.status().state).toBe('stopped');
  expect(fs.existsSync(path.join(paths.runtime, 'installed.json'))).toBe(true);
});

it('refuses success on package drift, leaving setup retryable', async () => {
  vi.mocked(verifyUpdateEnvironment).mockRejectedValueOnce(new Error('Package inventory differs'));
  await expect(backend.setup()).rejects.toThrow('Package inventory differs');
  expect(backend.status().state).toBe('error');
  expect(fs.existsSync(path.join(paths.runtime, 'installed.json'))).toBe(false);
  expect(command.mock.calls.some(([executable]) => executable === paths.python)).toBe(false);
  await backend.setup();
  expect(backend.status().state).toBe('stopped');
});

it('does not change an already installed environment', async () => {
  const marker = JSON.stringify({ ...RUNTIME_RELEASE, sourceSha256: RUNTIME_RELEASE.comfyArchiveSha256 });
  fs.writeFileSync(path.join(paths.runtime, 'installed.json'), marker);
  await backend.setup();
  expect(command).not.toHaveBeenCalled();
  expect(verifyUpdateEnvironment).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(paths.runtime, 'installed.json'), 'utf8')).toBe(marker);
  expect(fs.existsSync(path.join(paths.runtime, 'reviewed-runtime-requirements.txt'))).toBe(false);
});

const launcherFailure = () => new RuntimeCommandFailure('uv.exe', 1, 'error: Failed to update Windows PE resources: uv-trampoline.exe\nCaused by: The system cannot open the device or file specified. (os error -2147024786)');
const deniedLauncher = (name = 'uv-trampoline-17776.exe') => new RuntimeCommandFailure('uv.exe', 1, `error: Failed to update Windows PE resources: C:/test temp/${name}\nCaused by: Access is denied. (os error -2147024891)`);
it('recovers from the clean-install launcher access denial with cached pinned arguments', async () => {
  command.mockRejectedValueOnce(deniedLauncher());
  await backend.setup();
  expect(command.mock.calls[1]).toEqual(command.mock.calls[0]);
  expect(backend.status().state).toBe('stopped');
  expect(verifyUpdateEnvironment).toHaveBeenCalledTimes(1);
});
it('does not retry access denial for an unrelated executable', async () => {
  command.mockRejectedValueOnce(deniedLauncher('unrelated.exe'));
  await expect(backend.setup()).rejects.toThrow('Python package launcher');
  expect(command).toHaveBeenCalledTimes(1);
});
it('limits repeated launcher access denials to three attempts without a success marker', async () => {
  command.mockRejectedValue(deniedLauncher());
  await expect(backend.setup()).rejects.toThrow('Python package launcher');
  expect(command).toHaveBeenCalledTimes(3);
  expect(verifyUpdateEnvironment).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(paths.runtime, 'installed.json'))).toBe(false);
});
it('retries the exact transient launcher failure using identical pinned arguments', async () => {
  command.mockRejectedValueOnce(launcherFailure());
  await backend.setup();
  expect(command.mock.calls[1]).toEqual(command.mock.calls[0]);
  expect(backend.status().state).toBe('stopped');
  expect(verifyUpdateEnvironment).toHaveBeenCalledTimes(1);
});
it('bounds launcher retries and never writes a success marker on exhaustion', async () => {
  command.mockRejectedValue(launcherFailure());
  await expect(backend.setup()).rejects.toThrow('Python package launcher');
  expect(command).toHaveBeenCalledTimes(3);
  expect(verifyUpdateEnvironment).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(paths.runtime, 'installed.json'))).toBe(false);
});
it('does not retry unrelated failures', async () => {
  command.mockRejectedValueOnce(new RuntimeCommandFailure('uv.exe', 1, 'error: No space left on device'));
  await expect(backend.setup()).rejects.toThrow('No space left');
  expect(command).toHaveBeenCalledTimes(1);
});
it('cancellation prevents another package attempt', async () => {
  command.mockImplementationOnce(async () => {
    (backend as unknown as { abort: AbortController }).abort.abort();
    throw launcherFailure();
  });
  await expect(backend.setup()).rejects.toThrow('cancelled');
  expect(command).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(paths.runtime, 'installed.json'))).toBe(false);
});

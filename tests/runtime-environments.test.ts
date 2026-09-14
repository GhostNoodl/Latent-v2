import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeCommandFailure } from '../src/main/runtime-command-error';
import { createPaths } from '../src/main/paths';
import { prepareRuntimeEnvironment, runtimeEnvironmentPaths, verifiedRuntimeEnvironment, type EnvironmentCommand } from '../src/main/runtime-environments';
import { verifyUpdateEnvironment } from '../src/main/runtime-update-probe';
import type { AppPaths } from '../src/shared/types';
vi.mock('../src/main/runtime-update-probe', () => ({ verifyUpdateEnvironment: vi.fn() }));
let paths: AppPaths; let root: string; let requirements: string;
const set = { environmentPreparationBytes: 1024 * 1024, id: 'candidate-test', pythonVersion: '3.12.13', packages: [{ name: 'torch', version: '2.11.0+cu130' }, { name: 'example', version: '2.0' }] };
beforeEach(async () => {
  vi.restoreAllMocks(); vi.resetAllMocks(); vi.mocked(verifyUpdateEnvironment).mockResolvedValue({});
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-environment-test-')); paths = createPaths(root);
  await fs.mkdir(path.dirname(paths.python), { recursive: true }); await fs.writeFile(paths.python, 'original interpreter');
  await fs.mkdir(path.join(paths.runtime, 'tools')); await fs.writeFile(path.join(paths.runtime, 'tools', process.platform === 'win32' ? 'uv.exe' : 'uv'), 'tool fixture');
  requirements = path.join(paths.runtime, 'upstream.txt'); await fs.writeFile(requirements, 'example>=1\n');
});
afterEach(async () => { vi.restoreAllMocks(); if (!path.basename(root).startsWith('latent-environment-test-')) throw new Error('Unsafe cleanup'); await fs.rm(root, { recursive: true, force: true }); });
const run = (): EnvironmentCommand => vi.fn(async (_exe, args, selected) => {
  if (args[0] === 'venv') { await fs.mkdir(path.dirname(selected.python), { recursive: true }); await fs.writeFile(selected.python, 'new interpreter'); }
});
describe('retained runtime environment preparation', () => {
  it('prepares at a permanent path, verifies it, and reopens without changing active paths or files', async () => {
    const original = { ...paths }; const command = run();
    const receipt = await prepareRuntimeEnvironment(paths, set, requirements, command, new AbortController().signal);
    const selected = await verifiedRuntimeEnvironment(paths, receipt.id, set);
    expect(receipt.state).toBe('ready'); expect(selected.python).not.toBe(paths.python); expect(paths).toEqual(original);
    expect(await fs.readFile(paths.python, 'utf8')).toBe('original interpreter');
    const calls = vi.mocked(command).mock.calls;
    expect(calls).toHaveLength(3); expect(calls[0][1]).toContain(paths.python);
    for (const call of calls.slice(1)) { expect(call[1][call[1].indexOf('--python') + 1]).toBe(selected.python); expect(call[2].python).toBe(selected.python); }
    expect(vi.mocked(verifyUpdateEnvironment).mock.calls[0][1]).toEqual({ pythonVersion: set.pythonVersion, packages: [] });
    expect(await fs.readFile(runtimeEnvironmentPaths(paths, receipt.id).requirements, 'utf8')).toBe('example==2.0\ntorch==2.11.0+cu130\n');
  });
  it('retains failed preparation and allocates a distinct environment for retry', async () => {
    const failing = vi.fn(async () => { throw new Error('download interrupted'); });
    await expect(prepareRuntimeEnvironment(paths, set, requirements, failing, new AbortController().signal)).rejects.toThrow('download interrupted');
    const [failedId] = await fs.readdir(path.join(paths.runtime, 'environments'));
    const failed = JSON.parse(await fs.readFile(runtimeEnvironmentPaths(paths, failedId).receipt, 'utf8'));
    expect(failed.state).toBe('failed'); await expect(verifiedRuntimeEnvironment(paths, failedId, set)).rejects.toThrow(/incomplete/);
    const retry = await prepareRuntimeEnvironment(paths, set, requirements, run(), new AbortController().signal);
    expect(retry.id).not.toBe(failedId); expect(await fs.readFile(paths.python, 'utf8')).toBe('original interpreter');
  });
  it('does not publish ready after cancellation at the final verification boundary', async () => {
    const abort = new AbortController();
    vi.mocked(verifyUpdateEnvironment).mockResolvedValueOnce({}).mockImplementationOnce(async () => { abort.abort(); return {}; });
    await expect(prepareRuntimeEnvironment(paths, set, requirements, run(), abort.signal)).rejects.toThrow();
    const [id] = await fs.readdir(path.join(paths.runtime, 'environments'));
    expect(JSON.parse(await fs.readFile(runtimeEnvironmentPaths(paths, id).receipt, 'utf8')).state).toBe('failed');
  });
  it('rejects changed dependency identity and detects post-preparation package drift', async () => {
    const receipt = await prepareRuntimeEnvironment(paths, set, requirements, run(), new AbortController().signal);
    await expect(verifiedRuntimeEnvironment(paths, receipt.id, { ...set, packages: [{ name: 'example', version: '3.0' }] })).rejects.toThrow(/another reviewed set/);
    vi.mocked(verifyUpdateEnvironment).mockRejectedValueOnce(new Error('package drift'));
    await expect(verifiedRuntimeEnvironment(paths, receipt.id, set)).rejects.toThrow('package drift');
    expect(await fs.readFile(paths.python, 'utf8')).toBe('original interpreter');
  });
  it('retries the known transient Windows launcher failure inside the same staged environment', async () => {
    const execute = run(); let failures = 0; const command: EnvironmentCommand = async (exe, args, selected, signal) => {
      if (args[0] === 'pip' && failures++ === 0) throw new RuntimeCommandFailure('uv.exe', 2, 'Failed to update Windows PE resources: os error -2147024786');
      return execute(exe, args, selected, signal);
    };
    const receipt = await prepareRuntimeEnvironment(paths, set, requirements, command, new AbortController().signal);
    expect(receipt.state).toBe('ready'); expect(await fs.readdir(path.join(paths.runtime, 'environments'))).toEqual([receipt.id]);
    expect(await fs.readFile(paths.python, 'utf8')).toBe('original interpreter');
  });
  it('refuses insufficient workspace before creating an environment or running commands', async () => {
    const command = run(); vi.spyOn(fs, 'statfs').mockResolvedValue({ bavail: 1, bsize: 4096 } as any);
    await expect(prepareRuntimeEnvironment(paths, set, requirements, command, new AbortController().signal)).rejects.toThrow(/free workspace/);
    expect(command).not.toHaveBeenCalled(); await expect(fs.stat(path.join(paths.runtime, 'environments'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(paths.python, 'utf8')).toBe('original interpreter');
  });
  it('rejects malformed pins before commands or environment reservations', async () => {
    const command = run();
    await expect(prepareRuntimeEnvironment(paths, { ...set, packages: [{ name: 'example', version: '2.0\nother' }] }, requirements, command, new AbortController().signal)).rejects.toThrow(/pin/);
    expect(command).not.toHaveBeenCalled(); await expect(fs.stat(path.join(paths.runtime, 'environments'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

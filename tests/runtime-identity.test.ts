import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn, type ChildProcess } from 'node:child_process';
import { createPaths } from '../src/main/paths';
import { captureRuntimeIdentity, inventoryRuntimeSource, probeRuntimePython, RUNTIME_IDENTITY_PYTHON } from '../src/main/runtime-identity';
import { canonicalRuntimeJson, runtimeIdentitySchema } from '../src/shared/runtime-identity';
import type { AppPaths } from '../src/shared/types';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
let paths: AppPaths;
const actualProbe = () => Promise.resolve({ version: '3.12.13', implementation: 'CPython' as const, torchVersion: '2.11.0+cu130', torchCudaBuild: '13.0', packages: [{ name: 'zod-fixture', version: '1.2.3' }, { name: 'torch', version: '2.11.0+cu130' }] });
beforeEach(async () => {
  paths = createPaths(await fs.mkdtemp(path.join(os.tmpdir(), 'latent-identity-')));
  await fs.mkdir(paths.backend, { recursive: true }); await fs.mkdir(path.dirname(paths.python), { recursive: true });
  await fs.writeFile(paths.python, 'private interpreter fixture');
  await fs.writeFile(path.join(paths.backend, 'main.py'), '# actual source');
  await fs.writeFile(path.join(paths.backend, 'comfyui_version.py'), '__version__ = "0.34.9"\n');
  await fs.writeFile(path.join(paths.runtime, 'installed.json'), JSON.stringify({ comfyCommit: 'a'.repeat(40), comfyVersion: '0.34.0', sourceSha256: 'b'.repeat(64) }));
  await fs.mkdir(path.join(paths.root, 'custom_nodes', 'my-node'), { recursive: true });
  await fs.writeFile(path.join(paths.root, 'custom_nodes', 'my-node', '__init__.py'), '# current custom code');
  vi.mocked(spawn).mockReset();
});
afterEach(async () => { await fs.rm(paths.root, { recursive: true, force: true }); });

describe('observed runtime identity', () => {
  it('captures actual probe/source data independently of the installed baseline and persists stable identities', async () => {
    const first = await captureRuntimeIdentity(paths, { deviceMode: 'lowvram' }, undefined, actualProbe);
    expect(first.data.comfy.baseline?.version).toBe('0.34.0'); expect(first.data.comfy.observedVersion).toBe('0.34.9');
    expect(first.data.comfy.observedGitCommit).toBeNull(); expect(first.data.python.torchVersion).toBe('2.11.0+cu130');
    expect(first.data.packages.map(item => item.name)).toEqual(['torch', 'zod-fixture']);
    expect(first.data.customNodes[0].name).toBe('my-node'); expect(first.data.launch.deviceMode).toBe('lowvram');
    const second = await captureRuntimeIdentity(paths, { deviceMode: 'lowvram' }, undefined, async () => ({ ...await actualProbe(), packages: (await actualProbe()).packages.reverse() }));
    expect(second.sha256).toBe(first.sha256);
    const stored = await fs.readFile(path.join(paths.runtime, 'identities', `${first.sha256}.json`), 'utf8');
    expect(createHash('sha256').update(stored).digest('hex')).toBe(first.sha256);
    expect(JSON.parse(stored)).toEqual(first.data); expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024 * 1024);
    const manifest = JSON.parse(await fs.readFile(path.join(paths.runtime, 'identities', `${first.data.comfy.source.manifestSha256}.json`), 'utf8'));
    expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(['comfyui_version.py', 'main.py']);
    expect(runtimeIdentitySchema.parse(first)).toEqual(first);
  });

  it('changes identity when installed package versions, actual core code, custom code or device choice change', async () => {
    const base = await captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, actualProbe);
    const packages = await captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, async () => ({ ...await actualProbe(), packages: [{ name: 'torch', version: '2.12.0' }] }));
    expect(packages.sha256).not.toBe(base.sha256);
    await fs.writeFile(path.join(paths.backend, 'main.py'), '# edited source');
    const core = await captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, actualProbe); expect(core.data.comfy.source.manifestSha256).not.toBe(base.data.comfy.source.manifestSha256);
    await fs.writeFile(path.join(paths.root, 'custom_nodes', 'my-node', '__init__.py'), '# custom edit');
    const custom = await captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, actualProbe); expect(custom.data.customNodes[0].source.manifestSha256).not.toBe(core.data.customNodes[0].source.manifestSha256);
    const cpu = await captureRuntimeIdentity(paths, { deviceMode: 'cpu' }, undefined, actualProbe); expect(cpu.sha256).not.toBe(custom.sha256);
  });

  it('excludes model weights, generated/cache files, .env and Git metadata from source identity', async () => {
    const before = await inventoryRuntimeSource(paths.backend);
    for (const directory of ['models', 'output', 'cache', '__pycache__', '.git']) { await fs.mkdir(path.join(paths.backend, directory)); await fs.writeFile(path.join(paths.backend, directory, 'data'), 'ignored'); }
    await fs.writeFile(path.join(paths.backend, 'unmanaged.safetensors'), 'ignored weight'); await fs.writeFile(path.join(paths.backend, '.env'), 'do-not-record');
    expect(await inventoryRuntimeSource(paths.backend)).toEqual(before);
  });

  it('observes only a local Git HEAD and includes source modifications independently', async () => {
    const git = path.join(paths.backend, '.git'); await fs.mkdir(path.join(git, 'refs', 'heads'), { recursive: true });
    await fs.writeFile(path.join(git, 'HEAD'), 'ref: refs/heads/main\n'); await fs.writeFile(path.join(git, 'refs', 'heads', 'main'), `${'c'.repeat(40)}\n`);
    const result = await captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, actualProbe); expect(result.data.comfy.observedGitCommit).toBe('c'.repeat(40)); expect(result.data.comfy.baseline?.commit).toBe('a'.repeat(40));
    await fs.writeFile(path.join(git, 'HEAD'), 'ref: refs/../../secret\n');
    await expect(captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, actualProbe)).rejects.toThrow(/HEAD reference/);
  });

  it('rejects links in source, custom nodes, and the identity destination without following them', async () => {
    const link = path.join(paths.backend, 'outside'); await fs.symlink(paths.outputs, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(inventoryRuntimeSource(paths.backend)).rejects.toThrow(/link|junction/); await fs.unlink(link);
    const custom = path.join(paths.root, 'custom_nodes', 'alias'); await fs.symlink(paths.outputs, custom, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, actualProbe)).rejects.toThrow(/link|junction/); await fs.unlink(custom);
    const identity = path.join(paths.runtime, 'identities'); await fs.rm(identity, { recursive: true, force: true }); await fs.symlink(paths.outputs, identity, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, actualProbe)).rejects.toThrow(/link|junction/); await fs.unlink(identity);
  });

  it('preserves corrupt existing identity artifacts and refuses to relabel them', async () => {
    const first = await captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, actualProbe);
    const file = path.join(paths.runtime, 'identities', `${first.sha256}.json`); await fs.writeFile(file, 'corrupt-original');
    await expect(captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, actualProbe)).rejects.toThrow(/corrupt/);
    expect(await fs.readFile(file, 'utf8')).toBe('corrupt-original');
  });

  it('rejects cancelled work and oversized/malformed Python metadata before publishing an identity', async () => {
    const abort = new AbortController(); abort.abort();
    await expect(captureRuntimeIdentity(paths, { deviceMode: 'auto' }, abort.signal, actualProbe)).rejects.toThrow();
    await expect(captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, async () => ({ ...await actualProbe(), packages: Array.from({ length: 2049 }, () => ({ name: 'a', version: '1' })) }))).rejects.toThrow();
    await expect(captureRuntimeIdentity(paths, { deviceMode: 'auto' }, undefined, async () => ({ ...await actualProbe(), packages: [{ name: 'https://user:secret@example.com', version: '1' }] }))).rejects.toThrow();
    expect((await fs.readdir(path.join(paths.runtime, 'identities'))).filter(name => name.endsWith('.json'))).toEqual([]);
  });

  it('bounds large source files without reading a model-sized payload', async () => {
    const file = await fs.open(path.join(paths.backend, 'oversized.bin'), 'w'); await file.truncate(64 * 1024 * 1024 + 1); await file.close();
    await expect(inventoryRuntimeSource(paths.backend)).rejects.toThrow(/inventory limit/);
  });
});

describe('fixed private Python inspector', () => {
  it('uses isolated CPU-only fixed code and returns sanitized fields without emitting diagnostics', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1234, kill: vi.fn() });
    vi.mocked(spawn).mockImplementationOnce((() => {
      setTimeout(async () => { child.stderr.write('package diagnostics'); child.stdout.write(`LATENT_RUNTIME_IDENTITY=${JSON.stringify(await actualProbe())}\n`); child.emit('close', 0); }, 0);
      return child as unknown as ChildProcess;
    }) as typeof spawn);
    expect(await probeRuntimePython(paths)).toEqual(await actualProbe());
    const [command, args, options] = vi.mocked(spawn).mock.calls[0];
    expect(command).toBe(paths.python); expect(args).toEqual(['-I', '-B', '-c', RUNTIME_IDENTITY_PYTHON]);
    expect(options).toMatchObject({ cwd: paths.runtime, windowsHide: true, env: { CUDA_VISIBLE_DEVICES: '-1', PYTHONDONTWRITEBYTECODE: '1' } });
    expect(RUNTIME_IDENTITY_PYTHON).not.toContain('cuda.is_available'); expect(canonicalRuntimeJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });
});

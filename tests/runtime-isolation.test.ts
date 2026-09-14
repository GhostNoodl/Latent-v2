import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import AdmZip from 'adm-zip';
import type { AppPaths } from '../src/shared/types';
import { backendArguments, containedPath, launcherSource, modelPathsYaml, RUNTIME_RELEASE, runtimeEnvironment, validateRuntimePaths } from '../src/main/runtime-config';
import { extractRuntimeZip, sha256File } from '../src/main/runtime-archive';
import { isManagedSystemStats, ManagedBackend, reserveBackendPort } from '../src/main/managed-backend';

const roots: string[] = [];
function fixture(): AppPaths {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latent-runtime-test-'));
  roots.push(root);
  return { root, runtime: path.join(root, 'runtime'), backend: path.join(root, 'runtime', 'ComfyUI'), python: path.join(root, 'runtime', 'venv', 'Scripts', 'python.exe'), models: path.join(root, 'models'), outputs: path.join(root, 'outputs'), inputs: path.join(root, 'inputs'), temp: path.join(root, 'temp'), user: path.join(root, 'user'), cache: path.join(root, 'cache'), logs: path.join(root, 'logs'), database: path.join(root, 'latent.db') };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('managed runtime isolation', () => {
  it('rejects an existing destination junction before writing outside the extraction tree', async () => {
    const paths = fixture(); const stage = path.join(paths.root, 'stage'); const outside = path.join(paths.root, 'outside');
    fs.mkdirSync(stage); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(stage, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const zip = new AdmZip(); zip.addFile('commit/linked/new.txt', Buffer.from('must not escape'));
    const archive = path.join(paths.root, 'fixture.zip'); zip.writeZip(archive);
    await expect(extractRuntimeZip(archive, stage, 'commit/')).rejects.toThrow(/link|junction/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it('rejects paths that could write into the existing installation or a sibling prefix', () => {
    const paths = fixture();
    expect(() => validateRuntimePaths(paths)).not.toThrow();
    expect(() => validateRuntimePaths({ ...paths, models: path.join(paths.root, '..', 'old-ComfyUI', 'models') })).toThrow(/inside|outside/);
    expect(() => containedPath(paths.root, `${paths.root}-other`)).toThrow(/inside/);
    expect(() => containedPath(paths.root, paths.root)).toThrow(/inside/);
  });

  it('rejects junctions that would redirect model storage outside this app', () => {
    const paths = fixture();
    const other = fixture();
    fs.symlinkSync(other.root, paths.models, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => validateRuntimePaths(paths)).toThrow(/junction|symbolic/);
    fs.unlinkSync(paths.models);
  });

  it('does not inherit Python environments, model tokens, home caches, or package indexes', () => {
    const paths = fixture();
    const environment = runtimeEnvironment(paths, {
      SystemRoot: 'C:\\Windows', PATH: 'C:\\existing-comfy\\python', PYTHONPATH: 'C:\\existing-comfy',
      PYTHONHOME: 'C:\\existing-comfy', VIRTUAL_ENV: 'C:\\old-venv', UV_INDEX: 'https://unexpected.example',
      PIP_EXTRA_INDEX_URL: 'https://unexpected.example', HF_TOKEN: 'not-a-real-token', HOME: 'C:\\old-home',
    });
    for (const name of ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'UV_INDEX', 'PIP_EXTRA_INDEX_URL', 'HF_TOKEN']) expect(environment[name]).toBeUndefined();
    expect(environment.PATH).not.toContain('existing-comfy');
    for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'UV_PYTHON_INSTALL_DIR', 'UV_CACHE_DIR', 'HF_HOME', 'TORCH_HOME', 'CUDA_CACHE_PATH']) {
      expect(environment[name]?.startsWith(paths.root)).toBe(true);
    }
    expect(environment.PYTHONNOUSERSITE).toBe('1');
    expect(environment.UV_NO_CONFIG).toBe('1');
  });

  it('launches only on loopback, with explicit directories, and never silently falls back to CPU', () => {
    const paths = fixture();
    const args = backendArguments(paths, 19023, { deviceMode: 'auto' });
    expect(args[args.indexOf('--listen') + 1]).toBe('127.0.0.1');
    expect(args).toContain('--disable-auto-launch');
    expect(args).toContain('--disable-api-nodes');
    expect(args).not.toContain('--cpu');
    expect(args[args.indexOf('--output-directory') + 1]).toBe(paths.outputs);
    expect(args[args.indexOf('--database-url') + 1]).toContain('comfyui.db');
    expect(backendArguments(paths, 19023, { deviceMode: 'cpu' })).toContain('--cpu');
    expect(backendArguments(paths, 19023, { deviceMode: 'lowvram' })).toContain('--disable-dynamic-vram');
    expect(() => backendArguments(paths, 0)).toThrow();
    expect(modelPathsYaml(paths)).toContain(JSON.stringify(paths.models.replaceAll('\\', '/')));
  });

  it('does not mistake an existing external ComfyUI server for its managed process', () => {
    const paths = fixture();
    const stats = { system: { comfyui_version: RUNTIME_RELEASE.comfyVersion, argv: [path.join(paths.backend, 'main.py')] }, devices: [] };
    expect(isManagedSystemStats(stats, paths)).toBe(true);
    expect(isManagedSystemStats({ ...stats, system: { ...stats.system, argv: ['C:\\existing-ComfyUI\\main.py'] } }, paths)).toBe(false);
    expect(isManagedSystemStats({ system: {}, devices: [] }, paths)).toBe(false);
  });

  it('allocates an unused loopback port instead of competing with ordinary port 8188', async () => {
    const port = await reserveBackendPort();
    expect(port).toBeGreaterThanOrEqual(1024);
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it('has a crash watchdog bound to its specific Electron owner', () => {
    const source = launcherSource();
    expect(source).toContain("os.environ['LATENT_PARENT_PID']");
    expect(source).toContain('WaitForSingleObject');
    expect(source).toContain('os._exit(0)');
    expect(source).toContain('CreateMutexW');
    expect(source).toContain("os.environ['LATENT_BACKEND_ROOT']");
    expect(source).toContain('sys.exit(12)');
  });
});

describe('installation state and archives', () => {
  it('does not mark an incomplete runtime installed and returns detached status snapshots', async () => {
    const paths = fixture();
    fs.mkdirSync(paths.runtime, { recursive: true });
    fs.writeFileSync(path.join(paths.runtime, 'installed.json'), JSON.stringify({ ...RUNTIME_RELEASE, sourceSha256: RUNTIME_RELEASE.comfyArchiveSha256 }));
    const backend = new ManagedBackend(paths, () => undefined);
    expect(backend.status().state).toBe('not-installed');
    const snapshot = backend.status();
    snapshot.logTail.push('external mutation');
    expect(backend.status().logTail).toEqual([]);
    await expect(backend.start()).rejects.toThrow(/Set up/);
    expect(backend.getUrl()).toBeNull();
    await backend.dispose();
    await expect(backend.start()).rejects.toThrow(/disposed/);
  });

  it('recognizes only its pinned successful marker and preserves installation on stop', async () => {
    const paths = fixture();
    fs.mkdirSync(paths.backend, { recursive: true });
    fs.mkdirSync(path.dirname(paths.python), { recursive: true });
    fs.writeFileSync(path.join(paths.backend, 'main.py'), '# test');
    fs.writeFileSync(paths.python, 'test');
    fs.writeFileSync(path.join(paths.runtime, 'installed.json'), JSON.stringify({ ...RUNTIME_RELEASE, sourceSha256: RUNTIME_RELEASE.comfyArchiveSha256 }));
    const backend = new ManagedBackend(paths, () => undefined);
    expect(backend.status().state).toBe('stopped');
    await backend.setup();
    await backend.stop();
    expect(backend.status().state).toBe('stopped');
    expect(fs.existsSync(paths.python)).toBe(true);
    await backend.dispose();
  });

  it('extracts only the expected commit root without overwriting pre-existing files', async () => {
    const paths = fixture();
    const archive = path.join(paths.root, 'source.zip');
    const stage = path.join(paths.root, 'stage');
    const zip = new AdmZip();
    zip.addFile('commit/main.py', Buffer.from('print("test")'));
    zip.writeZip(archive);
    await extractRuntimeZip(archive, stage, 'commit/');
    expect(fs.readFileSync(path.join(stage, 'main.py'), 'utf8')).toContain('test');
    expect(await sha256File(archive)).toMatch(/^[a-f0-9]{64}$/);
    await expect(extractRuntimeZip(archive, stage, 'commit/')).rejects.toThrow();
    await expect(extractRuntimeZip(archive, path.join(paths.root, 'other'), 'different/')).rejects.toThrow(/Unexpected root/);
  });

  it('budgets expanded cached ZIP contents before writing and permits retry after freeing space', async () => {
    const paths = fixture(); const archive = path.join(paths.root, 'compressed.zip'); const stage = path.join(paths.root, 'new', 'stage');
    const payload = Buffer.alloc(4 * 1024 * 1024, 7); const zip = new AdmZip(); zip.addFile('commit/weights.bin', payload); zip.writeZip(archive);
    const originalHash = await sha256File(archive); expect(fs.statSync(archive).size).toBeLessThan(payload.length / 100);
    const capacity = vi.spyOn(fs.promises, 'statfs').mockResolvedValue({ bavail: 256 * 1024 * 1024 + payload.length - 1, bsize: 1 } as fs.StatsFs);
    try {
      await expect(extractRuntimeZip(archive, stage, 'commit/')).rejects.toThrow('Not enough free space to extract');
      expect(fs.existsSync(stage)).toBe(false); expect(await sha256File(archive)).toBe(originalHash);
    } finally { capacity.mockRestore(); }
    await extractRuntimeZip(archive, stage, 'commit/'); expect(fs.readFileSync(path.join(stage, 'weights.bin')).equals(payload)).toBe(true);
    expect(await sha256File(archive)).toBe(originalHash);
  });

  it('validates later archive roots before extracting earlier valid entries', async () => {
    const paths = fixture(); const archive = path.join(paths.root, 'mixed.zip'); const stage = path.join(paths.root, 'mixed-stage');
    const zip = new AdmZip(); zip.addFile('commit/first.py', Buffer.from('valid')); zip.addFile('unexpected/last.py', Buffer.from('wrong root')); zip.writeZip(archive);
    await expect(extractRuntimeZip(archive, stage, 'commit/')).rejects.toThrow('Unexpected root'); expect(fs.existsSync(stage)).toBe(false);
  });
});

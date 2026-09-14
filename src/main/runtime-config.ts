import { storageBoundary } from './storage-locations';
import path from 'node:path';
import fs from 'node:fs';
import type { AppPaths, AppSettings } from '../shared/types';
import type { BackendModelRoot } from '../shared/model-locations';

/** Reviewed against the official release and wheel metadata on 2026-09-04. */
export const RUNTIME_RELEASE = {
  schema: 1,
  comfyVersion: '0.34.0',
  comfyCommit: '12d5279438bfefc058a269eae805ceab6047777f',
  // Digest of the exact commit archive retrieved from GitHub's official codeload endpoint.
  comfyArchiveSha256: 'a3c51a42bc7568d4b57267af3a1aa86a6cb379a199f95a90e8e3679c52651241',
  uvVersion: '0.11.32',
  // Digest published in the official astral-sh/uv release API.
  uvArchiveSha256: 'acfde570451cfdb8689fa159a138ee805ba4e241c466432750302c86254b0984',
  pythonVersion: '3.12.13',
  torchVersion: '2.11.0+cu130',
  torchvisionVersion: '0.26.0+cu130',
  torchaudioVersion: '2.11.0+cu130',
  torchIndex: 'https://download.pytorch.org/whl/cu130',
} as const;

export function containedPath(root: string, target: string): string {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Managed runtime path must be inside its dedicated directory: ${target}`);
  }
  return resolved;
}

/** Reject existing links/junctions that would redirect a managed write into another installation. */
export function validateRuntimePaths(paths: AppPaths): void {
  const root = path.resolve(paths.root);
  if (!path.isAbsolute(paths.root) || root === path.parse(root).root) throw new Error('A dedicated absolute storage directory is required.');
  for (const [key, target] of Object.entries(paths)) {
    if (key === 'root') continue;
    const boundary = storageBoundary(paths, target);
    if (path.resolve(target) !== boundary) containedPath(boundary, target);
    let current = path.resolve(target);
    while (true) {
      try {
        if (fs.lstatSync(current).isSymbolicLink()) throw new Error(`Managed storage cannot use a junction or symbolic link: ${current}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (current === boundary) break;
      current = path.dirname(current);
    }
  }
}

export function runtimeEnvironment(paths: AppPaths, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // Do not inherit another venv, Python search path, uv/pip configuration, or model credentials.
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
    if (inherited[key]) env[key] = inherited[key];
  }
  const runtimeCache = path.join(paths.cache, 'runtime');
  const runtimeHome = path.join(runtimeCache, 'home');
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? 'C:\\Windows';
  env.PATH = [path.dirname(paths.python), path.join(paths.runtime, 'tools'), path.join(systemRoot, 'System32'), systemRoot].join(path.delimiter);
  env.HOME = runtimeHome;
  env.USERPROFILE = runtimeHome;
  env.APPDATA = path.join(runtimeHome, 'AppData', 'Roaming');
  env.LOCALAPPDATA = path.join(runtimeHome, 'AppData', 'Local');
  env.TEMP = path.join(runtimeCache, 'temp');
  env.TMP = env.TEMP;
  env.UV_PYTHON_INSTALL_DIR = path.join(runtimeCache, 'python');
  env.UV_PYTHON_BIN_DIR = path.join(paths.runtime, 'tools');
  env.UV_CACHE_DIR = path.join(runtimeCache, 'uv');
  env.UV_NO_CONFIG = '1';
  env.UV_LINK_MODE = 'copy';
  env.UV_PYTHON_PREFERENCE = 'only-managed';
  env.UV_HTTP_TIMEOUT = '120';
  env.UV_NO_PROGRESS = '1';
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONUTF8 = '1';
  env.PYTHONPYCACHEPREFIX = path.join(runtimeCache, 'pycache');
  env.PIP_CONFIG_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.PIP_CACHE_DIR = path.join(runtimeCache, 'pip');
  env.HF_HOME = path.join(runtimeCache, 'huggingface');
  env.HF_HUB_DISABLE_TELEMETRY = '1';
  env.TORCH_HOME = path.join(runtimeCache, 'torch');
  env.XDG_CACHE_HOME = runtimeCache;
  env.MPLCONFIGDIR = path.join(runtimeCache, 'matplotlib');
  env.TRITON_CACHE_DIR = path.join(runtimeCache, 'triton');
  env.CUDA_CACHE_PATH = path.join(runtimeCache, 'cuda');
  return env;
}

export function backendArguments(paths: AppPaths, port: number, settings?: Pick<AppSettings, 'deviceMode'>): string[] {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid managed backend port.');
  const args = [
    '-s', path.join(paths.runtime, 'comfy-launcher.py'),
    '--listen', '127.0.0.1', '--port', String(port),
    '--base-directory', paths.root,
    '--extra-model-paths-config', path.join(paths.runtime, 'extra-model-paths.yaml'),
    '--input-directory', paths.inputs,
    '--output-directory', paths.outputs,
    '--temp-directory', paths.temp,
    '--user-directory', paths.user,
    '--database-url', `sqlite:///${path.join(paths.user, 'comfyui.db').replaceAll('\\', '/')}`,
    '--disable-auto-launch', '--disable-api-nodes',
    '--preview-method', 'latent2rgb', '--log-stdout',
  ];
  if (settings?.deviceMode === 'cpu') args.push('--cpu');
  if (settings?.deviceMode === 'lowvram') args.push('--lowvram', '--disable-dynamic-vram');
  return args;
}

export function modelPathsYaml(paths: AppPaths, externalRoots: readonly BackendModelRoot[] = []): string {
  // JSON strings are YAML-safe scalars, including Windows paths, spaces, and punctuation.
  const scalar = (value: string) => JSON.stringify(value.replaceAll('\\', '/'));
  if (externalRoots.length > 32) throw new Error('Too many reusable model directory mappings.');
  const ids = new Set<string>();
  const mappings = externalRoots.map(root => {
    if (!/^root_[a-f0-9-]{36}$/.test(root.id) || ids.has(root.id) || !['checkpoint', 'lora'].includes(root.kind) || !path.isAbsolute(root.path) || /[\r\n\u0000]/.test(root.path) || root.path.length > 2000) throw new Error('Invalid approved model directory mapping.');
    ids.add(root.id);
    return `latentv2_external_${root.id}:\n  is_default: false\n  ${root.kind === 'checkpoint' ? 'checkpoints' : 'loras'}: ${scalar(root.path)}\n`;
  }).join('');
  return `latentv2:\n  base_path: ${scalar(paths.models)}\n  is_default: true\n  checkpoints: checkpoints\n  loras: loras\n  vae: vae\n  embeddings: embeddings\n  controlnet: controlnet\n  upscale_models: upscale_models\n  diffusion_models: diffusion_models\n  text_encoders: text_encoders\n  clip_vision: clip_vision\nlatentv2_qwen_loras:\n  base_path: ${scalar(paths.models)}\n  is_default: false\n  loras: qwen-edit-loras\nlatentv2_video_loras:\n  base_path: ${scalar(paths.models)}\n  is_default: false\n  loras: video-loras\n${mappings}`;
}

/** A dead Electron owner cannot leave an untracked GPU server behind after a crash. */
export function launcherSource(): string {
  return `import os, sys, threading, runpy, time, hashlib
parent_pid = int(os.environ['LATENT_PARENT_PID'])
backend_main = os.environ['LATENT_BACKEND_MAIN']
studio_root = os.path.normcase(os.path.realpath(os.environ['LATENT_BACKEND_ROOT']))
# The OS releases ownership even if Electron or Python is killed. A second app,
# verifier, or session must not start a server against this studio's database.
if os.name == 'nt':
    import ctypes
    from ctypes import wintypes
    owner_kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    owner_kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
    owner_kernel.CreateMutexW.restype = wintypes.HANDLE
    owner_kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    mutex_name = 'Global\\\\LatentV2Backend-' + hashlib.sha256(studio_root.encode('utf-8')).hexdigest()
    owner_mutex = owner_kernel.CreateMutexW(None, True, mutex_name)
    if not owner_mutex:
        raise ctypes.WinError(ctypes.get_last_error())
    if ctypes.get_last_error() == 183:
        owner_kernel.CloseHandle(owner_mutex)
        print('Another Latent v2 backend already owns this studio. Close the other app or verification run before starting.', file=sys.stderr, flush=True)
        sys.exit(12)
else:
    import fcntl
    owner_lock = open(os.path.join(studio_root, 'runtime', 'backend-owner.lock'), 'a')
    try: fcntl.flock(owner_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('Another Latent v2 backend already owns this studio.', file=sys.stderr, flush=True)
        sys.exit(12)
def watch_owner():
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x00100000, False, parent_pid)
        if not handle: os._exit(1)
        kernel.WaitForSingleObject(handle, 0xFFFFFFFF)
        kernel.CloseHandle(handle)
        os._exit(0)
    else:
        while True:
            if os.getppid() != parent_pid: os._exit(0)
            time.sleep(2)
threading.Thread(target=watch_owner, daemon=True).start()
sys.path.insert(0, os.path.dirname(backend_main))
sys.argv[0] = backend_main
runpy.run_path(backend_main, run_name='__main__')
`;
}

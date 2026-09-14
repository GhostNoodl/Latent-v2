import { readStorageLocations } from './storage-locations';
import path from 'node:path';
import fs from 'node:fs';
import type { AppPaths } from '../shared/types';
export function inside(base: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
export function containedPath(base: string, ...parts: string[]): string {
  const result = path.resolve(base, ...parts);
  if (!inside(base, result)) throw new Error('The requested path is outside this studio.');
  return result;
}
export function createPaths(root: string): AppPaths {
  if (!path.isAbsolute(root)) throw new Error('The studio folder must be an absolute path.');
  const marker = path.join(root, '.latentv2-root.json');
  if (fs.existsSync(root) && !fs.existsSync(marker) && fs.readdirSync(root).length) {
    throw new Error('This folder already contains files and is not a Latent v2 studio. Choose an empty location.');
  }
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('The studio folder cannot be a symbolic link.');
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify({ application: 'latent-v2', schema: 1 }), { flag: 'wx' });
  const alternate = readStorageLocations(root);
  const runtime = path.join(root, 'runtime');
  const result: AppPaths = {
    root, runtime, backend: path.join(runtime, 'ComfyUI'),
    python: path.join(runtime, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    models: alternate.models ?? path.join(root, 'models'), outputs: alternate.outputs ?? path.join(root, 'outputs'), inputs: path.join(root, 'inputs'),
    temp: path.join(root, 'temp'), user: path.join(root, 'comfy-user'), cache: path.join(root, 'cache'),
    logs: path.join(root, 'logs'), database: path.join(root, 'studio.sqlite'),
  };
  for (const folder of [result.runtime, result.models, result.outputs, result.inputs, result.temp, result.user, result.cache, result.logs, path.join(result.models, 'checkpoints'), path.join(result.models, 'loras')]) {
    fs.mkdirSync(folder, { recursive: true });
    if (fs.lstatSync(folder).isSymbolicLink()) throw new Error(`Studio directory cannot be a symbolic link: ${folder}`);
  }
  return result;
}

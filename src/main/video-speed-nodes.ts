import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AppPaths } from '../shared/types';
import { assistantHash, downloadAssistantAsset } from './assistant-download';
import { containedPath, validateRuntimePaths } from './runtime-config';

/**
 * Small engine node that picks the attention kernel for the video model only. It ships inside the app and is
 * written into the studio's custom_nodes folder before every engine start, so it always matches this version.
 */
export const VIDEO_ATTENTION_DIRECTORY = 'latent_video_attention';
export const VIDEO_ATTENTION_SOURCE = `"""Latent: per-model attention choice for the H3 video model (normal or Sage)."""


class LatentVideoAttention:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"model": ("MODEL",), "attention": (["normal", "sage"],)}}

    RETURN_TYPES = ("MODEL",)
    FUNCTION = "patch"
    CATEGORY = "Latent/video"

    def patch(self, model, attention):
        import comfy.ldm.modules.attention as kernels
        if attention == "sage":
            if not kernels.SAGE_ATTENTION_IS_AVAILABLE:
                raise RuntimeError("SageAttention isn't installed in the engine. Install it in Settings or pick Normal.")
            chosen = kernels.attention_sage
        else:
            chosen = kernels.attention_pytorch
        clone = model.clone()
        clone.set_model_optimized_attention(chosen)
        return (clone,)


NODE_CLASS_MAPPINGS = {"LatentVideoAttention": LatentVideoAttention}
`;
export const VIDEO_ATTENTION_FILE = Object.freeze({
  filename: '__init__.py',
  bytes: Buffer.byteLength(VIDEO_ATTENTION_SOURCE),
  sha256: createHash('sha256').update(VIDEO_ATTENTION_SOURCE).digest('hex'),
});

/** Writes the attention node if it is missing or out of date. Called with the engine stopped. */
export async function installVideoAttentionNode(paths: AppPaths): Promise<void> {
  const directory = path.join(paths.root, 'custom_nodes', VIDEO_ATTENTION_DIRECTORY);
  const filename = path.join(directory, VIDEO_ATTENTION_FILE.filename);
  try {
    if ((await fs.promises.readFile(filename, 'utf8')) === VIDEO_ATTENTION_SOURCE) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fs.promises.mkdir(directory, { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, VIDEO_ATTENTION_SOURCE);
  await fs.promises.rename(temporary, filename);
}

/** Kijai's Sol-Attn (Apache-2.0), pinned and checked file by file. Needs only torch and triton. */
const SOL_REPOSITORY = 'kijai/ComfyUI-SolAttn_triton';
const SOL_REVISION = '26d816ebd4f1e43a2c6e4d4759be3137f10a7a73';
const SOL_FILES: readonly [string, number, string][] = [
  ['__init__.py', 32017, '2ba280f7e7b988f6b33558ddeafda2f3e4be8ddf99e4c814f3f2832fa7dfb6a6'],
  ['_autotune_log.py', 3938, '665b045b0aa7410110591b75f06f7726e84547001bc553cd2428bdd0910e4c4f'],
  ['_fused_prep.py', 4020, 'f484c118206a71a3066504c7b23bb0235d9d8e3630195ccd801bd6d4bf4e240e'],
  ['_fused_quant.py', 4341, '1d80718d0e7cb6078eafc91cc415359631100eb3ffbcaf35d5cd7c3fcd696a81'],
  ['_int8_fwd.py', 19215, 'bff511d577c8f51c999c5b1137af5be1a6f92ec68c9b1a4e9fcf6dacccc714b7'],
  ['_morton_h3.py', 10309, '0f831e27ac01323213a5d91c1ee0929f94e372ea93b61208cf7576efb51b4e20'],
  ['_morton.py', 6634, '25ea60d60d9dc2b77ecafc98496cb1171cda0dfa2a5c3041cedbdc177dfdb2fa'],
  ['_preprocess.py', 8369, '4a972b573706a3603cfbbf73988d1b18ba4671f8d435dc18bd02f9036224b7a0'],
  ['_tri_fwd.py', 16012, '09749207cad09091a7e3ab76a8c1a12121d4848f8cd4eb164639cc22684b892a'],
  ['LICENSE', 11558, '1eb85fc97224598dad1852b5d6483bbcf0aa8608790dcc657a5a2a761ae9c8c6'],
  ['readme.md', 2587, '4fa66078c041e070678b60e5f4623c3c76389ffa57a6bd127071d9523f46239a'],
];
export const SOL_ATTENTION_RELEASE = Object.freeze({
  repository: SOL_REPOSITORY,
  revision: SOL_REVISION,
  license: 'Apache-2.0',
  files: SOL_FILES.map(([filename, bytes, sha256]) => ({
    filename,
    bytes,
    sha256,
    url: `https://raw.githubusercontent.com/${SOL_REPOSITORY}/${SOL_REVISION}/${filename}`,
  })),
});

/** Folder of the optional Sol add-on inside the studio's custom_nodes. */
export const SOL_ATTENTION_DIRECTORY = 'latent_sol_attention';

/** Downloads Sol into a cache, checks every file, then swaps it into custom_nodes. Called with the engine stopped. */
export async function installSolAttention(paths: AppPaths, signal: AbortSignal): Promise<void> {
  validateRuntimePaths(paths);
  const stage = containedPath(paths.cache, path.join(paths.cache, 'sol-attention', SOL_REVISION));
  await fs.promises.mkdir(stage, { recursive: true });
  for (const asset of SOL_ATTENTION_RELEASE.files) await downloadAssistantAsset(asset, stage, signal, () => undefined);
  const nodes = path.join(paths.root, 'custom_nodes');
  const live = containedPath(paths.root, path.join(nodes, SOL_ATTENTION_DIRECTORY));
  const next = `${live}.${process.pid}.new`;
  await fs.promises.rm(next, { recursive: true, force: true });
  await fs.promises.mkdir(next, { recursive: true });
  for (const asset of SOL_ATTENTION_RELEASE.files) {
    const target = path.join(next, asset.filename);
    await fs.promises.copyFile(path.join(stage, asset.filename), target);
    if ((await assistantHash(target, signal)) !== asset.sha256)
      throw new Error('A Sol file didn’t copy cleanly. Try again.');
  }
  await fs.promises.rm(live, { recursive: true, force: true });
  await fs.promises.rename(next, live);
}
export function solAttentionInstalled(paths: AppPaths): boolean {
  try {
    return fs.statSync(path.join(paths.root, 'custom_nodes', SOL_ATTENTION_DIRECTORY, '__init__.py')).isFile();
  } catch {
    return false;
  }
}

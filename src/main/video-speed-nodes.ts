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

/** Kijai's Sol-Attn (Apache-2.0), pinned and checked file by file. Needs only torch and triton.
 * Sizes and hashes are of the files as GitHub serves them (LF line endings, not a Windows checkout). */
const SOL_REPOSITORY = 'kijai/ComfyUI-SolAttn_triton';
const SOL_REVISION = '26d816ebd4f1e43a2c6e4d4759be3137f10a7a73';
const SOL_FILES: readonly [string, number, string][] = [
  ['__init__.py', 31333, '76dcbf6f5c58c1f655ee674aecddb165c6069408bc6058e3a5b2383d7198509f'],
  ['_autotune_log.py', 3834, 'c9156e74f4cb8ed9e2be16c08885415c96daa093153fedcf0461e6868e9fa3bb'],
  ['_fused_prep.py', 3919, '970d9756033b5c4a992b48bb656e5a365a21380b16d5af4ed7a51b71a4cbd9ca'],
  ['_fused_quant.py', 4225, '24b36b7d8fe31bd3c7eb2259dc8eb7f63ceed2ee0aa340abc2bdedac78152502'],
  ['_int8_fwd.py', 18754, '17b42a3481e65539493bf0abc0a29f081ca53c02d0f72d4ce32a2a637f378547'],
  ['_morton_h3.py', 10069, '6c6468f3469bf3b66b68a2515632511ab56d0ebe31ce19d8603a6d3f0991a2e5'],
  ['_morton.py', 6478, '513dbcd50c97f99d4163eb42ff1f02809d372d702feaa061367ae7c5199066c6'],
  ['_preprocess.py', 8086, 'efe30d6aa72debd04c5f78860cdfb01e98cfa8503e4603d8392aca42af1dd8ee'],
  ['_tri_fwd.py', 15575, '4d2a8a1ae1524e5a1e2d52a034bfdfd42ba6c1cf3e1f03d29b877f2f57974b24'],
  ['LICENSE', 11357, 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4'],
  ['readme.md', 2514, '5da2b8e587c305d4870a39fac0e97c8c1a020ca923459dd93b9d5dcd45ee961e'],
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

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AppPaths } from '../shared/types';

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

/** Folder of the optional Sol add-on inside the studio's custom_nodes. */
export const SOL_ATTENTION_DIRECTORY = 'latent_sol_attention';
export function solAttentionInstalled(paths: AppPaths): boolean {
  try {
    return fs.statSync(path.join(paths.root, 'custom_nodes', SOL_ATTENTION_DIRECTORY, '__init__.py')).isFile();
  } catch {
    return false;
  }
}

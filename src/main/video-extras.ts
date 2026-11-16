import fs from 'node:fs';
import path from 'node:path';
import type { AppPaths } from '../shared/types';
import {
  VIDEO_EXTRA_SUBFOLDER,
  VIDEO_EXTRAS,
  videoExtraBytes,
  type VideoExtraFile,
  type VideoExtraId,
  type VideoExtrasStatus,
} from '../shared/video-extras';
import { downloadAssistantAsset } from './assistant-download';
import { containedPath, validateRuntimePaths } from './runtime-config';

export function videoExtraPath(paths: AppPaths, file: VideoExtraFile) {
  return containedPath(paths.models, path.join(paths.models, file.folder, VIDEO_EXTRA_SUBFOLDER, file.filename));
}
function present(paths: AppPaths, file: VideoExtraFile) {
  try {
    const stat = fs.statSync(videoExtraPath(paths, file));
    return stat.isFile() && stat.size === file.bytes;
  } catch {
    return false;
  }
}

/** Downloads the smoother and upscaler files on request. Each file is checked against its pinned hash. */
export class VideoExtrasService {
  private installing?: { id: VideoExtraId; progress: number; controller: AbortController };
  private error?: string;
  constructor(
    private paths: AppPaths,
    private changed: () => void,
  ) {}
  installed(id: VideoExtraId) {
    return VIDEO_EXTRAS[id].files.every(file => present(this.paths, file));
  }
  status(): VideoExtrasStatus {
    return {
      installed: { rife: this.installed('rife'), film: this.installed('film'), seedvr2: this.installed('seedvr2') },
      ...(this.installing ? { installing: { id: this.installing.id, progress: this.installing.progress } } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
  /** Throws a plain message when a finishing step's files aren't there. */
  assertInstalled(ids: readonly VideoExtraId[]) {
    for (const id of ids)
      if (!this.installed(id)) throw new Error(`Get the ${VIDEO_EXTRAS[id].label.toLowerCase()} files first.`);
  }
  async install(id: VideoExtraId, signal?: AbortSignal): Promise<void> {
    if (!(id in VIDEO_EXTRAS)) throw new Error('Pick a finishing step to download.');
    if (this.installing) throw new Error('Another download is running. Wait for it to finish.');
    validateRuntimePaths(this.paths);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.installing = { id, progress: 0, controller };
    this.error = undefined;
    this.changed();
    const total = videoExtraBytes(id);
    let done = 0;
    let last = 0;
    try {
      for (const file of VIDEO_EXTRAS[id].files) {
        if (present(this.paths, file)) {
          done += file.bytes;
          continue;
        }
        const directory = path.dirname(videoExtraPath(this.paths, file));
        await fs.promises.mkdir(directory, { recursive: true });
        await downloadAssistantAsset(
          { url: file.url, filename: file.filename, bytes: file.bytes, sha256: file.sha256 },
          directory,
          controller.signal,
          received => {
            if (!this.installing) return;
            this.installing.progress = Math.min(1, (done + received) / total);
            if (Date.now() - last > 500) {
              last = Date.now();
              this.changed();
            }
          },
        );
        done += file.bytes;
      }
    } catch (error) {
      this.error = controller.signal.aborted
        ? 'Download stopped. It picks up where it left off next time.'
        : `Download failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new Error(this.error, { cause: error });
    } finally {
      signal?.removeEventListener('abort', abort);
      this.installing = undefined;
      this.changed();
    }
  }
  cancel() {
    this.installing?.controller.abort();
  }
}

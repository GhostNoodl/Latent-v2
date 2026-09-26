import { QWEN21_GGUF_LOADER } from '../shared/qwen21-gguf-release';
import { QWEN_GGUF_RELEASE } from '../shared/qwen-gguf-release';
import { installQwenGGUFRuntime, verifyQwenGGUFRuntime } from './qwen-gguf-runtime';
import type { AppPaths } from '../shared/types';

const release = { ...QWEN21_GGUF_LOADER, wheel: QWEN_GGUF_RELEASE.wheel, packageVersion: QWEN_GGUF_RELEASE.packageVersion };
export const installQwen21GGUFRuntime = (paths: AppPaths, signal: AbortSignal, repair = false) => installQwenGGUFRuntime(paths, signal, repair, release);
export const verifyQwen21GGUFRuntime = (paths: AppPaths, signal?: AbortSignal) => verifyQwenGGUFRuntime(paths, signal, release);

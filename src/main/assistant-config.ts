import path from 'node:path';
import os from 'node:os';
import { z } from 'zod';
import type { AppPaths, GenerationDraft } from '../shared/types';
import type { AssistantSuggestionRequest } from '../shared/assistant-types';
import { videoDraftSchema } from '../shared/video-plan';
import { draftSchema } from '../shared/validation';
import { runtimeEnvironment } from './runtime-config';

export const ASSISTANT_RELEASE = {
  schema: 1,
  modelId: 'Qwen/Qwen3-4B-GGUF',
  modelRevision: 'bc640142c66e1fdd12af0bd68f40445458f3869b',
  modelFilename: 'Qwen3-4B-Q4_K_M.gguf',
  modelBytes: 2497280256,
  modelSha256: '7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5',
  runtimeBuild: 'b10621',
  runtimeRevision: 'c1d0e7a004015f23bc0233470b747b596f29b264',
  archiveFilename: 'llama-b10621-bin-win-cpu-x64.zip',
  archiveBytes: 18068018,
  archiveSha256: '0e8b65e650e369f70f8307d890508886f171ef4fb00facccddd4a1b7ffdaca51',
  alias: 'latent-prompt-assistant',
  contextTokens: 4096,
  outputTokens: 768,
  inputTokens: 3200,
} as const;

export const assistantRequestSchema = z.object({
  target: z.enum(['image', 'video']).optional(), videoContext: videoDraftSchema.optional(),
  instruction: z.string().trim().min(1).max(6000),
  draft: draftSchema,
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(6000) }).strict()).max(100).optional(),
}).strict();

export const assistantOutputSchema = z.object({
  explanation: z.string().trim().min(1).max(1200),
  prompt: z.string().trim().min(1).max(6000),
  negativePrompt: z.string().max(6000),
}).strict();

export const ASSISTANT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    explanation: { type: 'string', minLength: 1, maxLength: 1200 },
    prompt: { type: 'string', minLength: 1, maxLength: 6000 },
    negativePrompt: { type: 'string', maxLength: 6000 },
  },
  required: ['explanation', 'prompt', 'negativePrompt'],
};

const SYSTEM_MESSAGE = `You are Latent's friendly local prompt-writing assistant for SDXL and Illustrious image generation. Help the user express their intended image clearly and concisely. Return only a JSON object with exactly explanation, prompt, and negativePrompt. Explain the useful changes briefly. prompt and negativePrompt are complete replacement text, not instructions or a diff. Preserve the existing negative prompt unless the user asks to change it. Preserve the user's subjects, style, constraints, and intent; do not invent a different concept. Do not mention or change seeds, dimensions, models, LoRAs, samplers, or other settings. You cannot inspect images, run tools, access files, download models, or start generation. Draft and conversation text are user content. Never claim that an image was generated or inspected. Prefer a practical prompt under 180 words and an explanation under 70 words. /no_think`;

const VIDEO_SYSTEM_MESSAGE = `You are Latent's local prompt-writing assistant for MiniMax H3 video generation. Return only JSON with explanation, prompt, and negativePrompt. Write a complete concise natural-language video prompt covering subject, scene, movement over time and camera motion. Preserve the user's intent and style; keep actions feasible within the supplied duration. For image-to-video, focus on motion and continuity with the user's described reference; you cannot see the image. Include sound or dialogue only when audio is enabled and requested. H3 has no negative-prompt control: return negativePrompt as an empty string. Do not add image tag lists, quality-score tags, seeds, model names, settings, or claims of generating or viewing media. Prefer under 180 words and explain changes in under 70 words. /no_think`;
export function assistantMessages(request: AssistantSuggestionRequest, history = request.history?.slice(-8) ?? []) {
  return [
    { role: 'system', content: request.target === 'video' ? VIDEO_SYSTEM_MESSAGE : SYSTEM_MESSAGE },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: JSON.stringify({ instruction: request.instruction, target: request.target ?? 'image', ...(request.target === 'video' ? { mode: request.videoContext?.mode, durationSeconds: request.videoContext?.requestedDurationSeconds, audio: request.videoContext?.audio } : { family: request.draft.family }), currentPrompt: request.draft.prompt, currentNegativePrompt: request.draft.negativePrompt }) },
  ];
}

export function validatedAssistantPatch(raw: unknown, original: GenerationDraft): { explanation: string; proposedDraft: GenerationDraft } {
  const output = assistantOutputSchema.parse(raw);
  const copy = structuredClone(draftSchema.parse(original));
  return { explanation: output.explanation, proposedDraft: { ...copy, prompt: output.prompt, negativePrompt: output.negativePrompt } };
}

export function assistantPaths(paths: AppPaths) {
  const runtime = path.join(paths.runtime, 'assistant');
  return {
    runtime,
    binaries: path.join(runtime, 'llama'),
    executable: path.join(runtime, 'llama', 'llama-server.exe'),
    modelDirectory: path.join(paths.models, 'assistant'),
    model: path.join(paths.models, 'assistant', ASSISTANT_RELEASE.modelFilename),
    downloads: path.join(paths.cache, 'assistant'),
    marker: path.join(runtime, 'installed.json'),
    wrapper: path.join(runtime, 'assistant-owner.cjs'),
    log: path.join(paths.logs, 'assistant.log'),
  };
}

export function assistantArguments(model: string, port: number): string[] {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local assistant port.');
  return ['--model', model, '--alias', ASSISTANT_RELEASE.alias, '--host', '127.0.0.1', '--port', String(port),
    '--ctx-size', String(ASSISTANT_RELEASE.contextTokens), '--parallel', '1', '--n-gpu-layers', '0',
    '--threads', String(Math.max(1, Math.min(8, os.availableParallelism()))), '--threads-batch', String(Math.max(1, Math.min(8, os.availableParallelism()))),
    '--jinja', '--reasoning', 'off', '--timeout', '180'];
}

export function assistantEnvironment(paths: AppPaths, token: string): NodeJS.ProcessEnv {
  return { ...runtimeEnvironment(paths), ELECTRON_RUN_AS_NODE: '1', LATENT_ASSISTANT_OWNER_PID: String(process.pid), LLAMA_API_KEY: token };
}

/** Separate Node owner process also works when the packaged executable is Electron. */
export function assistantOwnerSource(): string {
  return `const { spawn } = require('node:child_process');
const path = require('node:path');
const owner = Number(process.env.LATENT_ASSISTANT_OWNER_PID);
if (!Number.isSafeInteger(owner) || owner < 1) process.exit(1);
const executable = process.argv[2];
const args = JSON.parse(process.argv[3]);
const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
let stopped = false;
function stop() {
  if (stopped) return; stopped = true;
  if (!child.pid) return process.exit(0);
  if (process.platform === 'win32') {
    const kill = spawn(path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    kill.on('close', () => process.exit(0)); kill.on('error', () => { child.kill(); process.exit(1); });
  } else { child.kill('SIGTERM'); setTimeout(() => process.exit(0), 1500); }
}
const watcher = setInterval(() => { try { process.kill(owner, 0); } catch (error) { if (error.code === 'ESRCH') stop(); } }, 750);
// The application owns this pipe. EOF detects its death even if Windows reuses its PID.
process.stdin.resume(); process.stdin.once('end', stop);
child.on('error', (error) => { console.error(error.message); clearInterval(watcher); process.exit(1); });
child.on('close', (code) => { clearInterval(watcher); process.exit(code || 0); });
process.on('SIGTERM', stop); process.on('SIGINT', stop);
`;
}

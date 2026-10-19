import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AppPaths } from '../shared/types';
import type { AssistantStatus, AssistantSuggestion, AssistantSuggestionRequest } from '../shared/assistant-types';
import type { StudioStore } from './store';
import {
  ASSISTANT_RELEASE as RELEASE,
  ASSISTANT_JSON_SCHEMA,
  assistantArguments,
  assistantEnvironment,
  assistantMessages,
  assistantOwnerSource,
  assistantPaths,
  assistantRequestSchema,
  missingProtectedParts,
  partialAssistantFields,
  validatedAssistantPatch,
} from './assistant-config';
import { assistantHash, downloadAssistantAsset } from './assistant-download';
import { preserveChangedReviewedAsset } from './reviewed-asset-repair';
import { containedPath, validateRuntimePaths } from './runtime-config';
import { extractRuntimeZip } from './runtime-archive';
import { reserveBackendPort } from './managed-backend';
import { activateAssistantRuntime, renameAssistantFile } from './assistant-files';

interface Installation {
  release: typeof RELEASE;
  installedAt: string;
  executableSha256: string;
  runtimeFiles: Record<string, string>;
}
const wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));
const canceled = () => new Error('Assistant request canceled.');
/** The model holds about 2.5 GB of memory, so it unloads after this long without a request. */
export const ASSISTANT_IDLE_MS = 10 * 60_000;

/** CPU-only assistant. Its sole output is a reviewable proposal; it cannot mutate the draft. */
export class PromptAssistant {
  private files;
  private current: AssistantStatus;
  private setupPromise?: Promise<void>;
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private setupController?: AbortController;
  private request?: { id: string; controller: AbortController; promise: Promise<AssistantSuggestion> };
  private child?: ChildProcess;
  private url?: string;
  private token?: string;
  private epoch = 0;
  private disposed = false;
  private idleTimer?: NodeJS.Timeout;

  constructor(
    private paths: AppPaths,
    private store: StudioStore,
    private changed: () => void,
  ) {
    validateRuntimePaths(paths);
    this.files = assistantPaths(paths);
    this.validatePaths();
    const installed = Boolean(this.installation());
    this.current = {
      installationAvailable: installed,
      state: installed ? 'stopped' : 'not-installed',
      message: installed ? 'Ready. It loads when you send a message.' : 'Not installed yet.',
      model: RELEASE.modelId,
      device: 'cpu',
      logTail: [],
    };
  }
  status(): AssistantStatus {
    return structuredClone(this.current);
  }
  private update(patch: Partial<AssistantStatus>) {
    const installationAvailable =
      patch.state && ['error', 'stopped', 'not-installed'].includes(patch.state)
        ? Boolean(this.installation())
        : this.current.installationAvailable;
    this.current = { ...this.current, ...patch, installationAvailable };
    this.changed();
  }
  private log(text: string) {
    const cleaned = text
      .replace(/\x1b\[[0-9;]*m/g, '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => (this.token ? line.replaceAll(this.token, '[private]') : line));
    if (!cleaned.length) return;
    this.update({ logTail: [...this.current.logTail, ...cleaned].slice(-60) });
    try {
      if (fs.existsSync(this.files.log) && fs.statSync(this.files.log).size > 5_000_000)
        fs.renameSync(this.files.log, `${this.files.log}.${Date.now()}`);
      fs.appendFileSync(this.files.log, `${cleaned.join('\n')}\n`);
    } catch {
      /* Diagnostics never make a request fail. */
    }
  }
  private validatePaths() {
    validateRuntimePaths(this.paths);
    for (const filename of Object.values(this.files)) {
      containedPath(storageBoundary(this.paths, filename), filename);
      let cursor = filename;
      while (cursor !== storageBoundary(this.paths, filename)) {
        try {
          if (fs.lstatSync(cursor).isSymbolicLink())
            throw new Error('Assistant storage cannot use symbolic links or junctions.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        cursor = path.dirname(cursor);
      }
    }
  }
  private installation(): Installation | undefined {
    try {
      const marker = JSON.parse(fs.readFileSync(this.files.marker, 'utf8')) as Installation;
      if (
        JSON.stringify(marker.release) !== JSON.stringify(RELEASE) ||
        !/^[a-f0-9]{64}$/.test(marker.executableSha256) ||
        !marker.runtimeFiles ||
        !Object.keys(marker.runtimeFiles).length
      )
        return undefined;
      const model = fs.lstatSync(this.files.model);
      const executable = fs.lstatSync(this.files.executable);
      if (
        model.size !== RELEASE.modelBytes ||
        !model.isFile() ||
        model.isSymbolicLink() ||
        !executable.isFile() ||
        executable.isSymbolicLink()
      )
        return undefined;
      return marker;
    } catch {
      return undefined;
    }
  }
  setup(repair = false): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Assistant was disposed.'));
    if (this.stopPromise) return Promise.reject(new Error('Wait for the assistant to stop before installing.'));
    if (this.setupPromise) return this.setupPromise;
    if (this.child) return Promise.reject(new Error('Stop the assistant before changing its installation.'));
    const controller = new AbortController();
    this.setupController = controller;
    this.setupPromise = this.install(controller.signal, repair)
      .catch(error => {
        const failure =
          error?.code === 'ENOSPC'
            ? new Error('Not enough disk space. Free some space, then press Repair.', { cause: error })
            : error;
        if (!controller.signal.aborted) this.update({ state: 'error', message: `Install failed: ${failure.message}` });
        throw failure;
      })
      .finally(() => {
        this.setupController = undefined;
        this.setupPromise = undefined;
      });
    return this.setupPromise;
  }
  private async install(signal: AbortSignal, repair: boolean) {
    if (process.platform !== 'win32' || process.arch !== 'x64')
      throw new Error('The managed assistant currently supports Windows x64.');
    this.validatePaths();
    for (const directory of [this.files.runtime, this.files.downloads, this.files.modelDirectory, this.paths.logs])
      await fs.promises.mkdir(directory, { recursive: true });
    if (repair) {
      await preserveChangedReviewedAsset(
        this.paths,
        path.join(this.files.downloads, RELEASE.archiveFilename),
        { bytes: RELEASE.archiveBytes, sha256: RELEASE.archiveSha256 },
        signal,
      );
      await preserveChangedReviewedAsset(
        this.paths,
        this.files.model,
        { bytes: RELEASE.modelBytes, sha256: RELEASE.modelSha256 },
        signal,
      );
    }
    this.update({ state: 'installing', message: 'Checking files…', installProgress: 0 });
    const archive = await downloadAssistantAsset(
      {
        filename: RELEASE.archiveFilename,
        url: `https://github.com/ggml-org/llama.cpp/releases/download/${RELEASE.runtimeBuild}/${RELEASE.archiveFilename}`,
        sha256: RELEASE.archiveSha256,
        bytes: RELEASE.archiveBytes,
      },
      this.files.downloads,
      signal,
      (received, total, verifying) =>
        this.update({
          message: verifying ? 'Checking the download…' : 'Downloading the assistant…',
          installProgress: (5 * received) / total,
          receivedBytes: received,
          totalBytes: total,
        }),
    );
    const stage = path.join(this.files.runtime, `llama-stage-${randomUUID()}`);
    await fs.promises.mkdir(stage);
    await extractRuntimeZip(archive, stage);
    signal.throwIfAborted();
    let binaryStage = stage;
    if (!fs.existsSync(path.join(binaryStage, 'llama-server.exe'))) {
      const roots = (await fs.promises.readdir(stage, { withFileTypes: true })).filter(
        entry => entry.isDirectory() && fs.existsSync(path.join(stage, entry.name, 'llama-server.exe')),
      );
      if (roots.length !== 1) throw new Error('The pinned CPU runtime does not contain its expected server.');
      binaryStage = path.join(stage, roots[0].name);
    }
    await downloadAssistantAsset(
      {
        filename: RELEASE.modelFilename,
        url: `https://huggingface.co/${RELEASE.modelId}/resolve/${RELEASE.modelRevision}/${RELEASE.modelFilename}`,
        sha256: RELEASE.modelSha256,
        bytes: RELEASE.modelBytes,
      },
      this.files.modelDirectory,
      signal,
      (received, total, verifying) =>
        this.update({
          message: verifying ? 'Checking the download…' : 'Downloading the assistant…',
          installProgress: 5 + (95 * received) / total,
          receivedBytes: received,
          totalBytes: total,
        }),
    );
    signal.throwIfAborted();
    const runtimeFiles: Record<string, string> = {};
    const inventory = async (directory: string) => {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        const filename = containedPath(binaryStage, path.join(directory, entry.name));
        if (entry.isDirectory()) await inventory(filename);
        else if (entry.isFile())
          runtimeFiles[path.relative(binaryStage, filename)] = await assistantHash(filename, signal);
        else throw new Error('The CPU runtime contains an unexpected filesystem entry.');
      }
    };
    await inventory(binaryStage);
    const installation: Installation = {
      release: RELEASE,
      installedAt: new Date().toISOString(),
      executableSha256: await assistantHash(path.join(binaryStage, 'llama-server.exe'), signal),
      runtimeFiles,
    };
    const marker = `${this.files.marker}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(marker, JSON.stringify(installation, null, 2), { flag: 'wx' });
    this.validatePaths();
    this.update({ message: 'Finishing up…' });
    await activateAssistantRuntime(binaryStage, this.files.binaries, signal, () =>
      renameAssistantFile(marker, this.files.marker, signal),
    );
    this.store.setState('assistant.installation', installation);
    this.update({
      state: 'stopped',
      message: 'Ready. It loads when you send a message.',
      installProgress: 100,
    });
  }
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('Assistant was disposed.'));
    if (this.stopPromise) return Promise.reject(new Error('The assistant is still stopping. Try again in a moment.'));
    if (this.startPromise) return this.startPromise;
    if (this.child && this.url && ['ready', 'thinking'].includes(this.current.state)) return Promise.resolve();
    const epoch = this.epoch;
    this.startPromise = this.launch(epoch)
      .catch(async error => {
        if (epoch === this.epoch) {
          await this.killOwnedChild();
          this.update({ state: 'error', message: `Assistant startup failed: ${error.message}` });
        }
        throw error;
      })
      .finally(() => {
        this.startPromise = undefined;
      });
    return this.startPromise;
  }
  private async launch(epoch: number) {
    if (this.setupPromise) await this.setupPromise;
    this.validatePaths();
    const marker = this.installation();
    if (!marker) throw new Error('Install the assistant first.');
    this.update({ state: 'starting', message: 'Loading the assistant…' });
    for (const [relative, hash] of Object.entries(marker.runtimeFiles)) {
      const filename = containedPath(this.files.binaries, path.join(this.files.binaries, relative));
      if (
        !/^[a-f0-9]{64}$/.test(hash) ||
        fs.lstatSync(filename).isSymbolicLink() ||
        (await assistantHash(filename)) !== hash
      )
        throw new Error('Some assistant files changed. Press Repair to fix them.');
    }
    if (
      (await assistantHash(this.files.executable)) !== marker.executableSha256 ||
      (await assistantHash(this.files.model)) !== RELEASE.modelSha256
    )
      throw new Error('Some assistant files changed. Press Repair to fix them.');
    if (epoch !== this.epoch) throw canceled();
    await fs.promises.writeFile(this.files.wrapper, assistantOwnerSource());
    const port = await reserveBackendPort();
    if (epoch !== this.epoch) throw canceled();
    this.token = randomBytes(32).toString('hex');
    this.url = `http://127.0.0.1:${port}`;
    const env = assistantEnvironment(this.paths, this.token);
    for (const key of ['TEMP', 'HOME', 'APPDATA', 'LOCALAPPDATA'])
      if (env[key]) await fs.promises.mkdir(env[key]!, { recursive: true });
    if (epoch !== this.epoch) throw canceled();
    const child = spawn(
      process.execPath,
      [this.files.wrapper, this.files.executable, JSON.stringify(assistantArguments(this.files.model, port))],
      { cwd: this.files.binaries, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    let spawnError: Error | undefined;
    child.stdout?.on('data', chunk => this.log(String(chunk)));
    child.stderr?.on('data', chunk => this.log(String(chunk)));
    child.on('error', error => {
      spawnError = error;
    });
    child.on('close', code => {
      if (this.child !== child) return;
      this.child = undefined;
      this.url = undefined;
      this.token = undefined;
      if (epoch === this.epoch) {
        this.request?.controller.abort();
        this.update({
          state: 'error',
          requestId: undefined,
          message: `The assistant crashed (code ${code ?? 'unknown'}). Send again to restart it.`,
        });
      }
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (epoch !== this.epoch) throw canceled();
      if (spawnError) throw spawnError;
      if (this.child !== child || child.exitCode !== null)
        throw new Error(`The assistant closed while loading. ${this.current.logTail.slice(-3).join(' ')}`);
      try {
        const health = await this.json('/health', undefined, AbortSignal.timeout(1200));
        if (health.status === 'ok') {
          const models = await this.json('/v1/models', undefined, AbortSignal.timeout(1200));
          if (!Array.isArray(models.data) || !models.data.some((model: { id?: string }) => model.id === RELEASE.alias))
            throw new Error('Unexpected local assistant model.');
          if (epoch !== this.epoch || this.child !== child) throw canceled();
          this.update({ state: 'ready', message: 'Ready.' });
          this.armIdleStop();
          return;
        }
      } catch {
        /* A loading model returns 503. */
      }
      await wait(250);
    }
    throw new Error('The assistant took more than two minutes to load.');
  }
  private async json(endpoint: string, body: unknown, signal: AbortSignal): Promise<any> {
    return (await this.post(endpoint, body, signal)).json();
  }
  private async post(endpoint: string, body: unknown, signal: AbortSignal): Promise<Response> {
    if (!this.url || !this.token) throw new Error('The assistant is not running.');
    let response: Response;
    try {
      response = await fetch(`${this.url}${endpoint}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new Error('Lost the connection to the assistant. Send again to retry.', { cause: error });
    }
    if (!response.ok) throw new Error(`The assistant returned an error (HTTP ${response.status}).`);
    return response;
  }
  /** Reads an OpenAI-style event stream, passing each text piece on as it arrives. */
  private async stream(endpoint: string, body: unknown, signal: AbortSignal, onText: (text: string) => void) {
    const response = await this.post(endpoint, body, signal);
    if (!response.body) throw new Error('The assistant sent an empty reply.');
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason: string | undefined;
    let completionTokens: number | undefined;
    let toolCalls = false;
    const handle = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      const chunk = JSON.parse(data);
      if (chunk.error) throw new Error(`The assistant hit an error: ${chunk.error.message ?? 'unknown'}`);
      const choice = chunk.choices?.[0];
      if (choice?.delta?.tool_calls?.length) toolCalls = true;
      if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
        content += choice.delta.content;
        onText(content);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (Number.isInteger(chunk.usage?.completion_tokens)) completionTokens = chunk.usage.completion_tokens;
    };
    try {
      for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(piece, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          handle(buffer.slice(0, newline).trim());
          buffer = buffer.slice(newline + 1);
        }
      }
      handle(buffer.trim());
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof SyntaxError) throw new Error('The assistant sent a garbled reply. Try again.');
      if (error instanceof Error && error.message.startsWith('The assistant hit an error')) throw error;
      throw new Error('Lost the connection to the assistant. Send again to retry.', { cause: error });
    }
    return { content, finishReason, completionTokens, toolCalls };
  }
  private armIdleStop() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.request || !this.child || this.current.state !== 'ready') return;
      void this.stop('Unloaded after 10 quiet minutes to free memory. It loads again when you send.').catch(
        () => undefined,
      );
    }, ASSISTANT_IDLE_MS);
    this.idleTimer.unref?.();
  }
  suggest(input: AssistantSuggestionRequest): Promise<AssistantSuggestion> {
    if (this.disposed) return Promise.reject(new Error('Assistant was disposed.'));
    if (this.request) return Promise.reject(new Error('Wait for the current reply, or cancel it first.'));
    clearTimeout(this.idleTimer);
    const parsed = assistantRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(parsed.error);
    const request = structuredClone(parsed.data);
    const id = randomUUID();
    const controller = new AbortController();
    const task = { id, controller, promise: undefined as unknown as Promise<AssistantSuggestion> };
    this.request = task;
    task.promise = this.generate(request, task).finally(() => {
      if (this.request === task) {
        this.request = undefined;
        if (this.current.state === 'thinking')
          this.update({
            state: this.child ? 'ready' : 'stopped',
            message: controller.signal.aborted ? 'Reply cancelled.' : 'Ready.',
            requestId: undefined,
            reply: undefined,
          });
        else if (this.current.reply) this.update({ reply: undefined });
        if (this.child) this.armIdleStop();
      }
    });
    return task.promise;
  }
  private async generate(
    request: AssistantSuggestionRequest,
    task: { id: string; controller: AbortController },
  ): Promise<AssistantSuggestion> {
    const started = Date.now();
    const starting = this.start();
    // Cancel the waiting request immediately; starting the shared local server may finish independently.
    await new Promise<void>((resolve, reject) => {
      const aborted = () => reject(task.controller.signal.reason ?? canceled());
      task.controller.signal.addEventListener('abort', aborted, { once: true });
      starting.then(resolve, reject).finally(() => task.controller.signal.removeEventListener('abort', aborted));
      if (task.controller.signal.aborted) aborted();
    });
    task.controller.signal.throwIfAborted();
    const signal = AbortSignal.any([task.controller.signal, AbortSignal.timeout(180_000)]);
    this.update({ state: 'thinking', message: 'Writing…', requestId: task.id, reply: {} });
    const history = request.history?.slice(-8) ?? [];
    let messages = assistantMessages(request, history);
    let promptTokens = 0;
    while (true) {
      const template = await this.json(
        '/apply-template',
        { messages, chat_template_kwargs: { enable_thinking: false } },
        signal,
      );
      if (typeof template.prompt !== 'string') throw new Error('The assistant returned an invalid prompt template.');
      const tokenized = await this.json(
        '/tokenize',
        { content: template.prompt, add_special: false, parse_special: true },
        signal,
      );
      if (!Array.isArray(tokenized.tokens)) throw new Error('The assistant could not count the prompt context.');
      promptTokens = tokenized.tokens.length;
      if (promptTokens <= RELEASE.inputTokens) break;
      if (!history.length)
        throw new Error('That is too much text for the assistant. Shorten your message or prompt and try again.');
      history.shift();
      messages = assistantMessages(request, history);
    }
    let shown = '';
    const response = await this.stream(
      '/v1/chat/completions',
      {
        model: RELEASE.alias,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: RELEASE.outputTokens,
        temperature: 0.7,
        top_p: 0.8,
        top_k: 20,
        min_p: 0,
        presence_penalty: 1.5,
        chat_template_kwargs: { enable_thinking: false },
        reasoning_effort: 'none',
        response_format: { type: 'json_object', schema: ASSISTANT_JSON_SCHEMA },
      },
      signal,
      text => {
        if (this.request?.id !== task.id) return;
        const reply = partialAssistantFields(text);
        const key = `${reply.explanation ?? ''}\u0000${reply.prompt ?? ''}`;
        if (key === shown) return;
        shown = key;
        this.update({ reply });
      },
    );
    signal.throwIfAborted();
    if (response.finishReason !== 'stop' || response.toolCalls)
      throw new Error('The assistant ran out of room before finishing. Try a shorter message.');
    let raw: unknown;
    try {
      raw = JSON.parse(response.content);
    } catch {
      throw new Error('The assistant sent a garbled reply. Try again.');
    }
    const patch = validatedAssistantPatch(raw, request.draft);
    if (request.target === 'video') patch.proposedDraft.negativePrompt = request.draft.negativePrompt;
    const dropped = missingProtectedParts(request, patch.proposedDraft.prompt);
    signal.throwIfAborted();
    if (this.request?.id !== task.id) throw canceled();
    return {
      id: task.id,
      createdAt: new Date().toISOString(),
      ...patch,
      originalDraft: structuredClone(request.draft),
      modelId: RELEASE.modelId,
      modelRevision: RELEASE.modelRevision,
      promptTokens,
      completionTokens: response.completionTokens,
      durationMs: Date.now() - started,
      historyTurnsUsed: history.length,
      ...(dropped.length ? { dropped } : {}),
    };
  }
  async cancel(): Promise<void> {
    const task = this.request;
    if (!task) return;
    task.controller.abort(canceled());
    await task.promise.catch(() => undefined);
  }
  stop(message = 'Stopped.'): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    clearTimeout(this.idleTimer);
    this.epoch += 1;
    this.setupController?.abort(canceled());
    this.request?.controller.abort(canceled());
    this.stopPromise = (async () => {
      await this.killOwnedChild();
      await Promise.allSettled([this.setupPromise, this.startPromise, this.request?.promise].filter(Boolean));
      this.update({
        state: this.installation() ? 'stopped' : 'not-installed',
        message,
        requestId: undefined,
        reply: undefined,
      });
    })().finally(() => {
      this.stopPromise = undefined;
    });
    return this.stopPromise;
  }
  private async killOwnedChild() {
    const child = this.child;
    this.url = undefined;
    this.token = undefined;
    if (!child?.pid) {
      this.child = undefined;
      return;
    }
    if (process.platform === 'win32') {
      await new Promise<void>((resolve, reject) => {
        const killer = spawn(
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, stdio: 'ignore' },
        );
        killer.on('error', reject);
        killer.on('close', () => resolve());
      });
    } else child.kill('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (this.child === child && child.exitCode === null && Date.now() < deadline) await wait(50);
    if (this.child === child && child.exitCode === null) throw new Error('The assistant did not stop. Try Stop again.');
    if (this.child === child) this.child = undefined;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }
}

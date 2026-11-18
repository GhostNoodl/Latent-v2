import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import type {
  AssistantModelOption,
  AssistantReply,
  AssistantRequest,
  AssistantSettings,
  AssistantStatus,
  CloudProviderId,
} from '../../shared/assistant-types';
import type { AppPaths } from '../../shared/types';
import {
  ASSISTANT_PROVIDER_IDS,
  CLOUD_PROVIDERS,
  CLOUD_PROVIDER_IDS,
  DEFAULT_ASSISTANT_SETTINGS,
  LOCAL_ASSISTANT_MODEL_IDS,
  LOCAL_ASSISTANT_MODELS,
  fitsBesideRender,
  pickDefaultModel,
  recommendedLocalModel,
} from '../../shared/assistant-catalog';
import { draftSchema } from '../../shared/validation';
import { videoDraftSchema } from '../../shared/video-plan';
import { AssistantKeys, type KeyCrypto } from './keys';
import { LOCAL_ALIAS, LocalAssistant, resolveDevice, type LocalHardware } from './local';
import {
  buildConversation,
  missingProtectedParts,
  negativeIgnored,
  parseReply,
  partialReply,
  systemPrompt,
  type ChatMessage,
} from './prompts';
import { AssistantProviderError, listOpenAIStyleModels, streamClaude, streamOpenAIStyle } from './providers';

interface StateStore {
  getState<T>(key: string, fallback: T): T;
  setState(key: string, value: unknown): void;
}

const SETTINGS_KEY = 'assistant.settings';
const providerSchema = z.enum(ASSISTANT_PROVIDER_IDS as [string, ...string[]]);
const settingsSchema = z
  .object({
    provider: providerSchema,
    models: z.partialRecord(z.enum(CLOUD_PROVIDER_IDS as [string, ...string[]]), z.string().trim().min(1).max(300)),
    customUrl: z
      .string()
      .trim()
      .max(500)
      .refine(
        value => !value || /^https?:\/\/[^\s]+$/i.test(value),
        'Enter a web address starting with http:// or https://.',
      ),
    localModel: z.enum(LOCAL_ASSISTANT_MODEL_IDS as [string, ...string[]]),
    localDevice: z.enum(['auto', 'gpu', 'cpu']),
  })
  .strict();

export const assistantRequestSchema = z
  .object({
    target: z.enum(['image', 'video', 'edit']),
    action: z.enum(['chat', 'improve', 'expand', 'shorten', 'tags', 'sentences', 'variations', 'describe', 'motion']),
    instruction: z.string().max(4000).optional(),
    draft: draftSchema,
    videoContext: videoDraftSchema.optional(),
    checkpointName: z.string().max(300).optional(),
    loraNames: z.array(z.string().min(1).max(300)).max(12).optional(),
    image: z
      .object({ kind: z.enum(['source', 'output']), id: z.string().min(1).max(200) })
      .strict()
      .optional(),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }).strict())
      .max(30)
      .optional(),
  })
  .strict();

const canceled = () => new Error('Assistant request canceled.');

export interface AssistantServiceOptions {
  paths: AppPaths;
  store: StateStore;
  crypto?: KeyCrypto;
  hardware: () => LocalHardware;
  /** Path of a source image or a saved output, checked by their own services. */
  imagePath: (ref: { kind: 'source' | 'output'; id: string }) => Promise<string>;
  changed: () => void;
  /** What is rendering right now, if anything. */
  renderActive?: () => 'image' | 'video' | undefined;
}

/** The prompt assistant: one place that knows which brain to ask and how. */
export class AssistantService {
  readonly keys: AssistantKeys;
  readonly local: LocalAssistant;
  private modelLists = new Map<CloudProviderId, AssistantModelOption[]>();
  private request?: { id: string; controller: AbortController; promise: Promise<AssistantReply> };
  private writing?: AssistantStatus['writing'];
  private disposed = false;

  constructor(private options: AssistantServiceOptions) {
    this.keys = new AssistantKeys(options.store, options.crypto);
    this.local = new LocalAssistant(options.paths, options.hardware, options.changed);
  }

  settings(): AssistantSettings {
    const saved = this.options.store.getState<unknown>(SETTINGS_KEY, null);
    const fallback = { ...DEFAULT_ASSISTANT_SETTINGS, localModel: recommendedLocalModel(this.options.hardware()) };
    if (!saved) return structuredClone(fallback);
    const parsed = settingsSchema.partial().safeParse(saved);
    return parsed.success ? ({ ...fallback, ...parsed.data } as AssistantSettings) : structuredClone(fallback);
  }
  saveSettings(patch: Partial<AssistantSettings>) {
    const parsed = settingsSchema.safeParse({
      ...this.settings(),
      ...patch,
      models: { ...this.settings().models, ...patch.models },
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      // Our own refine messages are written for people; anything else gets a plain fallback.
      throw new Error(issue?.code === 'custom' ? issue.message : "That setting couldn't be saved. Try again.");
    }
    const next = parsed.data;
    this.options.store.setState(SETTINGS_KEY, next);
    this.options.changed();
    return this.status();
  }

  private modelOptions(provider: CloudProviderId): AssistantModelOption[] {
    return CLOUD_PROVIDERS[provider].models ?? this.modelLists.get(provider) ?? [];
  }
  private chosenModel(provider: CloudProviderId, settings = this.settings()): string | undefined {
    return settings.models[provider] ?? pickDefaultModel(provider, this.modelOptions(provider));
  }

  status(): AssistantStatus {
    const settings = this.settings();
    const hardware = this.options.hardware();
    const local = {
      ...this.local.status(settings.localModel),
      gpu: Number.isFinite(hardware.vramMiB),
      downloadBytes: Object.fromEntries(
        LOCAL_ASSISTANT_MODEL_IDS.map(id => [
          id,
          this.local
            .missingDownloads(id, resolveDevice(id, settings.localDevice, hardware))
            .reduce((total, file) => total + file.bytes, 0),
        ]),
      ),
    };
    const keys = this.keys.summary();
    const base = { settings, keys, local, ...(this.writing ? { writing: this.writing } : {}) };
    if (settings.provider === 'local') {
      const model = LOCAL_ASSISTANT_MODELS[settings.localModel];
      const installed = local.state !== 'not-installed';
      return {
        ...base,
        ready: installed && local.state !== 'installing',
        ...(installed
          ? {}
          : { reason: `Download ${model.name} in Settings, Assistant, or pick a cloud assistant there.` }),
        label: `${model.name} on this PC`,
        vision: true,
      };
    }
    const provider = settings.provider as CloudProviderId;
    const definition = CLOUD_PROVIDERS[provider];
    const model = this.chosenModel(provider, settings);
    const option = this.modelOptions(provider).find(item => item.id === model);
    const reason =
      definition.keyRequired && !keys[provider]
        ? `Add your ${definition.name} key in Settings, Assistant.`
        : provider === 'custom' && !settings.customUrl
          ? 'Add your server address in Settings, Assistant.'
          : !model
            ? `Pick a ${definition.name} model in Settings, Assistant.`
            : undefined;
    return {
      ...base,
      ready: !reason,
      ...(reason ? { reason } : {}),
      label: model
        ? `${option?.name ?? model}${provider === 'anthropic' ? '' : ` · ${definition.name}`}`
        : definition.name,
      vision: option?.vision ?? true,
    };
  }

  setKey(provider: CloudProviderId, value: string | null) {
    this.keys.set(provider, value);
    this.modelLists.delete(provider);
    this.options.changed();
  }

  /** Models a provider offers. Claude's list is built in; the others ask the provider. */
  async listModels(provider: CloudProviderId): Promise<AssistantModelOption[]> {
    const definition = CLOUD_PROVIDERS[provider];
    if (definition.models) return definition.models;
    const target = this.openAITarget(provider, '');
    const list = await listOpenAIStyleModels(provider, target, AbortSignal.timeout(20_000));
    this.modelLists.set(provider, list);
    this.options.changed();
    return list;
  }

  private openAITarget(provider: CloudProviderId, model: string) {
    const definition = CLOUD_PROVIDERS[provider];
    const settings = this.settings();
    const baseUrl = provider === 'custom' ? settings.customUrl : definition.baseUrl!;
    if (!baseUrl) throw new AssistantProviderError('Add your server address in Settings, Assistant.');
    const key = this.keys.get(provider);
    if (definition.keyRequired && !key)
      throw new AssistantProviderError(`Add your ${definition.name} key in Settings, Assistant.`);
    return {
      name: definition.name,
      baseUrl,
      key,
      model,
      ...(provider === 'openrouter' ? { headers: { 'X-Title': 'Latent' } } : {}),
    };
  }

  installLocal(id = this.settings().localModel) {
    const device = resolveDevice(id, this.settings().localDevice, this.options.hardware());
    return this.local.install(id, device);
  }
  /** Bytes still to download for the picked local model. */
  localDownloadBytes(id = this.settings().localModel) {
    const device = resolveDevice(id, this.settings().localDevice, this.options.hardware());
    return this.local.missingDownloads(id, device).reduce((total, file) => total + file.bytes, 0);
  }

  /** Frees the graphics card for a job that needs it. */
  makeRoomFor(jobKind: 'image' | 'video') {
    if (this.request || !this.local.onGpu()) return;
    const vram = this.options.hardware().vramMiB ?? 0;
    if (fitsBesideRender(this.settings().localModel, jobKind, vram)) return;
    void this.local.stop('Unloaded to make room for your render. It loads again when you send.').catch(() => undefined);
  }

  private async loadImage(ref: { kind: 'source' | 'output'; id: string }) {
    const filename = await this.options.imagePath(ref);
    const data = await sharp(filename, { limitInputPixels: 80_000_000 })
      .rotate()
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#808080' })
      .jpeg({ quality: 86 })
      .toBuffer();
    return { mediaType: 'image/jpeg' as const, base64: data.toString('base64') };
  }

  suggest(input: AssistantRequest): Promise<AssistantReply> {
    if (this.disposed) return Promise.reject(new Error('Assistant was closed.'));
    if (this.request) return Promise.reject(new Error('Wait for the current reply, or stop it first.'));
    const parsed = assistantRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new Error('That request was not valid.'));
    const request = parsed.data as AssistantRequest;
    if (request.action === 'chat' && !request.instruction?.trim())
      return Promise.reject(new Error('Type what you want first.'));
    if (request.action === 'describe' && !request.image) return Promise.reject(new Error('Pick a picture first.'));
    const id = randomUUID();
    const controller = new AbortController();
    const task = { id, controller, promise: undefined as unknown as Promise<AssistantReply> };
    this.request = task;
    this.writing = { requestId: id };
    this.options.changed();
    task.promise = this.generate(request, task).finally(() => {
      if (this.request === task) {
        this.request = undefined;
        this.writing = undefined;
        this.options.changed();
      }
    });
    return task.promise;
  }

  private async generate(request: AssistantRequest, task: { id: string; controller: AbortController }) {
    const started = Date.now();
    const settings = this.settings();
    const signal = AbortSignal.any([task.controller.signal, AbortSignal.timeout(300_000)]);
    const status = this.status();
    if (!status.ready) throw new Error(status.reason ?? 'The assistant is not set up yet.');
    const image = request.image ? await this.loadImage(request.image) : undefined;
    signal.throwIfAborted();
    const local = settings.provider === 'local';
    const messages: ChatMessage[] = buildConversation(request, local ? 24_000 : 60_000);
    if (image) messages[messages.length - 1] = { ...messages[messages.length - 1], image };
    const system = systemPrompt(request);
    let shown = '';
    const onText = (text: string) => {
      if (this.request?.id !== task.id) return;
      const partial = partialReply(text);
      const key = `${partial.message ?? ''}\u0000${partial.prompt ?? ''}`;
      if (key === shown) return;
      shown = key;
      this.writing = { requestId: task.id, ...partial };
      this.options.changed();
    };
    let text: string;
    let label = status.label;
    if (local) {
      const release = this.local.hold();
      try {
        const device = resolveDevice(settings.localModel, settings.localDevice, this.options.hardware());
        const rendering = this.options.renderActive?.();
        if (
          device === 'gpu' &&
          rendering &&
          !fitsBesideRender(settings.localModel, rendering, this.options.hardware().vramMiB ?? 0)
        )
          throw new AssistantProviderError(
            `${LOCAL_ASSISTANT_MODELS[settings.localModel].name} needs the graphics card, and your ${rendering} is using it. Send again when it's done, or use a cloud assistant.`,
          );
        const server = await this.local.ensure(settings.localModel, device, signal);
        label = `${LOCAL_ASSISTANT_MODELS[settings.localModel].name} on this PC${server.device === 'gpu' ? '' : ' (processor)'}`;
        text = await streamOpenAIStyle(
          {
            name: 'The local assistant',
            baseUrl: `${server.url}/v1`,
            key: server.token,
            model: LOCAL_ALIAS,
            extraBody: {
              temperature: request.action === 'variations' ? 0.9 : 0.7,
              top_p: 0.8,
              top_k: 20,
              presence_penalty: 1.5,
              max_tokens: 2500,
              chat_template_kwargs: { enable_thinking: false },
            },
          },
          { system, messages, signal, onText },
        );
      } finally {
        release();
      }
    } else {
      const provider = settings.provider as CloudProviderId;
      const model = this.chosenModel(provider, settings)!;
      if (provider === 'anthropic') {
        const key = this.keys.get('anthropic');
        if (!key) throw new Error('Add your Claude key in Settings, Assistant.');
        text = await streamClaude(key, model, { system, messages, signal, onText });
      } else text = await streamOpenAIStyle(this.openAITarget(provider, model), { system, messages, signal, onText });
    }
    signal.throwIfAborted();
    if (this.request?.id !== task.id) throw canceled();
    const reply = parseReply(text);
    const ignoresNegative = negativeIgnored(request.draft);
    const options = (
      reply.prompts.length
        ? reply.prompts
        : [{ prompt: request.draft.prompt, negativePrompt: request.draft.negativePrompt }]
    )
      .slice(0, request.action === 'variations' ? 3 : 1)
      .map(option => {
        const negativePrompt =
          request.target !== 'image' ? '' : ignoresNegative ? request.draft.negativePrompt : option.negativePrompt;
        const dropped = missingProtectedParts(request, option.prompt);
        return { prompt: option.prompt, negativePrompt, ...(dropped.length ? { dropped } : {}) };
      });
    return {
      id: task.id,
      createdAt: new Date().toISOString(),
      message: reply.message || 'Here you go.',
      options,
      label,
      durationMs: Date.now() - started,
    };
  }

  async cancel() {
    const task = this.request;
    if (!task) return;
    task.controller.abort(canceled());
    await task.promise.catch(() => undefined);
  }

  /** Something is busy (downloading, loading or writing), so app updates should wait. */
  busy() {
    const local = this.local.status(this.settings().localModel).state;
    return Boolean(this.request) || local === 'installing' || local === 'starting';
  }

  async dispose() {
    this.disposed = true;
    await this.cancel();
    await this.local.dispose();
  }
}

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  BackendStatus,
  GenerationDraft,
  GenerationJob,
  GenerationRecord,
  ModelAsset,
  Preset,
  StudioJob,
  VideoJob,
} from '../shared/types';
import { isImageJob, isVideoJob } from '../shared/types';
import type { VideoDraft } from '../shared/video-types';
import type { VideoAssetsStatus } from '../shared/video-assets';
import type { SourceImageAsset } from '../shared/source-types';
import type { QwenEditJobRequest, QwenEditProfile } from '../shared/qwen-edit-types';
import { qwenSameSize, qwenWorkingSize } from '../shared/qwen-area';
import { enhancementActionLabel, prepareOneClickEnhancement } from '../shared/enhancement';
import { ENHANCE_MAX_SIDE } from '../shared/vram';
import {
  applyVideoSetting,
  describeVideo,
  isVideoKey,
  qualityMissing,
  qualityName,
  splitVideoFlags,
  videoDraftFor,
  VIDEO_LENGTHS,
  VIDEO_QUALITY,
  VIDEO_SIZES,
  type TelegramVideoOverrides,
} from './telegram-video';
import { SAMPLERS, SCHEDULERS } from '../shared/defaults';
import { IMAGE_MODEL_IDS, IMAGE_MODELS, type ImageModelId } from '../shared/image-models';
import { telegramSettingsSchema, type TelegramSettings, type TelegramStatus } from '../shared/telegram-types';
import type { StudioStore } from './store';
import {
  applySetting,
  bestFor,
  describeSettings,
  isCreateImage,
  settingsFromRecord,
  effectiveDraft,
  isSettingKey,
  loraList,
  modelChoices,
  modelName,
  POPULAR_SAMPLERS,
  sizeChoices,
  splitPromptFlags,
  type ControlContext,
  type SettingKey,
  type TelegramOverrides,
} from './telegram-controls';

export { telegramDraft } from './telegram-controls';
export interface TelegramCredentialCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
export interface TelegramBotPorts {
  store: Pick<StudioStore, 'getState' | 'setState' | 'recordsForJob'>;
  crypto?: TelegramCredentialCrypto;
  fetch: typeof fetch;
  /** The studio's current Create settings, which Telegram chats start from. */
  draft(): GenerationDraft;
  models(): ModelAsset[];
  presets(): Preset[];
  sizes(): { name: string; width: number; height: number }[];
  /** Newer models whose files are downloaded and checked. */
  imageModels?(): ImageModelId[];
  /** Prompts saved beside the prompt box in Create. */
  savedPrompts?(): { id: string; text: string }[];
  /** Studio images, newest first. */
  records?(): readonly GenerationRecord[];
  /** A saved image, to enhance or edit it. */
  record?(id: string): GenerationRecord | undefined;
  /** Imports a picture from the chat so the engine can use it. */
  importImage?(bytes: Uint8Array, name: string): Promise<SourceImageAsset>;
  /** Uses a studio image as a source, keeping the link to it. */
  useOutputAsSource?(recordId: string): Promise<SourceImageAsset>;
  /** Largest side Enhance may make on this PC. */
  enhanceMaxSide?(): number;
  /** The Qwen Edit setup to use, or undefined when none is downloaded. */
  editProfile?(): QwenEditProfile | undefined;
  queueEdit?(request: QwenEditJobRequest): Promise<GenerationJob>;
  /** The Video page's open setup. */
  videoDraft?(): unknown;
  videoStatus?(): { canGenerate: boolean; message: string; assets?: VideoAssetsStatus };
  queueVideo?(draft: VideoDraft): Promise<VideoJob>;
  readVideo?(recordId: string): Promise<Buffer>;
  queue(draft: GenerationDraft): Promise<GenerationJob>;
  jobs(): StudioJob[];
  cancel(id: string): Promise<void>;
  backend(): BackendStatus;
  /** Why the studio cannot queue right now (closing, moving storage), if anything. */
  blockedReason(): string | undefined;
  readOutput(record: GenerationRecord): Promise<Buffer>;
  changed(): void;
  log(message: string): void;
  wait?(ms: number, signal: AbortSignal): Promise<void>;
}
interface TelegramUser {
  id: number;
}
interface TelegramChat {
  id: number;
  type: string;
}
interface TelegramPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}
interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  document?: { file_id: string; mime_type?: string; file_size?: number };
  reply_to_message?: TelegramMessage;
}
interface TelegramCallback {
  id: string;
  from: TelegramUser;
  message?: { chat: TelegramChat };
  data?: string;
}
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallback;
}
interface RemoteJob {
  chatId: number;
  prompt: string;
  /** The image finished; its automatic face fix is still on the way. */
  waitingFaces?: boolean;
  /** Sending failed; try again at `at` (ms), skipping the `sent` pictures that already went out. */
  retry?: { attempts: number; at: number; sent: number };
}
/** A dropped connection should not lose the picture: a failed send is tried this many times in all. */
const DELIVERY_ATTEMPTS = 4;
const RETRY_DELAY_MS = 30_000;
interface ChatState {
  overrides: TelegramOverrides;
  video?: TelegramVideoOverrides;
  lastPrompt?: string;
  /** SDXL tweaks put aside while this chat uses a newer model. */
  classic?: TelegramOverrides;
}
type Button = { text: string; callback_data: string };

const SETTINGS_STATE = 'telegram.settings.v1';
const TOKEN_STATE = 'telegram.encrypted-token.v1';
const OFFSET_STATE = 'telegram.offset.v1';
const JOBS_STATE = 'telegram.jobs.v1';
const CHATS_STATE = 'telegram.chats.v1';
/** Which studio image each sent photo is, so replies and Enhance taps find it again. */
const SENT_STATE = 'telegram.sent.v1';
const SENT_KEPT = 300;
/** Jobs that came from Telegram, so /last skips them and finds the last image made on the PC. */
const REMOTE_IDS_STATE = 'telegram.job-ids.v1';
const REMOTE_IDS_KEPT = 500;
/** Telegram bots can download files up to 20 MB and upload up to 50 MB. */
const DOWNLOAD_LIMIT = 20 * 1024 * 1024;
const UPLOAD_LIMIT = 50 * 1024 * 1024;
const API = 'https://api.telegram.org';
const POLL_SECONDS = 25;
const tokenPattern = /^\d{3,20}:[A-Za-z0-9_-]{20,100}$/;
const storedTokenSchema = z
  .object({
    version: z.literal(1),
    ciphertext: z
      .string()
      .min(4)
      .max(32_768)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
const DEFAULT_SETTINGS: TelegramSettings = { enabled: false, allowedUserIds: [] };
const HELP = [
  'Send me a prompt and I’ll make it on your PC. You start with the studio’s Create settings and can change anything below just for this chat.',
  '',
  'Making images',
  '/gen <prompt> - same as just sending a prompt',
  '/again - run your last prompt again with a new seed',
  '/prompts - your saved prompts, tap one to make it',
  '/queue - what is waiting or running',
  '/cancel - cancel your latest image',
  '',
  'Settings (send without a value to see choices)',
  '/settings - show everything',
  '/model - pick a model, SDXL or one of the newer ones',
  '/loras - list LoRAs; /lora <name> [weight], /lora off <name>, /lora on <name>, /lora remove <name>, /lora clear',
  '/size 832x1216 or /size portrait',
  '/steps 30 · /cfg 6.5 · /seed 1234 or random · /batch 1-4',
  '/sampler · /scheduler',
  '/neg <negative prompt> or /neg off',
  '/hires on [scale] [denoise] or off',
  '/faces on [illustrated|anime|photographic] [strength] or off',
  '/triggers on|off - add LoRA trigger words automatically',
  '/preset - load one of the studio’s saved presets',
  '/last - copy the settings from the last image you made on the PC',
  '/reset - go back to the studio’s Create settings',
  '',
  'Editing',
  'Reply to any picture with what to change, like: make it night time',
  'Or send a photo with the change as its caption',
  'Tap ✨ Enhance under a picture to upscale and refine it',
  '',
  'Video',
  '/video <what happens> - make a clip',
  '/video by itself - pick quality, length and shape',
  'Animate a picture: send it, or reply to one, with /video <what happens>',
  'One-off changes: a wave rolling in --length 8 --quality better --size tall',
  '/videoreset - go back to the Video page settings',
  '',
  'Newer models (Anima, Z-Image and friends) pick their best settings for you and make images from text only, so LoRAs, hires fix and face fix sit out.',
  '',
  'One-off changes work inside a prompt too:',
  'a fox in the snow --size landscape --steps 35 --seed 7',
  'Wildcards work as well: a __animal__ in {spring|winter}',
  '',
  '/status - is the engine running? · /id - your Telegram user ID',
].join('\n');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

const hasPicture = (value: TelegramMessage | undefined): boolean =>
  Boolean(value?.photo?.length || value?.document?.mime_type?.startsWith('image/'));

class TelegramApiError extends Error {
  constructor(
    public code: number,
    text: string,
    public retryAfter?: number,
  ) {
    super(text);
  }
}

/** Optional remote control: long-polls Telegram, so nothing on the PC has to accept connections. */
export class TelegramBotService {
  private state: TelegramStatus['state'] = 'off';
  private statusMessage = 'Telegram remote is off.';
  private botUsername?: string;
  private controller?: AbortController;
  private running?: Promise<void>;
  private sweepTimer?: NodeJS.Timeout;
  private sweeping = false;
  private disposed = false;
  /** Jobs being sent right now, so a repeated finish or a sweep never sends them twice. */
  private delivering = new Set<string>();
  constructor(private ports: TelegramBotPorts) {}

  settings(): TelegramSettings {
    const parsed = telegramSettingsSchema.safeParse(this.ports.store.getState(SETTINGS_STATE, DEFAULT_SETTINGS));
    return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
  }
  status(): TelegramStatus {
    return {
      ...this.settings(),
      hasToken: storedTokenSchema.safeParse(this.ports.store.getState(TOKEN_STATE, null)).success,
      state: this.state,
      message: this.statusMessage,
      botUsername: this.botUsername,
    };
  }
  async saveSettings(patch: unknown): Promise<void> {
    const next = telegramSettingsSchema.parse({ ...this.settings(), ...telegramSettingsSchema.partial().parse(patch) });
    this.ports.store.setState(SETTINGS_STATE, next);
    await this.restart();
  }
  async setToken(value: string | null): Promise<void> {
    if (value === null) {
      this.ports.store.setState(TOKEN_STATE, null);
      this.ports.store.setState(OFFSET_STATE, 0);
      await this.restart();
      return;
    }
    const token = typeof value === 'string' ? value.trim() : '';
    if (!tokenPattern.test(token))
      throw new Error('That does not look like a bot token. Copy the whole token BotFather gave you.');
    let ciphertext: string;
    try {
      ciphertext = this.secureCrypto().encryptString(token).toString('base64');
    } catch (error) {
      throw new Error(`Windows secure credential storage could not protect this token. ${message(error)}`);
    }
    this.ports.store.setState(TOKEN_STATE, storedTokenSchema.parse({ version: 1, ciphertext }));
    this.ports.store.setState(OFFSET_STATE, 0);
    await this.restart();
  }
  start() {
    // Face fixes finish as separate jobs after their image; check on them until they land.
    this.sweepTimer ??= setInterval(() => void this.sweep(), 3000);
    void this.restart();
  }
  async dispose() {
    this.disposed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    await this.stop();
  }

  /** Delivers finished Telegram jobs back to the chat that asked for them. */
  jobFinished(job: StudioJob) {
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) return;
    const remote = this.remoteJobs()[job.id];
    if (!remote || remote.waitingFaces || remote.retry || this.delivering.has(job.id)) return;
    if (job.status === 'completed' && isImageJob(job) && job.draft.autoFace && !job.autoFaceFinished) {
      this.remember(job.id, { ...remote, waitingFaces: true });
      return;
    }
    void this.sendResult(job, remote);
  }
  /** Sends images whose face fixes have all settled, falling back to the original when none ran. */
  async sweep() {
    if (this.sweeping || !this.settings().enabled) return;
    this.sweeping = true;
    try {
      const jobs = this.ports.jobs();
      for (const [id, remote] of Object.entries(this.remoteJobs())) {
        if (this.delivering.has(id)) continue;
        if (remote.retry) {
          const job = jobs.find(item => item.id === id);
          if (!job) this.forget(id);
          else if (Date.now() >= remote.retry.at) await this.sendResult(job, remote);
          continue;
        }
        if (!remote.waitingFaces) continue;
        const job = jobs.find(item => item.id === id);
        if (!job || !isImageJob(job)) {
          this.forget(id);
          continue;
        }
        if (!job.autoFaceFinished) continue;
        const children = Object.values(job.autoFaceResults ?? {})
          .map(result => result.jobId && jobs.find(item => item.id === result.jobId))
          .filter((child): child is StudioJob => Boolean(child));
        if (children.some(child => ['queued', 'running'].includes(child.status))) continue;
        await this.sendResult(job, { ...remote, waitingFaces: false });
      }
    } finally {
      this.sweeping = false;
    }
  }

  private secureCrypto(): TelegramCredentialCrypto {
    const crypto = this.ports.crypto;
    if (!crypto?.isEncryptionAvailable() || crypto.getSelectedStorageBackend?.() === 'basic_text')
      throw new Error('Secure credential storage is unavailable on this PC, so the bot token was not saved.');
    return crypto;
  }
  private token(): string | undefined {
    const stored = this.ports.store.getState(TOKEN_STATE, null);
    if (stored === null) return undefined;
    const parsed = storedTokenSchema.safeParse(stored);
    if (!parsed.success) throw new Error('The saved bot token is invalid. Paste it again.');
    let value: string;
    try {
      value = this.secureCrypto().decryptString(Buffer.from(parsed.data.ciphertext, 'base64'));
    } catch {
      throw new Error('The saved bot token could not be unlocked. Paste it again.');
    }
    if (!tokenPattern.test(value)) throw new Error('The saved bot token is invalid. Paste it again.');
    return value;
  }
  private redact(text: string) {
    try {
      const token = this.token();
      return token ? text.split(token).join('<token>') : text;
    } catch {
      return text;
    }
  }
  private setState(state: TelegramStatus['state'], text: string) {
    this.state = state;
    this.statusMessage = text;
    this.ports.changed();
  }
  private async stop() {
    this.controller?.abort();
    await this.running?.catch(() => undefined);
    this.controller = undefined;
    this.running = undefined;
  }
  private async restart() {
    await this.stop();
    this.botUsername = undefined;
    if (this.disposed) return;
    const settings = this.settings();
    let token: string | undefined;
    try {
      token = this.token();
    } catch (error) {
      this.setState('error', message(error));
      return;
    }
    if (!settings.enabled) return this.setState('off', 'Telegram remote is off.');
    if (!token) return this.setState('error', 'Paste your bot token from BotFather to connect.');
    if (!settings.allowedUserIds.length)
      return this.setState('error', 'Add at least one Telegram user ID that may use the bot.');
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.run(token, controller.signal);
  }
  private async call<T>(
    token: string,
    method: string,
    body: Record<string, unknown> | FormData,
    signal: AbortSignal,
    timeoutMs = 20_000,
  ): Promise<T> {
    const form = body instanceof FormData;
    const response = await this.ports.fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: form ? undefined : { 'Content-Type': 'application/json' },
      body: form ? body : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
    let data: { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: any };
    try {
      data = await response.json();
    } catch {
      throw new TelegramApiError(response.status, `Telegram returned an unreadable response (${response.status}).`);
    }
    if (!data.ok)
      throw new TelegramApiError(
        data.error_code ?? response.status,
        data.description || `Telegram request failed (${response.status}).`,
        typeof data.parameters?.retry_after === 'number' ? data.parameters.retry_after : undefined,
      );
    return data.result as T;
  }
  private wait(ms: number, signal: AbortSignal) {
    if (this.ports.wait) return this.ports.wait(ms, signal);
    return new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  private async run(token: string, signal: AbortSignal) {
    let failures = 0;
    this.setState('connecting', 'Connecting to Telegram…');
    while (!signal.aborted) {
      try {
        if (!this.botUsername) {
          const me = await this.call<{ username?: string }>(token, 'getMe', {}, signal);
          this.botUsername = me.username;
          // Long polling and a webhook cannot both be active for one bot.
          await this.call(token, 'deleteWebhook', {}, signal);
          this.setState('online', `Listening as @${me.username ?? 'your bot'}.`);
        }
        const offset = this.ports.store.getState<number>(OFFSET_STATE, 0);
        const updates = await this.call<TelegramUpdate[]>(
          token,
          'getUpdates',
          { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] },
          signal,
          (POLL_SECONDS + 15) * 1000,
        );
        if (failures) this.setState('online', `Listening as @${this.botUsername ?? 'your bot'}.`);
        failures = 0;
        for (const update of updates) {
          if (signal.aborted) return;
          this.ports.store.setState(OFFSET_STATE, update.update_id + 1);
          if (update.message) await this.handle(token, update.message, signal);
          else if (update.callback_query) await this.handleButton(token, update.callback_query, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        const code = error instanceof TelegramApiError ? error.code : 0;
        if (code === 401 || code === 404) {
          this.setState('error', 'Telegram rejected the bot token. Paste a fresh one from BotFather.');
          return;
        }
        failures++;
        const delay =
          error instanceof TelegramApiError && error.retryAfter
            ? error.retryAfter * 1000
            : Math.min(60_000, 2_000 * 2 ** Math.min(failures - 1, 5));
        this.setState(
          'error',
          code === 409
            ? 'Another program is using this bot token. Close it, and Latent will reconnect.'
            : `Cannot reach Telegram right now (${this.redact(message(error))}). Retrying…`,
        );
        await this.wait(delay, signal);
      }
    }
  }
  private async send(
    token: string,
    chatId: number,
    text: string,
    signal = new AbortController().signal,
    buttons?: Button[][],
  ) {
    await this.call(
      token,
      'sendMessage',
      {
        chat_id: chatId,
        text: text.slice(0, 4000),
        ...(buttons?.length ? { reply_markup: { inline_keyboard: buttons } } : {}),
      },
      signal,
    );
  }
  private allowed(from: TelegramUser | undefined, chat: TelegramChat | undefined) {
    return Boolean(from && chat?.type === 'private' && this.settings().allowedUserIds.includes(String(from.id)));
  }
  private async handle(token: string, incoming: TelegramMessage, signal: AbortSignal) {
    const from = incoming.from?.id;
    const raw = incoming.text ?? incoming.caption ?? '';
    const picture = hasPicture(incoming)
      ? incoming
      : hasPicture(incoming.reply_to_message)
        ? incoming.reply_to_message!
        : undefined;
    if (!from || incoming.chat.type !== 'private' || typeof raw !== 'string' || (!raw.trim() && !picture)) return;
    const text = raw.trim();
    const first = text.split(/\s+/, 1)[0] ?? '';
    const command = first.startsWith('/') ? first.slice(1).split('@')[0].toLowerCase() : undefined;
    const args = command ? text.slice(first.length).trim() : text;
    const chatId = incoming.chat.id;
    if (!this.allowed(incoming.from, incoming.chat)) {
      // Strangers only learn their own ID, so the owner can add them if they mean to.
      if (command === 'start' || command === 'id')
        await this.send(
          token,
          chatId,
          `This bot is private. Your Telegram user ID is ${from}. The owner can add it in Latent under Settings > Remote.`,
          signal,
        );
      return;
    }
    const reply = (value: string, buttons?: Button[][]) => this.send(token, chatId, value, signal, buttons);
    const source = picture ? () => this.pictureSource(token, chatId, picture, signal) : undefined;
    if (command === 'video' || command === 'vid') return this.video(chatId, args, reply, source);
    if (command === 'videoreset') {
      const { video: _video, ...rest } = this.chat(chatId);
      this.saveChat(chatId, rest);
      return reply('Back to the Video page settings.');
    }
    if (source && (command === undefined || command === 'edit')) {
      if (!args)
        return reply(
          'Nice picture! Reply to it with what to change (like: make it night time), or with /video <what happens> to animate it.',
        );
      return this.edit(chatId, args, source, reply);
    }
    if (command === 'edit')
      return reply('Reply to a picture with what to change, or send a photo with the change as its caption.');
    switch (command) {
      case 'start':
      case 'help':
        return reply(HELP);
      case 'id':
        return reply(`Your Telegram user ID is ${from}.`);
      case 'status':
        return reply(this.statusText());
      case 'queue':
        return reply(this.queueText(chatId));
      case 'cancel':
        return this.cancelLatest(chatId, reply);
      case 'settings':
        return reply(describeSettings(this.context(), this.chat(chatId).overrides));
      case 'reset':
        this.saveChat(chatId, { ...this.chat(chatId), overrides: {}, classic: undefined });
        return reply("Back to the studio's Create settings.");
      case 'again': {
        const last = this.chat(chatId).lastPrompt;
        return last ? this.generate(chatId, last, reply) : reply('There is no earlier prompt yet. Send one first.');
      }
      case 'gen':
      case undefined:
        return this.generate(chatId, args, reply);
      case 'loras':
        return reply(this.loraText(chatId));
      case 'models':
        return this.choices(chatId, 'model', reply);
      case 'last':
      case 'pc':
        return this.useLast(chatId, reply);
      case 'prompts':
      case 'prompt':
        return args ? this.savedPrompt(chatId, args, reply) : this.promptList(reply);
    }
    if (isSettingKey(command)) {
      if (!args) return this.choices(chatId, command, reply);
      return this.change(chatId, command, args).then(reply, error => reply(message(error)));
    }
    return reply(`I don't know /${command}. Send /help for everything I can do.`);
  }
  private async handleButton(token: string, query: TelegramCallback, signal: AbortSignal) {
    const chat = query.message?.chat;
    if (!chat || !this.allowed(query.from, chat)) return;
    const enhance = /^enh:([a-f0-9]{32})$/.exec(query.data ?? '');
    if (enhance) {
      await this.call(token, 'answerCallbackQuery', { callback_query_id: query.id }, signal);
      return this.enhance(chat.id, enhance[1], value => this.send(token, chat.id, value, signal));
    }
    const video = /^vid:([a-z]+):(.{1,20})$/.exec(query.data ?? '');
    if (video && isVideoKey(video[1])) {
      let text: string;
      try {
        text = this.changeVideo(chat.id, video[1], video[2]);
      } catch (error) {
        text = message(error);
      }
      await this.call(token, 'answerCallbackQuery', { callback_query_id: query.id, text: text.slice(0, 190) }, signal);
      return this.send(token, chat.id, text, signal);
    }
    if (query.data === 'last:prompt') {
      await this.call(token, 'answerCallbackQuery', { callback_query_id: query.id }, signal);
      const prompt = this.lastPcImage()?.draft.prompt.trim();
      const send = (value: string) => this.send(token, chat.id, value, signal);
      return prompt ? this.generate(chat.id, prompt, send) : send('That image has no prompt to reuse.');
    }
    const saved = /^prompt:(\d{1,3})$/.exec(query.data ?? '');
    if (saved) {
      await this.call(token, 'answerCallbackQuery', { callback_query_id: query.id }, signal);
      return this.savedPrompt(chat.id, saved[1], value => this.send(token, chat.id, value, signal));
    }
    const match = /^set:([a-z]+):(.{1,40})$/.exec(query.data ?? '');
    let text: string;
    if (!match || !isSettingKey(match[1])) text = 'That button has expired.';
    else
      try {
        text = await this.change(chat.id, match[1], match[2]);
      } catch (error) {
        text = message(error);
      }
    await this.call(token, 'answerCallbackQuery', { callback_query_id: query.id, text: text.slice(0, 190) }, signal);
    await this.send(token, chat.id, text, signal);
  }
  private context(chatId?: number): ControlContext {
    const ready = new Set(this.ports.imageModels?.() ?? []);
    return {
      studio: this.ports.draft(),
      models: this.ports.models(),
      // Sorted once here so list numbers, buttons and typed numbers all agree.
      presets: [...this.ports.presets()].sort((a, b) => a.name.localeCompare(b.name)),
      sizes: this.ports.sizes(),
      imageModels: IMAGE_MODEL_IDS.filter(id => ready.has(id)),
      classic: chatId === undefined ? undefined : this.chat(chatId).classic,
    };
  }
  private async change(chatId: number, key: SettingKey, args: string) {
    const chat = this.chat(chatId);
    const result = applySetting(this.context(chatId), chat.overrides, key, args);
    const next: ChatState = { ...chat, overrides: result.overrides };
    if (result.classic === null) delete next.classic;
    else if (result.classic) next.classic = result.classic;
    this.saveChat(chatId, next);
    return result.message;
  }
  private savedPrompts() {
    return (this.ports.savedPrompts?.() ?? []).filter(item => item.text.trim());
  }
  private promptList(reply: (text: string, buttons?: Button[][]) => Promise<void>) {
    const prompts = this.savedPrompts();
    if (!prompts.length) return reply('No saved prompts yet. Save some beside the prompt box in Create.');
    const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
    return reply(
      `${prompts.map((item, index) => `${index + 1}. ${short(item.text, 160)}`).join('\n')}\n\nTap one to make it, or send /prompts <number>.`,
      prompts.slice(0, 30).map((item, index) => [{ text: short(item.text, 40), callback_data: `prompt:${index + 1}` }]),
    );
  }
  private savedPrompt(chatId: number, choice: string, reply: (text: string) => Promise<void>) {
    const prompts = this.savedPrompts();
    const index = /^\d+$/.test(choice.trim()) ? Number(choice.trim()) - 1 : -1;
    const item = prompts[index];
    if (!item) return reply(prompts.length ? `Pick a number from 1 to ${prompts.length}.` : 'No saved prompts yet.');
    return this.generate(chatId, item.text, reply);
  }
  /** Lists the options for a setting, as buttons where a tap is enough. */
  private async choices(chatId: number, key: SettingKey, reply: (text: string, buttons?: Button[][]) => Promise<void>) {
    const ctx = this.context(chatId);
    const draft = effectiveDraft(ctx.studio, this.chat(chatId).overrides, '');
    const button = (text: string, arg: string | number): Button => ({ text, callback_data: `set:${key}:${arg}` });
    const rows = (buttons: Button[], width: number) =>
      Array.from({ length: Math.ceil(buttons.length / width) }, (_, index) =>
        buttons.slice(index * width, index * width + width),
      );
    if (draft.imageModel && (key === 'hires' || key === 'faces' || key === 'lora'))
      return reply(
        `${IMAGE_MODELS[draft.imageModel].name} makes images from text only, so ${
          key === 'hires' ? 'hires fix' : key === 'faces' ? 'face fix' : 'LoRAs'
        } sit${key === 'lora' ? '' : 's'} out. Pick an SDXL model with /model to use ${key === 'lora' ? 'them' : 'it'}.`,
      );
    switch (key) {
      case 'model': {
        const choices = modelChoices(ctx);
        if (!choices.length) return reply('No models are installed in the studio yet.');
        const lines = choices.map(
          (choice, index) =>
            `${index + 1}. ${choice.name}${choice.kind === 'newer' ? ` (newer, best at ${bestFor(choice.id)})` : ''}`,
        );
        const firstNewer = choices.findIndex(choice => choice.kind === 'newer');
        if (firstNewer > 0) lines.splice(firstNewer, 0, '', 'Newer models');
        const missing = IMAGE_MODEL_IDS.length - (ctx.imageModels?.length ?? 0);
        const more = missing
          ? `\n\n${missing} more newer model${missing === 1 ? ' is' : 's are'} in the studio's model picker, ready to download.`
          : '';
        return reply(
          `Current model: ${modelName(draft, ctx.models)}\n\n${lines.join('\n')}\n\nTap one, or send /model <number or name>.${more}`,
          rows(
            choices.slice(0, 40).map((choice, index) => button(choice.name.slice(0, 40), index + 1)),
            1,
          ),
        );
      }
      case 'lora':
        return reply(this.loraText(chatId));
      case 'size':
        return reply(
          `Current size: ${draft.width}×${draft.height}.${draft.imageModel ? ` These suit ${IMAGE_MODELS[draft.imageModel].name}.` : ''} Tap one, or send /size <width>x<height> (multiples of 64, 256 to 2048).`,
          rows(
            sizeChoices(ctx, draft).map((size, index) =>
              button(`${size.name} ${size.width}×${size.height}`, index + 1),
            ),
            2,
          ),
        );
      case 'sampler':
        return reply(
          `Current sampler: ${draft.sampler}. Popular ones are below; any of these also work with /sampler <name>:\n${SAMPLERS.join(', ')}`,
          rows(
            POPULAR_SAMPLERS.map(name => button(name, name)),
            2,
          ),
        );
      case 'scheduler':
        return reply(
          `Current scheduler: ${draft.scheduler}.`,
          rows(
            SCHEDULERS.map(name => button(name, name)),
            3,
          ),
        );
      case 'preset': {
        const presets = ctx.presets;
        if (!presets.length) return reply('The studio has no saved presets yet.');
        return reply(
          `${presets.map((preset, index) => `${index + 1}. ${preset.name}`).join('\n')}\n\nTap one to load its model, LoRAs and settings into this chat.`,
          rows(
            presets.slice(0, 30).map((preset, index) => button(preset.name.slice(0, 40), index + 1)),
            1,
          ),
        );
      }
      case 'hires':
        return reply(
          `Hires fix is ${draft.hiresFix ? 'on' : 'off'}. For custom strength send /hires on <scale> <denoise>, like /hires on 1.5 0.35.`,
          [[button('On (1.5×)', 'on'), button('Off', 'off')]],
        );
      case 'faces':
        return reply(
          `Face fix is ${draft.autoFace ? `on (${draft.autoFace.profile})` : 'off'}. The face detector must be set up in the studio first.`,
          [
            [button('Illustrated', 'on illustrated'), button('Anime', 'on anime'), button('Photo', 'on photographic')],
            [button('Off', 'off')],
          ],
        );
      case 'triggers':
        return reply(`Automatic LoRA trigger words are ${draft.autoTriggers ? 'on' : 'off'}.`, [
          [button('On', 'on'), button('Off', 'off')],
        ]);
      case 'neg':
        return reply(
          `Negative prompt: ${draft.negativePrompt || 'none'}\n\nSend /neg <text> to change it or /neg off to clear it.`,
        );
      case 'steps':
        return reply(
          `Steps: ${draft.steps}. Send /steps <1-100>.${draft.imageModel ? ` Best for ${IMAGE_MODELS[draft.imageModel].name}: ${bestFor(draft.imageModel)}.` : ''}`,
        );
      case 'cfg':
        return reply(
          `CFG: ${draft.cfg}. Send /cfg <0-30>, decimals are fine.${draft.imageModel ? ` Best for ${IMAGE_MODELS[draft.imageModel].name}: ${bestFor(draft.imageModel)}.` : ''}`,
        );
      case 'seed':
        return reply(`Seed: ${draft.seed}. Send /seed <number> to pin it or /seed random.`);
      case 'batch':
        return reply(`Images per prompt: ${draft.batchSize}.`, [
          [1, 2, 3, 4].map(count => button(String(count), count)),
        ]);
    }
  }
  private changeVideo(chatId: number, key: Parameters<typeof applyVideoSetting>[1], args: string) {
    const chat = this.chat(chatId);
    const result = applyVideoSetting(chat.video ?? {}, key, args);
    this.saveChat(chatId, { ...chat, video: result.overrides });
    return result.message;
  }
  /** Gets the picture a message carries or replies to into the studio as a source image. */
  private async pictureSource(token: string, chatId: number, picture: TelegramMessage, signal: AbortSignal) {
    const recordId = this.sentRecord(chatId, picture.message_id);
    if (recordId && this.ports.useOutputAsSource && this.ports.record?.(recordId))
      return this.ports.useOutputAsSource(recordId);
    if (!this.ports.importImage) throw new Error("This version of the studio can't take pictures from Telegram.");
    const file = picture.photo?.length
      ? picture.photo.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b))
      : picture.document;
    if (!file) throw new Error("That message doesn't have a picture in it.");
    if ((file.file_size ?? 0) > DOWNLOAD_LIMIT)
      throw new Error('That picture is over 20 MB, too big for a bot to fetch.');
    const info = await this.call<{ file_path?: string; file_size?: number }>(
      token,
      'getFile',
      { file_id: file.file_id },
      signal,
    );
    if (!info.file_path || (info.file_size ?? 0) > DOWNLOAD_LIMIT)
      throw new Error("Telegram wouldn't hand over that picture.");
    const response = await this.ports.fetch(`${API}/file/bot${token}/${info.file_path}`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    });
    if (!response.ok) throw new Error(`Telegram wouldn't hand over that picture (${response.status}).`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > DOWNLOAD_LIMIT) throw new Error('That picture is over 20 MB.');
    return this.ports.importImage(bytes, 'Picture from Telegram');
  }
  private async edit(
    chatId: number,
    instruction: string,
    source: () => Promise<SourceImageAsset>,
    reply: (text: string) => Promise<void>,
  ) {
    if (instruction.length > 4000) return reply('Keep the change under 4000 characters.');
    const profile = this.ports.editProfile?.();
    if (!profile || !this.ports.queueEdit)
      return reply("Editing needs the Qwen Edit files. Set them up on the studio's Edit page first.");
    const blocked = this.ports.blockedReason();
    if (blocked) return reply(`The studio can't take new edits right now: ${blocked}`);
    let job: GenerationJob;
    try {
      const picture = await source();
      const { width, height } = picture.normalized;
      const parent = picture.originGenerationId ? this.ports.record?.(picture.originGenerationId) : undefined;
      job = await this.ports.queueEdit({
        mode: 'qwen-edit',
        sourceId: picture.id,
        sourceSha256: picture.normalized.sha256,
        operation: 'edit',
        instruction,
        negativePrompt: '',
        settings: { profile, ...qwenWorkingSize(width, height), seed: 'random', resize: 'stretch' },
        output: qwenSameSize(width, height),
        lineage: {
          // Editing an edit carries on its chain, like the Edit page.
          conversationId: parent?.qwenEdit?.lineage.conversationId ?? randomUUID(),
          branchId: parent?.qwenEdit?.lineage.branchId ?? randomUUID(),
          ...(picture.originGenerationId ? { parentRecordId: picture.originGenerationId } : {}),
        },
      });
    } catch (error) {
      return reply(`Couldn't start that edit: ${message(error)}`);
    }
    this.remember(job.id, { chatId, prompt: `Edit: ${instruction.slice(0, 290)}` });
    return reply(`Editing it! ${this.ahead(job.id)}${this.engineNote()}`);
  }
  private async enhance(chatId: number, recordId: string, reply: (text: string) => Promise<void>) {
    const record = this.ports.record?.(recordId);
    if (!record || !this.ports.useOutputAsSource) return reply("That picture isn't in the studio anymore.");
    const current = effectiveDraft(this.ports.draft(), this.chat(chatId).overrides, '');
    if (!record.checkpoint && (current.imageModel || !current.checkpointId))
      return reply('Enhance runs on an SDXL model. Pick one with /model first.');
    const blocked = this.ports.blockedReason();
    if (blocked) return reply(`The studio can't take new images right now: ${blocked}`);
    const maxSide = this.ports.enhanceMaxSide?.() ?? ENHANCE_MAX_SIDE;
    let job: GenerationJob;
    try {
      const source = await this.ports.useOutputAsSource(record.id);
      job = await this.ports.queue(prepareOneClickEnhancement(record, source, current, 2, maxSide));
    } catch (error) {
      return reply(`Couldn't enhance that one: ${message(error)}`);
    }
    const prompt = (record.resolvedPrompt ?? record.draft.prompt ?? '').slice(0, 280);
    this.remember(job.id, { chatId, prompt: `Enhanced: ${prompt}` });
    return reply(
      `${enhancementActionLabel(record, maxSide) === 'Refine image' ? 'Refining' : 'Upscaling and refining'} it to ${job.draft.width}×${job.draft.height}. ${this.ahead(job.id)}${this.engineNote()}`,
    );
  }
  private async video(
    chatId: number,
    text: string,
    reply: (text: string, buttons?: Button[][]) => Promise<void>,
    source?: () => Promise<SourceImageAsset>,
  ) {
    const status = this.ports.videoStatus?.();
    if (!this.ports.queueVideo || !status) return reply("This version of the studio can't make clips from Telegram.");
    const chat = this.chat(chatId);
    if (!text) {
      if (source) return reply('Tell me what should happen, like: /video she turns and smiles');
      const draft = videoDraftFor(this.ports.videoDraft?.(), chat.video ?? {}, '');
      const button = (label: string, key: string, value: string | number): Button => ({
        text: label,
        callback_data: `vid:${key}:${value}`,
      });
      return reply(
        `${describeVideo(this.ports.videoDraft?.(), chat.video ?? {}, status.assets)}\n\nSend /video <what happens> to make a clip. Tap to change the settings for this chat.`,
        [
          VIDEO_QUALITY.map(item =>
            button(`${item.profile === draft.profile ? '• ' : ''}${item.name}`, 'quality', item.profile),
          ),
          VIDEO_LENGTHS.map(seconds =>
            button(`${seconds === draft.requestedDurationSeconds ? '• ' : ''}${seconds}s`, 'length', seconds),
          ),
          [0, 3, 6].map(index => {
            const size = VIDEO_SIZES[index];
            const current = size.width === draft.width && size.height === draft.height;
            return button(`${current ? '• ' : ''}${size.name} ${size.width}×${size.height}`, 'size', index + 1);
          }),
        ],
      );
    }
    if (text.length > 4000) return reply('That prompt is too long. Keep it under 4000 characters.');
    const { prompt, flags } = splitVideoFlags(text);
    if (!prompt) return reply('Put what happens before any --settings, like: /video waves rolling in --length 8');
    let overrides = chat.video ?? {};
    try {
      for (const flag of flags) overrides = applyVideoSetting(overrides, flag.key, flag.args).overrides;
    } catch (error) {
      return reply(message(error));
    }
    if (!status.canGenerate) return reply(`Can't make clips right now: ${status.message}`);
    const blocked = this.ports.blockedReason();
    if (blocked) return reply(`The studio can't take new clips right now: ${blocked}`);
    let job: VideoJob;
    try {
      const picture = source ? await source() : undefined;
      const draft = videoDraftFor(
        this.ports.videoDraft?.(),
        overrides,
        prompt,
        picture && {
          sourceId: picture.id,
          sha256: picture.normalized.sha256,
          width: picture.normalized.width,
          height: picture.normalized.height,
        },
      );
      const missing = qualityMissing(status.assets, draft.profile);
      if (missing) return reply(missing);
      job = await this.ports.queueVideo(draft);
    } catch (error) {
      return reply(`Couldn't queue that clip: ${message(error)}`);
    }
    this.remember(job.id, { chatId, prompt: prompt.slice(0, 300) });
    const draft = job.video;
    return reply(
      `${source ? 'Animating it!' : 'Queued a clip!'} ${this.ahead(job.id)}\n${qualityName(draft.profile)} · ${job.durationSeconds.toFixed(1)}s · ${draft.width}×${draft.height}. Clips take a few minutes.`,
    );
  }
  /** The newest plain Create image that wasn't asked for from Telegram. */
  private lastPcImage() {
    const remote = new Set(this.ports.store.getState<string[]>(REMOTE_IDS_STATE, []));
    return this.ports.records?.().find(record => !remote.has(record.jobId) && isCreateImage(record));
  }
  private async useLast(chatId: number, reply: (text: string, buttons?: Button[][]) => Promise<void>) {
    const record = this.lastPcImage();
    if (!record) return reply("I couldn't find an image made on the PC yet. Make one in Create first.");
    const chat = this.chat(chatId);
    let result;
    try {
      result = settingsFromRecord(this.context(chatId), record);
    } catch (error) {
      return reply(`Couldn't copy the settings from your last PC image. ${message(error)}`);
    }
    const next: ChatState = { ...chat, overrides: result.overrides };
    delete next.classic;
    this.saveChat(chatId, next);
    const prompt = record.draft.prompt.trim();
    return reply(
      prompt
        ? `${result.message}\n\nIts prompt: ${prompt.slice(0, 600)}${prompt.length > 600 ? '…' : ''}`
        : result.message,
      prompt ? [[{ text: 'Make it again with that prompt', callback_data: 'last:prompt' }]] : undefined,
    );
  }
  private ahead(jobId: string) {
    const ahead = this.ports.jobs().filter(item => item.status === 'queued' && item.id !== jobId).length;
    return ahead ? `${ahead} ahead of it.` : "It's next up.";
  }
  private engineNote() {
    return this.ports.backend().state === 'ready' ? '' : " The engine isn't running yet, so it'll wait for it.";
  }
  private sentRecord(chatId: number, messageId: number): string | undefined {
    const sent = this.ports.store.getState<Record<string, string>>(SENT_STATE, {});
    const value = sent && typeof sent === 'object' ? sent[`${chatId}:${messageId}`] : undefined;
    return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
  }
  private rememberSent(chatId: number, messageId: number, recordId: string) {
    const sent = this.ports.store.getState<Record<string, string>>(SENT_STATE, {});
    const kept = Object.entries(sent && typeof sent === 'object' ? sent : {}).slice(-(SENT_KEPT - 1));
    this.ports.store.setState(SENT_STATE, Object.fromEntries([...kept, [`${chatId}:${messageId}`, recordId]]));
  }
  private loraText(chatId: number) {
    const ctx = this.context();
    const loras = loraList(ctx.models);
    const draft = effectiveDraft(ctx.studio, this.chat(chatId).overrides, '');
    if (!loras.length) return 'No LoRAs are installed in the studio yet.';
    if (draft.imageModel)
      return `${IMAGE_MODELS[draft.imageModel].name} makes images from text only, so LoRAs sit out. Pick an SDXL model with /model to use them.`;
    const active = new Map(draft.loras.map(lora => [lora.modelId, lora]));
    return [
      ...loras.map((lora, index) => {
        const used = active.get(lora.id);
        return `${index + 1}. ${lora.name}${used ? (used.off ? ' ⏸ off' : ` ✅ ${used.weight}`) : ''}`;
      }),
      '',
      'Add or change one with /lora <number or name> [weight]. /lora off <number> switches one off without losing it, /lora on <number> brings it back, /lora remove <number> takes it out, /lora clear empties the list.',
    ].join('\n');
  }
  private statusText() {
    const backend = this.ports.backend();
    const jobs = this.ports.jobs();
    const running = jobs.filter(job => job.status === 'running').length;
    const queued = jobs.filter(job => job.status === 'queued').length;
    const engine =
      backend.state === 'ready' ? 'The engine is running.' : `The engine: ${backend.message || backend.state}`;
    return `${engine}\n${running} running, ${queued} waiting in the queue.`;
  }
  private mine(chatId: number) {
    const remote = this.remoteJobs();
    return this.ports
      .jobs()
      .filter(job => remote[job.id]?.chatId === chatId && ['queued', 'running'].includes(job.status));
  }
  private queueText(chatId: number) {
    const remote = this.remoteJobs();
    const jobs = this.mine(chatId);
    if (!jobs.length) return 'Nothing of yours is waiting. Send a prompt to start one.';
    return jobs
      .map(job => {
        const progress =
          job.status === 'running' && job.progressMax ? ` ${Math.round((job.progress / job.progressMax) * 100)}%` : '';
        return `${job.status === 'running' ? 'Running' + progress : 'Waiting'}: ${remote[job.id].prompt.slice(0, 80)}`;
      })
      .join('\n');
  }
  private async cancelLatest(chatId: number, reply: (text: string) => Promise<void>) {
    const latest = this.mine(chatId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!latest) return reply('Nothing of yours to cancel.');
    try {
      await this.ports.cancel(latest.id);
      await reply('Cancelling your latest image.');
    } catch (error) {
      await reply(`Could not cancel it: ${message(error)}`);
    }
  }
  private async generate(chatId: number, text: string, reply: (text: string) => Promise<void>) {
    if (!text) return reply('Send a prompt after /gen, or just send the prompt by itself.');
    if (text.length > 4000) return reply('That prompt is too long. Keep it under 4000 characters.');
    const { prompt, flags } = splitPromptFlags(text);
    if (!prompt) return reply('Put the prompt before any --settings, like: a red fox --steps 30');
    const chat = this.chat(chatId);
    const ctx = this.context(chatId);
    let overrides = chat.overrides;
    try {
      for (const flag of flags) overrides = applySetting(ctx, overrides, flag.key, flag.args).overrides;
    } catch (error) {
      return reply(message(error));
    }
    this.saveChat(chatId, { ...chat, lastPrompt: text });
    const blocked = this.ports.blockedReason();
    if (blocked) return reply(`The studio can't take new images right now: ${blocked}`);
    const draft = effectiveDraft(ctx.studio, overrides, prompt);
    let job: GenerationJob;
    try {
      job = await this.ports.queue(draft);
    } catch (error) {
      return reply(`Couldn't queue that: ${message(error)}`);
    }
    this.remember(job.id, { chatId, prompt: prompt.slice(0, 300) });
    const model = modelName(draft, ctx.models);
    await reply(
      `Queued! ${this.ahead(job.id)}${this.engineNote()}\n${model} · ${draft.width}×${draft.height} · ${draft.steps} steps${draft.hiresFix ? ' · hires' : ''}${draft.autoFace ? ' · face fix' : ''}`,
    );
  }
  /** The pictures a finished job leaves behind, without the in-between hires and face stages. */
  private finished(jobId: string) {
    const records = this.ports.store.recordsForJob(jobId);
    const done = records.filter(record => record.outputRole !== 'base' && record.outputRole !== 'face-pass');
    return done.length ? done : records;
  }
  /** Sends a finished job, and keeps it for another try when the connection drops part way. */
  private async sendResult(job: StudioJob, remote: RemoteJob) {
    this.delivering.add(job.id);
    let sent = remote.retry?.sent ?? 0;
    try {
      await this.deliver(job, remote, sent, () => sent++);
      this.forget(job.id);
    } catch (error) {
      const attempts = (remote.retry?.attempts ?? 0) + 1;
      const again = attempts < DELIVERY_ATTEMPTS && !this.disposed;
      this.ports.log(
        `Telegram delivery${again ? `, trying again in ${(RETRY_DELAY_MS * attempts) / 1000}s` : ', giving up'}: ${this.redact(message(error))}`,
      );
      if (again)
        this.remember(job.id, {
          ...remote,
          waitingFaces: false,
          retry: { attempts, at: Date.now() + RETRY_DELAY_MS * attempts, sent },
        });
      else this.forget(job.id);
    } finally {
      this.delivering.delete(job.id);
    }
  }
  private async deliver(job: StudioJob, remote: RemoteJob, skip = 0, onSent: () => void = () => undefined) {
    const token = this.token();
    if (!token || !this.settings().enabled) return;
    const signal = this.controller?.signal ?? new AbortController().signal;
    if (job.status === 'cancelled') return this.send(token, remote.chatId, 'Cancelled.', signal);
    if (job.status === 'failed')
      return this.send(
        token,
        remote.chatId,
        `That one failed: ${job.error || 'open the studio queue for details.'}`,
        signal,
      );
    if (isVideoJob(job)) return this.deliverVideo(token, job, remote, signal);
    if (!isImageJob(job)) return;
    const jobs = this.ports.jobs();
    // A face-fixed copy replaces its original; anything without one keeps the original.
    const pictures = this.finished(job.id)
      .flatMap(record => {
        const childId = job.autoFaceResults?.[record.id]?.jobId;
        const child = childId && jobs.find(item => item.id === childId);
        const fixed = child && child.status === 'completed' ? this.finished(child.id) : [];
        return fixed.length ? fixed : [record];
      })
      .slice(0, 10);
    if (!pictures.length) return this.send(token, remote.chatId, 'Done, but no saved image was found.', signal);
    for (const [index, record] of pictures.entries()) {
      if (index < skip) continue;
      const bytes = await this.ports.readOutput(record);
      const caption =
        index === 0
          ? `${remote.prompt.slice(0, 900)}\nSeed ${record.actualSeed} · ${record.width}×${record.height}`
          : '';
      const sent = await this.upload(token, remote.chatId, bytes, `latent-${record.id}.png`, caption, signal, [
        [{ text: '✨ Enhance', callback_data: `enh:${record.id}` }],
      ]);
      if (sent?.message_id) this.rememberSent(remote.chatId, sent.message_id, record.id);
      onSent();
    }
  }
  private async deliverVideo(token: string, job: VideoJob, remote: RemoteJob, signal: AbortSignal) {
    const recordId = job.outputIds[0];
    if (!recordId || !this.ports.readVideo)
      return this.send(token, remote.chatId, "The clip is done, but I couldn't find the saved file.", signal);
    const bytes = await this.ports.readVideo(recordId);
    if (bytes.byteLength > UPLOAD_LIMIT)
      return this.send(
        token,
        remote.chatId,
        `The clip is done, but at ${Math.round(bytes.byteLength / 1024 / 1024)} MB it's too big for Telegram. It's on the studio's Video page.`,
        signal,
      );
    const caption = `${remote.prompt.slice(0, 900)}\nSeed ${job.actualSeed} · ${job.durationSeconds.toFixed(1)}s`;
    const form = (field: string) => {
      const data = new FormData();
      data.set('chat_id', String(remote.chatId));
      data.set('caption', caption);
      if (field === 'video') data.set('supports_streaming', 'true');
      data.set(field, new Blob([new Uint8Array(bytes)], { type: 'video/mp4' }), `latent-${recordId}.mp4`);
      return data;
    };
    try {
      await this.call(token, 'sendVideo', form('video'), signal, 300_000);
    } catch (error) {
      if (signal.aborted || !(error instanceof TelegramApiError)) throw error;
      await this.call(token, 'sendDocument', form('document'), signal, 300_000);
    }
  }
  private async upload(
    token: string,
    chatId: number,
    bytes: Buffer,
    filename: string,
    caption: string,
    signal: AbortSignal,
    buttons?: Button[][],
  ): Promise<{ message_id?: number } | undefined> {
    const form = (field: string) => {
      const data = new FormData();
      data.set('chat_id', String(chatId));
      if (caption) data.set('caption', caption);
      if (buttons) data.set('reply_markup', JSON.stringify({ inline_keyboard: buttons }));
      data.set(field, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), filename);
      return data;
    };
    try {
      return await this.call(token, 'sendPhoto', form('photo'), signal, 120_000);
    } catch (error) {
      // Photos are capped at 10 MB and limited dimensions; a document keeps the full PNG instead.
      if (signal.aborted || !(error instanceof TelegramApiError)) throw error;
      return await this.call(token, 'sendDocument', form('document'), signal, 120_000);
    }
  }
  private chat(chatId: number): ChatState {
    const saved = this.ports.store.getState<Record<string, ChatState>>(CHATS_STATE, {})[String(chatId)];
    return saved && typeof saved === 'object' ? { ...saved, overrides: saved.overrides ?? {} } : { overrides: {} };
  }
  private saveChat(chatId: number, value: ChatState) {
    const chats = this.ports.store.getState<Record<string, ChatState>>(CHATS_STATE, {});
    this.ports.store.setState(CHATS_STATE, { ...chats, [String(chatId)]: value });
  }
  private remoteJobs(): Record<string, RemoteJob> {
    const saved = this.ports.store.getState<Record<string, RemoteJob>>(JOBS_STATE, {});
    return saved && typeof saved === 'object' ? saved : {};
  }
  private remember(id: string, remote: RemoteJob) {
    const ids = this.ports.store.getState<string[]>(REMOTE_IDS_STATE, []);
    const known = Array.isArray(ids) ? ids.filter(item => typeof item === 'string' && item !== id) : [];
    this.ports.store.setState(REMOTE_IDS_STATE, [...known.slice(-(REMOTE_IDS_KEPT - 1)), id]);
    const live = new Set(this.ports.jobs().map(job => job.id));
    const kept = Object.entries(this.remoteJobs()).filter(([jobId]) => jobId !== id && live.has(jobId));
    this.ports.store.setState(JOBS_STATE, Object.fromEntries([...kept.slice(-200), [id, remote]]));
  }
  private forget(id: string) {
    const remote = this.remoteJobs();
    delete remote[id];
    this.ports.store.setState(JOBS_STATE, remote);
  }
}

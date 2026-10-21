import { z } from 'zod';
import type {
  BackendStatus,
  GenerationDraft,
  GenerationJob,
  GenerationRecord,
  ModelAsset,
  Preset,
  StudioJob,
} from '../shared/types';
import { isImageJob } from '../shared/types';
import { SAMPLERS, SCHEDULERS } from '../shared/defaults';
import { telegramSettingsSchema, type TelegramSettings, type TelegramStatus } from '../shared/telegram-types';
import type { StudioStore } from './store';
import {
  applySetting,
  checkpointList,
  describeSettings,
  effectiveDraft,
  isSettingKey,
  loraList,
  POPULAR_SAMPLERS,
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
interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
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
  lastPrompt?: string;
}
type Button = { text: string; callback_data: string };

const SETTINGS_STATE = 'telegram.settings.v1';
const TOKEN_STATE = 'telegram.encrypted-token.v1';
const OFFSET_STATE = 'telegram.offset.v1';
const JOBS_STATE = 'telegram.jobs.v1';
const CHATS_STATE = 'telegram.chats.v1';
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
  'Send me a prompt and I will make it on the studio PC. You start with the studio’s Create settings and can change anything below just for this chat.',
  '',
  'Making images',
  '/gen <prompt> - same as just sending a prompt',
  '/again - run your last prompt again with a new seed',
  '/queue - what is waiting or running',
  '/cancel - cancel your latest image',
  '',
  'Settings (send without a value to see choices)',
  '/settings - show everything',
  '/model - pick the checkpoint',
  '/loras - list LoRAs; /lora <name> [weight], /lora remove <name>, /lora clear',
  '/size 832x1216 or /size portrait',
  '/steps 30 · /cfg 6.5 · /seed 1234 or random · /batch 1-4',
  '/sampler · /scheduler',
  '/neg <negative prompt> or /neg off',
  '/hires on [scale] [denoise] or off',
  '/faces on [illustrated|anime|photographic] [strength] or off',
  '/triggers on|off - add LoRA trigger words automatically',
  '/preset - load one of the studio’s saved presets',
  '/reset - go back to the studio’s Create settings',
  '',
  'One-off changes work inside a prompt too:',
  'a fox in the snow --size landscape --steps 35 --seed 7',
  '',
  '/status - is the image engine running? · /id - your Telegram user ID',
].join('\n');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
    if (!from || incoming.chat.type !== 'private' || typeof incoming.text !== 'string') return;
    const text = incoming.text.trim();
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
          `This bot is private. Your Telegram user ID is ${from}. The owner can add it in Latent under Settings > Telegram remote.`,
          signal,
        );
      return;
    }
    const reply = (value: string, buttons?: Button[][]) => this.send(token, chatId, value, signal, buttons);
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
        this.saveChat(chatId, { ...this.chat(chatId), overrides: {} });
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
  private context(): ControlContext {
    return {
      studio: this.ports.draft(),
      models: this.ports.models(),
      // Sorted once here so list numbers, buttons and typed numbers all agree.
      presets: [...this.ports.presets()].sort((a, b) => a.name.localeCompare(b.name)),
      sizes: this.ports.sizes(),
    };
  }
  private async change(chatId: number, key: SettingKey, args: string) {
    const chat = this.chat(chatId);
    const result = applySetting(this.context(), chat.overrides, key, args);
    this.saveChat(chatId, { ...chat, overrides: result.overrides });
    return result.message;
  }
  /** Lists the options for a setting, as buttons where a tap is enough. */
  private async choices(chatId: number, key: SettingKey, reply: (text: string, buttons?: Button[][]) => Promise<void>) {
    const ctx = this.context();
    const draft = effectiveDraft(ctx.studio, this.chat(chatId).overrides, '');
    const button = (text: string, arg: string | number): Button => ({ text, callback_data: `set:${key}:${arg}` });
    const rows = (buttons: Button[], width: number) =>
      Array.from({ length: Math.ceil(buttons.length / width) }, (_, index) =>
        buttons.slice(index * width, index * width + width),
      );
    switch (key) {
      case 'model': {
        const models = checkpointList(ctx.models);
        if (!models.length) return reply('No checkpoints are installed in the studio yet.');
        const current = ctx.models.find(model => model.id === draft.checkpointId)?.name ?? 'none';
        return reply(
          `Current model: ${current}\n\n${models.map((model, index) => `${index + 1}. ${model.name}`).join('\n')}\n\nTap one, or send /model <number or name>.`,
          rows(
            models.slice(0, 30).map((model, index) => button(model.name.slice(0, 40), index + 1)),
            1,
          ),
        );
      }
      case 'lora':
        return reply(this.loraText(chatId));
      case 'size':
        return reply(
          `Current size: ${draft.width}×${draft.height}. Tap one, or send /size <width>x<height> (multiples of 64, 256 to 2048).`,
          rows(
            ctx.sizes.map((size, index) => button(`${size.name} ${size.width}×${size.height}`, index + 1)),
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
        return reply(`Steps: ${draft.steps}. Send /steps <1-100>.`);
      case 'cfg':
        return reply(`CFG: ${draft.cfg}. Send /cfg <0-30>.`);
      case 'seed':
        return reply(`Seed: ${draft.seed}. Send /seed <number> to pin it or /seed random.`);
      case 'batch':
        return reply(`Images per prompt: ${draft.batchSize}.`, [
          [1, 2, 3, 4].map(count => button(String(count), count)),
        ]);
    }
  }
  private loraText(chatId: number) {
    const ctx = this.context();
    const loras = loraList(ctx.models);
    const draft = effectiveDraft(ctx.studio, this.chat(chatId).overrides, '');
    if (!loras.length) return 'No LoRAs are installed in the studio yet.';
    const active = new Map(draft.loras.map(lora => [lora.modelId, lora.weight]));
    return [
      ...loras.map(
        (lora, index) => `${index + 1}. ${lora.name}${active.has(lora.id) ? ` ✅ ${active.get(lora.id)}` : ''}`,
      ),
      '',
      'Add or change one with /lora <number or name> [weight], remove with /lora remove <number>, or /lora clear.',
    ].join('\n');
  }
  private statusText() {
    const backend = this.ports.backend();
    const jobs = this.ports.jobs();
    const running = jobs.filter(job => job.status === 'running').length;
    const queued = jobs.filter(job => job.status === 'queued').length;
    const engine =
      backend.state === 'ready' ? 'Image engine is running.' : `Image engine: ${backend.message || backend.state}`;
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
    const ctx = this.context();
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
    const ahead = this.ports.jobs().filter(item => item.status === 'queued' && item.id !== job.id).length;
    const model = ctx.models.find(item => item.id === draft.checkpointId)?.name ?? 'the selected model';
    const engine =
      this.ports.backend().state === 'ready' ? '' : ' The image engine is not running yet, so it will wait for it.';
    await reply(
      `Queued! ${ahead ? `${ahead} ahead of it.` : "It's next up."}${engine}\n${model} · ${draft.width}×${draft.height} · ${draft.steps} steps${draft.hiresFix ? ' · hires' : ''}${draft.autoFace ? ' · face fix' : ''}`,
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
      await this.upload(token, remote.chatId, bytes, `latent-${record.id}.png`, caption, signal);
      onSent();
    }
  }
  private async upload(
    token: string,
    chatId: number,
    bytes: Buffer,
    filename: string,
    caption: string,
    signal: AbortSignal,
  ) {
    const form = (field: string) => {
      const data = new FormData();
      data.set('chat_id', String(chatId));
      if (caption) data.set('caption', caption);
      data.set(field, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), filename);
      return data;
    };
    try {
      await this.call(token, 'sendPhoto', form('photo'), signal, 120_000);
    } catch (error) {
      // Photos are capped at 10 MB and limited dimensions; a document keeps the full PNG instead.
      if (signal.aborted || !(error instanceof TelegramApiError)) throw error;
      await this.call(token, 'sendDocument', form('document'), signal, 120_000);
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

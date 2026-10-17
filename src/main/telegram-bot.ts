import { z } from 'zod';
import type { BackendStatus, GenerationDraft, GenerationJob, GenerationRecord, StudioJob } from '../shared/types';
import { isImageJob } from '../shared/types';
import { telegramSettingsSchema, type TelegramSettings, type TelegramStatus } from '../shared/telegram-types';
import type { StudioStore } from './store';

export interface TelegramCredentialCrypto {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
export interface TelegramBotPorts {
  store: Pick<StudioStore, 'getState' | 'setState' | 'records'>;
  crypto?: TelegramCredentialCrypto;
  fetch: typeof fetch;
  /** The studio's current Create settings, which Telegram prompts reuse. */
  draft(): GenerationDraft;
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
interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  text?: string;
}
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}
interface RemoteJob {
  chatId: number;
  prompt: string;
}

const SETTINGS_STATE = 'telegram.settings.v1';
const TOKEN_STATE = 'telegram.encrypted-token.v1';
const OFFSET_STATE = 'telegram.offset.v1';
const JOBS_STATE = 'telegram.jobs.v1';
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
  'Send me a prompt and I will make it on the studio PC with the current Create settings (model, size, LoRAs, steps).',
  '',
  '/gen <prompt> - same as sending a prompt',
  '/queue - what is waiting or running',
  '/cancel - cancel your latest image',
  '/status - is the image engine running?',
  '/id - show your Telegram user ID',
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

/**
 * A Telegram copy of the studio draft: a plain text-to-image job with a fresh seed. Features
 * that need a picked source image or a follow-up pass stay in the studio window.
 */
export function telegramDraft(base: GenerationDraft, prompt: string): GenerationDraft {
  const {
    autoFace: _autoFace,
    autoFaceParentRecordId: _autoFaceParent,
    enhance: _enhance,
    faceDetailer: _faceDetailer,
    ipAdapter: _ipAdapter,
    regionalPrompts: _regional,
    qwenEdit: _qwenEdit,
    variationOfRecordId: _variation,
    controlNet: _controlNet,
    upscale: _upscale,
    imageInput: _imageInput,
    dynamicPrompts: _dynamic,
    promptTriggerSpans: _spans,
    ...rest
  } = structuredClone(base);
  // Studio prompts carry LoRA trigger words visibly; a typed prompt gets them added automatically.
  return { ...rest, prompt, seed: 'random', triggerResolutionVersion: 'punctuation@2' };
}

/** Optional remote control: long-polls Telegram, so nothing on the PC has to accept connections. */
export class TelegramBotService {
  private state: TelegramStatus['state'] = 'off';
  private statusMessage = 'Telegram remote is off.';
  private botUsername?: string;
  private controller?: AbortController;
  private running?: Promise<void>;
  private disposed = false;
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
    void this.restart();
  }
  async dispose() {
    this.disposed = true;
    await this.stop();
  }

  /** Delivers finished Telegram jobs back to the chat that asked for them. */
  jobFinished(job: StudioJob) {
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) return;
    const remote = this.remoteJobs()[job.id];
    if (!remote) return;
    this.forget(job.id);
    void this.deliver(job, remote).catch(error => this.ports.log(`Telegram delivery: ${this.redact(message(error))}`));
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
          { offset, timeout: POLL_SECONDS, allowed_updates: ['message'] },
          signal,
          (POLL_SECONDS + 15) * 1000,
        );
        if (failures) this.setState('online', `Listening as @${this.botUsername ?? 'your bot'}.`);
        failures = 0;
        for (const update of updates) {
          if (signal.aborted) return;
          this.ports.store.setState(OFFSET_STATE, update.update_id + 1);
          if (update.message) await this.handle(token, update.message, signal);
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
  private async send(token: string, chatId: number, text: string, signal = new AbortController().signal) {
    await this.call(token, 'sendMessage', { chat_id: chatId, text: text.slice(0, 4000) }, signal);
  }
  private async handle(token: string, incoming: TelegramMessage, signal: AbortSignal) {
    const from = incoming.from?.id;
    if (!from || incoming.chat.type !== 'private' || typeof incoming.text !== 'string') return;
    const text = incoming.text.trim();
    const first = text.split(/\s+/, 1)[0] ?? '';
    const command = first.startsWith('/') ? first.slice(1).split('@')[0].toLowerCase() : undefined;
    const chatId = incoming.chat.id;
    if (!this.settings().allowedUserIds.includes(String(from))) {
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
    switch (command) {
      case 'start':
      case 'help':
        return this.send(token, chatId, HELP, signal);
      case 'id':
        return this.send(token, chatId, `Your Telegram user ID is ${from}.`, signal);
      case 'status':
        return this.send(token, chatId, this.statusText(), signal);
      case 'queue':
        return this.send(token, chatId, this.queueText(chatId), signal);
      case 'cancel':
        return this.cancelLatest(token, chatId, signal);
      case 'gen':
      case undefined:
        return this.generate(token, chatId, command ? text.slice(first.length).trim() : text, signal);
      default:
        return this.send(token, chatId, `I don't know /${command}.\n\n${HELP}`, signal);
    }
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
  private async cancelLatest(token: string, chatId: number, signal: AbortSignal) {
    const latest = this.mine(chatId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!latest) return this.send(token, chatId, 'Nothing of yours to cancel.', signal);
    try {
      await this.ports.cancel(latest.id);
      await this.send(token, chatId, 'Cancelling your latest image.', signal);
    } catch (error) {
      await this.send(token, chatId, `Could not cancel it: ${message(error)}`, signal);
    }
  }
  private async generate(token: string, chatId: number, prompt: string, signal: AbortSignal) {
    if (!prompt)
      return this.send(token, chatId, 'Send a prompt after /gen, or just send the prompt by itself.', signal);
    if (prompt.length > 4000)
      return this.send(token, chatId, 'That prompt is too long. Keep it under 4000 characters.', signal);
    const blocked = this.ports.blockedReason();
    if (blocked) return this.send(token, chatId, `The studio can't take new images right now: ${blocked}`, signal);
    let job: GenerationJob;
    try {
      job = await this.ports.queue(telegramDraft(this.ports.draft(), prompt));
    } catch (error) {
      return this.send(token, chatId, `Couldn't queue that: ${message(error)}`, signal);
    }
    this.remember(job.id, { chatId, prompt: prompt.slice(0, 300) });
    const ahead = this.ports.jobs().filter(item => item.status === 'queued' && item.id !== job.id).length;
    const engine =
      this.ports.backend().state === 'ready' ? '' : ' The image engine is not running yet, so it will wait for it.';
    await this.send(
      token,
      chatId,
      `Queued! ${ahead ? `${ahead} ahead of it.` : "It's next up."}${engine} I'll send the image here when it's done.`,
      signal,
    );
  }
  private async deliver(job: StudioJob, remote: RemoteJob) {
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
    const records = this.ports.store.records().filter(record => record.jobId === job.id);
    // Hires fix keeps the pre-pass image as a "base" record; send only the finished pictures.
    const finished = records.filter(record => record.outputRole !== 'base' && record.outputRole !== 'face-pass');
    const pictures = (finished.length ? finished : records).slice(0, 10);
    if (!pictures.length) return this.send(token, remote.chatId, 'Done, but no saved image was found.', signal);
    for (const [index, record] of pictures.entries()) {
      const bytes = await this.ports.readOutput(record);
      const caption =
        index === 0
          ? `${remote.prompt.slice(0, 900)}\nSeed ${record.actualSeed} · ${record.width}×${record.height}`
          : '';
      await this.upload(token, remote.chatId, bytes, `latent-${record.id}.png`, caption, signal);
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
  private remoteJobs(): Record<string, RemoteJob> {
    const saved = this.ports.store.getState<Record<string, RemoteJob>>(JOBS_STATE, {});
    return saved && typeof saved === 'object' ? saved : {};
  }
  private remember(id: string, remote: RemoteJob) {
    const live = new Set(this.ports.jobs().map(job => job.id));
    const kept = Object.entries(this.remoteJobs()).filter(([jobId]) => live.has(jobId));
    this.ports.store.setState(JOBS_STATE, Object.fromEntries([...kept.slice(-200), [id, remote]]));
  }
  private forget(id: string) {
    const remote = this.remoteJobs();
    delete remote[id];
    this.ports.store.setState(JOBS_STATE, remote);
  }
}

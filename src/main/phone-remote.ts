import http from 'node:http';
import os from 'node:os';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { GenerationDraft, GenerationJob, GenerationRecord, ModelAsset, StudioJob } from '../shared/types';
import { isImageJob } from '../shared/types';
import {
  DEFAULT_PHONE_SETTINGS,
  phoneGenerateSchema,
  phoneSettingsSchema,
  type PhoneSettings,
  type PhoneStatus,
} from '../shared/phone-types';
import { checkpointList, effectiveDraft, type TelegramOverrides } from './telegram-controls';
import { PHONE_PAGE_HTML, PHONE_PAGE_SCRIPT } from './phone-page';
import type { StudioStore } from './store';

const SETTINGS_STATE = 'phone.settings.v1';
const TOKENS_STATE = 'phone.tokens.v1';
const MAX_BODY = 16 * 1024;
const MAX_PHONES = 10;
/** Wrong pairing codes allowed before pairing pauses; the code changes after a few pauses. */
const PAIR_ATTEMPTS = 5;
const PAIR_PAUSE_MS = 60_000;
const tokensSchema = z
  .array(
    z
      .object({
        hash: z.string().regex(/^[a-f0-9]{64}$/),
        createdAt: z.string().max(40),
        lastSeen: z.string().max(40).optional(),
      })
      .strict(),
  )
  .max(MAX_PHONES);
type StoredToken = z.infer<typeof tokensSchema>[number];

export interface PhoneRemotePorts {
  store: Pick<StudioStore, 'getState' | 'setState'>;
  draft(): GenerationDraft;
  models(): ModelAsset[];
  history(): readonly GenerationRecord[];
  jobs(): StudioJob[];
  queue(draft: GenerationDraft): Promise<GenerationJob>;
  cancel(id: string): Promise<void>;
  blockedReason(): string | undefined;
  readOutput(record: GenerationRecord): Promise<Buffer>;
  changed(): void;
  log(message: string): void;
  /** Network addresses, injectable for tests. */
  addresses?(): string[];
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Private IPv4 addresses on this PC, home networks first. */
export function lanAddresses(interfaces = os.networkInterfaces()): string[] {
  const found: string[] = [];
  for (const list of Object.values(interfaces))
    for (const item of list ?? [])
      if (item.family === 'IPv4' && !item.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))
        found.push(item.address);
  return found.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')));
}

/**
 * Optional phone page on the home network. Off by default. A phone pairs once with a six-digit code
 * shown in Settings and then holds a random token; every other request needs that token.
 */
export class PhoneRemoteService {
  private server?: http.Server;
  private state: PhoneStatus['state'] = 'off';
  private statusMessage = 'Phone remote is off.';
  private code = '';
  private failures = 0;
  private pausedUntil = 0;
  private pauses = 0;
  constructor(private ports: PhoneRemotePorts) {}

  settings(): PhoneSettings {
    const parsed = phoneSettingsSchema.safeParse(this.ports.store.getState(SETTINGS_STATE, DEFAULT_PHONE_SETTINGS));
    return parsed.success ? parsed.data : { ...DEFAULT_PHONE_SETTINGS };
  }
  status(): PhoneStatus {
    const settings = this.settings();
    const online = this.state === 'online';
    return {
      ...settings,
      state: this.state,
      message: this.statusMessage,
      urls: online ? (this.ports.addresses?.() ?? lanAddresses()).map(ip => `http://${ip}:${settings.port}`) : [],
      pairingCode: online ? this.code : undefined,
      pairedPhones: this.tokens().length,
    };
  }
  async saveSettings(patch: unknown) {
    const next = phoneSettingsSchema.parse({ ...this.settings(), ...phoneSettingsSchema.partial().parse(patch) });
    this.ports.store.setState(SETTINGS_STATE, next);
    await this.restart();
  }
  newCode() {
    this.code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.failures = 0;
    this.pausedUntil = 0;
    this.ports.changed();
  }
  forgetPhones() {
    this.ports.store.setState(TOKENS_STATE, []);
    this.newCode();
  }
  start() {
    void this.restart();
  }
  async dispose() {
    await this.stop();
  }
  /** Request handler, exposed for tests. */
  handle = (request: http.IncomingMessage, response: http.ServerResponse) => {
    void this.route(request, response).catch(error => {
      if (!response.headersSent) this.json(response, 500, { error: 'Something went wrong on the PC.' });
      this.ports.log(`Phone remote: ${message(error)}`);
    });
  };

  private tokens(): StoredToken[] {
    const parsed = tokensSchema.safeParse(this.ports.store.getState(TOKENS_STATE, []));
    return parsed.success ? parsed.data : [];
  }
  private setState(state: PhoneStatus['state'], text: string) {
    this.state = state;
    this.statusMessage = text;
    this.ports.changed();
  }
  private async stop() {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    server?.closeAllConnections?.();
  }
  private async restart() {
    await this.stop();
    const settings = this.settings();
    if (!settings.enabled) return this.setState('off', 'Phone remote is off.');
    this.newCode();
    const server = http.createServer(this.handle);
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(settings.port, '0.0.0.0', () => resolve());
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return this.setState(
        'error',
        code === 'EADDRINUSE'
          ? `Port ${settings.port} is already in use. Pick another port.`
          : `The phone page could not start. ${message(error)}`,
      );
    }
    server.on('error', error => this.setState('error', `The phone page stopped. ${message(error)}`));
    this.server = server;
    this.setState('online', 'Open the address below on your phone, on the same Wi-Fi.');
  }

  private headers(type: string, extra: Record<string, string> = {}) {
    return {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      ...extra,
    };
  }
  private json(response: http.ServerResponse, status: number, body: unknown) {
    response.writeHead(status, this.headers('application/json; charset=utf-8'));
    response.end(JSON.stringify(body));
  }
  private async body(request: http.IncomingMessage): Promise<unknown> {
    if (!/^application\/json\b/.test(request.headers['content-type'] ?? ''))
      throw Object.assign(new Error('Send JSON.'), { status: 415 });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw Object.assign(new Error('That request is too big.'), { status: 413 });
      chunks.push(chunk as Buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw Object.assign(new Error('That request is not valid JSON.'), { status: 400 });
    }
  }
  /** The phone's token from the Authorization header, if it matches a paired phone. */
  private authorized(request: http.IncomingMessage) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
    if (!match) return false;
    const hash = Buffer.from(sha(match[1]), 'hex');
    const tokens = this.tokens();
    const found = tokens.find(token => timingSafeEqual(Buffer.from(token.hash, 'hex'), hash));
    if (!found) return false;
    const now = new Date().toISOString();
    if (!found.lastSeen || Date.parse(now) - Date.parse(found.lastSeen) > 60_000)
      this.ports.store.setState(
        TOKENS_STATE,
        tokens.map(token => (token === found ? { ...token, lastSeen: now } : token)),
      );
    return true;
  }
  private pair(code: unknown) {
    const now = Date.now();
    if (now < this.pausedUntil)
      throw Object.assign(new Error('Too many wrong codes. Wait a minute and try again.'), { status: 429 });
    const typed = typeof code === 'string' ? code.trim() : '';
    if (!/^\d{6}$/.test(typed) || !this.code || !timingSafeEqual(Buffer.from(typed), Buffer.from(this.code))) {
      this.failures += 1;
      if (this.failures >= PAIR_ATTEMPTS) {
        this.failures = 0;
        this.pausedUntil = now + PAIR_PAUSE_MS;
        this.pauses += 1;
        // Someone keeps guessing: change the code so guesses so far are wasted.
        if (this.pauses >= 3) {
          this.pauses = 0;
          this.code = String(randomInt(0, 1_000_000)).padStart(6, '0');
          this.ports.changed();
        }
      }
      throw Object.assign(new Error('That code is not right. Check Settings > Phone remote on the PC.'), {
        status: 403,
      });
    }
    const token = randomBytes(32).toString('base64url');
    const tokens = [
      ...this.tokens().slice(-(MAX_PHONES - 1)),
      { hash: sha(token), createdAt: new Date(now).toISOString() },
    ];
    this.ports.store.setState(TOKENS_STATE, tokens);
    // A code pairs one phone; the next phone gets a fresh one.
    this.newCode();
    return token;
  }
  private stateFor() {
    const draft = this.ports.draft();
    const models = checkpointList(this.ports.models());
    const jobs = this.ports.jobs().filter(isImageJob).slice(-8).reverse();
    const images = this.ports.history().slice(0, 24);
    return {
      studio: {
        checkpointId: draft.checkpointId,
        negativePrompt: draft.negativePrompt,
        width: draft.width,
        height: draft.height,
        steps: draft.steps,
        batchSize: draft.batchSize,
      },
      models: models.map(model => ({ id: model.id, name: model.name })),
      jobs: jobs.map(job => ({
        id: job.id,
        status: job.status,
        prompt: job.draft.prompt.slice(0, 200),
        progress: job.progressMax ? Math.round((job.progress / job.progressMax) * 100) : 0,
        error: job.status === 'failed' ? job.error?.slice(0, 300) : undefined,
        images: job.outputIds,
      })),
      images: images.map(record => ({
        id: record.id,
        prompt: (record.resolvedPrompt ?? record.draft.prompt).slice(0, 300),
        width: record.width,
        height: record.height,
      })),
    };
  }
  private draftFor(input: unknown): GenerationDraft {
    const request = phoneGenerateSchema.parse(input);
    const overrides: TelegramOverrides = {};
    if (request.checkpointId) {
      const model = checkpointList(this.ports.models()).find(item => item.id === request.checkpointId);
      if (!model) throw Object.assign(new Error('That model is not installed.'), { status: 400 });
      overrides.checkpointId = model.id;
      overrides.family = model.family as GenerationDraft['family'];
      if (model.id !== this.ports.draft().checkpointId) overrides.modelSampling = null;
    }
    if (request.negativePrompt !== undefined) overrides.negativePrompt = request.negativePrompt;
    if (request.width) overrides.width = request.width;
    if (request.height) overrides.height = request.height;
    if (request.steps) overrides.steps = request.steps;
    if (request.seed) overrides.seed = request.seed;
    if (request.batchSize) overrides.batchSize = request.batchSize;
    return effectiveDraft(this.ports.draft(), overrides, request.prompt);
  }
  private async route(request: http.IncomingMessage, response: http.ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://phone');
    const method = request.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/') {
      response.writeHead(200, this.headers('text/html; charset=utf-8'));
      return response.end(PHONE_PAGE_HTML);
    }
    if (method === 'GET' && url.pathname === '/app.js') {
      response.writeHead(200, this.headers('text/javascript; charset=utf-8'));
      return response.end(PHONE_PAGE_SCRIPT);
    }
    try {
      if (method === 'POST' && url.pathname === '/api/pair') {
        const body = (await this.body(request)) as { code?: unknown } | null;
        return this.json(response, 200, { token: this.pair(body?.code) });
      }
      if (!url.pathname.startsWith('/api/')) return this.json(response, 404, { error: 'Not found.' });
      if (!this.authorized(request)) return this.json(response, 401, { error: 'Pair this phone first.' });
      if (method === 'GET' && url.pathname === '/api/state') return this.json(response, 200, this.stateFor());
      if (method === 'POST' && url.pathname === '/api/generate') {
        const blocked = this.ports.blockedReason();
        if (blocked) return this.json(response, 409, { error: blocked });
        const job = await this.ports.queue(this.draftFor(await this.body(request)));
        return this.json(response, 200, { jobId: job.id });
      }
      if (method === 'POST' && url.pathname === '/api/cancel') {
        const body = z
          .object({
            jobId: z
              .string()
              .max(64)
              .regex(/^[A-Za-z0-9-]+$/),
          })
          .parse(await this.body(request));
        if (!this.ports.jobs().some(job => job.id === body.jobId))
          return this.json(response, 404, { error: 'That image is not in the queue.' });
        await this.ports.cancel(body.jobId);
        return this.json(response, 200, { ok: true });
      }
      const image = /^\/api\/image\/([a-f0-9]{32})$/.exec(url.pathname);
      if (method === 'GET' && image) {
        const record = this.ports.history().find(item => item.id === image[1]);
        if (!record) return this.json(response, 404, { error: 'That image is gone.' });
        const bytes = await this.ports.readOutput(record);
        response.writeHead(200, this.headers('image/png', { 'Content-Length': String(bytes.length) }));
        return response.end(bytes);
      }
      return this.json(response, 404, { error: 'Not found.' });
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (error instanceof z.ZodError)
        return this.json(response, 400, { error: error.issues[0]?.message ?? 'Check the values.' });
      if (status) return this.json(response, status, { error: message(error) });
      return this.json(response, 500, { error: message(error).slice(0, 300) });
    }
  }
}

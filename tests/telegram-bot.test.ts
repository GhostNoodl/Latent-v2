import { afterEach, expect, it } from 'vitest';
import { TelegramBotService, telegramDraft, type TelegramBotPorts } from '../src/main/telegram-bot';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import type { GenerationDraft, GenerationJob, GenerationRecord, StudioJob } from '../src/shared/types';

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ';
const OWNER = 1111;
const STRANGER = 2222;
type Call = { method: string; body: any };

function harness() {
  const state = new Map<string, unknown>();
  const records: GenerationRecord[] = [];
  const jobs: StudioJob[] = [];
  const queued: GenerationDraft[] = [];
  const calls: Call[] = [];
  const updates: unknown[][] = [];
  let changes = 0;
  let updateId = 1;
  let release: (() => void) | undefined;
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    const method = url.split('/').pop()!;
    const body =
      init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body));
    calls.push({ method, body });
    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (method === 'getMe') return reply({ username: 'latent_test_bot' });
    if (method === 'getUpdates') {
      const batch = updates.shift();
      if (batch) return reply(batch);
      // Like a real long poll: hold until the bot stops or the test adds messages.
      await new Promise<void>(resolve => {
        release = resolve;
        init?.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      init?.signal?.throwIfAborted();
      return reply(updates.shift() ?? []);
    }
    return reply(true);
  }) as typeof fetch;
  const ports: TelegramBotPorts = {
    store: {
      getState: <T>(key: string, fallback: T) => (state.has(key) ? structuredClone(state.get(key) as T) : fallback),
      setState: (key: string, value: unknown) => void state.set(key, structuredClone(value)),
      records: () => records,
    },
    crypto: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(`sealed:${value}`),
      decryptString: value => value.toString().replace(/^sealed:/, ''),
    },
    fetch: fakeFetch,
    draft: () => ({ ...structuredClone(DEFAULT_DRAFT), checkpointId: 'model-a' }) as GenerationDraft,
    queue: async draft => {
      queued.push(draft);
      const job = {
        id: `job${queued.length}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        actualSeed: '42',
        status: 'queued',
        progress: 0,
        progressMax: 20,
        outputIds: [],
        draft,
      } as GenerationJob;
      jobs.push(job);
      return job;
    },
    jobs: () => jobs,
    cancel: async id => {
      const job = jobs.find(item => item.id === id)!;
      job.status = 'cancelled';
    },
    backend: () => ({ state: 'ready', message: 'Ready', logTail: [] }),
    blockedReason: () => undefined,
    readOutput: async () => Buffer.from('png-bytes'),
    changed: () => void changes++,
    log: () => undefined,
    wait: async () => undefined,
  };
  const message = (from: number, text: string) => ({
    update_id: updateId++,
    message: { message_id: updateId, from: { id: from }, chat: { id: from, type: 'private' }, text },
  });
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(check()).toBe(true);
  };
  const push = (...batch: unknown[]) => {
    updates.push(batch);
    release?.();
  };
  return { state, records, jobs, queued, calls, ports, message, until, push, changes: () => changes };
}

let bot: TelegramBotService | undefined;
afterEach(async () => {
  await bot?.dispose();
  bot = undefined;
});

it('stays off until it is turned on with a token and allowed users', async () => {
  const h = harness();
  bot = new TelegramBotService(h.ports);
  bot.start();
  await h.until(() => bot!.status().state === 'off');
  await bot.setToken(TOKEN);
  expect(bot.status()).toMatchObject({ hasToken: true, state: 'off', enabled: false });
  expect(JSON.stringify([...h.state.values()])).not.toContain('AAbbCCdd');
  await bot.saveSettings({ enabled: true });
  expect(bot.status().state).toBe('error');
  expect(bot.status().message).toMatch(/user ID/);
  expect(h.calls).toEqual([]);
  await expect(bot.setToken('not a token')).rejects.toThrow(/bot token/);
});

it('queues prompts from allowed users, ignores strangers and sends finished images back', async () => {
  const h = harness();
  bot = new TelegramBotService(h.ports);
  await bot.setToken(TOKEN);
  await bot.saveSettings({ enabled: true, allowedUserIds: [String(OWNER)] });
  await h.until(() => bot!.status().state === 'online');
  expect(bot.status().botUsername).toBe('latent_test_bot');

  h.push(
    h.message(STRANGER, '/start'),
    h.message(STRANGER, 'a castle on a hill'),
    h.message(OWNER, 'a cozy cabin in the snow'),
    h.message(OWNER, '/gen  a red fox'),
  );
  await h.until(() => h.queued.length === 2);
  const sent = () => h.calls.filter(call => call.method === 'sendMessage');
  await h.until(() => sent().length === 3);
  expect(sent()[0].body).toMatchObject({ chat_id: STRANGER });
  expect(sent()[0].body.text).toContain(`Your Telegram user ID is ${STRANGER}`);
  expect(sent()[1].body.text).toMatch(/^Queued!/);
  expect(h.queued.map(draft => draft.prompt)).toEqual(['a cozy cabin in the snow', 'a red fox']);
  expect(h.queued[0]).toMatchObject({ checkpointId: 'model-a', seed: 'random' });

  const job = h.jobs[0];
  h.records.push(
    { id: 'base1', jobId: job.id, outputRole: 'base', actualSeed: '42', width: 512, height: 512 } as GenerationRecord,
    {
      id: 'final1',
      jobId: job.id,
      outputRole: 'final',
      actualSeed: '42',
      width: 1024,
      height: 1024,
    } as GenerationRecord,
  );
  job.status = 'completed';
  bot.jobFinished(job);
  await h.until(() => h.calls.some(call => call.method === 'sendPhoto'));
  const photos = h.calls.filter(call => call.method === 'sendPhoto');
  expect(photos).toHaveLength(1);
  expect(photos[0].body.chat_id).toBe(String(OWNER));
  expect(photos[0].body.caption).toContain('a cozy cabin in the snow');
  expect(photos[0].body.caption).toContain('1024×1024');
  // Delivered once, even if the queue reports the same finish again.
  bot.jobFinished(job);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(h.calls.filter(call => call.method === 'sendPhoto')).toHaveLength(1);

  h.push(h.message(OWNER, '/cancel'));
  await h.until(() => h.jobs[1].status === 'cancelled');
});

it('reports a rejected token instead of retrying forever', async () => {
  const h = harness();
  h.ports.fetch = (async () =>
    new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), {
      status: 401,
    })) as typeof fetch;
  bot = new TelegramBotService(h.ports);
  await bot.setToken(TOKEN);
  await bot.saveSettings({ enabled: true, allowedUserIds: [String(OWNER)] });
  await h.until(() => bot!.status().state === 'error');
  expect(bot.status().message).toMatch(/rejected the bot token/);
});

it('turns the studio draft into a plain text-to-image job', () => {
  const base = {
    ...structuredClone(DEFAULT_DRAFT),
    prompt: 'old',
    seed: '7',
    imageInput: { mode: 'img2img', sourceId: 'a', sourceSha256: 'b', denoise: 0.5, resize: 'stretch' },
    autoFace: { profile: 'anime', strength: 0.4 },
    triggerResolutionVersion: 'visible@3',
  } as GenerationDraft;
  const draft = telegramDraft(base, 'new prompt');
  expect(draft).toMatchObject({ prompt: 'new prompt', seed: 'random', triggerResolutionVersion: 'punctuation@2' });
  expect(draft.imageInput).toBeUndefined();
  expect(draft.autoFace).toBeUndefined();
  expect(base.prompt).toBe('old');
});

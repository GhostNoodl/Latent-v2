import { afterEach, expect, it } from 'vitest';
import { TelegramBotService, type TelegramBotPorts } from '../src/main/telegram-bot';
import { DEFAULT_DRAFT, SIZE_PRESETS } from '../src/shared/defaults';
import type { GenerationDraft, GenerationJob, GenerationRecord, ModelAsset, StudioJob } from '../src/shared/types';

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQ';
const OWNER = 1111;
const STRANGER = 2222;
type Call = { method: string; body: any };
const asset = (id: string, name: string, kind: 'checkpoint' | 'lora') =>
  ({
    id,
    name,
    filename: `${id}.safetensors`,
    kind,
    family: 'illustrious',
    bytes: 1,
    triggers: [],
    status: 'ready',
  }) as ModelAsset;
const MODELS = [
  asset('model-a', 'Alpha XL', 'checkpoint'),
  asset('model-b', 'Beta Pony', 'checkpoint'),
  asset('lora-1', 'Detail Tweaker', 'lora'),
];

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
      recordsForJob: (jobId: string) => records.filter(record => record.jobId === jobId),
    },
    crypto: {
      isEncryptionAvailable: () => true,
      encryptString: value => Buffer.from(`sealed:${value}`),
      decryptString: value => value.toString().replace(/^sealed:/, ''),
    },
    fetch: fakeFetch,
    draft: () => ({ ...structuredClone(DEFAULT_DRAFT), checkpointId: 'model-a' }) as GenerationDraft,
    models: () => MODELS,
    presets: () => [],
    sizes: () => SIZE_PRESETS,
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

it('changes settings per chat with commands, buttons and one-off prompt flags', async () => {
  const h = harness();
  bot = new TelegramBotService(h.ports);
  await bot.setToken(TOKEN);
  await bot.saveSettings({ enabled: true, allowedUserIds: [String(OWNER)] });
  await h.until(() => bot!.status().state === 'online');
  const sent = () => h.calls.filter(call => call.method === 'sendMessage').map(call => call.body);

  h.push(h.message(OWNER, '/model'));
  await h.until(() => sent().length === 1);
  expect(sent()[0].text).toContain('2. Beta Pony');
  expect(sent()[0].reply_markup.inline_keyboard[1][0]).toEqual({ text: 'Beta Pony', callback_data: 'set:model:2' });

  // A tap on the second model, then typed changes.
  h.push(
    {
      update_id: 900,
      callback_query: {
        id: 'q1',
        from: { id: OWNER },
        message: { chat: { id: OWNER, type: 'private' } },
        data: 'set:model:2',
      },
    },
    h.message(OWNER, '/lora detail 0.7'),
    h.message(OWNER, '/size portrait'),
    h.message(OWNER, '/steps 500'),
    h.message(OWNER, 'a lighthouse --steps 12 --seed 99 --neg blurry, lowres'),
  );
  await h.until(() => h.queued.length === 1);
  expect(h.calls.find(call => call.method === 'answerCallbackQuery')?.body.text).toBe('Model set to Beta Pony.');
  expect(sent().map(body => body.text)).toContain('Steps needs a whole number from 1 to 100.');
  expect(h.queued[0]).toMatchObject({
    prompt: 'a lighthouse',
    checkpointId: 'model-b',
    loras: [{ modelId: 'lora-1', weight: 0.7, clipWeight: 0.7 }],
    width: 832,
    height: 1216,
    steps: 12,
    seed: '99',
    negativePrompt: 'blurry, lowres',
  });

  // Flags were one-off; the chat's own settings stay, and /again repeats the whole line.
  h.push(h.message(OWNER, '/settings'), h.message(OWNER, '/reset'), h.message(OWNER, 'a plain prompt'));
  await h.until(() => h.queued.length === 2);
  expect(sent().find(body => body.text.startsWith('Model: Beta Pony'))?.text).toContain('Steps 28');
  expect(h.queued[1]).toMatchObject({ checkpointId: 'model-a', loras: [], width: 1024, seed: 'random' });
  h.push(h.message(OWNER, '/again'));
  await h.until(() => h.queued.length === 3);
  expect(h.queued[2].prompt).toBe('a plain prompt');
});

it('waits for face fixes and sends the fixed picture instead of the original', async () => {
  const h = harness();
  bot = new TelegramBotService(h.ports);
  await bot.setToken(TOKEN);
  await bot.saveSettings({ enabled: true, allowedUserIds: [String(OWNER)] });
  await h.until(() => bot!.status().state === 'online');
  h.push(h.message(OWNER, 'a portrait --faces on anime'));
  await h.until(() => h.queued.length === 1);
  expect(h.queued[0].autoFace).toMatchObject({ profile: 'anime' });

  const parent = h.jobs[0] as GenerationJob;
  h.records.push({ id: 'orig', jobId: parent.id, actualSeed: '1', width: 1024, height: 1024 } as GenerationRecord);
  parent.status = 'completed';
  bot.jobFinished(parent);
  await bot.sweep();
  expect(h.calls.some(call => call.method === 'sendPhoto')).toBe(false);

  const child = {
    ...structuredClone(parent),
    id: 'child',
    status: 'running',
    draft: { ...parent.draft, autoFace: undefined },
  } as GenerationJob;
  h.jobs.push(child);
  parent.autoFaceFinished = true;
  parent.autoFaceResults = { orig: { state: 'queued', jobId: 'child' } };
  await bot.sweep();
  expect(h.calls.some(call => call.method === 'sendPhoto')).toBe(false);

  child.status = 'completed';
  h.records.push({
    id: 'fixed',
    jobId: 'child',
    outputRole: 'final',
    actualSeed: '1',
    width: 1024,
    height: 1024,
  } as GenerationRecord);
  bot.jobFinished(child);
  await bot.sweep();
  await h.until(() => h.calls.some(call => call.method === 'sendPhoto'));
  const photos = h.calls.filter(call => call.method === 'sendPhoto');
  expect(photos).toHaveLength(1);
  expect((photos[0].body.photo as File).name).toBe('latent-fixed.png');
});

it('keeps a picture whose send failed and tries again later instead of dropping it', async () => {
  const h = harness();
  const base = h.ports.fetch;
  let failures = 1;
  h.ports.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/sendPhoto') && failures > 0) {
      failures--;
      throw new TypeError('fetch failed');
    }
    return base(input, init);
  }) as typeof fetch;
  bot = new TelegramBotService(h.ports);
  await bot.setToken(TOKEN);
  await bot.saveSettings({ enabled: true, allowedUserIds: [String(OWNER)] });
  await h.until(() => bot!.status().state === 'online');
  h.push(h.message(OWNER, 'a stormy harbor'));
  await h.until(() => h.queued.length === 1);
  const job = h.jobs[0];
  h.records.push({ id: 'pic', jobId: job.id, actualSeed: '7', width: 512, height: 512 } as GenerationRecord);
  job.status = 'completed';
  bot.jobFinished(job);
  await h.until(() => {
    const saved = h.state.get('telegram.jobs.v1') as Record<string, { retry?: unknown }> | undefined;
    return Boolean(saved?.[job.id]?.retry);
  });
  // Not due yet: nothing goes out early, and a repeated finish doesn't jump the queue.
  bot.jobFinished(job);
  await bot.sweep();
  expect(h.calls.filter(call => call.method === 'sendPhoto')).toHaveLength(0);

  const now = Date.now;
  Date.now = () => now() + 60_000;
  try {
    await bot.sweep();
  } finally {
    Date.now = now;
  }
  expect(h.calls.filter(call => call.method === 'sendPhoto')).toHaveLength(1);
  expect((h.state.get('telegram.jobs.v1') as Record<string, unknown>)[job.id]).toBeUndefined();
});

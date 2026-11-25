import { afterEach, expect, it } from 'vitest';
import { TelegramBotService, type TelegramBotPorts } from '../src/main/telegram-bot';
import { DEFAULT_DRAFT, SIZE_PRESETS } from '../src/shared/defaults';
import type {
  GenerationDraft,
  GenerationJob,
  GenerationRecord,
  ModelAsset,
  StudioJob,
  VideoJob,
} from '../src/shared/types';
import type { VideoDraft } from '../src/shared/video-types';
import type { VideoAssetsStatus } from '../src/shared/video-assets';
import type { SourceImageAsset } from '../src/shared/source-types';
import type { QwenEditJobRequest } from '../src/shared/qwen-edit-types';
import { DEFAULT_VIDEO_DRAFT } from '../src/shared/video-plan';

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
    if (url.startsWith(`https://api.telegram.org/file/bot${TOKEN}/`)) {
      calls.push({ method: 'download', body: url });
      return new Response(new Uint8Array([1, 2, 3]));
    }
    expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    const method = url.split('/').pop()!;
    const body =
      init?.body instanceof FormData ? Object.fromEntries(init.body.entries()) : JSON.parse(String(init?.body));
    calls.push({ method, body });
    const reply = (result: unknown) => new Response(JSON.stringify({ ok: true, result }));
    if (method === 'getMe') return reply({ username: 'latent_test_bot' });
    if (method === 'sendPhoto') return reply({ message_id: 500 + calls.length });
    if (method === 'getFile') return reply({ file_path: 'photos/file_1.jpg', file_size: 3 });
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

it('makes saved prompts and lists newer models next to the checkpoints', async () => {
  const h = harness();
  h.ports.savedPrompts = () => [
    { id: 's1', text: 'a lighthouse at dusk' },
    { id: 's2', text: 'a tiny robot gardener' },
  ];
  h.ports.imageModels = () => ['krea2-turbo'];
  bot = new TelegramBotService(h.ports);
  await bot.setToken(TOKEN);
  await bot.saveSettings({ enabled: true, allowedUserIds: [String(OWNER)] });
  await h.until(() => bot!.status().state === 'online');
  const sent = () => h.calls.filter(call => call.method === 'sendMessage');

  h.push(h.message(OWNER, '/prompts'));
  await h.until(() => sent().length === 1);
  expect(sent()[0].body.text).toContain('2. a tiny robot gardener');
  expect(sent()[0].body.reply_markup.inline_keyboard[1][0].callback_data).toBe('prompt:2');
  h.push({
    update_id: 900,
    callback_query: {
      id: 'cb',
      from: { id: OWNER },
      message: { chat: { id: OWNER, type: 'private' } },
      data: 'prompt:2',
    },
  });
  await h.until(() => h.queued.length === 1);
  expect(h.queued[0].prompt).toBe('a tiny robot gardener');

  h.push(h.message(OWNER, '/model'));
  await h.until(() => sent().some(call => call.body.text.includes('Newer models')));
  const list = sent().find(call => call.body.text.includes('Newer models'))!.body.text;
  expect(list).toContain('3. Krea 2 Turbo');
  h.push(h.message(OWNER, '/model 3'), h.message(OWNER, 'a neon street --steps 6'));
  await h.until(() => h.queued.length === 2);
  expect(h.queued[1]).toMatchObject({ imageModel: 'krea2-turbo', checkpointId: '', steps: 6, loras: [] });
  await h.until(() => sent().some(call => call.body.text.includes('Krea 2 Turbo ·')));
});

const SHA = 'a'.repeat(64);
const sourceAsset = (id: string, width = 1024, height = 768, originGenerationId?: string) =>
  ({
    id,
    normalized: { sha256: SHA, bytes: 3, width, height, mimeType: 'image/png' },
    ...(originGenerationId ? { originGenerationId } : {}),
  }) as unknown as SourceImageAsset;

it('makes clips with /video and sends them back', async () => {
  const h = harness();
  const videos: VideoDraft[] = [];
  h.ports.videoStatus = () => ({
    canGenerate: true,
    message: 'Ready.',
    assets: { fusedPresent: true, turboPresent: true, basePresent: true } as VideoAssetsStatus,
  });
  h.ports.videoDraft = () => ({ ...DEFAULT_VIDEO_DRAFT, prompt: 'studio prompt', requestedDurationSeconds: 6 });
  h.ports.queueVideo = async draft => {
    videos.push(draft);
    const job = {
      kind: 'video',
      id: `vid${videos.length}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      actualSeed: '9',
      status: 'queued',
      progress: 0,
      progressMax: 4,
      outputIds: [],
      video: draft,
      frames: 141,
      durationSeconds: 141 / 24,
    } as VideoJob;
    h.jobs.push(job);
    return job;
  };
  h.ports.readVideo = async () => Buffer.from('mp4-bytes');
  bot = new TelegramBotService(h.ports);
  await bot.setToken(TOKEN);
  await bot.saveSettings({ enabled: true, allowedUserIds: [String(OWNER)] });
  await h.until(() => bot!.status().state === 'online');
  const sent = () => h.calls.filter(call => call.method === 'sendMessage');

  h.push(h.message(OWNER, '/video'));
  await h.until(() => sent().length === 1);
  expect(sent()[0].body.text).toContain('Length: 6 seconds');
  h.push({
    update_id: 901,
    callback_query: {
      id: 'cb',
      from: { id: OWNER },
      message: { chat: { id: OWNER, type: 'private' } },
      data: 'vid:quality:turbo8',
    },
  });
  await h.until(() => sent().length === 2);
  expect(sent()[1].body.text).toContain('Better');

  h.push(h.message(OWNER, '/video a wave rolling in --length 8 --size tall'));
  await h.until(() => videos.length === 1);
  expect(videos[0]).toMatchObject({
    prompt: 'a wave rolling in',
    mode: 'txt2vid',
    profile: 'turbo8',
    requestedDurationSeconds: 8,
    width: 480,
    height: 832,
    seed: 'random',
  });
  await h.until(() => sent().some(call => call.body.text.startsWith('Queued a clip!')));

  const job = h.jobs[0] as VideoJob;
  job.status = 'completed';
  job.outputIds = ['b'.repeat(32)];
  bot.jobFinished(job);
  await h.until(() => h.calls.some(call => call.method === 'sendVideo'));
  const clip = h.calls.find(call => call.method === 'sendVideo')!;
  expect(clip.body.caption).toContain('a wave rolling in');
  expect(clip.body.chat_id).toBe(String(OWNER));
});

it('edits pictures sent with a caption and enhances results from the button', async () => {
  const h = harness();
  const edits: QwenEditJobRequest[] = [];
  const imported: string[] = [];
  const recordId = 'c'.repeat(32);
  const record = {
    id: recordId,
    jobId: 'job0',
    actualSeed: '42',
    width: 1024,
    height: 1024,
    resolvedPrompt: 'a red fox',
    draft: { ...structuredClone(DEFAULT_DRAFT), checkpointId: 'model-a', prompt: 'a red fox' },
    checkpoint: MODELS[0],
    loras: [],
  } as unknown as GenerationRecord;
  h.ports.record = id => (id === recordId ? record : undefined);
  h.ports.importImage = async (_bytes, name) => {
    imported.push(name);
    return sourceAsset('src_11111111-1111-1111-1111-111111111111', 1200, 800);
  };
  h.ports.useOutputAsSource = async id => sourceAsset('src_22222222-2222-2222-2222-222222222222', 1024, 1024, id);
  h.ports.editProfile = () => 'lightning8';
  h.ports.queueEdit = async request => {
    edits.push(request);
    const job = {
      id: `edit${edits.length}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      actualSeed: '1',
      status: 'queued',
      progress: 0,
      progressMax: 8,
      outputIds: [],
      draft: structuredClone(DEFAULT_DRAFT),
    } as GenerationJob;
    h.jobs.push(job);
    return job;
  };
  bot = new TelegramBotService(h.ports);
  await bot.setToken(TOKEN);
  await bot.saveSettings({ enabled: true, allowedUserIds: [String(OWNER)] });
  await h.until(() => bot!.status().state === 'online');

  h.push({
    update_id: 950,
    message: {
      message_id: 3,
      from: { id: OWNER },
      chat: { id: OWNER, type: 'private' },
      caption: 'make it night time',
      photo: [
        { file_id: 'small', width: 90, height: 60 },
        { file_id: 'big', width: 1200, height: 800 },
      ],
    },
  });
  await h.until(() => edits.length === 1);
  expect(h.calls.find(call => call.method === 'getFile')!.body).toEqual({ file_id: 'big' });
  expect(imported).toHaveLength(1);
  expect(edits[0]).toMatchObject({
    mode: 'qwen-edit',
    operation: 'edit',
    instruction: 'make it night time',
    sourceId: 'src_11111111-1111-1111-1111-111111111111',
    settings: { profile: 'lightning8', seed: 'random', resize: 'stretch' },
    output: { width: 1200, height: 800 },
  });

  h.push({
    update_id: 951,
    callback_query: {
      id: 'cb2',
      from: { id: OWNER },
      message: { chat: { id: OWNER, type: 'private' } },
      data: `enh:${recordId}`,
    },
  });
  await h.until(() => h.queued.length === 1);
  expect(h.queued[0]).toMatchObject({
    enhance: { parentRecordId: recordId },
    width: 2048,
    height: 2048,
    imageInput: { mode: 'img2img', sourceId: 'src_22222222-2222-2222-2222-222222222222' },
  });
});

it('copies the settings from the last image made on the PC, skipping its own', async () => {
  const h = harness();
  const pcRecord = {
    id: 'd'.repeat(32),
    jobId: 'pc-job',
    draft: { ...structuredClone(DEFAULT_DRAFT), checkpointId: 'model-b', prompt: 'a misty forest', steps: 33 },
    loras: [],
  } as unknown as GenerationRecord;
  h.ports.records = () => [
    ...h.jobs.map(
      job =>
        ({
          id: 'e'.repeat(32),
          jobId: job.id,
          draft: { ...(job as GenerationJob).draft },
          loras: [],
        }) as unknown as GenerationRecord,
    ),
    pcRecord,
  ];
  bot = new TelegramBotService(h.ports);
  await bot.setToken(TOKEN);
  await bot.saveSettings({ enabled: true, allowedUserIds: [String(OWNER)] });
  await h.until(() => bot!.status().state === 'online');
  const sent = () => h.calls.filter(call => call.method === 'sendMessage');

  h.push(h.message(OWNER, 'from telegram --steps 12'));
  await h.until(() => h.queued.length === 1);
  h.push(h.message(OWNER, '/last'));
  await h.until(() => sent().some(call => call.body.text.includes('last image on the PC')));
  const answer = sent().find(call => call.body.text.includes('last image on the PC'))!.body;
  expect(answer.text).toContain('Beta Pony');
  expect(answer.text).toContain('a misty forest');
  h.push({
    update_id: 990,
    callback_query: {
      id: 'cb',
      from: { id: OWNER },
      message: { chat: { id: OWNER, type: 'private' } },
      data: answer.reply_markup.inline_keyboard[0][0].callback_data,
    },
  });
  await h.until(() => h.queued.length === 2);
  expect(h.queued[1]).toMatchObject({ prompt: 'a misty forest', checkpointId: 'model-b', steps: 33, seed: 'random' });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import type { AssistantRequest } from '../src/shared/assistant-types';
import {
  buildConversation,
  missingProtectedParts,
  parseReply,
  partialReply,
  protectedParts,
  systemPrompt,
  userTurn,
} from '../src/main/assistant/prompts';
import { AssistantKeys } from '../src/main/assistant/keys';
import { localServerArguments, resolveDevice } from '../src/main/assistant/local';
import { streamOpenAIStyle } from '../src/main/assistant/providers';
import {
  LOCAL_ASSISTANT_MODELS,
  fitsBesideRender,
  pickDefaultModel,
  recommendedLocalModel,
} from '../src/shared/assistant-catalog';
import { wordDiff } from '../src/renderer/assistant/word-diff';

const GiB = 1024 ** 3;
const request = (patch: Partial<AssistantRequest> = {}): AssistantRequest => ({
  target: 'image',
  action: 'improve',
  draft: {
    ...structuredClone(DEFAULT_DRAFT),
    prompt: 'a cat, {red|blue} hat, __pose__, mytrigger',
    negativePrompt: 'blurry',
  },
  ...patch,
});

describe('assistant prompts', () => {
  it('keeps wildcards, choice groups and trigger words safe', () => {
    const base = request();
    base.draft.loras = [{ modelId: 'lora-1', strength: 1 } as never];
    base.draft.triggerWords = { 'lora-1': ['mytrigger'] };
    expect(protectedParts(base)).toEqual(expect.arrayContaining(['mytrigger', '{red|blue}', '__pose__']));
    expect(missingProtectedParts(base, 'a cat, __pose__')).toEqual(expect.arrayContaining(['mytrigger', '{red|blue}']));
  });

  it('writes tag advice for Illustrious and sentence advice for video', () => {
    const anime = request();
    anime.draft.family = 'illustrious';
    expect(systemPrompt(anime)).toContain('Danbooru');
    expect(systemPrompt(request({ target: 'video' }))).toContain('MiniMax H3');
  });

  it('uses the newer model guide and says when the negative is ignored', () => {
    const flux = request();
    flux.draft.imageModel = 'flux3-klein';
    flux.draft.cfg = 1;
    expect(systemPrompt(flux)).toContain('ignores the negative prompt');
  });

  it('puts the quick action and the typed words in the turn', () => {
    const turn = userTurn(request({ action: 'variations', instruction: 'more moody' }));
    expect(turn).toContain('exactly 3 options');
    expect(turn).toContain('more moody');
    expect(turn).toContain('"currentPrompt"');
  });

  it('drops old turns to fit and never starts with the assistant', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: (index % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: 'x'.repeat(2000),
    }));
    const messages = buildConversation(request({ history }), 12_000);
    expect(messages.length).toBeLessThan(13);
    expect(messages[0].role).toBe('user');
    expect(messages.at(-1)!.text).toContain('Current state');
  });

  it('reads replies wrapped in chatter, fences or thinking', () => {
    const raw =
      '<think>hmm</think>Sure! ```json\n{"message":"Done.","prompts":[{"prompt":"a cat","negativePrompt":""}]}\n```';
    expect(parseReply(raw)).toEqual({ message: 'Done.', prompts: [{ prompt: 'a cat', negativePrompt: '' }] });
    expect(() => parseReply('no json here')).toThrow(/could not read/);
  });

  it('shows the message and first prompt while streaming', () => {
    expect(partialReply('{"message":"Adding rain\\nand')).toEqual({ message: 'Adding rain\nand' });
    expect(partialReply('{"message":"Ok","prompts":[{"prompt":"a ca')).toEqual({ message: 'Ok', prompt: 'a ca' });
  });
});

describe('assistant keys', () => {
  const crypto = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`locked:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^locked:/, ''),
  };
  const memory = () => {
    const state = new Map<string, unknown>();
    return {
      state,
      getState: <T>(key: string, fallback: T) => (state.has(key) ? (state.get(key) as T) : fallback),
      setState: (key: string, value: unknown) => void state.set(key, structuredClone(value)),
    };
  };

  it('stores keys locked and only shows the last 4 characters', () => {
    const store = memory();
    const keys = new AssistantKeys(store, crypto);
    keys.set('anthropic', 'sk-ant-secret-1234');
    expect(JSON.stringify(store.state.get('assistant.keys'))).not.toContain('sk-ant-secret');
    expect(keys.summary()).toEqual({ anthropic: { last4: '1234' } });
    expect(keys.get('anthropic')).toBe('sk-ant-secret-1234');
    keys.set('anthropic', null);
    expect(keys.summary()).toEqual({});
  });

  it('refuses to save when Windows cannot protect the key', () => {
    const keys = new AssistantKeys(memory(), { ...crypto, isEncryptionAvailable: () => false });
    expect(() => keys.set('openai', 'sk-test-abcd')).toThrow(/protect/);
  });

  it('rejects keys with spaces', () => {
    const keys = new AssistantKeys(memory(), crypto);
    expect(() => keys.set('openai', 'two words')).toThrow(/looks wrong/);
  });
});

describe('local assistant', () => {
  it('suggests a model that fits the PC', () => {
    expect(recommendedLocalModel({ vramMiB: 24576, ramBytes: 64 * GiB })).toBe('qwen38-27b');
    expect(recommendedLocalModel({ vramMiB: 16384, ramBytes: 32 * GiB })).toBe('qwen35-9b');
    expect(recommendedLocalModel({ vramMiB: 24576, ramBytes: 32 * GiB })).toBe('qwen38-27b');
    expect(recommendedLocalModel({ vramMiB: 24576, ramBytes: 16 * GiB })).toBe('qwen35-9b');
    expect(recommendedLocalModel({ ramBytes: 16 * GiB })).toBe('qwen35-4b');
  });

  it('steps off the graphics card when a render needs it', () => {
    expect(fitsBesideRender('qwen36-35b', 'image', 24576)).toBe(true);
    expect(fitsBesideRender('qwen38-27b', 'image', 24576)).toBe(false);
    expect(fitsBesideRender('qwen35-9b', 'image', 16384)).toBe(false);
    expect(fitsBesideRender('qwen35-4b', 'video', 24576)).toBe(false);
  });

  it('runs on the processor without an NVIDIA card', () => {
    expect(resolveDevice('qwen35-9b', 'auto', {})).toBe('cpu');
    expect(resolveDevice('qwen35-9b', 'auto', { vramMiB: 16384 })).toBe('gpu');
    expect(resolveDevice('qwen35-9b', 'auto', { vramMiB: 8192 })).toBe('cpu');
    expect(resolveDevice('qwen35-9b', 'cpu', { vramMiB: 24576 })).toBe('cpu');
  });

  it('keeps the big model experts in system memory and turns thinking off', () => {
    const big = localServerArguments('qwen36-35b', { model: 'm.gguf', vision: 'v.gguf' }, 40000, 'gpu');
    expect(big).toEqual(expect.arrayContaining(['--cpu-moe', '--mmproj', 'v.gguf', '--reasoning', 'off']));
    const cpu = localServerArguments('qwen35-4b', { model: 'm.gguf', vision: 'v.gguf' }, 40000, 'cpu');
    expect(cpu).toEqual(expect.arrayContaining(['--device', 'none', '--no-mmproj-offload']));
    expect(() => localServerArguments('qwen35-4b', { model: 'm', vision: 'v' }, 80, 'cpu')).toThrow();
  });

  it('pins every local file by size and hash', () => {
    for (const model of Object.values(LOCAL_ASSISTANT_MODELS))
      for (const file of [model.model, model.vision]) {
        expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(file.url).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[a-f0-9]{40}\//);
        expect(file.bytes).toBeGreaterThan(100_000_000);
      }
  });
});

describe('cloud providers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('picks a sensible default model from a list', () => {
    expect(pickDefaultModel('anthropic', [])).toBe('claude-opus-5-5');
    expect(
      pickDefaultModel('openai', [
        { id: 'gpt-4o', name: '' },
        { id: 'gpt-5.1', name: '' },
        { id: 'gpt-5', name: '' },
      ]),
    ).toBe('gpt-5.1');
    expect(pickDefaultModel('openrouter', [{ id: 'x/y', name: '' }])).toBeUndefined();
  });

  it('streams a reply and steps down when the server cannot do JSON schemas', async () => {
    const bodies: any[] = [];
    const stream = (text: string) =>
      new Response(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(0, 10) } }] })}`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(10) }, finish_reason: 'stop' }] })}`,
          'data: [DONE]',
          '',
        ].join('\n'),
      );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.response_format?.type === 'json_schema')
          return new Response('{"error":{"message":"nope"}}', { status: 400 });
        return stream('{"message":"Hi","prompts":[]}');
      }),
    );
    const seen: string[] = [];
    const text = await streamOpenAIStyle(
      { name: 'Test', baseUrl: 'http://localhost:1/v1/', model: 'm', key: 'k' },
      {
        system: 's',
        messages: [{ role: 'user', text: 'hi' }],
        signal: new AbortController().signal,
        onText: t => seen.push(t),
      },
    );
    expect(text).toBe('{"message":"Hi","prompts":[]}');
    expect(bodies.map(body => body.response_format?.type)).toEqual(['json_schema', 'json_object']);
    expect(seen.at(-1)).toBe(text);
  });

  it('explains a rejected key without echoing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 401 })),
    );
    await expect(
      streamOpenAIStyle(
        { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', key: 'sk-very-secret' },
        {
          system: 's',
          messages: [{ role: 'user', text: 'hi' }],
          signal: new AbortController().signal,
          onText: () => {},
        },
      ),
    ).rejects.toThrow(/didn't accept the key/);
  });
});

describe('word diff', () => {
  it('marks only the new words', () => {
    const pieces = wordDiff('a cat, hat', 'a black cat, red hat');
    expect(pieces.filter(piece => piece.added).map(piece => piece.text.trim())).toEqual(['black', 'red']);
    expect(pieces.map(piece => piece.text).join('')).toBe('a black cat, red hat');
  });
});

describe('word diff joins neighbours', () => {
  it('highlights a new phrase as one piece', () => {
    expect(
      wordDiff('a cat', 'a cat, wet hair')
        .filter(piece => piece.added)
        .map(piece => piece.text),
    ).toEqual(['wet hair']);
  });
});

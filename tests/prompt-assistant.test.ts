import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assistantMessages,
  assistantRequestSchema,
  missingProtectedParts,
  partialAssistantFields,
  protectedParts,
} from '../src/main/assistant-config';
import { PromptAssistant } from '../src/main/prompt-assistant';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import type { AssistantSuggestionRequest } from '../src/shared/assistant-types';
import type { AppPaths, GenerationDraft } from '../src/shared/types';

const request = (draft: Partial<GenerationDraft>, extra: Partial<AssistantSuggestionRequest> = {}) => ({
  instruction: 'make it rain',
  draft: { ...DEFAULT_DRAFT, ...draft },
  ...extra,
});

describe('partialAssistantFields', () => {
  it('reads fields from JSON that is still being written', () => {
    expect(partialAssistantFields('{"explanation": "Added \\"rain\\"\\nok", "prompt": "1girl, ra')).toEqual({
      explanation: 'Added "rain"\nok',
      prompt: '1girl, ra',
    });
    expect(partialAssistantFields('{"expl')).toEqual({});
    expect(partialAssistantFields('{"prompt": "caf\\u00e9 \\u00')).toEqual({ prompt: 'café ' });
  });
});

describe('protected prompt parts', () => {
  it('collects trigger words, wildcards and choice groups', () => {
    const value = request({
      prompt: 'wtrcolor, 1girl, __hair__, {red|blue {dress|coat}} street',
      loras: [{ modelId: 'a', weight: 1, clipWeight: 1 }],
      triggerWords: { a: ['wtrcolor', 'unused'] },
    });
    expect(protectedParts(value)).toEqual(['wtrcolor', '{red|blue {dress|coat}}', '__hair__']);
    expect(missingProtectedParts(value, 'wtrcolor, 1girl, rain, {red|blue {dress|coat}}')).toEqual(['__hair__']);
  });
  it('sends them, the LoRA names and the family style to the model', () => {
    const value = request({ prompt: '__pose__, 1girl', family: 'illustrious' }, { loraNames: ['Watercolor XL'] });
    const [system, user] = assistantMessages(value);
    expect(system.content).toContain('danbooru-style tags');
    expect(JSON.parse(user.content)).toMatchObject({ loras: ['Watercolor XL'], keepExactly: ['__pose__'] });
    expect(assistantMessages(request({ family: 'sdxl' }))[0].content).toContain('short descriptive phrases');
    expect(assistantRequestSchema.safeParse(value).success).toBe(true);
  });
});

describe('streaming replies', () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const step of cleanup.splice(0)) step();
  });

  it('shows the reply while it is written and returns the finished suggestion', async () => {
    const reply = JSON.stringify({
      explanation: 'Added rain.',
      prompt: '1girl, rain, city street',
      negativePrompt: 'blurry',
    });
    const server = http.createServer((incoming, outgoing) => {
      let body = '';
      incoming.on('data', chunk => (body += chunk));
      incoming.on('end', () => {
        if (incoming.url === '/apply-template') return outgoing.end(JSON.stringify({ prompt: 'templated' }));
        if (incoming.url === '/tokenize') return outgoing.end(JSON.stringify({ tokens: [1, 2, 3] }));
        expect(JSON.parse(body)).toMatchObject({ stream: true });
        outgoing.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const pieces = reply.match(/.{1,7}/gs)!;
        for (const piece of pieces)
          outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
        outgoing.write(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 21 } })}\n\n`);
        outgoing.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => server.close());
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'latent-assistant-test-'));
    cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const paths = Object.fromEntries(
      ['runtime', 'backend', 'python', 'models', 'outputs', 'inputs', 'temp', 'user', 'cache', 'logs', 'database'].map(
        key => [key, path.join(root, key)],
      ),
    ) as unknown as AppPaths;
    paths.root = root;
    const seen: Array<{ explanation?: string; prompt?: string }> = [];
    const assistant: PromptAssistant = new PromptAssistant(paths, { setState() {} } as never, () => {
      const live = assistant?.status().reply;
      if (live?.prompt) seen.push(live);
    });
    Object.assign(assistant as unknown as Record<string, unknown>, {
      child: { pid: undefined, exitCode: null },
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: 'test',
      current: { ...assistant.status(), state: 'ready' },
    });
    const suggestion = await assistant.suggest(request({ prompt: '1girl, city street' }));
    expect(suggestion.proposedDraft.prompt).toBe('1girl, rain, city street');
    expect(suggestion.completionTokens).toBe(21);
    expect(suggestion.dropped).toBeUndefined();
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)?.prompt).toBe('1girl, rain, city street');
    expect(assistant.status()).toMatchObject({ state: 'ready', reply: undefined });
    clearTimeout((assistant as unknown as { idleTimer?: NodeJS.Timeout }).idleTimer);
  });
});

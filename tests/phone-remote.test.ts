import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import type { GenerationDraft } from '../src/shared/types';
import { PhoneRemoteService, lanAddresses } from '../src/main/phone-remote';

let server: http.Server;
let base = '';
let service: PhoneRemoteService;
let queued: GenerationDraft[] = [];
const state = new Map<string, unknown>();
const currentCode = () => (service as unknown as { code: string }).code;

beforeEach(async () => {
  queued = [];
  state.clear();
  service = new PhoneRemoteService({
    store: {
      getState: (key: string, fallback: unknown) => (state.has(key) ? state.get(key) : fallback),
      setState: (key: string, value: unknown) => void state.set(key, value),
    } as never,
    draft: () => ({ ...structuredClone(DEFAULT_DRAFT), checkpointId: 'checkpoint:a', family: 'sdxl' }),
    models: () =>
      [
        { id: 'checkpoint:a', name: 'A', kind: 'checkpoint', status: 'ready', family: 'sdxl' },
        { id: 'checkpoint:b', name: 'B', kind: 'checkpoint', status: 'ready', family: 'illustrious' },
      ] as never,
    history: () => [],
    jobs: () => [],
    queue: async draft => {
      queued.push(draft);
      return { id: 'job-1' } as never;
    },
    cancel: async () => {},
    blockedReason: () => undefined,
    readOutput: async () => Buffer.from(''),
    changed: () => {},
    log: () => {},
  });
  service.newCode();
  server = http.createServer(service.handle);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

const post = (path: string, body: unknown, token?: string) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const pair = async () => {
  const response = await post('/api/pair', { code: currentCode() });
  return ((await response.json()) as { token: string }).token;
};

describe('phone remote', () => {
  it('serves the page but nothing else without pairing', async () => {
    const page = await fetch(base + '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await fetch(base + '/api/state')).status).toBe(401);
    expect((await post('/api/generate', { prompt: 'x' })).status).toBe(401);
    expect((await fetch(base + '/api/state', { headers: { Authorization: 'Bearer nope' } })).status).toBe(401);
  });
  it('pairs once per code and then accepts the token', async () => {
    const code = currentCode();
    const first = await post('/api/pair', { code });
    expect(first.status).toBe(200);
    const { token } = (await first.json()) as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await post('/api/pair', { code })).status).toBe(403);
    const response = await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { models: unknown[] }).models).toHaveLength(2);
    service.forgetPhones();
    expect((await fetch(base + '/api/state', { headers: { Authorization: `Bearer ${token}` } })).status).toBe(401);
  });
  it('pauses pairing after five wrong codes', async () => {
    for (let i = 0; i < 5; i++) expect((await post('/api/pair', { code: 'abc' })).status).toBe(403);
    expect((await post('/api/pair', { code: currentCode() })).status).toBe(429);
  });
  it('queues a prompt with the phone’s choices over the studio settings', async () => {
    const token = await pair();
    const response = await post(
      '/api/generate',
      { prompt: 'a fox', width: 1216, height: 832, batchSize: 2, checkpointId: 'checkpoint:b' },
      token,
    );
    expect(response.status).toBe(200);
    expect(queued[0]).toMatchObject({
      prompt: 'a fox',
      width: 1216,
      height: 832,
      batchSize: 2,
      checkpointId: 'checkpoint:b',
      family: 'illustrious',
      seed: 'random',
    });
    expect((await post('/api/generate', { prompt: 'a fox', checkpointId: 'checkpoint:zzz' }, token)).status).toBe(400);
    expect((await post('/api/generate', { prompt: 'x', width: 1000 }, token)).status).toBe(400);
    expect((await post('/api/generate', { prompt: 'x', extra: true }, token)).status).toBe(400);
  });
  it('lists private network addresses only', () => {
    expect(
      lanAddresses({
        eth: [{ family: 'IPv4', internal: false, address: '10.0.0.5' }],
        wifi: [{ family: 'IPv4', internal: false, address: '192.168.1.23' }],
        lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
        pub: [{ family: 'IPv4', internal: false, address: '8.8.8.8' }],
      } as never),
    ).toEqual(['192.168.1.23', '10.0.0.5']);
  });
});

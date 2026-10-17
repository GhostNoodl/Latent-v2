import { describe, expect, it, vi } from 'vitest';
import { JobService } from '../src/main/jobs';

function idleService() {
  const service = Object.create(JobService.prototype) as any;
  Object.assign(service, {
    items: [],
    polling: false,
    tickAgain: false,
    disposed: false,
    maintenance: false,
    drainWaiters: [],
    connect: vi.fn(),
    backend: { status: () => ({ state: 'stopped' }) },
  });
  return service;
}

describe('queue wake-ups', () => {
  it('re-runs a tick straight after the one in flight instead of waiting for the timer', async () => {
    const service = idleService();
    service.polling = true;
    service.kick();
    expect(service.tickAgain).toBe(true);
    service.polling = false;
    await service.tick();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    // The first tick, then exactly one immediate follow-up, then nothing more.
    expect(service.connect).toHaveBeenCalledTimes(2);
    expect(service.tickAgain).toBe(false);
  });

  it('ticks at once when nothing is in flight, and never after disposal', async () => {
    const service = idleService();
    service.kick();
    await new Promise(resolve => setImmediate(resolve));
    expect(service.connect).toHaveBeenCalledTimes(1);
    service.disposed = true;
    service.tickAgain = true;
    service.polling = false;
    await service.tick();
    await new Promise(resolve => setImmediate(resolve));
    expect(service.connect).toHaveBeenCalledTimes(1);
  });
});

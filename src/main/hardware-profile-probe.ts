import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import type { AppPaths } from '../shared/types';
import type { HardwareGpu, HardwareInventory, HardwareTelemetry } from '../shared/hardware-profile-types';
import { canonicalRuntimeJson, runtimeIdentitySchema, type RuntimeIdentitySnapshot } from '../shared/runtime-identity';
const execute = promisify(execFile);
export function parseNvidiaInventory(csv: string): HardwareGpu[] {
  if (csv.length > 32768) throw new Error('GPU inventory response exceeded its bound.'); const gpus: HardwareGpu[] = [];
  for (const line of csv.trim().split(/\r?\n/).filter(Boolean)) {
    const parts = line.split(',').map(value => value.trim()); if (parts.length !== 5) throw new Error('GPU inventory returned an ambiguous row.');
    const [index, uuid, name, memory, driver] = parts; const value = { index: Number(index), uuid, name, vramMiB: Number(memory), driver };
    if (!/^\d+$/.test(index) || !/^GPU-[a-f0-9-]{16,80}$/i.test(uuid) || !name || name.length > 200 || !Number.isFinite(value.vramMiB) || value.vramMiB <= 0 || !/^[\w.-]{1,80}$/.test(driver) || gpus.some(gpu => gpu.index === value.index || gpu.uuid === uuid) || gpus.length >= 32) throw new Error('GPU inventory is unavailable or ambiguous.'); gpus.push(value);
  }
  return gpus.sort((a, b) => a.index - b.index);
}
export async function queryNvidiaInventory(): Promise<HardwareGpu[]> { const result = await execute('nvidia-smi', ['--query-gpu=index,uuid,name,memory.total,driver_version', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 8000, maxBuffer: 32768 }); return parseNvidiaInventory(result.stdout); }
async function boundedStats(url: string) {
  const parsed = new URL(url); if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port || parsed.username || parsed.password) throw new Error('Hardware inspection requires the owned loopback backend.');
  const response = await fetch(new URL('/system_stats', parsed), { signal: AbortSignal.timeout(8000), redirect: 'error' }); if (!response.ok || !response.body) throw new Error('The private backend did not report device information.'); const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  try { while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 512 * 1024) throw new Error('Backend device information exceeded its bound.'); chunks.push(next.value); } } finally { await reader.cancel().catch(() => {}); } return JSON.parse(Buffer.concat(chunks).toString());
}
export function inventoryFingerprint(inventory: Omit<HardwareInventory, 'fingerprint'>): string { const { observedAt: _observed, messages: _messages, ...identity } = inventory; if (identity.runtimeIdentity) identity.runtimeIdentity = { ...identity.runtimeIdentity, observedAt: 'identity-only' }; return createHash('sha256').update(canonicalRuntimeJson(identity)).digest('hex'); }
export function assembleHardwareInventory(system: Pick<HardwareInventory, 'os' | 'arch' | 'ramBytes'>, gpus: HardwareGpu[], stats: any, runtime: RuntimeIdentitySnapshot | undefined, messages: string[] = []): HardwareInventory {
  const value: Omit<HardwareInventory, 'fingerprint'> = { ...system, observedAt: new Date().toISOString(), gpus: structuredClone(gpus), detection: gpus.length ? 'nvidia' : 'unavailable', messages: [...messages], ...(runtime ? { runtimeIdentity: runtimeIdentitySchema.parse(runtime) } : {}) };
  const devices = Array.isArray(stats?.devices) ? stats.devices : [];
  if (devices.length === 1 && typeof devices[0]?.name === 'string') { const device = devices[0]; const type = device.type === 'cuda' ? 'cuda' : device.type === 'cpu' ? 'cpu' : 'other'; value.activeDevice = { type, name: device.name, ...(Number.isInteger(device.index) && device.index >= 0 ? { index: device.index } : {}), ...(Number.isFinite(device.vram_total) && device.vram_total > 0 ? { vramBytes: device.vram_total } : {}) };
    if (type === 'cuda') { const matches = gpus.filter(gpu => device.name.includes(gpu.name) && (value.activeDevice!.vramBytes === undefined || Math.abs(value.activeDevice!.vramBytes! / 1048576 - gpu.vramMiB) < 128)); if (matches.length === 1) value.selectedGpu = matches[0]; else { value.detection = 'ambiguous'; value.messages.push('The CUDA device could not be mapped unambiguously to the NVIDIA inventory.'); } }
  } else if (devices.length > 1) { value.detection = 'ambiguous'; value.messages.push('The backend reported multiple active devices; no single-device measured profile is assumed.'); }
  else value.messages.push('Start the private engine to confirm its selected device and runtime.');
  if (gpus.length > 1 && !value.selectedGpu) value.detection = 'ambiguous'; return { ...value, fingerprint: inventoryFingerprint(value) };
}
export async function inspectHardware(paths: AppPaths, backendUrl: string | null, runtime?: RuntimeIdentitySnapshot): Promise<HardwareInventory> {
  const messages: string[] = []; let gpus: HardwareGpu[] = []; let stats: any;
  try { gpus = await queryNvidiaInventory(); } catch { messages.push('NVIDIA tooling did not provide a reliable GPU inventory. CPU or other GPU backends are not assumed to be measured.'); }
  if (backendUrl) try { stats = await boundedStats(backendUrl); if (path.resolve(String(stats?.system?.argv?.[0] ?? '')) !== path.resolve(paths.backend, 'main.py')) throw new Error('The device response did not identify the owned backend.'); } catch { stats = undefined; messages.push('The owned backend device response is unavailable; refresh after it is ready.'); }
  return assembleHardwareInventory({ os: `${os.type()} ${os.release()}`, arch: os.arch(), ramBytes: os.totalmem() }, gpus, stats, runtime, messages);
}
/** Opt-in read-only telemetry. Starting a recorder never starts or runs a GPU workload. */
export class HardwareTelemetryRecorder {
  private samples: HardwareTelemetry['samples'] = []; private startedAt = new Date().toISOString(); private timer?: NodeJS.Timeout; private pending?: Promise<void>; private errors = 0; private attempts = 0; private stopped = false;
  constructor(private gpuUuid: string, private intervalMs = 250, private maxSamples = 20000, private readSample = async () => { const result = await execute('nvidia-smi', ['--id=' + gpuUuid, '--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 5000, maxBuffer: 8192 }); const fields = result.stdout.trim().split(',').map(value => Number(value.trim())); if (fields.length !== 2) throw new Error('Invalid GPU telemetry'); return { memoryMiB: fields[0], utilizationPercent: fields[1] }; }) { if (!/^GPU-[a-f0-9-]{16,80}$/i.test(gpuUuid) || !Number.isInteger(intervalMs) || intervalMs < 250 || intervalMs > 5000 || !Number.isInteger(maxSamples) || maxSamples < 1 || maxSamples > 20000) throw new Error('Invalid bounded hardware telemetry request.'); }
  start() { if (this.timer || this.stopped) throw new Error('This telemetry recorder cannot be started twice.'); this.startedAt = new Date().toISOString(); const tick = () => { if (this.pending || this.stopped || this.attempts >= this.maxSamples) return; this.attempts++; this.pending = this.sample().finally(() => { this.pending = undefined; if (this.attempts >= this.maxSamples && this.timer) clearInterval(this.timer); }); }; tick(); this.timer = setInterval(tick, this.intervalMs); this.timer.unref(); return this; }
  private async sample() { try { const value = await this.readSample(); if (!Number.isFinite(value.memoryMiB) || !Number.isFinite(value.utilizationPercent) || value.memoryMiB < 0 || value.memoryMiB > 1048576 || value.utilizationPercent < 0 || value.utilizationPercent > 100) throw new Error('Invalid GPU telemetry'); this.samples.push({ at: new Date().toISOString(), ...value }); } catch { this.errors++; } }
  async stop(): Promise<HardwareTelemetry> { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.pending; return { startedAt: this.startedAt, endedAt: new Date().toISOString(), gpuUuid: this.gpuUuid, requestedIntervalMs: this.intervalMs, samples: structuredClone(this.samples), ...(this.samples.length ? { observedMaxMiB: Math.max(...this.samples.map(sample => sample.memoryMiB)) } : {}), errors: this.errors, limitReached: this.attempts >= this.maxSamples, scope: 'sampled-whole-device', instantaneousPeakKnown: false }; }
}

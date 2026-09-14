import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { inside } from './paths';

export interface SessionFileProgress { bytes: number; totalBytes: number; cached: boolean; }
interface Fingerprint { canonical: string; dev: string; ino: string; size: string; mtimeNs: string; ctimeNs: string; nlink: string; }
interface Verified { fingerprint: Fingerprint; sha256: string; bytes: number; }
interface Pending { controller: AbortController; consumers: Map<symbol, (progress: SessionFileProgress) => void>; promise: Promise<Verified>; progress: SessionFileProgress; }
const same = (left: Fingerprint, right: Fingerprint) => JSON.stringify(left) === JSON.stringify(right);
const keyOf = (filename: string) => process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);
function statFingerprint(canonical: string, stat: BigIntStats): Fingerprint {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error('Verified assets must remain independent regular files.');
  return { canonical: keyOf(canonical), dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), nlink: stat.nlink.toString() };
}

/** Session-only full-SHA evidence; never initialized from a disk receipt. */
export class SessionFileVerifier {
  private cache = new Map<string, Verified>();
  private pending = new Map<string, Pending>();
  private active = new Set<Pending>();
  private disposed = false;
  constructor(private root: string, private maxEntries = 8) { if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 64) throw new Error('Invalid verification cache bound.'); }
  invalidate(filename?: string): void {
    const prefix = filename === undefined ? undefined : `${keyOf(filename)}\0`;
    for (const key of this.cache.keys()) if (prefix === undefined || key.startsWith(prefix)) this.cache.delete(key);
    for (const [key, operation] of this.pending) if (prefix === undefined || key.startsWith(prefix)) { operation.controller.abort(); this.pending.delete(key); }
  }
  private async fingerprint(filename: string): Promise<Fingerprint> {
    const absolute = path.resolve(filename); const root = path.resolve(this.root);
    if (!inside(root, absolute) || absolute === root) throw new Error('The verified asset is outside its private directory.');
    for (let current = absolute; ; current = path.dirname(current)) {
      const stat = await fs.lstat(current, { bigint: true });
      if (stat.isSymbolicLink() || current !== absolute && !stat.isDirectory()) throw new Error('Verified asset paths cannot contain symbolic links or junctions.');
      if (current === root) break;
    }
    const canonical = await fs.realpath(absolute); if (!inside(await fs.realpath(root), canonical)) throw new Error('The verified asset resolves outside its private directory.');
    return statFingerprint(canonical, await fs.lstat(absolute, { bigint: true }));
  }
  async verify(filename: string, expected: { bytes: number; sha256: string }, signal?: AbortSignal, progress: (value: SessionFileProgress) => void = () => {}): Promise<{ cached: boolean; bytes: number; sha256: string }> {
    if (this.disposed) throw new Error('The session verifier was disposed.'); signal?.throwIfAborted(); if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 1 || !/^[a-f0-9]{64}$/.test(expected.sha256)) throw new Error('Invalid reviewed file identity.');
    const key = `${keyOf(filename)}\0${expected.bytes}\0${expected.sha256}`;
    let before: Fingerprint;
    try { before = await this.fingerprint(filename); if (before.size !== String(expected.bytes)) throw new Error('The reviewed asset size changed.'); }
    catch (error) { this.invalidate(filename); throw error; }
    signal?.throwIfAborted(); if (this.disposed) throw new Error('The session verifier was disposed.');
    const cached = this.cache.get(key);
    if (cached && same(before, cached.fingerprint)) {
      try { const after = await this.fingerprint(filename); if (!same(before, after)) throw new Error('The asset changed during verification.'); signal?.throwIfAborted(); progress({ bytes: expected.bytes, totalBytes: expected.bytes, cached: true }); return { cached: true, bytes: expected.bytes, sha256: cached.sha256 }; }
      catch (error) { this.invalidate(filename); throw error; }
    }
    // Remove stale entries for this path, but preserve a matching in-flight read.
    for (const stored of this.cache.keys()) if (stored.startsWith(`${keyOf(filename)}\0`)) this.cache.delete(stored);
    let operation = this.pending.get(key);
    if (operation?.controller.signal.aborted) operation = undefined;
    if (!operation) {
      if (this.active.size >= this.maxEntries) throw new Error('Too many distinct asset checks are active. Retry after verification finishes.');
      operation = { controller: new AbortController(), consumers: new Map(), progress: { bytes: 0, totalBytes: expected.bytes, cached: false }, promise: undefined as unknown as Promise<Verified> };
      const owned = operation;
      owned.promise = this.hash(filename, expected, before, owned).then(value => {
        owned.controller.signal.throwIfAborted(); if (this.cache.size >= this.maxEntries) this.cache.delete(this.cache.keys().next().value!); this.cache.set(key, value); return value;
      }).finally(() => { this.active.delete(owned); if (this.pending.get(key) === owned) this.pending.delete(key); });
      this.active.add(owned); this.pending.set(key, owned);
    }
    const owned = operation; const consumer = Symbol('verification caller');
    return new Promise((resolve, reject) => {
      let finished = false;
      const cleanup = () => { if (finished) return; finished = true; signal?.removeEventListener('abort', abort); owned.consumers.delete(consumer); };
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Verification cancelled.')); if (!owned.consumers.size) owned.controller.abort(); };
      const observe = (value: SessionFileProgress) => { try { progress(value); } catch { /* An observer cannot invalidate file evidence or other callers. */ } };
      owned.consumers.set(consumer, observe); signal?.addEventListener('abort', abort, { once: true });
      owned.promise.then(value => { if (finished) return; cleanup(); resolve({ cached: false, bytes: value.bytes, sha256: value.sha256 }); }, error => { if (finished) return; cleanup(); reject(error); });
      if (signal?.aborted) abort(); else observe(owned.progress);
    });
  }
  async dispose(): Promise<void> { this.disposed = true; const operations = [...this.active]; this.invalidate(); await Promise.allSettled(operations.map(operation => operation.promise)); }
  private async hash(filename: string, expected: { bytes: number; sha256: string }, before: Fingerprint, operation: Pending): Promise<Verified> {
    const signal = operation.controller.signal; const file = await fs.open(filename, 'r');
    try {
      if (!same(before, statFingerprint(before.canonical, await file.stat({ bigint: true })))) throw new Error('The asset changed before its hash could start.');
      const hash = createHash('sha256'); let bytes = 0;
      for await (const chunk of file.createReadStream({ highWaterMark: 4 * 1024 * 1024, autoClose: false })) {
        signal.throwIfAborted(); bytes += chunk.length; if (bytes > expected.bytes) throw new Error('The asset grew while its hash was being checked.'); hash.update(chunk);
        operation.progress = { bytes, totalBytes: expected.bytes, cached: false }; for (const callback of operation.consumers.values()) callback(operation.progress);
      }
      signal.throwIfAborted(); const hashValue = hash.digest('hex');
      if (bytes !== expected.bytes || hashValue !== expected.sha256) throw new Error('The reviewed asset bytes changed. The original file was preserved.');
      if (!same(before, statFingerprint(before.canonical, await file.stat({ bigint: true }))) || !same(before, await this.fingerprint(filename))) throw new Error('The asset changed while its full hash was being checked.');
      signal.throwIfAborted(); return { fingerprint: before, sha256: hashValue, bytes };
    } finally { await file.close(); }
  }
}

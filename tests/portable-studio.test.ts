import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStartupPaths, PORTABLE_STUDIO_FILENAME } from '../src/main/portable-studio';
import { createPaths } from '../src/main/paths';
const dirs: string[] = [];
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'latent-portable-test-')); dirs.push(base);
  const portable = path.join(base, 'portable'); fs.mkdirSync(portable);
  const root = path.join(base, 'studio');
  const pointer = path.join(portable, PORTABLE_STUDIO_FILENAME);
  const env = { PORTABLE_EXECUTABLE_DIR: portable, PORTABLE_EXECUTABLE_FILE: path.join(portable, 'Latent.exe') };
  return { base, portable, root, pointer, env, options: { isPackaged: true, defaultRoot: root, env } };
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
describe('portable studio persistence', () => {
  it('pins the physical marked studio and reuses it when the launch default changes', () => {
    const f = fixture(); const first = createStartupPaths(f.options);
    expect(first.root).toBe(fs.realpathSync.native(f.root));
    expect(JSON.parse(fs.readFileSync(f.pointer, 'utf8'))).toEqual({ schema: 1, appId: 'studio.latent.v2', root: first.root });
    fs.writeFileSync(path.join(first.outputs, 'keep.png'), 'original'); const pointer = fs.readFileSync(f.pointer);
    const next = path.join(f.base, 'different-context');
    expect(createStartupPaths({ ...f.options, defaultRoot: next })).toEqual(first);
    expect(fs.existsSync(next)).toBe(false); expect(fs.readFileSync(f.pointer)).toEqual(pointer);
    expect(fs.readFileSync(path.join(first.outputs, 'keep.png'), 'utf8')).toBe('original');
  });
  it('explicit root bypasses an invalid pointer and never creates or repins it', () => {
    const f = fixture(); const explicit = path.join(f.base, 'override');
    createStartupPaths({ ...f.options, env: { ...f.env, LATENT_DATA_ROOT: explicit } });
    expect(fs.existsSync(f.pointer)).toBe(false);
    fs.writeFileSync(f.pointer, 'unknown data');
    expect(createStartupPaths({ ...f.options, env: { ...f.env, LATENT_DATA_ROOT: explicit } }).root).toBe(explicit);
    expect(fs.readFileSync(f.pointer, 'utf8')).toBe('unknown data'); expect(fs.existsSync(f.root)).toBe(false);
  });
  it('stores the physical location returned for a virtualized default, not its logical alias', () => {
    const f = fixture(); const physicalAlias = path.join(f.base, 'physical-studio'); createPaths(physicalAlias); const physical = fs.realpathSync.native(physicalAlias);
    const original = fs.realpathSync.native;
    vi.spyOn(fs.realpathSync, 'native').mockImplementation(((filename: fs.PathLike) => path.resolve(String(filename)) === f.root ? physical : original(filename)) as typeof fs.realpathSync.native);
    const selected = createStartupPaths(f.options);
    expect(selected.root).toBe(physical); expect(JSON.parse(fs.readFileSync(f.pointer, 'utf8')).root).toBe(physical);
    vi.restoreAllMocks();
    expect(createStartupPaths({ ...f.options, defaultRoot: path.join(f.base, 'outside-launch') }).root).toBe(physical);
  });
  it('development and unpacked launches retain the normal default without a pointer', () => {
    const f = fixture(); createStartupPaths({ ...f.options, isPackaged: false });
    expect(fs.existsSync(f.pointer)).toBe(false);
    createStartupPaths({ ...f.options, env: {} }); expect(fs.existsSync(f.pointer)).toBe(false);
  });
  it.each([
    '{bad json', JSON.stringify({ schema: 2, appId: 'studio.latent.v2', root: 'C:\\studio' }),
    JSON.stringify({ schema: 1, appId: 'other', root: 'C:\\studio' }),
    JSON.stringify({ schema: 1, appId: 'studio.latent.v2', root: '../studio' }),
    JSON.stringify({ schema: 1, appId: 'studio.latent.v2', root: 'C:\\studio', extra: true }),
    'x'.repeat(4097),
  ])('refuses an incompatible/unknown pointer without fallback or overwrite (%#)', data => {
    const f = fixture(); fs.writeFileSync(f.pointer, data);
    expect(() => createStartupPaths(f.options)).toThrow('Cannot open the portable studio');
    expect(fs.readFileSync(f.pointer, 'utf8')).toBe(data); expect(fs.existsSync(f.root)).toBe(false);
  });
  it('refuses a stale pointer or invalid marker before creating managed folders', () => {
    const f = fixture(); const target = path.join(f.base, 'missing');
    fs.writeFileSync(f.pointer, JSON.stringify({ schema: 1, appId: 'studio.latent.v2', root: target }));
    expect(() => createStartupPaths(f.options)).toThrow('Cannot open'); expect(fs.existsSync(target)).toBe(false);
    fs.mkdirSync(target); fs.writeFileSync(path.join(target, '.latentv2-root.json'), JSON.stringify({ application: 'other', schema: 1 }));
    expect(() => createStartupPaths(f.options)).toThrow('Cannot open'); expect(fs.readdirSync(target)).toEqual(['.latentv2-root.json']);
    expect(fs.existsSync(f.root)).toBe(false);
  });
  it('refuses linked ancestors and hard-linked metadata without following an outside studio', () => {
    const f = fixture(); const real = path.join(f.base, 'outside'); createPaths(real);
    const alias = path.join(f.base, 'alias'); fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(f.pointer, JSON.stringify({ schema: 1, appId: 'studio.latent.v2', root: path.join(alias, 'child') }));
    expect(() => createStartupPaths(f.options)).toThrow('Linked'); expect(fs.existsSync(path.join(real, 'child'))).toBe(false);
    fs.unlinkSync(f.pointer); const original = path.join(f.base, 'original.json');
    fs.writeFileSync(original, JSON.stringify({ schema: 1, appId: 'studio.latent.v2', root: real })); fs.linkSync(original, f.pointer);
    expect(() => createStartupPaths(f.options)).toThrow('unlinked'); expect(fs.existsSync(f.root)).toBe(false);
  });
  it('checks an existing default marker and refuses mismatched wrapper locations', () => {
    const f = fixture(); fs.mkdirSync(f.root); fs.writeFileSync(path.join(f.root, '.latentv2-root.json'), '{}');
    expect(() => createStartupPaths(f.options)).toThrow('Cannot open'); expect(fs.existsSync(f.pointer)).toBe(false);
    expect(fs.readdirSync(f.root)).toEqual(['.latentv2-root.json']);
    expect(() => createStartupPaths({ ...f.options, env: { ...f.env, PORTABLE_EXECUTABLE_FILE: path.join(f.base, 'wrong.exe') } })).toThrow('inconsistent');
  });
  it('accepts the wrapper file alone and refuses a marker hard link', () => {
    const f = fixture(); createStartupPaths({ ...f.options, env: { PORTABLE_EXECUTABLE_FILE: f.env.PORTABLE_EXECUTABLE_FILE } });
    fs.linkSync(path.join(f.root, '.latentv2-root.json'), path.join(f.base, 'marker-copy'));
    expect(() => createStartupPaths(f.options)).toThrow('unlinked');
  });
});

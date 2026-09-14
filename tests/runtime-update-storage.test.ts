import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectUpdateTree, reviewedArchiveManifest, readUpdateJson, writeUpdateJson } from '../src/main/runtime-update-storage';
import { latestReviewedRuntimeSet } from '../src/main/reviewed-runtime-channel';
let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-update-storage-test-')); });
afterEach(async () => { if (!path.basename(root).startsWith('latent-update-storage-test-')) throw new Error('Unsafe test cleanup'); await fs.rm(root, { recursive: true, force: true }); });
async function archive(names: string[]) { const set = latestReviewedRuntimeSet(); const zip = new AdmZip(); for (const name of names) zip.addFile(`ComfyUI-${set.backend.commit}/${name}`, Buffer.from('fixture')); const filename = path.join(root, 'fixture.zip'); await fs.writeFile(filename, zip.toBuffer()); return { filename, set }; }
describe('private updater archive and metadata boundaries', () => {
  it.each(['CON.py', 'folder/NUL', 'folder/COM1.txt', 'space .', 'drive:C.py'])('rejects unsafe Windows archive path %s', async unsafe => { const { filename, set } = await archive([unsafe]); expect(() => reviewedArchiveManifest(filename, set)).toThrow(/unsafe path/); });
  it('rejects Windows case collisions and source-marker shadowing', async () => { let fixture = await archive(['main.py', 'MAIN.py']); expect(() => reviewedArchiveManifest(fixture.filename, fixture.set)).toThrow(/colliding/); fixture = await archive(['.latent-source.json']); expect(() => reviewedArchiveManifest(fixture.filename, fixture.set)).toThrow(/colliding/); });
  it('rejects hard-linked source and metadata files', async () => { const file = path.join(root, 'a.py'); await fs.writeFile(file, '{}'); await fs.link(file, path.join(root, 'b.py')); await expect(inspectUpdateTree(root)).rejects.toThrow(/linked files/); await expect(readUpdateJson(root, file)).rejects.toThrow(/independent file/); });
  it('publishes durable complete JSON and does not follow a metadata junction', async () => { const file = path.join(root, 'transaction.json'); await writeUpdateJson(root, file, { phase: 'before-move', test: true }); expect(await readUpdateJson(root, file)).toEqual({ phase: 'before-move', test: true }); expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]); const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'latent-update-outside-test-')); try { await fs.symlink(outside, path.join(root, 'junction'), 'junction'); await expect(writeUpdateJson(root, path.join(root, 'junction/state.json'), {})).rejects.toThrow(/symbolic links|junctions/); expect(await fs.readdir(outside)).toEqual([]); } finally { if (!path.basename(outside).startsWith('latent-update-outside-test-')) throw new Error('Unsafe outside fixture cleanup'); await fs.rm(outside, { recursive: true, force: true }); } });
});

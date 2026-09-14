import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { violations, inspect } from './public-source.mjs';
test('rejects private payload names and credential-shaped content without echoing values', () => {
  const secret = 'gh' + 'p_' + 'A'.repeat(36);
  assert(violations('src/example.ts', Buffer.from(secret)).includes('credential'));
  assert(violations('Latent-v2-studio.json',Buffer.from('{}')).includes('private-payload'));
  assert(violations('cache/user.json',Buffer.from('{}')).includes('private-payload'));
  assert(violations('src/example.ts',Buffer.from('GPU-' + '12345678-' + '1234-1234-1234-123456789abc')).includes('device-identifier'));
  assert.deepEqual(violations('src/example.ts',Buffer.from('export const version = 1;')),[]);
});
test('export inspection rejects extra files, stale exceptions, and linked inputs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'latent-public-boundary-'));
  try {
    await fs.writeFile(path.join(root,'example.txt'),'public');
    const manifest = {schema:1,files:[{from:'example.txt',to:'example.txt'}]};
    await fs.writeFile(path.join(root,'public-source-manifest.json'),JSON.stringify(manifest));
    assert.equal((await inspect(root,true)).files.length,1);
    await fs.writeFile(path.join(root,'extra.txt'),'unexpected');
    await assert.rejects(inspect(root,true),/Unlisted export file/);
    await fs.unlink(path.join(root,'extra.txt'));
    await fs.writeFile(path.join(root,'example.txt'),'gh'+'p_'+'B'.repeat(36));
    await assert.rejects(inspect(root,true),/credential/);
    await fs.unlink(path.join(root,'example.txt'));
    await fs.mkdir(path.join(root,'actual'));
    await fs.symlink(path.join(root,'actual'),path.join(root,'example.txt'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(inspect(root,true),/Linked public source input/);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

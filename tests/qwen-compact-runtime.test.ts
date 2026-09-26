import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createPaths } from '../src/main/paths';
import { QWEN_GGUF_RELEASE as release } from '../src/shared/qwen-gguf-release';
import { installQwenGGUFRuntime, verifyQwenGGUFRuntime } from '../src/main/qwen-gguf-runtime';
const state = vi.hoisted(() => ({ version: '0.19.0', launcherFailures: 0, commands: [] as string[][] }));
vi.mock('node:child_process', () => ({ spawn: (_exe: string, args: string[]) => {
 state.commands.push(args); const child = new EventEmitter() as any; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = vi.fn();
 queueMicrotask(() => { if (args.includes('--offline') && state.launcherFailures-- > 0) { child.stderr.emit('data', Buffer.from('failed to remove file uv-trampoline-123.exe: Access is denied. (os error 5)')); child.emit('close', 1); return; } child.stdout.emit('data', Buffer.from(args.some(a=>a.includes('m.distributions()')) ? state.version+'\n' : '')); child.emit('close', 0); }); return child;
} }));
vi.mock('../src/main/assistant-download', () => ({
 assistantHash: async (file: string) => { const data=await fs.readFile(file); const pins=release.files; const pin=[...pins,release.wheel].find(p=>p.filename===path.basename(file)); return data[0]===0 ? pin?.sha256 : createHash('sha256').update(data).digest('hex'); },
 downloadAssistantAsset: async (pin: {filename:string;bytes:number}, directory:string) => { await fs.mkdir(directory,{recursive:true}); const file=path.join(directory,pin.filename); await fs.writeFile(file,Buffer.alloc(pin.bytes)); return file; },
}));
it('repairs only the owned loader, retaining changed code and preserving unrelated nodes', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'latent-compact-repair-')); const paths=createPaths(root);const signal=new AbortController().signal;state.version='0.19.0';state.commands=[];
 try {
  const other=path.join(root,'custom_nodes','unrelated');await fs.mkdir(other,{recursive:true});await fs.writeFile(path.join(other,'keep.txt'),'keep');
  await installQwenGGUFRuntime(paths,signal);await verifyQwenGGUFRuntime(paths);
  const live=path.join(root,'custom_nodes',release.directory);await fs.writeFile(path.join(live,'nodes.py'),'changed source');
  await expect(installQwenGGUFRuntime(paths,signal)).rejects.toThrow('changed');
  await installQwenGGUFRuntime(paths,signal,true);await verifyQwenGGUFRuntime(paths);
  const cache=path.join(paths.cache,'qwen-gguf-loader');const retained=(await fs.readdir(cache)).filter(n=>n.startsWith('retained-'));expect(retained).toHaveLength(1);
  expect(await fs.readFile(path.join(cache,retained[0],'nodes.py'),'utf8')).toBe('changed source');expect(await fs.readFile(path.join(other,'keep.txt'),'utf8')).toBe('keep');
  const install=state.commands.find(args=>args.includes('--reinstall-package'));expect(install).toContain('gguf');expect(install).toContain('--no-deps');expect(install).toContain('--offline');
 } finally {await fs.rm(root,{recursive:true,force:true});}
});
it('refuses a conflicting dependency version before modifying loader code', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'latent-compact-conflict-'));state.version='0.18.0';state.commands=[];
 try {const paths=createPaths(root);await expect(installQwenGGUFRuntime(paths,new AbortController().signal,true)).rejects.toThrow('preserved');expect(state.commands.some(args=>args.includes('install'))).toBe(false);await expect(fs.stat(path.join(root,'custom_nodes',release.directory))).rejects.toThrow();}
 finally {state.version='0.19.0';await fs.rm(root,{recursive:true,force:true});}
});

it('retries a transient Windows launcher lock without changing the pinned dependency', async () => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'latent-qwen-loader-retry-'));state.version='0.19.0';state.launcherFailures=1;state.commands=[];
 try {await installQwenGGUFRuntime(createPaths(root),new AbortController().signal,true);expect(state.commands.filter(args=>args.includes('--offline'))).toHaveLength(2);}
 finally {state.launcherFailures=0;await fs.rm(root,{recursive:true,force:true});}
});

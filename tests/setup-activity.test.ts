import {it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configureSetupActivity,beginSetupActivity,setupActivitySnapshot,redactSetupText} from '../src/main/setup-activity';
it('records progress, preserves diagnostics, redacts URL credentials and survives restart',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'latent-activity-'));
 try{
 configureSetupActivity(dir,()=>{});
 const source=new URL('https://example.com/file?token=private#secret');
 source.username='user';source.password='secret';
 const task=beginSetupActivity('Python packages',source.href,path.join(dir,'python'));
 task.note('Downloading package https://example.com/wheel?token=private');
 task.progress('Downloading torch',50);
 expect(setupActivitySnapshot()[0].progress).toBe(50);
 task.finish('failed','File was blocked');
 const text=fs.readFileSync(path.join(dir,'download-setup.jsonl'),'utf8');
 expect(text).not.toContain('private');expect(text).not.toContain('user:secret');
 configureSetupActivity(dir,()=>{});
 expect(setupActivitySnapshot()[0]).toMatchObject({state:'failed',message:'File was blocked',source:'https://example.com/file'});
 expect(setupActivitySnapshot()[0].details).toContain('Downloading package');
 beginSetupActivity('Interrupted operation','local',dir);
 configureSetupActivity(dir,()=>{});
 expect(setupActivitySnapshot().at(-1)?.state).toBe('interrupted');
 expect(redactSetupText('Bearer mysecret')).toBe('Bearer [redacted]');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

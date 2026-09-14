import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateInstallerConfig, inspectDistributionFiles, DISTRIBUTION_FILES, publicPackageReport } from './windows-distribution.mjs';
import { checkNotices } from './third-party-notices.mjs';
const project=path.resolve(import.meta.dirname,'..');
const pkg=JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8'));
test('installer stays per-user and preserves the studio',()=>{validateInstallerConfig(pkg);for(const [key,value] of [['perMachine',true],['allowElevation',true],['deleteAppDataOnUninstall',true],['packElevateHelper',true]]){const changed=structuredClone(pkg);changed.build.nsis[key]=value;assert.throws(()=>validateInstallerConfig(changed));}const changed=structuredClone(pkg);changed.build.extraFiles.push({from:'.data',to:'studio'});assert.throws(()=>validateInstallerConfig(changed),/extra files/);});
test('notices match the installed production dependency inventory',()=>checkNotices(project));
test('shipped license identity detects omissions and tampering',async()=>{
 const output=await fs.mkdtemp(path.join(os.tmpdir(),'latent-notice-check-'));
 try {for(const [source,name] of [...DISTRIBUTION_FILES.map(n=>[n,n]),['node_modules/electron/dist/LICENSE','LICENSE.electron.txt'],['node_modules/electron/dist/LICENSES.chromium.html','LICENSES.chromium.html']])await fs.copyFile(path.join(project,source),path.join(output,name));
 assert.equal((await inspectDistributionFiles(project,output)).length,5);
 await fs.writeFile(path.join(output,'THIRD-PARTY-NOTICES.txt'),'changed');await assert.rejects(inspectDistributionFiles(project,output),/changed distribution notice/);
 await fs.unlink(path.join(output,'THIRD-PARTY-NOTICES.txt'));await assert.rejects(inspectDistributionFiles(project,output),/ENOENT/);
 }finally{await fs.rm(output,{recursive:true,force:true});}
});

test('shipped build reports omit machine paths and reject other private data',()=>{
 const local=['C:','Users','build-account','project'].join('/');
 const report=publicPackageReport({appOutDir:local,appVersion:'0.1.0'});
 assert.deepEqual(JSON.parse(report),{appVersion:'0.1.0'});
 assert.throws(()=>publicPackageReport({unexpectedPath:local}),/private build information/);
});

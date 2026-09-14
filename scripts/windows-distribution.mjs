import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { violations } from './public-source.mjs';
export const DISTRIBUTION_FILES = ['LICENSE','THIRD-PARTY-NOTICES.txt','README-WINDOWS.txt'];
export function validateInstallerConfig(pkg) {
 const n=pkg.build?.nsis;
 if(!n || n.oneClick!==true || n.perMachine!==false || n.allowElevation!==false || n.deleteAppDataOnUninstall!==false || n.packElevateHelper!==false || n.runAfterFinish!==true)throw Error('Installer must remain per-user, preserve studio data and start guided setup without elevation.');
 if(n.include || n.script || pkg.build.afterAllArtifactBuild)throw Error('Custom installer hooks need a separate data-preservation review.');
 if(JSON.stringify(pkg.build.extraFiles)!==JSON.stringify(DISTRIBUTION_FILES.map(name=>({from:name,to:name}))))throw Error('Installer extra files must contain only the reviewed licenses and Windows guide.');
 if(pkg.build.win.requestedExecutionLevel!=='asInvoker')throw Error('App must run without elevation.');
}
export async function inspectDistributionFiles(project, output) {
 const files=[];
 for(const [source,name] of [...DISTRIBUTION_FILES.map(name=>[name,name]),['node_modules/electron/dist/LICENSE','LICENSE.electron.txt'],['node_modules/electron/dist/LICENSES.chromium.html','LICENSES.chromium.html']]){
  const original=await fs.readFile(path.join(project,source));const destination=path.join(output,name);const stat=await fs.lstat(destination);
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid distribution notice: '+name);
  const actual=await fs.readFile(destination);if(!actual.equals(original))throw Error('Missing or changed distribution notice: '+name);
  if(DISTRIBUTION_FILES.includes(name)&&violations(name,actual).length)throw Error('Distribution notice failed privacy review: '+name);
  files.push({name,bytes:actual.length,sha256:createHash('sha256').update(actual).digest('hex')});
 }
 return files;
}

export function publicPackageReport(report) {
 const {appOutDir: _privateBuildPath, ...publicReport}=report;
 const text=JSON.stringify(publicReport,null,2);
 if(violations('Latent-package-resources.json',Buffer.from(text)).length)throw Error('Package report contains private build information.');
 return text;
}

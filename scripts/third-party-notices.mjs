import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export async function renderNotices(project = path.resolve(import.meta.dirname, '..')) {
 const pkg = JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8'));
 const lock = JSON.parse(await fs.readFile(path.join(project,'package-lock.json'),'utf8'));
 const sections = ['Latent v2 - Third-party notices\n\nLatent v2 is MIT licensed. Dependencies retain their respective licenses.\nThis inventory covers installed Windows x64 production npm packages, including\nbundled renderer dependencies. Electron and Chromium notices are supplied as\nLICENSE.electron.txt and LICENSES.chromium.html beside the application.\n\nThe separately acquired Python/ComfyUI runtime and model weights are not shipped\nin the installer. Their upstream licenses accompany those separate components.'];
 for (const [name,entry] of Object.entries(lock.packages).sort(([a],[b])=>a.localeCompare(b,'en'))) {
  if (!name || entry.dev || entry.os && !entry.os.includes('win32') || entry.cpu && !entry.cpu.includes('x64')) continue;
  const folder = path.join(project,name);let installed;
  try {installed=JSON.parse(await fs.readFile(path.join(folder,'package.json'),'utf8'));} catch(error) {if(entry.optional && error.code==='ENOENT')continue;throw error;}
  if(installed.version!==entry.version)throw Error('Notice dependency differs from lock: '+name);
  const files=(await fs.readdir(folder)).filter(n=>/^(licen[sc]e|copying|notice)(?:$|[.-])/i.test(n)).sort();
  if(!files.length)throw Error('Missing dependency license: '+name);
  sections.push(`${installed.name} ${installed.version}\nDeclared license: ${installed.license ?? 'See included license'}\nSource: ${typeof installed.repository==='string'?installed.repository:installed.repository?.url ?? installed.homepage ?? 'See npm package metadata'}`);
  for(const file of files){const stat=await fs.lstat(path.join(folder,file));if(!stat.isFile()||stat.isSymbolicLink())throw Error('Unexpected license input: '+name+'/'+file);sections.push(file+'\n'+await fs.readFile(path.join(folder,file),'utf8'));}
 }
 sections.push('Electron '+pkg.devDependencies.electron+'\nhttps://github.com/electron/electron\n'+await fs.readFile(path.join(project,'node_modules/electron/dist/LICENSE'),'utf8'));
 sections.push('Sharp Windows native libraries\n\nThe prebuilt Sharp package includes libvips and additional libraries.\nThe native DLLs are unpacked under resources/app.asar.unpacked/node_modules/\n@img/sharp-win32-x64/lib, allowing replacement with interface-compatible builds.\nModification and reverse engineering for debugging such modifications are not\nrestricted by Latent. Source and build instructions: https://github.com/lovell/sharp\nand https://github.com/lovell/sharp-libvips . Exact installed native versions:\n'+await fs.readFile(path.join(project,'node_modules/@img/sharp-win32-x64/versions.json'),'utf8'));
 sections.push('Upstream Windows native package notices\n'+await fs.readFile(path.join(project,'node_modules/@img/sharp-win32-x64/README.md'),'utf8'));
 sections.push('GNU LGPL version 3 and incorporated GPL version 3\nLicense text from SPDX license-list-data v3.27.0 (LGPL-3.0-only.txt).\nNative component grants may allow later versions as stated above.\n\n'+await fs.readFile(path.join(project,'licenses/LGPL-3.0.txt'),'utf8'));
 return sections.join('\n\n'+'='.repeat(72)+'\n\n').replaceAll('\r\n','\n')+'\n';
}
export async function checkNotices(project) {const expected=await renderNotices(project);if((await fs.readFile(path.join(project,'THIRD-PARTY-NOTICES.txt'),'utf8')).replaceAll('\r\n','\n')!==expected)throw Error('Third-party notices are stale. Run npm run notices and review the changes.');}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const project=path.resolve(import.meta.dirname,'..');
 if(process.argv[2]==='--check')await checkNotices(project);
 else if(process.argv.length===2)await fs.writeFile(path.join(project,'THIRD-PARTY-NOTICES.txt'),await renderNotices(project));
 else throw Error('Use notices or notices --check.');
 console.log('Third-party notices '+(process.argv[2]?'checked':'generated')+'.');
}

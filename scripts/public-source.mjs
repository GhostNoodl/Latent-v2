import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestName = 'public-source-manifest.json';
const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['credential', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-)?[A-Za-z0-9_-]{32,}|AKIA[A-Z0-9]{16})/],
  ['credential-url', /https?:\/\/[^\s/"']+:[^\s/@"']+@/],
  ['user-profile-path', /(?:[A-Z]:[\\/]+Users[\\/]+(?!Example User|Public|Default|test|fixture)[^\s"'<>]+)/i],
  ['mac-user-path', /\/Users\/(?!example|test|fixture)[^\s/"']+/],
  ['device-identifier', /GPU-[a-f0-9]{8}-[a-f0-9-]{20,}/i],
];
const forbidden = /(?:^|\/)(?:\.git|\.data|\.runtime|\.artifacts|node_modules|release|outputs|inputs|cache|logs)(?:\/|$)|(?:^|\/)(?:\.env(?:\..*)?|Latent-v2-studio\.json)$|\.(?:sqlite(?:-wal|-shm)?|db|safetensors|gguf|ckpt|pth|onnx|part|partial|log|map)$/i;
export function violations(name, data) {
  const errors = [];
  if (forbidden.test(name)) errors.push('private-payload');
  const value = data.toString('utf8');
  for (const [category, pattern] of patterns) if (pattern.test(value)) errors.push(category);
  // Only field assignments, not schema/property declarations. Report category/path, never values.
  if (/(?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*["'][^"'\r\n]{16,}["']/i.test(value)) errors.push('credential-assignment-review');
  return errors;
}
function relative(name) { if (!name || name.includes('\\') || path.isAbsolute(name) || name.split('/').some(x => !x || x === '.' || x === '..')) throw Error('Invalid public manifest path'); return name; }
async function safeFile(root, name) {
  const filename = path.join(root, relative(name));
  for (let cursor = filename; ; cursor = path.dirname(cursor)) { const stat = await fs.lstat(cursor); if (stat.isSymbolicLink()) throw Error('Linked public source input: ' + name); if (cursor === root) break; }
  const stat = await fs.stat(filename); if (!stat.isFile() || stat.nlink !== 1) throw Error('Non-independent public source input: ' + name);
  return fs.readFile(filename);
}
export async function inspect(root = project, exported = false) {
  root = path.resolve(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, manifestName), 'utf8'));
  const files = []; const seen = new Set(); const errors = [];
  for (const entry of manifest.files) {
    const source = relative(exported ? entry.to : entry.from), target = relative(entry.to);
    if (seen.has(target.toLowerCase())) throw Error('Duplicate public target'); seen.add(target.toLowerCase());
    const data = await safeFile(root, source);
    for (const reason of violations(target, data)) {
      const exception = (entry.exceptions ?? []).find(e => e.category === reason && e.sha256 === createHash('sha256').update(data).digest('hex') && target.startsWith('tests/') && e.reason);
      if (!exception) errors.push({ path: target, reason });
    }
    files.push({ from: entry.from, path: target, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), data });
  }
  if (errors.length) throw Error('Public source checks failed: ' + JSON.stringify(errors));
  if (exported) {
    const walk = async (folder, prefix = '') => { for (const e of await fs.readdir(folder, { withFileTypes: true })) { const n = prefix + e.name; if (['node_modules', 'dist', 'dist-electron', 'release', '.git'].includes(n)) continue; if (e.isSymbolicLink()) throw Error('Link in export: ' + n); if (e.isDirectory()) await walk(path.join(folder,e.name), n+'/'); else if (!seen.has(n.toLowerCase()) && ![manifestName,'PUBLIC-EXPORT.json'].includes(n)) throw Error('Unlisted export file: '+n); } };
    await walk(root);
  }
  return { manifest, files };
}
export async function exportSource(destination) {
  const { manifest, files } = await inspect();
  const root = path.resolve(destination); const rel = path.relative(project, root);
  if (!rel.startsWith('.artifacts' + path.sep) || rel.split(path.sep).length !== 2) throw Error('Use a new direct child of .artifacts for staging');
  await fs.mkdir(path.dirname(root), { recursive: true });
  if ((await fs.lstat(path.dirname(root))).isSymbolicLink()) throw Error('Linked staging parent');
  await fs.mkdir(root); // Never overwrite a previous export.
  for (const file of files) { const target = path.join(root,file.path); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,file.data,{flag:'wx'}); }
  await fs.writeFile(path.join(root,manifestName),JSON.stringify({...manifest,files:manifest.files.map(e=>({...e,from:e.to,to:e.to}))},null,2));
  await fs.writeFile(path.join(root,'PUBLIC-EXPORT.json'),JSON.stringify({schema:1,files:files.map(({path,bytes,sha256})=>({path,bytes,sha256})),privateHistoryIncluded:false},null,2));
  await inspect(root,true); console.log('Public staging export created: '+root);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, destination] = process.argv.slice(2);
  if (mode === 'export' && destination) await exportSource(destination);
  else if (mode === 'check') { const result = await inspect(project, await fs.access(path.join(project,'PUBLIC-EXPORT.json')).then(()=>true,()=>false)); console.log(`Public source checks passed (${result.files.length} files).`); }
  else if (mode === 'release') { await inspect(project, true); const pkg = JSON.parse(await fs.readFile(path.join(project,'package.json'),'utf8')); if (!pkg.license || pkg.license === 'UNLICENSED') throw Error('Public release requires an approved project license'); await fs.access(path.join(project,'LICENSE')); console.log('Source release gate passed; artifact audit and release approval are still required.'); }
  else throw Error('Use check, release, or export <new .artifacts folder>');
}

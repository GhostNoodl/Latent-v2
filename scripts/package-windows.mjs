import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { PROJECT, inspectPackagingSources, inspectBuiltResources, sourceFingerprint } from './packaging-resources.mjs';
const args = process.argv.slice(2); let directoryOnly = false, installer = false, outputName;
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--dir' && !directoryOnly) directoryOnly = true;
  else if (args[index] === '--installer' && !installer) installer = true;
  else if (args[index] === '--output' && outputName === undefined) {
    outputName = args[++index];
    if (!outputName || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(outputName)) throw new Error('Use a new release-folder name containing only letters, digits, hyphens or underscores.');
  } else throw new Error('Use npm run package [-- --dir] [--output <new-release-folder>].');
}
const require = createRequire(import.meta.url); const npmCli = process.env.npm_execpath; if (!npmCli || !path.isAbsolute(npmCli)) throw new Error('Run this command through npm run package so the current npm CLI is explicit.'); await fs.access(npmCli);
let output;
if (outputName) {
  const releaseRoot = path.join(PROJECT, 'release');
  await fs.mkdir(releaseRoot, { recursive: true });
  if ((await fs.lstat(releaseRoot)).isSymbolicLink()) throw new Error('The release folder must be a real project directory.');
  output = path.join(releaseRoot, outputName);
  // Reserve the new folder atomically; never replace a previous package.
  await fs.mkdir(output);
}
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }; for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_NAME', 'LATENT_DEV_URL', 'ELECTRON_RUN_AS_NODE']) delete env[key];
const run = argv => new Promise((resolve, reject) => { const child = spawn(process.execPath, argv, { cwd: PROJECT, env, windowsHide: true, stdio: 'inherit' }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Packaging command exited ${code}; existing outputs were preserved.`))); });
await inspectPackagingSources(); const before = await sourceFingerprint(); await run([npmCli, 'run', 'build']); const after = await sourceFingerprint(); if (before.sha256 !== after.sha256) throw new Error('Source changed during the build. Stop concurrent edits and rebuild a consistent package.'); await inspectBuiltResources();
await run([path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js'), '--win', ...(directoryOnly ? ['--dir'] : [installer ? 'nsis' : 'portable']), '--x64', '--publish', 'never', ...(output ? [`--config.directories.output=${output}`] : [])]);
console.log('Unsigned Windows package completed. Packaged EXE launch, fresh-root setup and generation acceptance remain separate checks.');

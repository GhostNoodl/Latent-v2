import { build } from 'esbuild';
import fs from 'node:fs/promises';
import { writePackagingMetadata } from './packaging-resources.mjs';
await build({ entryPoints: ['src/main/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron', 'sharp'], sourcemap: true });
await build({ entryPoints: ['src/preload/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], sourcemap: true });
await fs.cp('resources', 'dist-electron/resources', { recursive: true });
await writePackagingMetadata();

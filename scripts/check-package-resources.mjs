import fs from 'node:fs/promises';
import path from 'node:path';
import { PROJECT, inspectPackagingSources, inspectBuiltResources, inspectPackagedResources } from './packaging-resources.mjs';
const args = process.argv.slice(2); const mode = args[0] ?? '--source'; if (!['--source', '--built', '--packaged'].includes(mode) || args.length > (mode === '--packaged' ? 2 : 1) || mode === '--packaged' && !args[1]) throw new Error('Use --source, --built, or --packaged <app-output-directory>.');
const report = mode === '--packaged' ? await inspectPackagedResources(path.resolve(args[1])) : mode === '--built' ? await inspectBuiltResources() : await inspectPackagingSources();
const filename = path.join(PROJECT, 'docs/verification', `packaging-${mode.slice(2)}-${report.checkedAt.replaceAll(':', '-').replaceAll('.', '-')}.json`); await fs.mkdir(path.dirname(filename), { recursive: true }); await fs.writeFile(filename, JSON.stringify(report, null, 2)); console.log(`${report.scope}: passed\n${filename}`);

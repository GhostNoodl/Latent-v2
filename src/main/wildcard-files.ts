import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WILDCARD_FILE_LIMIT,
  mergeWildcardImports,
  parseWildcardFile,
  wildcardExportFiles,
  type WildcardImport,
} from '../shared/wildcard-import';

const MAX_FILES = 5000;
const MAX_TOTAL = 64 * 1024 * 1024;
const MAX_DEPTH = 8;
const WILDCARD_FILE = /\.(txt|ya?ml|json)$/i;

/** Reads picked files, or every wildcard file inside a picked folder (names relative to it). */
export async function readWildcardPaths(paths: string[], folder: boolean): Promise<WildcardImport> {
  const found: { file: string; name: string }[] = [];
  const skipped: string[] = [];
  async function walk(directory: string, root: string, depth: number) {
    if (depth > MAX_DEPTH || found.length >= MAX_FILES) return;
    const items = await fs.readdir(directory, { withFileTypes: true });
    for (const item of items.sort((a, b) => a.name.localeCompare(b.name))) {
      if (item.name.startsWith('.')) continue;
      const full = path.join(directory, item.name);
      if (item.isDirectory()) await walk(full, root, depth + 1);
      else if (item.isFile() && WILDCARD_FILE.test(item.name) && found.length < MAX_FILES)
        found.push({ file: full, name: path.relative(root, full) });
    }
  }
  if (folder) for (const root of paths) await walk(root, root, 0);
  else for (const file of paths) found.push({ file, name: path.basename(file) });
  const imports: WildcardImport[] = [];
  let total = 0;
  for (const { file, name } of found) {
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.size > WILDCARD_FILE_LIMIT || total + stat.size > MAX_TOTAL) {
      skipped.push(name);
      continue;
    }
    total += stat.size;
    imports.push(parseWildcardFile(name, await fs.readFile(file, 'utf8')));
  }
  const merged = mergeWildcardImports(imports);
  return { lists: merged.lists, skipped: [...skipped, ...merged.skipped] };
}

/** Writes each list as a .txt file, keeping folders, and never outside the picked folder. */
export async function exportWildcardFolder(folder: string, entries: Record<string, string[]>) {
  const root = path.resolve(folder);
  const files = wildcardExportFiles(entries);
  for (const file of files) {
    const target = path.resolve(root, ...file.path.split('/'));
    if (!target.startsWith(root + path.sep)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.text, 'utf8');
  }
  return { folder: root, files: files.length };
}

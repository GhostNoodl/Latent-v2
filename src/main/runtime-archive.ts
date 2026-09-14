import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';
import { containedPath } from './runtime-config';

export function sha256File(filename: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filename);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export async function extractRuntimeZip(archive: string, destination: string, prefix = ''): Promise<void> {
  const zip = new AdmZip(archive);
  const entries = zip.getEntries();
  const planned: { entry: (typeof entries)[number]; target: string }[] = [];
  const rejectLinkedAncestors = async (target: string) => {
    for (let cursor = path.resolve(target); ; cursor = path.dirname(cursor)) {
      try { if ((await fs.promises.lstat(cursor)).isSymbolicLink()) throw new Error('Runtime extraction path contains a symbolic link or junction.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (cursor === path.dirname(cursor)) break;
    }
  };
  let expandedBytes = 0;
  for (const entry of entries) {
    const archiveName = entry.entryName.replaceAll('\\', '/');
    if (archiveName.startsWith('/') || archiveName.split('/').includes('..') || archiveName.includes(':')) throw new Error('Unsafe path in runtime archive.');
    if (prefix && !archiveName.startsWith(prefix)) throw new Error('Unexpected root in runtime archive.');
    const name = prefix ? archiveName.slice(prefix.length) : archiveName;
    if (!name) continue;
    // Unix symbolic links cannot redirect subsequent writes outside the managed directory.
    if (((entry.attr >>> 16) & 0xf000) === 0xa000) throw new Error('Runtime archive contains a symbolic link.');
    const target = containedPath(destination, path.join(destination, name));
    if (!entry.isDirectory) {
      if (!Number.isSafeInteger(entry.header.size) || entry.header.size < 0 || !Number.isSafeInteger(expandedBytes + entry.header.size)) throw new Error('Runtime archive has an invalid expanded size.');
      expandedBytes += entry.header.size;
    }
    planned.push({ entry, target });
  }
  // Cached downloads still need room for their expanded contents. Validate
  // every path and check capacity before creating any extracted files.
  if (planned.length) {
    let volumePath = path.resolve(destination);
    while (true) {
      try {
        const free = await fs.promises.statfs(volumePath);
        if (free.bavail * free.bsize < expandedBytes + 256 * 1024 * 1024) throw new Error('Not enough free space to extract the setup archive. Free space and retry; the archive and existing installation are preserved.');
        break;
      } catch (error) {
        const parent = path.dirname(volumePath);
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === volumePath) throw error;
        volumePath = parent;
      }
    }
  }
  for (const { target } of planned) await rejectLinkedAncestors(target);
  for (const { entry, target } of planned) {
    await rejectLinkedAncestors(target);
    if (entry.isDirectory) await fs.promises.mkdir(target, { recursive: true });
    else {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, entry.getData(), { flag: 'wx' });
    }
  }
}

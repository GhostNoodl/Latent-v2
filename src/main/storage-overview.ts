import { storageBoundary } from './storage-locations';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AppPaths, DownloadStatus } from '../shared/types';
import type { DownloadStorageSnapshot, PackageStorageSnapshot, StorageArea, StorageCounts, StorageDestination, StorageOverviewSnapshot, StoragePackage, StorageVolume } from '../shared/storage-types';
import type { StorageArtifactDefinition, StoragePackageDefinition } from './storage-catalog';
import { inside } from './paths';

const emptyCounts = (): StorageCounts => ({ savedBytes: 0, cacheBytes: 0, resumablePartialBytes: 0, otherPartialBytes: 0, stagingBytes: 0, fileCount: 0 });
type CountsKey = Exclude<keyof StorageCounts, 'fileCount'>;
interface FileStat { size: number; identity: string; device: string; links: number; mtimeNs: bigint; ctimeNs: bigint; }
export interface StorageOverviewOptions {
  catalog: () => readonly StoragePackageDefinition[];
  transfers?: () => readonly DownloadStatus[];
  limits?: { maxEntries?: number; maxDepth?: number; maxDurationMs?: number };
}
export class StorageOverviewService {
  private pending?: Promise<StorageOverviewSnapshot>;
  private latest?: StorageOverviewSnapshot;
  constructor(private paths: AppPaths, private options: StorageOverviewOptions) { this.assertPrivate(paths.root); }
  async packageStorage(packageId: string): Promise<PackageStorageSnapshot> {
    if (!/^[a-z0-9-]{1,80}$/.test(packageId)) throw new Error('Choose a reviewed workflow package.');
    const result = await this.measure(packageId);
    return { measuredAt: result.measuredAt, durationMs: result.durationMs, package: result.packages[0], destinations: result.destinations, volumes: result.volumes, warnings: result.warnings };
  }
  async downloadCapacity(): Promise<DownloadStorageSnapshot> {
    const destinations: StorageDestination[] = [], volumes = new Map<string, StorageVolume>();
    const modelDownloadDestinations = { checkpoint: '', lora: '' };
    for (const [kind, folder] of [['checkpoint', 'checkpoints'], ['lora', 'loras']] as const) {
      const filename = path.join(this.paths.models, folder);
      const id = `directory:${createHash('sha256').update(this.key(filename)).digest('hex').slice(0, 24)}`;
      const destination: StorageDestination = { id, path: filename, label: kind === 'lora' ? 'LoRA downloads' : 'Checkpoint downloads' };
      destinations.push(destination); modelDownloadDestinations[kind] = id;
      try {
        let nearest = filename;
        while (true) {
          this.assertPrivate(nearest);
          try { if (!(await fs.promises.lstat(nearest)).isDirectory()) throw new Error('The model download destination is not a directory.'); break; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; nearest = path.dirname(nearest); }
        }
        const stat = await fs.promises.lstat(nearest, { bigint: true });
        const volumeId = `volume:${stat.dev}`; destination.volumeId = volumeId;
        if (!volumes.has(volumeId)) {
          const space = await fs.promises.statfs(nearest), availableBytes = space.bavail * space.bsize, totalBytes = space.blocks * space.bsize;
          volumes.set(volumeId, { id: volumeId, path: path.parse(nearest).root,
            availableBytes: Number.isSafeInteger(availableBytes) && availableBytes >= 0 ? availableBytes : undefined,
            totalBytes: Number.isSafeInteger(totalBytes) && totalBytes >= 0 ? totalBytes : undefined,
            uniqueLogicalBytes: 0, knownPayloadBytes: 0, minimumDownloadBytes: 0, unverifiedPresentBytes: 0 });
        }
      } catch {
        const volumeId = `unavailable:${kind}`; destination.volumeId = volumeId;
        volumes.set(volumeId, { id: volumeId, path: filename, uniqueLogicalBytes: 0, knownPayloadBytes: 0, minimumDownloadBytes: 0, unverifiedPresentBytes: 0,
          error: 'Available space could not be checked for this private model folder. Check folder access and refresh.' });
      }
    }
    return { measuredAt: new Date().toISOString(), modelDownloadDestinations, destinations, volumes: [...volumes.values()] };
  }
  private key(filename: string) { const resolved = path.resolve(filename); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
  private assertPrivate(filename: string) {
    if (!path.isAbsolute(filename) || filename.includes('\0') || !inside(storageBoundary(this.paths, filename), filename) || filename.split(/[\\/]/).includes('..')) throw new Error('Storage inspection is limited to this studio’s private paths.');
    let cursor = path.resolve(filename);
    while (true) {
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Storage inspection does not follow symbolic links or junctions.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  }
  private async fileStat(filename: string): Promise<FileStat | undefined> {
    this.assertPrivate(filename);
    try {
      const stat = await fs.promises.lstat(filename, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
      if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('A file exceeds the supported storage measurement range.');
      return { size: Number(stat.size), identity: `${stat.dev}:${stat.ino}`, device: String(stat.dev), links: Number(stat.nlink), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async manifest(filename: string): Promise<Record<string, unknown> | undefined> {
    const stat = await this.fileStat(filename); if (!stat || stat.links !== 1 || !stat.size || stat.size > 16384) return undefined;
    const handle = await fs.promises.open(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat({ bigint: true }); if (`${opened.dev}:${opened.ino}` !== stat.identity || Number(opened.size) !== stat.size || opened.nlink !== 1n) return undefined;
      const bytes = Buffer.alloc(stat.size + 1); const read = await handle.read(bytes, 0, bytes.length, 0);
      const after = await this.fileStat(filename);
      if (read.bytesRead !== stat.size || !after || after.identity !== stat.identity || after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) return undefined;
      const parsed: unknown = JSON.parse(bytes.subarray(0, stat.size).toString('utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch { return undefined; } finally { await handle.close(); }
  }
  private matchingPartial(metadata: Record<string, unknown> | undefined, size: number, expected?: StorageArtifactDefinition) {
    if (!metadata || size < 1) return false;
    let publicSource = false;
    try { publicSource = typeof metadata.url === 'string' && new URL(metadata.url).protocol === 'https:'; } catch { /* Malformed legacy source. */ }
    const privateSource = typeof metadata.sourceIdentity === 'string' && /^[a-f0-9]{64}$/.test(metadata.sourceIdentity);
    if (!publicSource && !privateSource) return false;
    const total = metadata.bytes ?? metadata.totalBytes;
    if (!Number.isSafeInteger(total) || Number(total) < size || Number(total) < 1) return false;
    if (expected) return publicSource && metadata.url === expected.url && metadata.sha256 === expected.sha256 && total === expected.bytes;
    // General model resumes require a server validator. Pinned artifact manifests carry exact size/hash.
    const pinned = typeof metadata.sha256 === 'string' && /^[a-f0-9]{64}$/.test(metadata.sha256) && metadata.bytes === total;
    const etag = typeof metadata.etag === 'string' && /^"[^"\r\n]+"$/.test(metadata.etag);
    const modified = typeof metadata.lastModified === 'string' && Number.isFinite(Date.parse(metadata.lastModified));
    // Generic transfers deliberately omit their URL. A source digest identifies
    // their request, but only a server validator makes that partial resumable.
    return (publicSource && pinned) || etag || modified;
  }
  refresh(): Promise<StorageOverviewSnapshot> {
    if (this.pending) return this.pending.then(value => structuredClone(value));
    this.pending = this.measure().then(value => { this.latest = value; return value; }).finally(() => { this.pending = undefined; });
    return this.pending.then(value => structuredClone(value));
  }
  /** Reveal only IDs emitted by this service; use the nearest existing private directory. */
  async destination(id: string): Promise<string> {
    const destination = this.latest?.destinations.find(item => item.id === id);
    if (!destination) throw new Error('Refresh storage and choose a listed destination.');
    let current = destination.path;
    while (true) {
      this.assertPrivate(current);
      try { const stat = await fs.promises.lstat(current); if (!stat.isDirectory()) throw new Error('This storage destination is not a folder.'); return current; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const parent = path.dirname(current); if (parent === current || !inside(storageBoundary(this.paths, destination.path), parent)) throw new Error('The storage destination is unavailable.'); current = parent;
    }
  }
  private async measure(packageId?: string): Promise<StorageOverviewSnapshot> {
    this.assertPrivate(this.paths.root); const start = Date.now(); const startedAt = new Date().toISOString();
    const limit = (value: number | undefined, fallback: number, maximum: number) => { if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('Storage scan limits must be positive finite integers.'); return Math.min(maximum, value ?? fallback); };
    const maxEntries = limit(this.options.limits?.maxEntries, 200000, 200000); const maxDepth = limit(this.options.limits?.maxDepth, 32, 32); const maxDuration = limit(this.options.limits?.maxDurationMs, 30000, 30000);
    const catalog = structuredClone(this.options.catalog()); if (catalog.length > 40 || new Set(catalog.map(item => item.id)).size !== catalog.length) throw new Error('The storage package catalog is invalid.');
    const definitions = packageId ? catalog.filter(item => item.id === packageId) : catalog;
    if (packageId && definitions.length !== 1) throw new Error('Choose a reviewed workflow package.');
    for (const item of definitions) {
      if (!/^[a-z0-9-]{1,80}$/.test(item.id) || item.artifacts.length > 300 || item.destinations.length > 30) throw new Error('The storage package catalog exceeds its bounds.');
      for (const filename of [...item.destinations, ...item.artifacts.flatMap(asset => [asset.downloadPath, ...asset.candidatePaths])]) this.assertPrivate(filename);
      for (const asset of item.artifacts) if (!Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || !/^[a-f0-9]{64}$/.test(asset.sha256) || new URL(asset.url).protocol !== 'https:') throw new Error('The storage catalog contains an invalid pinned asset.');
    }
    const destinations = new Map<string, StorageDestination>(); const volumeMap = new Map<string, StorageVolume>();
    const destinationId = (filename: string, label: string) => {
      this.assertPrivate(filename); const id = `directory:${createHash('sha256').update(this.key(filename)).digest('hex').slice(0, 24)}`;
      if (!destinations.has(id)) destinations.set(id, { id, path: path.resolve(filename), label }); return id;
    };
    const modelDownloadDestinations = packageId ? undefined : {
      checkpoint: destinationId(path.join(this.paths.models, 'checkpoints'), 'Checkpoint downloads'),
      lora: destinationId(path.join(this.paths.models, 'loras'), 'LoRA downloads'),
    };
    const areaDefinitions = (packageId ? [] : [
      { id: 'models', label: 'Models', path: this.paths.models }, { id: 'outputs', label: 'Saved generations', path: this.paths.outputs }, { id: 'inputs', label: 'Sources and masks', path: this.paths.inputs },
      { id: 'runtime', label: 'Private runtimes', path: this.paths.runtime }, { id: 'cache', label: 'Download and runtime cache', path: this.paths.cache }, { id: 'temp', label: 'Temporary files', path: this.paths.temp },
      { id: 'custom-nodes', label: 'Reviewed custom nodes', path: path.join(this.paths.root, 'custom_nodes') }, { id: 'logs', label: 'Logs', path: this.paths.logs }, { id: 'user', label: 'Engine user files', path: this.paths.user }, { id: 'other', label: 'Studio metadata and other files', path: this.paths.root },
    ]).sort((a, b) => b.path.length - a.path.length);
    const areas: StorageArea[] = areaDefinitions.map(area => ({ id: area.id, label: area.label, destinationId: destinationId(area.path, area.label), ...emptyCounts() }));
    const byArea = new Map(areas.map(area => [area.id, area])); const observed = new Map<string, { filename: string; stat: FileStat; areaId: string }>();
    let complete = true; let scannedEntries = 0; let skippedLinks = 0; let unreadableEntries = 0; const warnings: string[] = [];
    const warn = (message: string) => { complete = false; if (!warnings.includes(message) && warnings.length < 20) warnings.push(message); };
    const canonicalRoot = await fs.promises.realpath(this.paths.root);
    const queue = packageId ? [] : [{ directory: this.paths.root, depth: 0 }]; let position = 0;
    while (position < queue.length) {
      if (scannedEntries >= maxEntries || Date.now() - start >= maxDuration) { warn('The bounded scan stopped before every file was counted. Folder totals are lower bounds.'); break; }
      const { directory, depth } = queue[position++];
      try {
        this.assertPrivate(directory); const before = await fs.promises.lstat(directory, { bigint: true }); const canonical = await fs.promises.realpath(directory);
        if (!inside(canonicalRoot, canonical)) { skippedLinks++; warn('A redirected directory was excluded.'); continue; }
        const handle = await fs.promises.opendir(directory);
        // Bound filesystem work while avoiding one round trip per runtime file.
        // Keep directories sequential so each retains its containment/identity checks.
        let batch: string[] = [];
        const inspectBatch = async () => {
          const filenames = batch; batch = [];
          const results = await Promise.allSettled(filenames.map(filename => fs.promises.lstat(filename, { bigint: true })));
          for (let index = 0; index < results.length; index++) {
            const filename = filenames[index]; const result = results[index];
            if (result.status === 'rejected') { unreadableEntries++; warn('Some files changed or could not be read during the scan.'); continue; }
            const stat = result.value;
            if (stat.isSymbolicLink()) { skippedLinks++; warn('Symbolic links and junctions were excluded; external model directories were not scanned.'); continue; }
            if (stat.isDirectory()) { if (depth + 1 <= maxDepth) queue.push({ directory: filename, depth: depth + 1 }); else warn('A directory exceeded the scan depth limit.'); }
            else if (stat.isFile() && stat.size <= BigInt(Number.MAX_SAFE_INTEGER)) {
              const areaId = areaDefinitions.find(area => inside(area.path, filename))!.id;
              observed.set(this.key(filename), { filename, areaId, stat: { size: Number(stat.size), identity: `${stat.dev}:${stat.ino}`, device: String(stat.dev), links: Number(stat.nlink), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs } });
            } else { unreadableEntries++; warn('Some entries were not ordinary measurable files.'); }
          }
        };
        try {
          for await (const entry of handle) {
            if (scannedEntries >= maxEntries || Date.now() - start >= maxDuration) { warn('The bounded scan stopped before every file was counted. Folder totals are lower bounds.'); break; }
            scannedEntries++; batch.push(path.join(directory, entry.name));
            if (batch.length === 16) await inspectBatch();
          }
        } finally { if (batch.length) await inspectBatch(); }
        this.assertPrivate(directory); const after = await fs.promises.lstat(directory, { bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino) warn('A directory changed during the scan; refresh after active installation finishes.');
      } catch { unreadableEntries++; warn('Some private directories were unreadable or changed during the scan.'); }
    }
    const expectedByPartial = new Map<string, StorageArtifactDefinition>();
    for (const definition of definitions) for (const asset of definition.artifacts) expectedByPartial.set(this.key(`${asset.downloadPath}.part`), asset);
    const partials = new Map<string, { bytes: number; resumable: boolean }>();
    let metadataReads = 0;
    for (const [key, file] of observed) if (file.filename.endsWith('.part')) {
      let metadata: Record<string, unknown> | undefined;
      try { if (++metadataReads <= 2000) metadata = await this.manifest(`${file.filename}.json`); else warn('Some partial-download metadata exceeded the inspection limit.'); } catch { /* Retain as an unclassified partial. */ }
      partials.set(key, { bytes: file.stat.size, resumable: file.stat.links === 1 && this.matchingPartial(metadata, file.stat.size, expectedByPartial.get(key)) });
    }
    const uniqueFiles = new Map<string, { size: number; device: string }>(); const totals = emptyCounts();
    for (const [key, file] of observed) {
      const relative = path.relative(this.paths.root, file.filename).replaceAll('\\', '/'); const partial = partials.get(key);
      let kind: CountsKey = file.areaId === 'cache' ? 'cacheBytes' : 'savedBytes';
      if (partial) kind = partial.resumable ? 'resumablePartialBytes' : 'otherPartialBytes';
      else if (/\.part(?:\.|$)/i.test(relative)) kind = 'otherPartialBytes';
      else if (file.areaId === 'temp' || /(?:^|\/)[^/]*(?:-stage-|\.previous-|\.invalid-|\.tmp(?:\.|$))/.test(relative)) kind = 'stagingBytes';
      const area = byArea.get(file.areaId)!; area[kind] += file.stat.size; area.fileCount++; totals[kind] += file.stat.size; totals.fileCount++;
      if (!uniqueFiles.has(file.stat.identity)) uniqueFiles.set(file.stat.identity, { size: file.stat.size, device: file.stat.device });
    }
    const statCache = new Map<string, Promise<FileStat | undefined>>();
    const checkedStat = (filename: string) => {
      const key = this.key(filename);
      if (!statCache.has(key)) statCache.set(key, this.fileStat(filename).then(stat => {
        const earlier = observed.get(key)?.stat;
        if (earlier && (!stat || earlier.size !== stat.size || earlier.mtimeNs !== stat.mtimeNs || earlier.identity !== stat.identity)) warn('Files changed while measuring; live download counts may be newer than folder totals.');
        return stat;
      }));
      return statCache.get(key)!;
    };
    const packageResults: StoragePackage[] = []; const assetResults: Array<{ identity: string; destinationId: string; bytes: number; present: number; remaining: number }> = [];
    for (const definition of definitions) {
      const result: StoragePackage = { id: definition.id, name: definition.name, state: definition.state, message: definition.message, progress: definition.progress, destinationIds: definition.destinations.map(destination => destinationId(destination, definition.name)), dependencies: definition.dependencies, knownPayloadBytes: 0, presentCandidateBytes: 0, resumableBytes: 0, minimumDownloadBytes: 0, unknownRequirements: definition.unknownRequirements, warnings: [] };
      const seen = new Set<string>();
      for (const asset of definition.artifacts) {
        const identity = `${asset.sha256}:${asset.bytes}`; if (seen.has(identity)) continue; seen.add(identity); result.knownPayloadBytes += asset.bytes;
        let present = 0; let partialBytes = 0;
        for (const candidate of asset.candidatePaths) try { const stat = await checkedStat(candidate); if (stat?.size === asset.bytes) present = asset.bytes; else if (stat) result.warnings.push(`${asset.filename}: existing file size differs from the pinned asset; it was preserved.`); } catch { result.warnings.push(`${asset.filename}: a candidate path could not be safely inspected.`); }
        if (!present) try {
          const partial = await checkedStat(`${asset.downloadPath}.part`);
          if (partial && partial.links === 1 && this.matchingPartial(await this.manifest(`${asset.downloadPath}.part.json`), partial.size, asset)) partialBytes = partial.size;
        } catch { result.warnings.push(`${asset.filename}: partial resume state is unavailable.`); }
        const remaining = Math.max(0, asset.bytes - present - partialBytes); result.presentCandidateBytes += present; result.resumableBytes += partialBytes; result.minimumDownloadBytes += remaining;
        assetResults.push({ identity, destinationId: destinationId(path.dirname(asset.downloadPath), definition.name), bytes: asset.bytes, present, remaining });
      }
      packageResults.push(result);
    }
    const transfers = structuredClone(packageId ? [] : this.options.transfers?.() ?? []).slice(0, 200).map(transfer => {
      const candidates = new Set<string>();
      for (const file of observed.values()) if (path.basename(file.filename) === transfer.name || path.basename(file.filename) === `${transfer.name}.part`) candidates.add(path.dirname(file.filename));
      const managedDestination = transfer.modelKind === 'checkpoint' ? path.join(this.paths.models, 'checkpoints') : transfer.modelKind === 'lora' ? path.join(this.paths.models, 'loras') : undefined;
      // Only accept a main-owned destination that exactly matches a managed kind.
      // Arbitrary supplied paths never become reveal targets, even inside the root.
      const declaredDestination = managedDestination && transfer.destinationDirectory && path.resolve(transfer.destinationDirectory) === path.resolve(managedDestination) ? managedDestination : undefined;
      const destination = declaredDestination ?? (candidates.size === 1 ? [...candidates][0] : undefined);
      const receivedBytes = Number.isFinite(transfer.receivedBytes) && transfer.receivedBytes >= 0 ? transfer.receivedBytes : 0;
      const totalBytes = Number.isFinite(transfer.totalBytes) && transfer.totalBytes > 0 ? transfer.totalBytes : undefined;
      return { id: transfer.id, name: transfer.name, state: transfer.state, receivedBytes, totalBytes, remainingBytes: totalBytes === undefined ? undefined : Math.max(0, totalBytes - receivedBytes), destinationId: destination ? destinationId(destination, transfer.name) : undefined, error: transfer.error };
    });
    for (const destination of destinations.values()) {
      let nearest = destination.path;
      try {
        while (true) { this.assertPrivate(nearest); try { await fs.promises.lstat(nearest); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; nearest = path.dirname(nearest); } }
        const stat = await fs.promises.lstat(nearest, { bigint: true }); const volumeId = `volume:${stat.dev}`; destination.volumeId = volumeId;
        if (!volumeMap.has(volumeId)) {
          const space = await fs.promises.statfs(nearest); const availableBytes = space.bavail * space.bsize; const totalBytes = space.blocks * space.bsize;
          volumeMap.set(volumeId, { id: volumeId, path: path.parse(nearest).root, availableBytes: Number.isSafeInteger(availableBytes) ? availableBytes : undefined, totalBytes: Number.isSafeInteger(totalBytes) ? totalBytes : undefined, uniqueLogicalBytes: 0, knownPayloadBytes: 0, minimumDownloadBytes: 0, unverifiedPresentBytes: 0 });
        }
      } catch { warn('Available space could not be read for one or more private destinations.'); }
    }
    for (const file of uniqueFiles.values()) { const volume = volumeMap.get(`volume:${file.device}`); if (volume) volume.uniqueLogicalBytes += file.size; }
    const union = new Map<string, typeof assetResults[number]>();
    for (const asset of assetResults) {
      const volumeId = destinations.get(asset.destinationId)?.volumeId; if (!volumeId) continue; const key = `${volumeId}:${asset.identity}`; const prior = union.get(key);
      if (!prior || asset.remaining < prior.remaining) union.set(key, asset);
    }
    for (const asset of union.values()) { const volumeId = destinations.get(asset.destinationId)?.volumeId; const volume = volumeId && volumeMap.get(volumeId); if (volume) { volume.knownPayloadBytes += asset.bytes; volume.minimumDownloadBytes += asset.remaining; volume.unverifiedPresentBytes += asset.present; } }
    return { version: 1, modelDownloadDestinations, measuredAt: startedAt, durationMs: Date.now() - start, complete, scannedEntries, skippedLinks, unreadableEntries, warnings, totals, uniqueLogicalBytes: [...uniqueFiles.values()].reduce((sum, file) => sum + file.size, 0), destinations: [...destinations.values()], areas, volumes: [...volumeMap.values()], packages: packageResults, transfers };
  }
}


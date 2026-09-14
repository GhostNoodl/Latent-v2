import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import type { AppPaths } from '../shared/types';
import { activeRegionalPromptRegions, regionalMaskAssetSchema, regionalPromptSettingsSchema, type RegionalMaskAsset, type RegionalPromptRegion, type RegionalPromptSettings } from '../shared/regional-prompt-types';
import { rasterizeRegionalMask, type RegionalCanvas } from '../shared/regional-prompt-workflow';
import { containedPath, inside } from './paths';

/** Source-independent immutable inputs. Call prepare only on explicit save/submit. */
export class RegionalMaskService {
  constructor(private paths: AppPaths) {}
  private async directory(create: boolean) {
    const root = path.resolve(this.paths.root); const inputs = path.resolve(this.paths.inputs);
    if (!inside(root, inputs) || inputs === root) throw new Error('Regional masks must stay within this studio inputs directory.');
    const directory = containedPath(inputs, 'regional-masks');
    const segments = path.relative(root, directory).split(path.sep); let current = root;
    const rootStat = await fs.lstat(root); if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Regional mask paths cannot use symbolic links or junctions.');
    for (const segment of segments) {
      current = path.join(current, segment);
      if (create) await fs.mkdir(current).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Regional mask paths cannot use symbolic links or junctions.');
    }
    if (!inside(await fs.realpath(root), await fs.realpath(directory))) throw new Error('Regional masks resolve outside this studio.');
    return directory;
  }
  async verify(assetInput: RegionalMaskAsset, region?: RegionalPromptRegion, dimensions?: RegionalCanvas): Promise<string> {
    const asset = regionalMaskAssetSchema.parse(assetInput); const directory = await this.directory(false);
    const filename = containedPath(directory, path.basename(asset.filename)); const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 24 * 1024 * 1024 || stat.size < 24) throw new Error('The retained regional mask is not a safe complete PNG.');
    const bytes = await fs.readFile(filename);
    if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256) throw new Error('The retained regional mask PNG changed. Restore its original file before reuse.');
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== asset.width || bytes.readUInt32BE(20) !== asset.height) throw new Error('The retained regional mask dimensions changed.');
    const decoded = PNG.sync.read(bytes, { checkCRC: true }); const red = Buffer.alloc(asset.width * asset.height);
    for (let index = 0; index < red.length; index++) {
      red[index] = decoded.data[index * 4];
      if (decoded.data[index * 4 + 1] !== red[index] || decoded.data[index * 4 + 2] !== red[index] || decoded.data[index * 4 + 3] !== 255) throw new Error('The retained regional mask is not an opaque grayscale asset.');
    }
    if (createHash('sha256').update(red).digest('hex') !== asset.rawMaskSha256) throw new Error('The retained regional mask pixels changed.');
    if (region || dimensions) {
      if (!region || !dimensions || region.id !== asset.regionId || dimensions.width !== asset.width || dimensions.height !== asset.height) throw new Error('The retained regional mask has a different region or canvas identity.');
      if ((await rasterizeRegionalMask(region, dimensions)).rawMaskSha256 !== asset.rawMaskSha256) throw new Error('The retained regional mask differs from its rectangle or feather settings.');
    }
    return filename;
  }
  async prepare(input: RegionalPromptSettings, dimensions: RegionalCanvas, frozenAssets?: RegionalMaskAsset[]): Promise<RegionalMaskAsset[]> {
    const settings = regionalPromptSettingsSchema.parse(input); const regions = activeRegionalPromptRegions(settings);
    if (settings.enabled && !regions.length) throw new Error('Enter text in at least one active region before saving regional masks.');
    if (frozenAssets) {
      const assets = frozenAssets.map(asset => regionalMaskAssetSchema.parse(asset));
      if (assets.length !== regions.length || new Set(assets.map(asset => asset.regionId)).size !== assets.length) throw new Error('The saved regional masks do not match this layout.');
      const result: RegionalMaskAsset[] = [];
      for (const region of regions) {
        const asset = assets.find(item => item.regionId === region.id); if (!asset) throw new Error(`The saved mask for ${region.name} is missing.`);
        await this.verify(asset, region, dimensions); result.push(asset);
      }
      return structuredClone(result);
    }
    if (!regions.length) return [];
    const directory = await this.directory(true); const result: RegionalMaskAsset[] = [];
    for (const region of regions) {
      const raster = await rasterizeRegionalMask(region, dimensions); const png = new PNG({ width: dimensions.width, height: dimensions.height });
      for (let index = 0; index < raster.pixels.length; index++) { const value = raster.pixels[index]; png.data.set([value, value, value, 255], index * 4); }
      const bytes = PNG.sync.write(png); const sha256 = createHash('sha256').update(bytes).digest('hex');
      const asset = regionalMaskAssetSchema.parse({ regionId: region.id, filename: `regional-masks/${sha256}.png`, sha256, rawMaskSha256: raster.rawMaskSha256, width: dimensions.width, height: dimensions.height, channel: 'red', encoding: 'png-u8-red@1' });
      const destination = containedPath(directory, `${sha256}.png`); const staging = containedPath(directory, `.pending-${randomUUID()}.png`);
      const handle = await fs.open(staging, 'wx', 0o600);
      try {
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await this.directory(false);
        // Hardlink publication is exclusive: existing assets are never replaced.
        await fs.link(staging, destination).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      } finally { await fs.unlink(staging); }
      await this.verify(asset, region, dimensions); result.push(asset);
    }
    return result;
  }
}

import { dialog } from 'electron';
import { z } from 'zod';
import type { HandlerContext, StudioMethods } from '../main';

/** Source images and mask suggestions. */
export function assistantSourcesHandlers(ctx: HandlerContext) {
  return {
    setupSegmentation: async repair => ctx.segmentation.setup(z.boolean().optional().parse(repair) ?? false),
    startSegmentation: async () => ctx.segmentation.start(),
    stopSegmentation: async () => ctx.segmentation.stop(),
    suggestMask: async request => ctx.segmentation.suggest(request),
    cancelSegmentation: async () => ctx.segmentation.cancel(),
    importSourceImage: async () => {
      const result = await dialog.showOpenDialog(ctx.window!, {
        title: 'Choose a source image',
        properties: ['openFile'],
        filters: [{ name: 'Still images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      const source = await ctx.sources.importFile(result.filePaths[0]);
      ctx.broadcast();
      return source;
    },
    importDroppedImage: async (bytes, name) => {
      const source = await ctx.sources.importBytes(bytes, name);
      ctx.broadcast();
      return source;
    },
    importLiveSketch: async bytes => ctx.sources.importLiveSketch(bytes),
    discardLiveSketches: async ids => {
      const removed = await ctx.sources.discardLiveSketches(ids);
      if (removed) ctx.broadcast();
      return removed;
    },
    useOutputAsSource: async recordId => {
      const source = await ctx.sources.importFile(await ctx.outputPath(ctx.id.parse(recordId)), recordId);
      ctx.broadcast();
      return source;
    },
    saveSourceMask: async (sourceId, bytes, options) => {
      const mask = await ctx.sources.saveMask(ctx.id.parse(sourceId), bytes, options);
      ctx.broadcast();
      return mask;
    },
  } satisfies Partial<StudioMethods>;
}

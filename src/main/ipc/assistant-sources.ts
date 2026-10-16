import { dialog } from 'electron';
import { z } from 'zod';
import { assistantConversationSchema } from '../../shared/assistant-conversation';
import type { HandlerContext, StudioMethods } from '../main';

/** Source images, mask suggestions and the prompt assistant. */
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
    setupAssistant: async repair => ctx.assistant.setup(z.boolean().optional().parse(repair) ?? false),
    startAssistant: async () => ctx.assistant.start(),
    stopAssistant: async () => ctx.assistant.stop(),
    suggestPrompt: async request => ctx.assistant.suggest(request),
    cancelAssistant: async () => ctx.assistant.cancel(),
    getAssistantConversation: async target => {
      const scope = z.enum(['image', 'video']).optional().parse(target);
      const saved = ctx.store.getState(
        scope === 'video' ? 'ctx.assistant.video.conversation' : 'ctx.assistant.conversation',
        null,
      );
      return saved ? assistantConversationSchema.parse(saved) : null;
    },
    saveAssistantConversation: async (value, target) => {
      const scope = z.enum(['image', 'video']).optional().parse(target);
      ctx.store.setState(
        scope === 'video' ? 'ctx.assistant.video.conversation' : 'ctx.assistant.conversation',
        assistantConversationSchema.parse(value),
      );
    },
  } satisfies Partial<StudioMethods>;
}

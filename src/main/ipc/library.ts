import { dialog, shell } from 'electron';
import { z } from 'zod';
import { modelTransferNeedsAttention } from '../model-transfer-notifications';
import type { HandlerContext, StudioMethods } from '../main';

/** Model library: folders, external roots, collections and Civitai. */
export function libraryHandlers(ctx: HandlerContext) {
  return {
    chooseExternalModelRoot: async input => {
      const kind = z.enum(['checkpoint', 'lora']).parse(input);
      const blocked = ctx.modelChangeBlockedReason();
      if (blocked) throw new Error(blocked);
      const result = await dialog.showOpenDialog(ctx.window!, {
        title: `Use an existing ${kind === 'lora' ? 'LoRA' : 'checkpoint'} folder read-only`,
        properties: ['openDirectory'],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      await ctx.changeModelFiles(() => ctx.modelLocations.registerExternalRoot(kind, result.filePaths[0]));
      void ctx.civitai.autoMetadata();
      ctx.broadcast();
      return ctx.modelLocations.snapshot();
    },
    unregisterExternalModelRoot: async rootId => {
      await ctx.changeModelFiles(() => ctx.modelLocations.unregisterExternalRoot(ctx.id.parse(rootId)));
      void ctx.civitai.autoMetadata();
      ctx.broadcast();
      return ctx.modelLocations.snapshot();
    },
    createModelFolder: async request => {
      await ctx.changeModelFiles(() => ctx.modelLocations.createFolder(request));
      void ctx.civitai.autoMetadata();
      ctx.broadcast();
      return ctx.modelLocations.snapshot();
    },
    deleteModel: async request => {
      await ctx.changeModelFiles(() => ctx.modelLocations.deleteModel(request, filename => shell.trashItem(filename)));
      ctx.broadcast();
      return ctx.snapshot();
    },
    moveModel: async request => {
      await ctx.changeModelFiles(() => ctx.modelLocations.moveModel(request));
      void ctx.civitai.autoMetadata();
      ctx.broadcast();
      return ctx.modelLocations.snapshot();
    },
    recoverModelLocations: async () => {
      await ctx.changeModelFiles(() => ctx.modelLocations.recover());
      void ctx.civitai.autoMetadata();
      ctx.broadcast();
      return ctx.modelLocations.snapshot();
    },
    createCollection: async (kind, name) => ctx.collections.create(kind, name),
    renameCollection: async (collectionId, name) => ctx.collections.rename(collectionId, name),
    removeCollection: async collectionId => ctx.collections.remove(collectionId),
    addCollectionMembers: async (collectionId, memberIds) => ctx.collections.addMembers(collectionId, memberIds),
    removeCollectionMembers: async (collectionId, memberIds) => ctx.collections.removeMembers(collectionId, memberIds),
    saveWildcards: entries => ctx.wildcards.save(entries),
    fetchModelCivitaiMetadata: async modelId => {
      await ctx.civitai.fetchLocalMetadata(z.string().max(1000).parse(modelId));
      return ctx.snapshot();
    },
    civitaiSearch: async request => ctx.civitai.search(request),
    civitaiDetail: async modelId => ctx.civitai.detail(modelId),
    civitaiFindByHash: async sha256 => ctx.civitai.findByHash(sha256),
    civitaiDownload: async request => {
      try {
        const asset = await ctx.civitai.download(request);
        ctx.notify('notifyDownload', 'Model ready', asset.name);
        void ctx.civitai.autoMetadata();
        return asset;
      } catch (error) {
        if (modelTransferNeedsAttention(error))
          ctx.notify('notifyError', 'Model download needs attention', ctx.errorMessage(error));
        throw error;
      }
    },
    cancelCivitai: async () => ctx.civitai.cancel(),
    getCivitaiSettings: async () => ctx.civitai.settings(),
    setCivitaiKey: async value => {
      ctx.civitai.setApiKey(value);
    },
    openCivitaiModel: async (modelId, versionId) => {
      const url = new URL(`https://civitai.com/models/${z.number().int().positive().parse(modelId)}`);
      if (versionId !== undefined)
        url.searchParams.set('modelVersionId', String(z.number().int().positive().parse(versionId)));
      await shell.openExternal(url.href);
    },
  } satisfies Partial<StudioMethods>;
}

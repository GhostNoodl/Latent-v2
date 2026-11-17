import { QWEN21_SET_ID } from '../../shared/qwen21-release';
import { IMAGE_MODELS, compareEngineVersions, imageModelIdSchema } from '../../shared/image-models';
import { IMAGE_MODELS_SET_ID, latestReviewedRuntimeSet, reviewedRuntimeSet } from '../reviewed-runtime-channel';
import { isQwen21Profile, qwenEditProfileSchema } from '../../shared/qwen-edit-types';
import { z } from 'zod';
import { shell } from 'electron';
import { activateIPAdapterWhenIdle } from '../ipadapter-lifecycle';
import { qwenConversationSchema } from '../../shared/qwen-conversation';
import type { HandlerContext, StudioMethods } from '../main';

/** Optional studio tools: face refinement, IPAdapter, Qwen editing, ControlNet and the upscaler. */
export function optionalToolsHandlers(ctx: HandlerContext) {
  return {
    setupFaceDetailer: async repair => ctx.faceDetailer.setup(z.boolean().optional().parse(repair) ?? false),
    cancelFaceDetailerSetup: async () => ctx.faceDetailer.cancelSetup(),
    detectFaces: async request => ctx.faceDetailer.detect(request),
    cancelFaceDetection: async () => ctx.faceDetailer.cancelDetection(),
    getFaceDetection: async detectionId => ctx.faceDetailer.getDetection(detectionId),
    getIPAdapterStatus: async () => ctx.ipAdapter.status(),
    stageIPAdapter: async repair => {
      const requested = z.boolean().optional().parse(repair) ?? false;
      if (!requested) {
        await ctx.ipAdapter.stage();
        return;
      }
      await ctx.models.library.withExclusive('repairing reference tools', async () => {
        ctx.assertModelLocationsReady();
        if (
          ctx.backend.status().state !== 'stopped' ||
          ctx.jobs.jobs().some(job => ['queued', 'running'].includes(job.status))
        )
          throw new Error('Stop the image engine and finish or cancel its queue before repairing reference tools.');
        await ctx.ipAdapter.stage(true);
      });
    },
    activateIPAdapter: async () => {
      await activateIPAdapterWhenIdle(
        ctx.models.library,
        ctx.backend,
        ctx.jobs,
        ctx.ipAdapter,
        ctx.assertModelLocationsReady,
      );
      ctx.broadcast();
    },
    cancelIPAdapterSetup: async () => ctx.ipAdapter.cancel(),
    getQwenConversation: async () => {
      const saved = ctx.store.getState('qwen.conversation', null);
      return saved ? qwenConversationSchema.parse(saved) : null;
    },
    saveQwenConversation: async value => {
      ctx.store.setState('qwen.conversation', qwenConversationSchema.parse(value));
    },
    setupQwenEdit: async (profile, repair) => {
      const selected = qwenEditProfileSchema.parse(profile);
      const requested = z.boolean().optional().parse(repair) ?? false;
      if (isQwen21Profile(selected)) {
        await ctx.runtimeUpdates.check();
        const current = ctx.runtimeUpdates.status().current?.setId;
        // Newer engines keep Qwen 2.1; only an older one moves to the Qwen 2.1 engine.
        if (!current || !reviewedRuntimeSet(current).mandatoryNodes.includes('TextEncodeQwenImage21')) {
          await ctx.runtimeUpdates.stage('update', QWEN21_SET_ID);
          await ctx.runtimeCoordinator.activateAndRecover(
            () => ctx.runtimeUpdates.activate(),
            () => ctx.runtimeUpdates.recover(),
          );
        }
      }
      if (selected === 'compact')
        await ctx.changeModelFiles(async () => {
          await ctx.qwenEdit.setup(selected, requested);
        });
      else if (requested)
        await ctx.jobs.withRuntimeMaintenance(
          async () => {
            await ctx.backendActivity.assertIdle('repair Qwen assets');
            if (ctx.backend.hasOwnedProcess()) throw new Error('Stop the image engine before repairing Qwen assets.');
            await ctx.qwenEdit.setup(selected, true);
          },
          { allowRetainedJobs: false },
        );
      else await ctx.qwenEdit.setup(selected);
    },
    setupImageModel: async id => {
      const model = IMAGE_MODELS[imageModelIdSchema.parse(id)];
      // Klein and MOSS need a newer engine: move to the latest reviewed one first (with rollback).
      const target = latestReviewedRuntimeSet();
      await ctx.runtimeUpdates.check();
      const current = ctx.runtimeUpdates.status().current?.setId;
      const engine = current ? reviewedRuntimeSet(current).backend.version : undefined;
      if (engine && compareEngineVersions(engine, model.minEngine) < 0) {
        if (target.id !== IMAGE_MODELS_SET_ID && compareEngineVersions(target.backend.version, model.minEngine) < 0)
          throw new Error(`${model.name} needs a newer engine than this app version includes.`);
        await ctx.runtimeUpdates.stage('update', target.id);
        await ctx.runtimeCoordinator.activateAndRecover(
          () => ctx.runtimeUpdates.activate(),
          () => ctx.runtimeUpdates.recover(),
        );
      }
      await ctx.imageModels.setup(model.id);
    },
    cancelImageModelSetup: async () => {
      ctx.imageModels.cancel();
    },
    openImageModelPage: async (id, page) => {
      const model = IMAGE_MODELS[imageModelIdSchema.parse(id)];
      const url = z.enum(['source', 'license']).parse(page) === 'license' ? model.license.url : model.guide.sourceUrl;
      if (!url.startsWith('https://huggingface.co/')) throw new Error('Unexpected model page.');
      await shell.openExternal(url);
    },
    cancelQwenEditSetup: async () => {
      ctx.qwenEdit.cancel();
    },
    enqueueQwenEdit: async request =>
      ctx.models.library.withShared('queuing an image edit', async () => {
        ctx.assertModelLocationsReady();
        return ctx.jobs.enqueueQwenEdit(request);
      }),
    setupControlNet: async repair => {
      const requested = z.boolean().optional().parse(repair) ?? false;
      if (requested)
        await ctx.jobs.withRuntimeMaintenance(
          async () => {
            await ctx.backendActivity.assertIdle('repair Canny ControlNet');
            await ctx.controlNet.setup(true);
          },
          { allowRetainedJobs: false },
        );
      else await ctx.controlNet.setup();
    },
    cancelControlNet: async () => ctx.controlNet.cancel(),
    setupUpscaler: async repair => {
      const requested = z.boolean().optional().parse(repair) ?? false;
      if (requested)
        await ctx.jobs.withRuntimeMaintenance(
          async () => {
            await ctx.backendActivity.assertIdle('repair the illustration upscaler');
            await ctx.upscaler.setup(true);
          },
          { allowRetainedJobs: false },
        );
      else await ctx.upscaler.setup();
    },
    cancelUpscaler: async () => ctx.upscaler.cancel(),
  } satisfies Partial<StudioMethods>;
}

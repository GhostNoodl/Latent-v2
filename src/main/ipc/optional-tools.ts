import { QWEN21_SET_ID } from '../../shared/qwen21-release';
import { isQwen21Profile, qwenEditProfileSchema } from '../../shared/qwen-edit-types';
import { z } from 'zod';
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
        if (ctx.runtimeUpdates.status().current?.setId !== QWEN21_SET_ID) {
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

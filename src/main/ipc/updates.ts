import { z } from 'zod';
import { runtimeUpdateSettingsSchema } from '../../shared/runtime-update-types';
import type { HandlerContext, StudioMethods } from '../main';

/** Desktop app updates and reviewed runtime updates. */
export function updatesHandlers(ctx: HandlerContext) {
  return {
    saveAppUpdateSettings: async value => {
      ctx.appUpdates!.settings(value);
    },
    checkAppUpdates: async () => ctx.appUpdates!.check(),
    downloadAppUpdate: async () => ctx.appUpdates!.download(),
    installAppUpdate: async () => {
      ctx.appUpdates!.requestInstall();
      setTimeout(() => void ctx.tickAppUpdates(), 0);
    },
    cancelAppUpdate: async () => {
      await ctx.appUpdates!.cancel();
    },
    getRuntimeUpdateStatus: async () => ctx.runtimeUpdateSnapshot(),
    saveRuntimeUpdateSettings: async value => {
      await ctx.runtimeUpdates.saveSettings(runtimeUpdateSettingsSchema.partial().parse(value));
      ctx.automaticRuntimeRetryAfter = 0;
      ctx.scheduleRuntimeIdleCheck();
    },
    checkRuntimeUpdates: async () => {
      await ctx.runtimeUpdates.check();
      ctx.automaticRuntimeRetryAfter = 0;
    },
    stageRuntimeUpdate: async kind => {
      await ctx.runtimeUpdates.stage(z.enum(['update', 'refresh']).parse(kind));
      ctx.automaticRuntimeRetryAfter = 0;
    },
    prepareRuntimeEnvironmentRepair: async () => {
      if (!ctx.runtimeCoordinator.canPrepareEnvironmentRepair())
        throw new Error(
          'A verified environment mismatch without a pending transaction is required before preparing this repair.',
        );
      await ctx.runtimeUpdates.prepareEnvironmentRepair();
      ctx.automaticRuntimeRetryAfter = 0;
    },
    activateRuntimeUpdate: async () => {
      try {
        await ctx.runtimeCoordinator.activateAndRecover(
          () => ctx.runtimeUpdates.activate(),
          () => ctx.runtimeUpdates.recover(),
        );
        ctx.automaticRuntimeRetryAfter = 0;
      } finally {
        ctx.broadcast();
      }
    },
    rollbackRuntimeUpdate: async () => {
      await ctx.runtimeUpdates.rollback();
      ctx.automaticRuntimeRetryAfter = 0;
    },
    recoverRuntimeUpdate: async () => {
      try {
        await ctx.runtimeCoordinator.recover(() => ctx.runtimeUpdates.recover());
        ctx.automaticRuntimeRetryAfter = 0;
      } finally {
        ctx.broadcast();
      }
    },
    cancelRuntimeUpdate: async () => ctx.runtimeUpdates.cancel(),
  } satisfies Partial<StudioMethods>;
}

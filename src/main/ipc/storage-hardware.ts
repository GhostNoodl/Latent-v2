import { storageBoundary } from '../storage-locations';
import { shell } from 'electron';
import { z } from 'zod';
import { privateShellPath } from '../shell-path';
import { isVideoJob } from '../../shared/types';
import type { HandlerContext, StudioMethods } from '../main';

/** Storage overview and hardware profiles. */
export function storageHardwareHandlers(ctx: HandlerContext) {
  return {
    getStorageOverview: async () => ctx.storageOverview.refresh(),
    getModelDownloadStorage: async () => ctx.storageOverview.downloadCapacity(),
    getPackageStorage: async packageId =>
      ctx.storageOverview.packageStorage(
        z
          .string()
          .regex(/^[a-z0-9-]{1,80}$/)
          .parse(packageId),
      ),
    revealStorageDestination: async destinationId => {
      const destination = await ctx.storageOverview.destination(
        z
          .string()
          .regex(/^directory:[a-f0-9]{24}$/)
          .parse(destinationId),
      );
      const error = await shell.openPath(await privateShellPath(storageBoundary(ctx.paths, destination), destination));
      if (error) throw new Error(error);
    },
    refreshHardwareProfiles: async () => {
      await ctx.hardwareProfiles.refresh();
      return ctx.hardwareProfiles.status();
    },
    recommendHardwareProfiles: async value => ctx.hardwareProfiles.recommend(value),
    applyHardwareProfile: async request => ctx.hardwareProfiles.apply(request),
    applyHardwareBackendRecommendation: async reportId => {
      const priorMode = ctx.store.settings().deviceMode;
      const result = await ctx.hardwareProfiles.applyBackendRecommendation(z.uuid().parse(reportId));
      if (ctx.store.settings().deviceMode !== priorMode)
        throw new Error('The engine preference changed while it was being checked. Recommend again.');
      ctx.store.saveSettings(result.settings);
      ctx.hardwareProfiles.settingsChanged();
      ctx.broadcast();
      return ctx.snapshot();
    },
    getJobMemoryAdvice: async jobId => {
      const job = ctx.jobs.jobs().find(value => value.id === ctx.id.parse(jobId));
      if (!job || job.status !== 'failed')
        throw new Error('Choose an existing failed generation to inspect its recovery advice.');
      if (isVideoJob(job))
        throw new Error(
          'Video recovery details are shown in its queue row. Image memory recommendations do not apply to video.',
        );
      return ctx.hardwareProfiles.oomAdvice(job.error ?? '', job.draft);
    },
  } satisfies Partial<StudioMethods>;
}

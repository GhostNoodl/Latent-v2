import { storageBoundary } from '../storage-locations';
import { shell } from 'electron';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { privateShellPath } from '../shell-path';
import { videoDraftSchema } from '../../shared/video-plan';
import { EMPTY_SHOT_BOARD, shotBoardSchema } from '../../shared/shot-board';
import { videoFileResponse } from '../video-media';
import { videoPlaybackFixtureRecord, VIDEO_PLAYBACK_FIXTURE_ID } from '../video-playback-fixture';
import type { HandlerContext, StudioMethods } from '../main';

const SHOT_BOARD_KEY = 'video.shotBoard.v1';
/** Video studio: conversations, planning, history and assets. */
export function videoHandlers(ctx: HandlerContext) {
  return {
    getVideoConversation: async () => ctx.videoConversations.get(),
    saveVideoConversation: async value => ctx.videoConversations.save(value),
    getShotBoard: async () => {
      const saved = shotBoardSchema.safeParse(ctx.store.getState<unknown>(SHOT_BOARD_KEY, EMPTY_SHOT_BOARD));
      return saved.success ? saved.data : EMPTY_SHOT_BOARD;
    },
    saveShotBoard: async value => ctx.store.setState(SHOT_BOARD_KEY, shotBoardSchema.parse(value)),
    planVideoDraft: async input => {
      const value = videoDraftSchema.parse(input);
      return ctx.videoDrafts.plan(
        value,
        value.seed === 'random' ? String(randomBytes(6).readUIntBE(0, 6)) : value.seed,
        async sourceId => (await ctx.sources.resolve(sourceId)).source,
      );
    },
    getVideoPlaybackFixture: async () => videoPlaybackFixtureRecord(ctx.videoFixture),
    getVideoHistory: async () => ctx.videoHistory.snapshot(),
    setupVideoAssets: async profile => ctx.videoAssets.setup(z.enum(['base', 'turbo8', 'fused4']).parse(profile)),
    verifyVideoAssets: async profile =>
      ctx.videoAssets.verifyLocal(z.enum(['base', 'turbo8', 'fused4']).parse(profile)),
    cancelVideoAssetSetup: async () => ctx.videoAssets.cancel(),
    restoreVideoParameters: async value => ctx.videoHistory.restore(ctx.id.parse(value)),
    revealVideo: async value => {
      const recordId = ctx.id.parse(value);
      if (recordId === VIDEO_PLAYBACK_FIXTURE_ID) {
        await videoPlaybackFixtureRecord(ctx.videoFixture);
        shell.showItemInFolder(ctx.videoFixture.filename);
        return;
      }
      const file = await ctx.videoHistory.file(recordId);
      await videoFileResponse(file, { method: 'HEAD', headers: new Headers(), signal: AbortSignal.timeout(15000) });
      shell.showItemInFolder(await privateShellPath(storageBoundary(ctx.paths, file.filename), file.filename));
    },
    openVideoLicense: async () => {
      await shell.openExternal(ctx.videoDrafts.status().licenseUrl);
    },
  } satisfies Partial<StudioMethods>;
}

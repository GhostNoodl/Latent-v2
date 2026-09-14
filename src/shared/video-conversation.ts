import { z } from 'zod';
import { videoDraftSchema } from './video-plan';

/** Editor persistence accepts unfinished fields; execution planning still uses videoDraftSchema. */
export const videoEditorDraftSchema = z.object({ ...videoDraftSchema.shape,
  width: z.number().finite().min(-100000).max(100000), height: z.number().finite().min(-100000).max(100000),
  requestedDurationSeconds: z.number().finite().min(-100000).max(100000), seed: z.string().max(32),
}).strict();
export const videoEditorSessionSchema = z.object({ id: z.uuid(), name: z.string().max(80), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), draft: videoEditorDraftSchema, selectedRecordId: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict();
export const videoConversationSchema = z.object({ schema: z.literal(1), activeSessionId: z.uuid().optional(), sessions: z.array(videoEditorSessionSchema).max(50) }).strict().superRefine((value, context) => {
  if (new Set(value.sessions.map(session => session.id)).size !== value.sessions.length) context.addIssue({ code: 'custom', message: 'Video draft sessions must have unique identities.' });
  if (value.activeSessionId && !value.sessions.some(session => session.id === value.activeSessionId)) context.addIssue({ code: 'custom', message: 'The active video draft is unavailable.' });
});
export type VideoConversation = z.infer<typeof videoConversationSchema>;
export type VideoEditorSession = z.infer<typeof videoEditorSessionSchema>;

import { z } from 'zod';
import { qwenEditJobRequestSchema, qwenEditWorkflowVersionSchema } from './qwen-edit-types';

export const QWEN_CONVERSATION_LIMIT = 50;
const recordId = z.string().regex(/^[a-f0-9]{32}$/);
const text = (maximum: number) => z.string().max(maximum).refine(value => !value.includes('\0'), 'Text cannot contain NUL characters.');
/** Editor text can contain an unfinished seed. Generation validates it later. */
export const qwenEditorSettingsSchema = z.object({
  profile: z.enum(['base', 'fast']), width: z.number().int().min(256).max(1024).multipleOf(64), height: z.number().int().min(256).max(1024).multipleOf(64),
  seed: text(32), resize: z.enum(['stretch', 'center-crop']),
  steps: z.number().int().min(1).max(60).optional(), guidance: z.number().finite().min(1).max(8).optional(),
}).strict().refine(value => value.profile !== 'fast' || (value.steps === undefined || value.steps === 4) && (value.guidance === undefined || value.guidance === 1), 'The fast profile requires four steps and CFG 1.');
export const qwenConversationDraftSchema = z.object({
  id: z.uuid(), title: text(80).min(1), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), branchId: z.uuid(),
  source: z.object({ id: z.string().regex(/^src_[a-f0-9-]{36}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), parentRecordId: recordId.optional() }).strict().optional(),
  selectedRecordId: recordId.optional(), instruction: text(4000), negativePrompt: text(4000), settings: qwenEditorSettingsSchema,
  frozenRecipe: z.object({ assetHashes: qwenEditJobRequestSchema.shape.assetHashes.unwrap(), workflowVersion: qwenEditWorkflowVersionSchema, reusedRecordId: recordId }).strict().optional(),
}).strict();
export const qwenConversationSchema = z.object({ schemaVersion: z.literal(1), activeConversationId: z.uuid().optional(), conversations: z.array(qwenConversationDraftSchema).max(QWEN_CONVERSATION_LIMIT) }).strict().superRefine((value, context) => {
  const ids = new Set(value.conversations.map(conversation => conversation.id));
  if (ids.size !== value.conversations.length) context.addIssue({ code: 'custom', message: 'Image-edit conversation identities must be unique.' });
  if (value.activeConversationId && !ids.has(value.activeConversationId)) context.addIssue({ code: 'custom', message: 'The active image-edit conversation must have a saved editor draft.' });
});
export type QwenConversationDraft = z.infer<typeof qwenConversationDraftSchema>;
export type QwenConversationStore = z.infer<typeof qwenConversationSchema>;
export function createQwenConversationDraft(title = 'New image edit', id: string = crypto.randomUUID()): QwenConversationDraft {
  const now = new Date().toISOString();
  return { id, title, createdAt: now, updatedAt: now, branchId: crypto.randomUUID(), instruction: '', negativePrompt: '', settings: { profile: 'base', width: 512, height: 512, seed: 'random', resize: 'center-crop' } };
}

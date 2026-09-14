import { z } from 'zod';
import { draftSchema } from './validation';
const id = z.string().min(1).max(100);
const suggestion = z.object({
  id, createdAt: z.iso.datetime(), explanation: z.string().max(16000), originalDraft: draftSchema, proposedDraft: draftSchema,
  modelId: z.string().min(1).max(300), modelRevision: z.string().min(1).max(100),
  promptTokens: z.number().int().nonnegative(), completionTokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative(), historyTurnsUsed: z.number().int().nonnegative(),
}).strict();
export const assistantConversationSchema = z.object({
  version: z.literal(1), instruction: z.string().max(4000),
  messages: z.array(z.object({ id, role: z.enum(['user', 'assistant']), content: z.string().max(16000), createdAt: z.iso.datetime(), suggestion: suggestion.optional() }).strict()).max(30),
  selectedSuggestionId: id.optional(), appliedSuggestionId: id.optional(),
}).strict();

import { z } from 'zod';

const id = z.string().min(1).max(100);
const action = z.enum([
  'chat',
  'improve',
  'expand',
  'shorten',
  'tags',
  'sentences',
  'variations',
  'describe',
  'motion',
]);
const image = z.object({ kind: z.enum(['source', 'output']), id: z.string().min(1).max(200) }).strict();
const reply = z
  .object({
    id,
    createdAt: z.iso.datetime(),
    message: z.string().max(8000),
    options: z
      .array(
        z
          .object({
            prompt: z.string().max(8000),
            negativePrompt: z.string().max(8000),
            dropped: z.array(z.string().max(600)).max(60).optional(),
          })
          .strict(),
      )
      .max(6),
    label: z.string().max(300),
    durationMs: z.number().nonnegative(),
  })
  .strict();

export const assistantConversationSchema = z
  .object({
    version: z.literal(2),
    messages: z
      .array(
        z
          .object({
            id,
            role: z.enum(['user', 'assistant']),
            content: z.string().max(8000),
            createdAt: z.iso.datetime(),
            action: action.optional(),
            image: image.optional(),
            reply: reply.optional(),
            applied: z.number().int().min(0).max(5).optional(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();

/** Where each page keeps its chat. The old assistant used version-1 keys, which are dropped. */
export function conversationKey(target: 'image' | 'video') {
  return target === 'video' ? 'assistant.v2.video' : 'assistant.v2.image';
}
export const OLD_CONVERSATION_KEYS = [
  'assistant.conversation',
  'assistant.video.conversation',
  'ctx.assistant.conversation',
  'ctx.assistant.video.conversation',
  'assistant.installation',
];

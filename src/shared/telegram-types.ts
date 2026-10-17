import { z } from 'zod';

/** Telegram user ids are positive integers; strings keep them exact in JSON and the UI. */
export const telegramUserIdSchema = z.string().regex(/^[1-9]\d{0,15}$/, 'Telegram user IDs are numbers only.');
export const telegramSettingsSchema = z
  .object({
    enabled: z.boolean(),
    allowedUserIds: z
      .array(telegramUserIdSchema)
      .max(20)
      .refine(ids => new Set(ids).size === ids.length, 'Each Telegram user ID can be listed once.'),
  })
  .strict();
export type TelegramSettings = z.infer<typeof telegramSettingsSchema>;
export interface TelegramStatus extends TelegramSettings {
  hasToken: boolean;
  state: 'off' | 'connecting' | 'online' | 'error';
  message: string;
  botUsername?: string;
}

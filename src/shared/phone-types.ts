import { z } from 'zod';

export const phoneSettingsSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(1024).max(65535),
  })
  .strict();
export type PhoneSettings = z.infer<typeof phoneSettingsSchema>;
export const DEFAULT_PHONE_SETTINGS: PhoneSettings = { enabled: false, port: 7870 };

export interface PhoneStatus extends PhoneSettings {
  state: 'off' | 'online' | 'error';
  message: string;
  /** Addresses a phone on the same Wi-Fi can open. */
  urls: string[];
  /** Six digits a new phone types once to pair. Only shown while the remote is on. */
  pairingCode?: string;
  pairedPhones: number;
}

/** What the phone sends to make an image. Anything left out follows the studio's Create settings. */
export const phoneGenerateSchema = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    negativePrompt: z.string().max(4000).optional(),
    checkpointId: z.string().min(1).max(1000).optional(),
    width: z.number().int().min(256).max(2048).multipleOf(64).optional(),
    height: z.number().int().min(256).max(2048).multipleOf(64).optional(),
    steps: z.number().int().min(1).max(100).optional(),
    seed: z
      .string()
      .regex(/^(random|\d{1,20})$/)
      .optional(),
    batchSize: z.number().int().min(1).max(4).optional(),
  })
  .strict();
export type PhoneGenerateRequest = z.infer<typeof phoneGenerateSchema>;

import { z } from 'zod';

const clipboardText = z.string().max(2_000_000);

/** IPC must acknowledge the native write, including permission or OS failures. */
export async function copyStudioText(value: unknown, clipboard: { writeText(text: string): Promise<void> }): Promise<void> {
  await clipboard.writeText(clipboardText.parse(value));
}

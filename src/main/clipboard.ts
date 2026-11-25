import { z } from 'zod';

const clipboardText = z.string().max(2_000_000);

/** IPC must acknowledge the native write, including permission or OS failures. */
export async function copyStudioText(
  value: unknown,
  clipboard: { writeText(text: string): Promise<void> },
): Promise<void> {
  await clipboard.writeText(clipboardText.parse(value));
}

export interface FileClipboardPorts {
  platform: NodeJS.Platform;
  /** Runs Windows PowerShell with the file path in an environment variable, never in the script text. */
  runPowerShell(script: string, env: Record<string, string>): Promise<void>;
}

/** Puts one file on the clipboard the way Explorer's Copy does (Windows PowerShell 5.1). */
export const COPY_FILE_SCRIPT = 'Set-Clipboard -LiteralPath $env:LATENT_COPY_FILE';

/**
 * Copies the file itself (not its pixels), so pasting into Explorer, Discord or a chat app
 * drops in the real file with its name and saved settings intact.
 */
export async function copyFileToClipboard(file: string, ports: FileClipboardPorts): Promise<void> {
  if (ports.platform !== 'win32') throw new Error('Copying the file only works on Windows.');
  try {
    await ports.runPowerShell(COPY_FILE_SCRIPT, { LATENT_COPY_FILE: file });
  } catch {
    throw new Error('Could not copy the file. Use Show in folder and copy it from there.');
  }
}

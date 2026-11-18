import { z } from 'zod';
import type { CloudProviderId } from '../../shared/assistant-types';
import { CLOUD_PROVIDER_IDS } from '../../shared/assistant-catalog';

export interface KeyCrypto {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
interface StateStore {
  getState<T>(key: string, fallback: T): T;
  setState(key: string, value: unknown): void;
}

const STATE_KEY = 'assistant.keys';
const storedSchema = z.record(
  z.string(),
  z.object({ version: z.literal(1), ciphertext: z.string().min(1).max(20000), last4: z.string().max(4) }).strict(),
);

/**
 * API keys, locked with Windows credential protection (Electron safeStorage).
 * The plain key only exists in the main process while a request is sent. It never goes to the window or the logs.
 */
export class AssistantKeys {
  constructor(
    private store: StateStore,
    private crypto: KeyCrypto | undefined,
  ) {}
  private stored() {
    const parsed = storedSchema.safeParse(this.store.getState(STATE_KEY, {}));
    return parsed.success ? parsed.data : {};
  }
  private secure(): KeyCrypto {
    const crypto = this.crypto;
    if (!crypto?.isEncryptionAvailable() || crypto.getSelectedStorageBackend?.() === 'basic_text')
      throw new Error("Windows can't protect saved keys right now, so the key wasn't saved.");
    return crypto;
  }
  /** Which providers have a key, and its last 4 characters so people can tell keys apart. */
  summary(): Partial<Record<CloudProviderId, { last4: string }>> {
    const result: Partial<Record<CloudProviderId, { last4: string }>> = {};
    for (const [provider, value] of Object.entries(this.stored()))
      if ((CLOUD_PROVIDER_IDS as string[]).includes(provider))
        result[provider as CloudProviderId] = { last4: value.last4 };
    return result;
  }
  has(provider: CloudProviderId) {
    return Boolean(this.stored()[provider]);
  }
  set(provider: CloudProviderId, value: string | null) {
    if (!CLOUD_PROVIDER_IDS.includes(provider)) throw new Error('Unknown provider.');
    const stored = this.stored();
    if (value === null) {
      delete stored[provider];
      this.store.setState(STATE_KEY, stored);
      return;
    }
    const key = value.trim();
    if (!key || key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key))
      throw new Error('That key looks wrong. Paste it again without spaces or line breaks.');
    let ciphertext: string;
    try {
      ciphertext = this.secure().encryptString(key).toString('base64');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Windows can't")) throw error;
      throw new Error("Windows couldn't protect this key, so it wasn't saved.");
    }
    stored[provider] = { version: 1, ciphertext, last4: key.slice(-4) };
    this.store.setState(STATE_KEY, stored);
  }
  /** The plain key, for one request. */
  get(provider: CloudProviderId): string | undefined {
    const entry = this.stored()[provider];
    if (!entry) return undefined;
    try {
      const value = this.secure().decryptString(Buffer.from(entry.ciphertext, 'base64'));
      if (!value || value.length > 4096 || /[\s\x00-\x1f\x7f]/.test(value)) throw new Error('bad key');
      return value;
    } catch {
      throw new Error("The saved key couldn't be unlocked. Paste it again in Settings, Assistant.");
    }
  }
}

/** Matches the id of the Assistant section in Settings. */
export const ASSISTANT_SETTINGS_SECTION = 'settings-assistant';

/** Makes Settings open on the Assistant tab next time it shows. */
export function openAssistantSettings() {
  try {
    localStorage.setItem('latent.settings-tab', ASSISTANT_SETTINGS_SECTION);
  } catch {
    /* Private storage can be unavailable; Settings then opens on its first tab. */
  }
}

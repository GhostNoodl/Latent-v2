import { describe, expect, it } from 'vitest';
import { DEFAULT_DRAFT } from '../src/shared/defaults';
import { acceptHardwareProfileApplication } from '../src/shared/hardware-profile-application';
import type { HardwareProfileApplication } from '../src/shared/hardware-profile-types';
const draft = { ...DEFAULT_DRAFT, prompt: 'A remembered scene', negativePrompt: 'retain my negative', seed: '123' };
const result = (): HardwareProfileApplication => ({ profileId: 'example', originalDraft: structuredClone(draft), proposedDraft: { ...draft, width: 768 }, changedFields: ['width'], explanation: 'Explicit change' });
describe('renderer hardware Apply handoff', () => {
  it('refuses a late result after a user edits and even restores the same values', () => {
    expect(() => acceptHardwareProfileApplication(result(), draft, 2, 4)).toThrow(/latest edits are intact/);
    expect(() => acceptHardwareProfileApplication(result(), { ...draft, prompt: 'New input' }, 2, 2)).toThrow(/latest edits are intact/);
  });
  it('accepts the same current draft into an isolated result and leaves a full previous recipe for Undo', () => {
    const application = result(); const previous = structuredClone(draft);
    const accepted = acceptHardwareProfileApplication(application, draft, 2, 2);
    accepted.prompt = 'Later editing'; expect(application.proposedDraft.prompt).toBe(draft.prompt);
    expect(previous).toEqual(draft); expect(previous.negativePrompt).toBe('retain my negative'); expect(previous.seed).toBe('123');
  });
});

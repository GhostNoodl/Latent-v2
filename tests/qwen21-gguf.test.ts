import { expect, it } from 'vitest';
import { qwenEditProfileSchema } from '../src/shared/qwen-edit-types';
import { selectedQwenAssets } from '../src/main/qwen-edit-assets';
import { reviewedRuntimeSet } from '../src/main/reviewed-runtime-channel';

it('keeps Qwen 2.1 native-only while retaining the older Compact profile', () => {
  expect(qwenEditProfileSchema.safeParse('qwen21-gguf').success).toBe(false);
  expect(qwenEditProfileSchema.parse('qwen21')).toBe('qwen21');
  expect(selectedQwenAssets('qwen21').every(asset => asset.format !== 'gguf')).toBe(true);
  expect(selectedQwenAssets('compact').some(asset => asset.format === 'gguf')).toBe(true);
  expect(reviewedRuntimeSet('comfy-0-37-0-qwen21-1').optionalCustomNodes.some(node => node.directory === 'latent_qwen21_gguf')).toBe(false);
});

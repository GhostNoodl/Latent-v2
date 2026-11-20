import { expect, it } from 'vitest';
import { unofferedInputMessage } from '../src/shared/engine-input-check';

const mask = 'source-images/mask_6d929150-6902-43dd-a17a-ab3cc812fe4d/mask.png';
const pic = 'source-images/src_11111111-1111-1111-1111-111111111111/image.png';

it('lets checked nested pictures and masks through the top-level-only dropdowns', () => {
  const verified = new Map([
    ['LoadImageMask', new Set([mask])],
    ['LoadImage', new Set([pic])],
  ]);
  expect(unofferedInputMessage('LoadImageMask', 'image', mask, ['other.png'], verified)).toBeUndefined();
  expect(unofferedInputMessage('LoadImage', 'image', pic, ['other.png'], verified)).toBeUndefined();
  // A mask checked for the mask loader does not unlock the picture loader.
  expect(unofferedInputMessage('LoadImage', 'image', mask, ['other.png'], verified)).toMatch(/picture/);
});

it('explains missing inputs without node names or paths', () => {
  const none = new Map<string, Set<string>>();
  const masked = unofferedInputMessage('LoadImageMask', 'image', mask, [], none)!;
  expect(masked).toBe("The engine can't find the painted area. Paint it again and retry.");
  const model = unofferedInputMessage('VAELoader', 'vae_name', 'qwen/qwen_vae.safetensors', ['a'], none)!;
  expect(model).toBe("The engine can't find qwen_vae.safetensors. Refresh models and try again.");
  for (const text of [masked, model]) expect(text).not.toMatch(/Load|source-images|\.image/);
  expect(unofferedInputMessage('VAELoader', 'vae_name', 'a', ['a'], none)).toBeUndefined();
  expect(unofferedInputMessage('KSampler', 'model', ['1', 0], ['a'], none)).toBeUndefined();
});

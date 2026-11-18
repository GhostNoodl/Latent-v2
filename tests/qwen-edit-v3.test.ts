import { expect, it } from 'vitest';
import { buildQwenEditWorkflow, validateQwenEditCapabilities } from '../src/shared/qwen-edit-workflow';
import { qwenAreaCrop, qwenSameSize, qwenWorkingSize } from '../src/shared/qwen-area';
import { qwenEditJobRequestSchema } from '../src/shared/qwen-edit-types';
import type { SourceImageAsset } from '../src/shared/source-types';
import { qwenBundle, qwenSource } from './qwen-compact.test';

const picture = (id: string) =>
  ({
    id: `src_${id.repeat(8)}-${id.repeat(4)}-4${id.repeat(3)}-8${id.repeat(3)}-${id.repeat(12)}`,
    normalized: { sha256: id.repeat(64), width: 800, height: 600, bytes: 100, mimeType: 'image/png' },
  }) as SourceImageAsset;
const base = {
  settings: { profile: 'lightning8' as const, width: 640, height: 512, seed: '7', resize: 'center-crop' as const },
  source: qwenSource,
  sourceFilename: 'source-images/a/image.png',
  instruction: 'Give her a silver necklace.',
  jobId: 'v3-test',
};

it('passes up to two extra pictures to both prompts', () => {
  const plan = buildQwenEditWorkflow(
    {
      ...base,
      references: [
        { source: picture('b'), filename: 'source-images/b/image.png' },
        { source: picture('c'), filename: 'source-images/c/image.png' },
      ],
    },
    qwenBundle('lightning8'),
  );
  expect(plan.workflowVersion).toBe('qwen-image-edit-2511-int8@3');
  expect(plan.workflow['40']).toEqual({ class_type: 'LoadImage', inputs: { image: 'source-images/b/image.png' } });
  expect(plan.workflow['8'].inputs.image2).toEqual(['40', 0]);
  expect(plan.workflow['8'].inputs.image3).toEqual(['41', 0]);
  expect(plan.workflow['9'].inputs.image3).toEqual(['41', 0]);
  expect(plan.references).toHaveLength(2);
  expect(() =>
    buildQwenEditWorkflow(
      {
        ...base,
        workflowVersion: 'qwen-image-edit-2511-int8@2',
        references: [{ source: picture('b'), filename: 'source-images/b/image.png' }],
      },
      qwenBundle('lightning8'),
    ),
  ).toThrow(/older recipe/);
});

it('saves whole-picture edits at the chosen size', () => {
  const plan = buildQwenEditWorkflow({ ...base, output: { width: 2048, height: 1536 } }, qwenBundle('lightning8'));
  expect(plan.workflow['17'].inputs).toMatchObject({ width: 2048, height: 1536 });
  expect(plan.output).toMatchObject({ width: 2048, height: 1536 });
  expect(qwenSameSize(8000, 6000)).toEqual({ width: 4096, height: 3072 });
});

it('edits only the painted crop and blends it back into the full picture', () => {
  const crop = { x: 400, y: 304, width: 512, height: 640 };
  const working = qwenWorkingSize(crop.width, crop.height);
  const plan = buildQwenEditWorkflow(
    {
      ...base,
      settings: { ...base.settings, ...working, resize: 'stretch' },
      area: {
        maskId: `mask_${'d'.repeat(8)}-dddd-4ddd-8ddd-${'d'.repeat(12)}`,
        maskSha256: 'd'.repeat(64),
        blend: 12,
        crop,
      },
      maskFilename: 'source-images/mask_d/mask.png',
    },
    qwenBundle('lightning8'),
  );
  expect(plan.workflow['30']).toEqual({ class_type: 'ImageCrop', inputs: { image: ['4', 0], ...crop } });
  expect(plan.workflow['5'].inputs.image).toEqual(['30', 0]);
  expect(plan.workflow['17'].inputs).toMatchObject({ width: 512, height: 640 });
  expect(plan.workflow['37'].inputs).toMatchObject({ destination: ['4', 0], source: ['17', 0], x: 400, y: 304 });
  expect(plan.workflow['37'].inputs.mask).toEqual(['36', 0]);
  expect(plan.workflow['7'].inputs.images).toEqual(['37', 0]);
  expect(plan.output).toMatchObject({ width: 2048, height: 1536 });
  expect(plan.area?.crop).toEqual(crop);
  expect(() =>
    buildQwenEditWorkflow(
      {
        ...base,
        area: {
          maskId: `mask_${'d'.repeat(8)}-dddd-4ddd-8ddd-${'d'.repeat(12)}`,
          maskSha256: 'd'.repeat(64),
          blend: 0,
          crop,
        },
        maskFilename: 'source-images/mask_d/mask.png',
      },
      qwenBundle('lightning8'),
    ),
  ).toThrow(/size of its painted area/);
  const objects = Object.fromEntries(
    ['ImageCrop', 'CropMask', 'ImageCompositeMasked', 'GrowMask', 'MaskToImage', 'ImageBlur', 'ImageToMask'].map(
      name => [name, { input: { required: {} } }],
    ),
  );
  expect(() => validateQwenEditCapabilities(objects, qwenBundle('lightning8'), plan)).toThrow();
});

it('crops around the painted pixels with room to match the surroundings', () => {
  const width = 1000;
  const height = 800;
  const red = new Uint8Array(width * height);
  for (let y = 500; y < 540; y++) for (let x = 600; x < 660; x++) red[y * width + x] = 255;
  const crop = qwenAreaCrop(red, width, height, 8);
  expect(crop.width).toBeGreaterThanOrEqual(384);
  expect(crop.height).toBeGreaterThanOrEqual(384);
  expect(crop.x % 8).toBe(0);
  expect(crop.x).toBeLessThanOrEqual(600);
  expect(crop.x + crop.width).toBeGreaterThanOrEqual(660);
  expect(crop.y + crop.height).toBeLessThanOrEqual(height);
  expect(() => qwenAreaCrop(new Uint8Array(width * height), width, height, 8)).toThrow(/Paint/);
});

it('accepts tries groups, painted areas and saved sizes in queued edits', () => {
  const parsed = qwenEditJobRequestSchema.safeParse({
    mode: 'qwen-edit',
    sourceId: `src_${'a'.repeat(8)}-aaaa-4aaa-8aaa-${'a'.repeat(12)}`,
    sourceSha256: 'a'.repeat(64),
    instruction: 'Relight it.',
    settings: { profile: 'fast', width: 1024, height: 1024, seed: 'random', resize: 'stretch' },
    area: { maskId: `mask_${'d'.repeat(8)}-dddd-4ddd-8ddd-${'d'.repeat(12)}`, maskSha256: 'd'.repeat(64), blend: 12 },
    output: { width: 2048, height: 2048 },
    lineage: {
      conversationId: crypto.randomUUID(),
      branchId: crypto.randomUUID(),
      group: crypto.randomUUID(),
    },
  });
  expect(parsed.success).toBe(true);
});

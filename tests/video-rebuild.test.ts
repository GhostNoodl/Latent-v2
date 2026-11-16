import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIDEO_DRAFT,
  planVideo,
  upgradeVideoDraft,
  videoDraftSchema,
  videoProfileAssets,
} from '../src/shared/video-plan';
import { bindVideoWorkflow, buildVideoWorkflow, SOL_ATTENTION_NODE } from '../src/shared/video-workflow';
import { parseVideoContract } from '../src/shared/video-history';
import { estimateVideoMs } from '../src/renderer/video-url';
import type { VideoDraft, VideoHistoryRecord } from '../src/shared/video-types';

const jobId = 'a'.repeat(32);
const draft = (patch: Partial<VideoDraft> = {}): VideoDraft => ({
  ...structuredClone(DEFAULT_VIDEO_DRAFT),
  prompt: 'Waves at sunset',
  ...patch,
});
const bindings = (profile: VideoDraft['profile']) =>
  videoProfileAssets(profile).map(asset => ({
    role: asset.role,
    filename: `minimax-h3/${asset.filename.split('/').at(-1)}`,
    sha256: asset.sha256,
    bytes: asset.bytes,
  }));
const build = (value: VideoDraft, options: { bigCard?: boolean; globalSage?: boolean } = {}) =>
  buildVideoWorkflow(
    {
      plan: planVideo(value, { actualSeed: '777', sources: [], bigCard: options.bigCard }),
      jobId,
      sourceFilenames: {},
      globalSage: options.globalSage,
    },
    bindings(value.profile),
  );

describe('video drafts', () => {
  it('moves drafts saved before the rebuild over with the same choices', () => {
    const old = {
      ...draft(),
      schema: 1,
      speed: undefined,
      attention: 'sage-auto',
      decodeMode: 'tiled',
    } as unknown as Record<string, unknown>;
    delete old.speed;
    const upgraded = videoDraftSchema.parse(upgradeVideoDraft(old)) as VideoDraft;
    expect(upgraded.schema).toBe(2);
    expect(upgraded.speed).toEqual({ textOnGpu: 'auto', attention: 'sage', finish: 'low-memory' });
  });
  it('defaults to the fast profile at 832×480', () => {
    expect(DEFAULT_VIDEO_DRAFT.profile).toBe('fused4');
    expect([DEFAULT_VIDEO_DRAFT.width, DEFAULT_VIDEO_DRAFT.height]).toEqual([832, 480]);
  });
  it('rejects sizes past what H3 is made for', () => {
    expect(videoDraftSchema.safeParse(draft({ width: 1344, height: 960 })).success).toBe(false);
    expect(videoDraftSchema.safeParse(draft({ width: 1344, height: 768 })).success).toBe(true);
  });
});

describe('video plan', () => {
  it('reads the prompt on the GPU only on big cards unless told otherwise', () => {
    expect(planVideo(draft(), { actualSeed: '1', sources: [], bigCard: true }).sampling.textEncoderDevice).toBe(
      'default',
    );
    expect(planVideo(draft(), { actualSeed: '1', sources: [], bigCard: false }).sampling.textEncoderDevice).toBe('cpu');
    const forced = draft({ speed: { ...DEFAULT_VIDEO_DRAFT.speed, textOnGpu: 'on' } });
    expect(planVideo(forced, { actualSeed: '1', sources: [] }).sampling.textEncoderDevice).toBe('default');
  });
  it('picks steps by quality', () => {
    expect(planVideo(draft({ profile: 'base' }), { actualSeed: '1', sources: [] }).sampling.steps).toBe(20);
    expect(planVideo(draft({ profile: 'turbo8' }), { actualSeed: '1', sources: [] }).sampling.steps).toBe(8);
    expect(planVideo(draft(), { actualSeed: '1', sources: [] }).sampling.steps).toBe(4);
  });
});

describe('video graph', () => {
  it('uses the engine-wide Sage without an extra node', () => {
    const graph = build(draft(), { globalSage: true }).workflow;
    expect(graph['17']).toBeUndefined();
    expect(graph['8'].inputs.model).toEqual(['1', 0]);
  });
  it('switches attention for this model when the engine setting differs', () => {
    expect(build(draft(), { globalSage: false }).workflow['17'].inputs.attention).toBe('sage');
    const normal = build(draft({ speed: { ...DEFAULT_VIDEO_DRAFT.speed, attention: 'normal' } }), { globalSage: true });
    expect(normal.workflow['17'].inputs.attention).toBe('normal');
    expect(normal.workflow['9'].inputs.model).toEqual(['17', 0]);
  });
  it('chains Sol after Sage', () => {
    const graph = build(draft({ speed: { ...DEFAULT_VIDEO_DRAFT.speed, attention: 'sage-sol' } }), {
      globalSage: true,
    }).workflow;
    expect(graph['18'].class_type).toBe(SOL_ATTENTION_NODE);
    expect(graph['10'].inputs.guider).toEqual(['9', 0]);
    expect(graph['9'].inputs.model).toEqual(['18', 0]);
  });
  it('adds the turbo add-on before attention and uses a tiled decode for low memory', () => {
    const graph = build(draft({ profile: 'turbo8', speed: { ...DEFAULT_VIDEO_DRAFT.speed, finish: 'low-memory' } }), {
      globalSage: false,
    }).workflow;
    expect(graph['17'].inputs.model).toEqual(['16', 0]);
    expect(graph['11'].class_type).toBe('VAEDecodeTiled');
  });
  it('round-trips through the saved clip check', () => {
    const contract = build(draft(), { bigCard: true });
    expect(parseVideoContract(JSON.parse(JSON.stringify(contract)), jobId).plan.actualSeed).toBe('777');
    expect(() => parseVideoContract(contract, 'b'.repeat(32))).toThrow();
  });
  it('names the missing node in plain words', () => {
    expect(() => bindVideoWorkflow(build(draft()), {})).toThrow(/engine/);
  });
  it('spells file names the way the engine lists them', () => {
    const contract = build(draft(), { globalSage: true });
    const objects = Object.fromEntries(
      Object.values(contract.workflow).map(node => [node.class_type, { input: { required: {} } }]),
    ) as Record<string, any>;
    const windows = (name: unknown) => [[String(name).replace('/', '\\')]];
    objects.UNETLoader.input.required.unet_name = windows(contract.workflow['1'].inputs.unet_name);
    objects.CLIPLoader.input.required.clip_name = windows(contract.workflow['2'].inputs.clip_name);
    objects.VAELoader.input.required.vae_name = windows(contract.workflow['3'].inputs.vae_name);
    const bound = bindVideoWorkflow(contract, objects);
    expect(String(bound.workflow['1'].inputs.unet_name)).toContain('\\');
  });
});

describe('time estimate', () => {
  it('scales from earlier clips with the same settings', () => {
    const record = {
      elapsedMs: 60000,
      plan: { draft: draft() },
    } as unknown as VideoHistoryRecord;
    expect(estimateVideoMs(draft(), [record])).toBe(60000);
    expect(estimateVideoMs(draft({ width: 1664 / 2, height: 960 }), [record])).toBe(120000);
    expect(estimateVideoMs(draft(), [])).toBeUndefined();
  });
});

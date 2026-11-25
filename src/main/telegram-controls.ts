import { followHiresScale } from '../shared/advanced-image-workflow';
import { DEFAULT_DRAFT, SAMPLERS, SCHEDULERS } from '../shared/defaults';
import type { GenerationDraft, GenerationRecord, ModelAsset, Preset } from '../shared/types';
import { draftSchema } from '../shared/validation';
import {
  IMAGE_MODELS,
  fitImageModelSize,
  imageModelSizes,
  imageModelStartingSettings,
  type ImageModelId,
} from '../shared/image-models';

/**
 * Per-chat txt2img settings layered over the studio's Create settings. Anything a chat never
 * changed keeps following the studio. `null` means "turned off here" for optional passes.
 */
type OverridableKey =
  | 'checkpointId'
  | 'imageModel'
  | 'family'
  | 'modelSampling'
  | 'loras'
  | 'negativePrompt'
  | 'width'
  | 'height'
  | 'steps'
  | 'cfg'
  | 'sampler'
  | 'scheduler'
  | 'seed'
  | 'batchSize'
  | 'autoTriggers'
  | 'triggerWords'
  | 'hiresFix'
  | 'autoFace';
export type TelegramOverrides = { [K in OverridableKey]?: GenerationDraft[K] | null };
export interface ControlContext {
  studio: GenerationDraft;
  models: ModelAsset[];
  presets: Preset[];
  sizes: { name: string; width: number; height: number }[];
  /** Newer models (Anima, Z-Image…) whose files are downloaded and checked. */
  imageModels?: ImageModelId[];
  /** This chat's SDXL tweaks, put aside while it uses a newer model. */
  classic?: TelegramOverrides;
}
export interface ControlResult {
  overrides: TelegramOverrides;
  message: string;
  /** New value for the chat's put-aside SDXL tweaks; `null` clears them, undefined keeps them. */
  classic?: TelegramOverrides | null;
}
/** The SDXL settings a newer model replaces; the same list Create puts aside. */
const CLASSIC_KEYS = [
  'family',
  'loras',
  'steps',
  'cfg',
  'sampler',
  'scheduler',
  'hiresFix',
  'autoFace',
  'modelSampling',
  'width',
  'height',
  'negativePrompt',
] as const satisfies readonly OverridableKey[];
/** Things newer models can't use yet; the queue refuses them, so a remote job leaves them out. */
const NEWER_MODEL_EXTRAS = ['hiresFix', 'autoFace', 'modelSampling', 'split'] as const;
export const SETTING_KEYS = [
  'model',
  'lora',
  'neg',
  'size',
  'steps',
  'cfg',
  'seed',
  'batch',
  'sampler',
  'scheduler',
  'hires',
  'faces',
  'triggers',
  'preset',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export const isSettingKey = (value: string): value is SettingKey => (SETTING_KEYS as readonly string[]).includes(value);
/** Short list for buttons; every sampler still works when typed. */
export const POPULAR_SAMPLERS = [
  'euler',
  'euler_ancestral',
  'dpmpp_2m',
  'dpmpp_2m_sde',
  'dpmpp_sde',
  'dpmpp_3m_sde',
  'uni_pc',
  'ddim',
];
const FACE_PROFILES = ['illustrated', 'anime', 'photographic'] as const;

/**
 * A Telegram copy of the studio draft as a plain text-to-image job.
 * Features that need a picked source image or a lineage in the studio stay in the studio window.
 */
export function telegramDraft(base: GenerationDraft, prompt: string): GenerationDraft {
  const {
    autoFaceParentRecordId: _autoFaceParent,
    enhance: _enhance,
    faceDetailer: _faceDetailer,
    ipAdapter: _ipAdapter,
    regionalPrompts: _regional,
    qwenEdit: _qwenEdit,
    variationOfRecordId: _variation,
    controlNet: _controlNet,
    upscale: _upscale,
    imageInput: _imageInput,
    dynamicPrompts: _dynamic,
    promptTriggerSpans: _spans,
    // Hashes pin a restored recipe to exact files; a fresh remote job uses what is installed now.
    assetHashes: _hashes,
    // Pause and tweak belongs to one image in the studio window.
    split: _split,
    ...rest
  } = structuredClone(base);
  if (rest.imageModel) {
    for (const key of NEWER_MODEL_EXTRAS) delete (rest as Partial<GenerationDraft>)[key];
    rest.loras = [];
  }
  return {
    ...rest,
    prompt,
    hiresFix: rest.hiresFix ? followHiresScale(rest.hiresFix, rest.width, rest.height) : undefined,
    // Studio prompts carry LoRA trigger words visibly; a typed prompt gets them added automatically.
    triggerResolutionVersion: 'punctuation@2',
  };
}
export function effectiveDraft(studio: GenerationDraft, overrides: TelegramOverrides, prompt: string): GenerationDraft {
  const merged: Record<string, unknown> = { ...structuredClone(studio) };
  for (const [key, value] of Object.entries(structuredClone(overrides)))
    if (value === null) delete merged[key];
    else if (value !== undefined) merged[key] = value;
  // The studio may pin a seed for its own work; remote prompts stay random unless a chat pins one.
  merged.seed = overrides.seed ?? 'random';
  return telegramDraft(merged as unknown as GenerationDraft, prompt);
}

const checkpoints = (models: ModelAsset[]) =>
  models
    .filter(model => model.kind === 'checkpoint' && model.status === 'ready' && model.family !== 'unknown')
    .sort((a, b) => a.name.localeCompare(b.name));
const loraModels = (models: ModelAsset[]) =>
  models
    .filter(model => model.kind === 'lora' && model.status === 'ready')
    .sort((a, b) => a.name.localeCompare(b.name));
export function checkpointList(models: ModelAsset[]) {
  return checkpoints(models);
}
export type ModelChoice =
  { kind: 'checkpoint'; name: string; asset: ModelAsset } | { kind: 'newer'; name: string; id: ImageModelId };
/** Everything /model can pick, numbered in this order: checkpoints, then the newer models. */
export function modelChoices(ctx: Pick<ControlContext, 'models' | 'imageModels'>): ModelChoice[] {
  return [
    ...checkpoints(ctx.models).map(asset => ({ kind: 'checkpoint' as const, name: asset.name, asset })),
    ...(ctx.imageModels ?? [])
      .filter(id => IMAGE_MODELS[id])
      .map(id => ({ kind: 'newer' as const, name: IMAGE_MODELS[id].name, id })),
  ];
}
/** Display name of the model a draft uses. */
export function modelName(draft: GenerationDraft, models: ModelAsset[]) {
  if (draft.imageModel) return IMAGE_MODELS[draft.imageModel]?.name ?? 'a newer model';
  if (!draft.checkpointId) return 'none picked yet';
  return models.find(model => model.id === draft.checkpointId)?.name ?? 'missing model';
}
/** Size buttons: the studio's sizes, or the sizes a newer model is made for. */
export function sizeChoices(ctx: ControlContext, draft: GenerationDraft) {
  return draft.imageModel ? imageModelSizes(draft.imageModel) : ctx.sizes;
}
const range = ([a, b]: [number, number]) => (a === b ? `${a}` : `${a}–${b}`);
/** "8 steps · CFG 1" style summary of what a newer model's makers recommend. */
export function bestFor(id: ImageModelId) {
  const { steps, cfg } = IMAGE_MODELS[id].guide;
  return `${range(steps)} steps · CFG ${range(cfg)}`;
}
const pickClassic = (overrides: TelegramOverrides) =>
  Object.fromEntries(
    CLASSIC_KEYS.filter(key => Object.hasOwn(overrides, key)).map(key => [key, overrides[key]]),
  ) as TelegramOverrides;
export function loraList(models: ModelAsset[]) {
  return loraModels(models);
}
/** Finds an item by its list number or by part of its name. */
function pick<T extends { name: string }>(items: T[], query: string, what: string, extra?: (item: T) => string): T {
  const value = query.trim();
  if (/^\d+$/.test(value)) {
    const item = items[Number(value) - 1];
    if (!item) throw new Error(`There is no ${what} number ${value}.`);
    return item;
  }
  const needle = value.toLocaleLowerCase();
  const exact = items.filter(
    item => item.name.toLocaleLowerCase() === needle || extra?.(item).toLocaleLowerCase() === needle,
  );
  if (exact.length === 1) return exact[0];
  const matches = items.filter(
    item => item.name.toLocaleLowerCase().includes(needle) || extra?.(item).toLocaleLowerCase().includes(needle),
  );
  if (matches.length === 1) return matches[0];
  if (!matches.length) throw new Error(`No ${what} matches "${value}".`);
  throw new Error(
    `"${value}" matches several: ${matches
      .slice(0, 8)
      .map(item => item.name)
      .join(', ')}. Use the number from the list instead.`,
  );
}
function number(value: string, label: string, min: number, max: number, integer = false) {
  const parsed = Number(value.trim());
  if (
    !value.trim() ||
    !Number.isFinite(parsed) ||
    parsed < min ||
    parsed > max ||
    (integer && !Number.isInteger(parsed))
  )
    throw new Error(`${label} needs a ${integer ? 'whole number' : 'number'} from ${min} to ${max}.`);
  return parsed;
}
const onOff = (value: string) => {
  const word = value.trim().split(/\s+/)[0]?.toLowerCase();
  if (['on', 'yes', 'true', '1'].includes(word)) return true;
  if (['off', 'no', 'false', '0', 'none'].includes(word)) return false;
  return undefined;
};

/** Applies one setting change, validating the result against the real draft rules. */
export function applySetting(
  ctx: ControlContext,
  overrides: TelegramOverrides,
  key: SettingKey,
  rawArgs: string,
): ControlResult {
  const args = rawArgs.trim();
  const next: TelegramOverrides = structuredClone(overrides);
  const current = effectiveDraft(ctx.studio, overrides, '');
  let message: string;
  let classic: TelegramOverrides | null | undefined;
  const newer = current.imageModel ? IMAGE_MODELS[current.imageModel]?.name : undefined;
  const firstWord = args.split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  const turningOff = onOff(firstWord) === false || ['remove', 'delete', 'clear'].includes(firstWord);
  if (newer && !turningOff && (key === 'lora' || key === 'hires' || key === 'faces'))
    throw new Error(
      `${newer} makes images from text only, so ${
        key === 'lora' ? 'LoRAs' : key === 'hires' ? 'hires fix' : 'face fix'
      } can't be used with it. Pick an SDXL model with /model first.`,
    );
  switch (key) {
    case 'model': {
      if (!args) throw new Error('Send /model to see the list, then /model <number or name>.');
      const choice = pick(modelChoices(ctx), args, 'model', item =>
        item.kind === 'checkpoint' ? item.asset.filename : item.id,
      );
      if (choice.kind === 'newer') {
        // Like Create: the SDXL setup is put aside and the model's best settings come in.
        if (!current.imageModel) classic = pickClassic(overrides);
        const size = fitImageModelSize(choice.id, current.width, current.height);
        Object.assign(next, {
          imageModel: choice.id,
          checkpointId: '',
          loras: [],
          hiresFix: null,
          autoFace: null,
          modelSampling: null,
          ...imageModelStartingSettings(choice.id),
          ...size,
        } satisfies TelegramOverrides);
        message = `Model set to ${choice.name}, with its best settings (${next.steps} steps, CFG ${next.cfg}, ${size.width}×${size.height}).`;
        if (current.loras.length || current.hiresFix || current.autoFace)
          message += ' It makes images from text only, so LoRAs, hires fix and face fix are off for it.';
        break;
      }
      const model = choice.asset;
      if (current.imageModel) {
        // Back from a newer model: bring the SDXL setup back.
        for (const key of CLASSIC_KEYS) delete next[key];
        if (ctx.studio.imageModel)
          Object.assign(next, {
            loras: [],
            steps: DEFAULT_DRAFT.steps,
            cfg: DEFAULT_DRAFT.cfg,
            sampler: DEFAULT_DRAFT.sampler,
            scheduler: DEFAULT_DRAFT.scheduler,
            width: DEFAULT_DRAFT.width,
            height: DEFAULT_DRAFT.height,
            negativePrompt: DEFAULT_DRAFT.negativePrompt,
            hiresFix: null,
            autoFace: null,
          } satisfies TelegramOverrides);
        Object.assign(next, structuredClone(ctx.classic ?? {}));
        classic = null;
      }
      next.checkpointId = model.id;
      next.imageModel = null;
      next.family = model.family as GenerationDraft['family'];
      // Prediction overrides belong to the model they were set for.
      if (model.id !== current.checkpointId) next.modelSampling = null;
      message = `Model set to ${model.name}.`;
      break;
    }
    case 'lora': {
      const [first = '', ...restWords] = args.split(/\s+/);
      const loras = structuredClone(current.loras);
      if (!args) throw new Error('Send /loras to see the list, then /lora <number or name> [weight].');
      if (first.toLowerCase() === 'clear' || first.toLowerCase() === 'none') {
        next.loras = [];
        message = 'LoRAs cleared.';
        break;
      }
      const action = ['remove', 'delete'].includes(first.toLowerCase())
        ? 'remove'
        : ['off', 'on'].includes(first.toLowerCase())
          ? (first.toLowerCase() as 'off' | 'on')
          : 'set';
      const words = action === 'set' ? [first, ...restWords] : restWords;
      if (!words.length) throw new Error(`Say which LoRA, like /lora ${action} 2.`);
      // A trailing number is the weight, unless it is the only word (a list number).
      const last = words.at(-1) ?? '';
      const hasWeight = action === 'set' && words.length > 1 && /^-?\d+(\.\d+)?$/.test(last);
      const query = (hasWeight ? words.slice(0, -1) : words).join(' ');
      const lora = pick(loraModels(ctx.models), query, 'LoRA', item => item.filename);
      const index = loras.findIndex(item => item.modelId === lora.id);
      if (action === 'remove') {
        if (index < 0) throw new Error(`${lora.name} isn't in use.`);
        loras.splice(index, 1);
        message = `Removed ${lora.name}.`;
      } else if (action === 'off') {
        if (index < 0) throw new Error(`${lora.name} isn't in use.`);
        loras[index] = { ...loras[index], off: true };
        message = `${lora.name} is off. It stays in the list; /lora on ${lora.name} brings it back.`;
      } else {
        // Setting a weight, or adding a LoRA again, switches it back on.
        const weight = hasWeight ? number(last, 'LoRA weight', -10, 10) : (loras[index]?.weight ?? 1);
        const { off: _off, ...kept } = loras[index] ?? { modelId: lora.id };
        if (index >= 0) loras[index] = { ...kept, weight, clipWeight: hasWeight ? weight : loras[index].clipWeight };
        else loras.push({ modelId: lora.id, weight, clipWeight: weight });
        message = `${lora.name} on, at weight ${weight}.`;
      }
      next.loras = loras;
      break;
    }
    case 'neg': {
      const off = onOff(args) === false || args.toLowerCase() === 'clear';
      next.negativePrompt = off ? '' : args;
      message = off || !args ? 'Negative prompt cleared.' : 'Negative prompt set.';
      if (
        !off &&
        args &&
        current.imageModel &&
        (IMAGE_MODELS[current.imageModel].negative === 'zero' || current.cfg <= 1)
      )
        message += ` ${newer} ignores it at CFG ${current.cfg}, though.`;
      break;
    }
    case 'size': {
      const dims = /^(\d{2,5})\s*[x×*:]\s*(\d{2,5})$/i.exec(args);
      if (dims) {
        const [width, height] = [Number(dims[1]), Number(dims[2])];
        if (width % 64 || height % 64 || Math.min(width, height) < 256 || Math.max(width, height) > 2048)
          throw new Error('Width and height need to be multiples of 64, from 256 to 2048. Like /size 832x1216.');
        next.width = width;
        next.height = height;
      } else {
        if (!args) throw new Error('Use /size 832x1216, or a size name like portrait.');
        const preset = pick(sizeChoices(ctx, current), args, 'size');
        next.width = preset.width;
        next.height = preset.height;
      }
      message = `Size set to ${next.width}×${next.height}.`;
      break;
    }
    case 'steps':
      next.steps = number(args, 'Steps', 1, 100, true);
      message = `Steps set to ${next.steps}.`;
      break;
    case 'cfg':
      next.cfg = number(args, 'CFG', 0, 30);
      message = `CFG set to ${next.cfg}.`;
      break;
    case 'seed':
      if (!args || args.toLowerCase() === 'random') next.seed = 'random';
      else if (/^\d+$/.test(args)) next.seed = args;
      else throw new Error('Use /seed random or /seed <number>.');
      message = next.seed === 'random' ? 'Seeds are random again.' : `Seed fixed at ${next.seed}.`;
      break;
    case 'batch':
      next.batchSize = number(args, 'Batch size', 1, 4, true);
      message = `Making ${next.batchSize} image${next.batchSize === 1 ? '' : 's'} per prompt.`;
      break;
    case 'sampler': {
      const value = args.toLowerCase();
      if (!SAMPLERS.includes(value)) throw new Error(`Unknown sampler. Try one of: ${SAMPLERS.join(', ')}.`);
      next.sampler = value;
      message = `Sampler set to ${value}.`;
      break;
    }
    case 'scheduler': {
      const value = args.toLowerCase();
      if (!SCHEDULERS.includes(value)) throw new Error(`Unknown scheduler. Try one of: ${SCHEDULERS.join(', ')}.`);
      next.scheduler = value;
      message = `Scheduler set to ${value}.`;
      break;
    }
    case 'hires': {
      const [toggle = '', scaleText, denoiseText] = args.split(/\s+/);
      const enabled = onOff(toggle);
      if (enabled === undefined)
        throw new Error('Use /hires on [scale] [denoise], for example /hires on 1.5 0.35, or /hires off.');
      if (!enabled) {
        next.hiresFix = null;
        message = 'Hires fix off.';
        break;
      }
      const scale = scaleText ? number(scaleText, 'Hires scale', 1.05, 2.5) : 1.5;
      const denoise = denoiseText ? number(denoiseText, 'Hires denoise', 0.05, 1) : 0.3;
      next.hiresFix = {
        classic: true,
        method: 'image',
        scaleFactor: scale,
        width: Math.round((current.width * scale) / 8) * 8,
        height: Math.round((current.height * scale) / 8) * 8,
        steps: 20,
        cfg: current.cfg,
        sampler: 'euler',
        scheduler: 'simple',
        denoise,
        seed: 'random',
      };
      message = `Hires fix on: ${scale}× with denoise ${denoise}.`;
      break;
    }
    case 'faces': {
      const [toggle = '', ...more] = args.split(/\s+/);
      const enabled = onOff(toggle);
      if (enabled === undefined)
        throw new Error('Use /faces on [illustrated|anime|photographic] [strength 0-1], or /faces off.');
      if (!enabled) {
        next.autoFace = null;
        message = 'Face fix off.';
        break;
      }
      const profile = FACE_PROFILES.find(item => more.some(word => word.toLowerCase() === item));
      const strengthText = more.find(word => /^\d*\.?\d+$/.test(word));
      const base = current.autoFace ?? {
        profile: 'illustrated' as const,
        strength: 0.45,
        classic: true,
        applyLoras: false,
        steps: 20,
        cfg: 7,
        sampler: 'euler',
        scheduler: 'normal',
      };
      next.autoFace = {
        ...base,
        profile: profile ?? base.profile,
        strength: strengthText ? number(strengthText, 'Face strength', 0.05, 1) : base.strength,
      };
      message = `Face fix on (${next.autoFace.profile}, ${Math.round(next.autoFace.strength * 100)}%).`;
      break;
    }
    case 'triggers': {
      const enabled = onOff(args);
      if (enabled === undefined) throw new Error('Use /triggers on or /triggers off.');
      next.autoTriggers = enabled;
      message = enabled ? 'LoRA trigger words get added automatically.' : 'LoRA trigger words are up to you now.';
      break;
    }
    case 'preset': {
      if (!args) throw new Error('Send /preset to see the list, then /preset <number or name>.');
      const preset = pick(ctx.presets, args, 'preset');
      Object.assign(next, draftSettings(preset.draft));
      message = `Loaded the "${preset.name}" preset.`;
      classic = null;
      break;
    }
  }
  const checked = draftSchema.safeParse(effectiveDraft(ctx.studio, next, ''));
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new Error(`That doesn't work: ${issue.path.join('.') || 'settings'} ${issue.message}`.trim());
  }
  return { overrides: next, message, ...(classic !== undefined ? { classic } : {}) };
}

/** Every setting a chat can change, taken from a saved draft (a preset, or an image's recipe). */
function draftSettings(draft: GenerationDraft): TelegramOverrides {
  return {
    checkpointId: draft.checkpointId,
    imageModel: draft.imageModel ?? null,
    family: draft.family,
    modelSampling: draft.modelSampling ?? null,
    loras: structuredClone(draft.loras),
    negativePrompt: draft.negativePrompt,
    width: draft.width,
    height: draft.height,
    steps: draft.steps,
    cfg: draft.cfg,
    sampler: draft.sampler,
    scheduler: draft.scheduler,
    seed: 'random',
    batchSize: draft.batchSize,
    autoTriggers: draft.autoTriggers,
    triggerWords: draft.triggerWords ? structuredClone(draft.triggerWords) : null,
    hiresFix: draft.hiresFix ? structuredClone(draft.hiresFix) : null,
    autoFace: draft.autoFace ? structuredClone(draft.autoFace) : null,
  };
}

/** A plain Create image: not an edit, Enhance, face fix pass or picture-to-picture job. */
export function isCreateImage(record: GenerationRecord) {
  const draft = record.draft;
  return (
    !!draft &&
    !record.qwenEdit &&
    !draft.qwenEdit &&
    !draft.enhance &&
    !draft.imageInput &&
    !draft.upscale &&
    !draft.faceDetailer &&
    !draft.autoFaceParentRecordId &&
    record.outputRole !== 'base' &&
    record.outputRole !== 'face-pass'
  );
}

/** Copies the settings an image was made with into a chat (everything but the prompt and seed). */
export function settingsFromRecord(ctx: ControlContext, record: GenerationRecord): ControlResult {
  const draft = record.draft;
  if (draft.imageModel) {
    if (!(ctx.imageModels ?? []).includes(draft.imageModel))
      throw new Error(
        `It was made with ${IMAGE_MODELS[draft.imageModel]?.name ?? 'a newer model'}, which isn't downloaded anymore.`,
      );
  } else if (!checkpoints(ctx.models).some(model => model.id === draft.checkpointId))
    throw new Error(`Its model (${record.checkpoint?.name ?? 'unknown'}) isn't installed anymore.`);
  const installed = new Set(loraModels(ctx.models).map(model => model.id));
  const missing = draft.loras.filter(lora => !installed.has(lora.modelId));
  const overrides = draftSettings({ ...draft, loras: draft.loras.filter(lora => installed.has(lora.modelId)) });
  const checked = draftSchema.safeParse(effectiveDraft(ctx.studio, overrides, ''));
  if (!checked.success) {
    const issue = checked.error.issues[0];
    throw new Error(`Those settings don't fit anymore: ${issue.path.join('.') || 'settings'} ${issue.message}`.trim());
  }
  const name = modelName(effectiveDraft(ctx.studio, overrides, ''), ctx.models);
  const used = draft.loras.filter(lora => installed.has(lora.modelId) && !lora.off).length;
  return {
    overrides,
    classic: null,
    message: [
      `Using the settings from your last image on the PC: ${name}${used ? ` + ${used} LoRA${used === 1 ? '' : 's'}` : ''}, ${draft.width}×${draft.height}, ${draft.steps} steps, CFG ${draft.cfg}${draft.hiresFix ? ', hires fix' : ''}${draft.autoFace ? ', face fix' : ''}.`,
      missing.length
        ? `${missing.length} of its LoRAs ${missing.length === 1 ? "isn't" : "aren't"} installed anymore, so I left ${missing.length === 1 ? 'it' : 'them'} out.`
        : '',
      'Seeds stay random. Send a prompt to use them.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** Splits `a castle --steps 30 --size portrait` into the prompt and one-off settings. */
export function splitPromptFlags(text: string): { prompt: string; flags: { key: SettingKey; args: string }[] } {
  const pattern = new RegExp(`(?:^|\\s)--(${SETTING_KEYS.join('|')})(?=\\s|$)`, 'gi');
  const marks = [...text.matchAll(pattern)];
  if (!marks.length) return { prompt: text.trim(), flags: [] };
  const flags = marks.map((mark, index) => ({
    key: mark[1].toLowerCase() as SettingKey,
    args: text.slice(mark.index! + mark[0].length, marks[index + 1]?.index ?? text.length).trim(),
  }));
  return { prompt: text.slice(0, marks[0].index).trim(), flags };
}

export function describeSettings(ctx: ControlContext, overrides: TelegramOverrides): string {
  const draft = effectiveDraft(ctx.studio, overrides, '');
  const name = (id: string) => ctx.models.find(model => model.id === id)?.name ?? 'missing model';
  const lines = [`Model: ${modelName(draft, ctx.models)}`];
  if (draft.imageModel) lines.push(`Best for it: ${bestFor(draft.imageModel)}`);
  else
    lines.push(
      `LoRAs: ${
        draft.loras.length
          ? draft.loras.map(lora => `${name(lora.modelId)} (${lora.off ? 'off' : lora.weight})`).join(', ')
          : 'none'
      }`,
    );
  lines.push(
    `Size: ${draft.width}×${draft.height}, ${draft.batchSize} per prompt`,
    `Steps ${draft.steps} · CFG ${draft.cfg} · ${draft.sampler} / ${draft.scheduler}`,
    `Seed: ${draft.seed}`,
    `Negative: ${draft.negativePrompt ? draft.negativePrompt.slice(0, 300) : 'none'}`,
  );
  if (!draft.imageModel)
    lines.push(
      `Hires fix: ${
        draft.hiresFix
          ? `on, ${draft.hiresFix.width}×${draft.hiresFix.height}, denoise ${draft.hiresFix.denoise}`
          : 'off'
      }`,
      `Face fix: ${draft.autoFace ? `on, ${draft.autoFace.profile} ${Math.round(draft.autoFace.strength * 100)}%` : 'off'}`,
      `Auto LoRA triggers: ${draft.autoTriggers ? 'on' : 'off'}`,
    );
  const changed = Object.keys(overrides).length;
  lines.push(
    '',
    changed
      ? 'Anything you have not changed here follows the studio. /reset to follow the studio completely.'
      : "These are the studio's current Create settings.",
  );
  return lines.join('\n');
}

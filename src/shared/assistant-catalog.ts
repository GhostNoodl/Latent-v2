import type {
  AssistantModelOption,
  AssistantProviderId,
  AssistantSettings,
  CloudProviderId,
  LocalAssistantModelId,
} from './assistant-types';

export interface CloudProviderDefinition {
  id: CloudProviderId;
  name: string;
  blurb: string;
  /** Where to get a key. */
  keyUrl?: string;
  /** OpenAI-style base URL. Claude uses its own SDK. */
  baseUrl?: string;
  keyRequired: boolean;
  /** Models we list without asking the provider. */
  models?: AssistantModelOption[];
  /** Ids we like best when nothing is picked yet, most preferred first. Regexes match against model ids. */
  preferred?: RegExp[];
}

export const CLOUD_PROVIDERS: Readonly<Record<CloudProviderId, CloudProviderDefinition>> = {
  anthropic: {
    id: 'anthropic',
    name: 'Claude',
    blurb: 'Anthropic. Very good at following your style and keeping your tags. Can look at pictures.',
    keyUrl: 'https://platform.claude.com/settings/keys',
    keyRequired: true,
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', vision: true },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', vision: true },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', vision: true },
    ],
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    blurb: 'ChatGPT models. Can look at pictures.',
    keyUrl: 'https://platform.openai.com/api-keys',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
    preferred: [/^gpt-5(\.\d+)?$/, /^gpt-5(\.\d+)?-mini$/, /^gpt-4\.1$/, /^gpt-4o$/],
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    blurb: 'Google. Has a free tier. Can look at pictures.',
    keyUrl: 'https://aistudio.google.com/apikey',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyRequired: true,
    preferred: [/^gemini-\d+(\.\d+)?-flash$/, /^gemini-\d+(\.\d+)?-pro$/, /^gemini-.*flash/],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    blurb: 'One key for hundreds of models, including ones with fewer content limits.',
    keyUrl: 'https://openrouter.ai/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
  },
  custom: {
    id: 'custom',
    name: 'Your own server',
    blurb: 'LM Studio, Ollama or anything else that speaks the OpenAI chat format.',
    keyRequired: false,
  },
};

export const CLOUD_PROVIDER_IDS = Object.keys(CLOUD_PROVIDERS) as CloudProviderId[];
export const ASSISTANT_PROVIDER_IDS: AssistantProviderId[] = ['local', ...CLOUD_PROVIDER_IDS];

/** A file pinned by size and SHA-256. */
export interface PinnedFile {
  filename: string;
  url: string;
  bytes: number;
  sha256: string;
}

const LLAMA_BUILD = 'b12490';
const llama = (filename: string, bytes: number, sha256: string): PinnedFile => ({
  filename,
  url: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${filename}`,
  bytes,
  sha256,
});

/** llama.cpp server for Windows x64. The CUDA build also carries the processor backends. */
export const LOCAL_ASSISTANT_RUNTIME = {
  build: LLAMA_BUILD,
  revision: 'ad9d9e8f50e6ff9a6bfbbdd3aef6d74a8428cf4e',
  cpu: [
    llama(
      'llama-b12490-bin-win-cpu-x64.zip',
      25444064,
      'f284c21e706bd116c00092a7b3fd02d37552779b9af60495dfac5afc84dbced4',
    ),
  ],
  cuda: [
    llama(
      'llama-b12490-bin-win-cuda-12.4-x64.zip',
      321604405,
      '8bb1670dcc7ef0eda5d619b3c2c7632efa1c561e83e7b4ffda8739095ab7afb3',
    ),
    llama(
      'cudart-llama-bin-win-cuda-12.4-x64.zip',
      391443627,
      '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
    ),
  ],
} as const;

export interface LocalAssistantModel {
  id: LocalAssistantModelId;
  name: string;
  /** Short plain description for the picker. */
  blurb: string;
  model: PinnedFile;
  /** Lets it look at pictures. */
  vision: PinnedFile;
  /** Rough graphics memory while loaded, in MiB. */
  gpuMiB: number;
  /** Mixture of experts: the expert weights stay in system memory so the card keeps room for images. */
  moe?: boolean;
  /** Smallest card that should run it on the graphics card. */
  minVramMiB: number;
  minRamBytes: number;
  license: string;
}

const hf = (repository: string, revision: string, filename: string, bytes: number, sha256: string): PinnedFile => ({
  filename,
  url: `https://huggingface.co/${repository}/resolve/${revision}/${filename}`,
  bytes,
  sha256,
});
const GiB = 1024 ** 3;

export const LOCAL_ASSISTANT_MODELS: Readonly<Record<LocalAssistantModelId, LocalAssistantModel>> = {
  'qwen35-4b': {
    id: 'qwen35-4b',
    name: 'Qwen3.5 4B',
    blurb: 'Light. Runs on any PC, even on the processor. Good for quick tidy-ups.',
    model: hf(
      'unsloth/Qwen3.5-4B-GGUF',
      'e87f176479d0855a907a41277aca2f8ee7a09523',
      'Qwen3.5-4B-Q4_K_M.gguf',
      2740937888,
      '00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4',
    ),
    vision: {
      ...hf(
        'unsloth/Qwen3.5-4B-GGUF',
        'e87f176479d0855a907a41277aca2f8ee7a09523',
        'mmproj-F16.gguf',
        672423616,
        'cd88edcf8d031894960bb0c9c5b9b7e1fea6ebee02b9f7ce925a00d12891f864',
      ),
    },
    gpuMiB: 4500,
    minVramMiB: 6 * 1024,
    minRamBytes: 8 * GiB,
    license: 'Apache 2.0',
  },
  'qwen35-9b': {
    id: 'qwen35-9b',
    name: 'Qwen3.5 9B',
    blurb: 'Balanced. Noticeably smarter. Best on a 12 to 16 GB graphics card.',
    model: hf(
      'unsloth/Qwen3.5-9B-GGUF',
      '3885219b6810b007914f3a7950a8d1b469d598a5',
      'Qwen3.5-9B-Q4_K_M.gguf',
      5680522464,
      '03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8',
    ),
    vision: hf(
      'unsloth/Qwen3.5-9B-GGUF',
      '3885219b6810b007914f3a7950a8d1b469d598a5',
      'mmproj-F16.gguf',
      918166080,
      'f70dc3509053962b0d0d3ee8a7eacebf5d60aa560cad78254ae8698516ae029f',
    ),
    gpuMiB: 8000,
    minVramMiB: 10 * 1024,
    minRamBytes: 16 * GiB,
    license: 'Apache 2.0',
  },
  'qwen36-35b': {
    id: 'qwen36-35b',
    name: 'Qwen3.6 35B',
    blurb: 'Smartest. Needs a 24 GB card and 48 GB of memory. Most of it sits in system memory, so images still fit.',
    model: hf(
      'unsloth/Qwen3.6-35B-A3B-GGUF',
      'a483e9e6cbd595906af30beda3187c2663a1118c',
      'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf',
      22134528992,
      'ac0e2c1189e055faa36eff361580e79c5bd6f8e76bffb4ce547f167d53e31a61',
    ),
    vision: hf(
      'unsloth/Qwen3.6-35B-A3B-GGUF',
      'a483e9e6cbd595906af30beda3187c2663a1118c',
      'mmproj-F16.gguf',
      899283680,
      '8971ee4f331ff0a4c609374f32984b3d4e6dc086c0aa35f1d637fad1829e887f',
    ),
    gpuMiB: 6000,
    moe: true,
    minVramMiB: 20 * 1024,
    minRamBytes: 48 * GiB,
    license: 'Apache 2.0',
  },
};
export const LOCAL_ASSISTANT_MODEL_IDS = Object.keys(LOCAL_ASSISTANT_MODELS) as LocalAssistantModelId[];

/** Bytes to download for a local model, plus the runtime if it isn't there yet. */
export function localModelBytes(id: LocalAssistantModelId) {
  const model = LOCAL_ASSISTANT_MODELS[id];
  return model.model.bytes + model.vision.bytes;
}
export function runtimeBytes(kind: 'cpu' | 'cuda') {
  return LOCAL_ASSISTANT_RUNTIME[kind].reduce((total, file) => total + file.bytes, 0);
}

/** The local model that suits this PC best. */
export function recommendedLocalModel(hardware: { vramMiB?: number; ramBytes?: number }): LocalAssistantModelId {
  const vram = Number.isFinite(hardware.vramMiB) ? hardware.vramMiB! : 0;
  const ram = hardware.ramBytes ?? 0;
  for (const id of ['qwen36-35b', 'qwen35-9b'] as const) {
    const model = LOCAL_ASSISTANT_MODELS[id];
    if (vram >= model.minVramMiB && ram >= model.minRamBytes) return id;
  }
  return 'qwen35-4b';
}

export const DEFAULT_ASSISTANT_SETTINGS: AssistantSettings = {
  provider: 'local',
  models: { anthropic: 'claude-opus-5-5' },
  customUrl: 'http://localhost:1234/v1',
  localModel: 'qwen35-9b',
  localDevice: 'auto',
};

export function providerName(id: AssistantProviderId) {
  return id === 'local' ? 'On this PC' : CLOUD_PROVIDERS[id].name;
}

/** Picks a sensible model from a provider's list when the person hasn't chosen one. */
export function pickDefaultModel(provider: CloudProviderId, options: AssistantModelOption[]): string | undefined {
  const definition = CLOUD_PROVIDERS[provider];
  if (definition.models?.length) return definition.models[0].id;
  for (const pattern of definition.preferred ?? []) {
    const matches = options.filter(option => pattern.test(option.id)).map(option => option.id);
    if (matches.length) return matches.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  }
  return undefined;
}

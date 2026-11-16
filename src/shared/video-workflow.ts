import type { ComfyWorkflow } from './types';
import type { VideoAssetIdentity, VideoPlan, VideoWorkflowContract } from './video-types';

export interface VideoAssetBinding {
  role: VideoAssetIdentity['role'];
  filename: string;
  sha256: string;
  bytes: number;
}
export function safeVideoRelativeFilename(value: string, extension: '.png' | '.safetensors') {
  if (
    typeof value !== 'string' ||
    value.length > 512 ||
    !value.toLowerCase().endsWith(extension) ||
    value
      .split('/')
      .some(
        part =>
          !/^[a-z0-9][a-z0-9_. -]{0,239}$/i.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error('A video file has an unsafe name.');
  return value;
}

/** Node names for the optional speed add-ons. */
export const VIDEO_ATTENTION_NODE = 'LatentVideoAttention';
export const SOL_ATTENTION_NODE = 'LatentSolAttention';

/** Settings the Sol add-on was tested with on a 3090. */
export const SOL_SETTINGS = Object.freeze({
  tau: 1.3,
  dense_blocks: '0-2',
  int8_qk: true,
  int8_pv: true,
  sink_conditioning: 'exact_kv_and_rows',
});

/**
 * Builds the engine graph for one clip. The plan already holds every choice; this only lays out nodes.
 * `globalSage` is true when the engine itself was started with SageAttention for everything.
 */
export function buildVideoWorkflow(
  input: {
    plan: VideoPlan;
    jobId: string;
    sourceFilenames: Record<string, string>;
    globalSage?: boolean;
  },
  bindings: readonly VideoAssetBinding[],
): VideoWorkflowContract {
  const { plan } = input;
  if (!/^[a-f0-9]{32}$/.test(input.jobId)) throw new Error('The video job needs a 32-character ID.');
  const names = new Map<string, string>();
  for (const asset of plan.assets) {
    const binding = bindings.find(value => value.role === asset.role);
    if (!binding) throw new Error(`The video ${asset.role} file is missing.`);
    names.set(asset.role, safeVideoRelativeFilename(binding.filename, '.safetensors'));
  }
  const filenamePrefix = `Latent_${input.jobId}_video`;
  let model: [string, number] = ['1', 0];
  const workflow: ComfyWorkflow = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: names.get('diffusion')!, weight_dtype: 'default' } },
    '2': {
      class_type: 'CLIPLoader',
      inputs: { clip_name: names.get('encoder')!, type: 'minimax', device: plan.sampling.textEncoderDevice },
    },
    '3': { class_type: 'VAELoader', inputs: { vae_name: names.get('videoVae')! } },
    '5': {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: ['2', 0],
        vae: ['3', 0],
        prompt: plan.draft.prompt,
        width: plan.width,
        height: plan.height,
        length: plan.frames,
      },
    },
    '6': { class_type: 'RandomNoise', inputs: { noise_seed: Number(plan.actualSeed) } },
    '7': { class_type: 'KSamplerSelect', inputs: { sampler_name: plan.sampling.sampler } },
  };
  if (plan.draft.profile === 'turbo8') {
    workflow['16'] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { model, lora_name: names.get('turbo')!, strength_model: 1 },
    };
    model = ['16', 0];
  }
  const attention = plan.sampling.attention;
  // Sage comes from the engine-wide setting when it is on; otherwise a small node switches this model only.
  if (attention === 'normal' ? input.globalSage : !input.globalSage) {
    workflow['17'] = {
      class_type: VIDEO_ATTENTION_NODE,
      inputs: { model, attention: attention === 'normal' ? 'normal' : 'sage' },
    };
    model = ['17', 0];
  }
  if (attention === 'sage-sol') {
    workflow['18'] = { class_type: SOL_ATTENTION_NODE, inputs: { model, ...SOL_SETTINGS } };
    model = ['18', 0];
  }
  Object.assign(workflow, {
    '8': {
      class_type: 'BasicScheduler',
      inputs: { model, scheduler: plan.sampling.scheduler, steps: plan.sampling.steps, denoise: 1 },
    },
    '9': { class_type: 'BasicGuider', inputs: { model, conditioning: ['5', 0] } },
    '10': {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['6', 0], guider: ['9', 0], sampler: ['7', 0], sigmas: ['8', 0], latent_image: ['5', 1] },
    },
    '11': !plan.decode.tiled
      ? { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } }
      : {
          class_type: 'VAEDecodeTiled',
          inputs: {
            samples: ['10', 0],
            vae: ['3', 0],
            tile_size: plan.decode.tileSize,
            overlap: plan.decode.overlap,
            temporal_size: plan.decode.temporalSize,
            temporal_overlap: plan.decode.temporalOverlap,
          },
        },
    '14': { class_type: 'CreateVideo', inputs: { images: ['11', 0], fps: 24 } },
    // V3 dynamic inputs are flattened on the API wire; the engine rebuilds the nested choices.
    '15': {
      class_type: 'SaveVideo',
      inputs: {
        video: ['14', 0],
        filename_prefix: filenamePrefix,
        format: 'mp4',
        'format.codec': 'h264',
        'format.codec.encoding': 're-encode',
        'format.codec.encoding.crf': 23,
      },
    },
  } satisfies ComfyWorkflow);
  if (plan.draft.audio === 'stereo-candidate') {
    workflow['4'] = { class_type: 'VAELoader', inputs: { vae_name: names.get('audioVae')! } };
    workflow['12'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 0], vae: ['4', 0] } };
    workflow['14'].inputs.audio = ['12', 0];
  }
  const sourceFilenames: string[] = [];
  for (const source of plan.sources) {
    const filename = safeVideoRelativeFilename(input.sourceFilenames[source.sourceId], '.png');
    const load = source.role === 'first' ? '20' : '22';
    const scale = source.role === 'first' ? '21' : '23';
    workflow[load] = { class_type: 'LoadImage', inputs: { image: filename } };
    workflow[scale] = {
      class_type: 'ImageScale',
      inputs: {
        image: [load, 0],
        width: plan.width,
        height: plan.height,
        upscale_method: 'lanczos',
        crop: source.resize === 'center-crop' ? 'center' : 'disabled',
      },
    };
    workflow['5'].inputs[source.role === 'first' ? 'first_frame' : 'last_frame'] = [scale, 0];
    sourceFilenames.push(filename);
  }
  return {
    schema: 2,
    plan,
    workflow,
    output: { nodeId: '15', filenamePrefix, extension: '.mp4' },
    sourceFilenames: [...new Set(sourceFilenames)],
  };
}

const MISSING_NODE_HELP: Record<string, string> = {
  MiniMaxH3ImageToVideo: 'This engine version has no H3 support. Update the engine in Settings.',
  [VIDEO_ATTENTION_NODE]: 'The engine needs a restart to pick up the video speed switch.',
  [SOL_ATTENTION_NODE]: 'Sol isn’t installed. Install it in the Speed panel, or pick Sage.',
};

/** Light check that the engine has every node and model file this graph needs. Returns the graph with
 * file names spelled the way the engine lists them (Windows uses backslashes). */
export function bindVideoWorkflow(
  contract: VideoWorkflowContract,
  objects: Record<string, any>,
): VideoWorkflowContract {
  const result = structuredClone(contract);
  for (const node of Object.values(result.workflow)) {
    const definition = objects[node.class_type];
    if (!definition)
      throw new Error(MISSING_NODE_HELP[node.class_type] ?? `The engine is missing the ${node.class_type} node.`);
    for (const field of ['unet_name', 'clip_name', 'vae_name', 'lora_name'] as const) {
      const value = node.inputs[field];
      if (typeof value !== 'string') continue;
      const spec = definition.input?.required?.[field];
      const options: unknown[] = Array.isArray(spec?.[0]) ? spec[0] : (spec?.[1]?.options ?? []);
      const match = options.find(
        option => typeof option === 'string' && option.replaceAll('\\', '/') === value.replaceAll('\\', '/'),
      );
      if (typeof match !== 'string')
        throw new Error(`The engine can’t see ${value.split('/').at(-1)}. Restart the engine and try again.`);
      node.inputs[field] = match;
    }
  }
  return result;
}

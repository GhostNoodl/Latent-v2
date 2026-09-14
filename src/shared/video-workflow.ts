import { planVideo } from './video-plan';
import type { SourceImageAsset } from './source-types';
import type { ComfyWorkflow } from './types';
import type { VideoAssetIdentity, VideoDraft, VideoWorkflowContract } from './video-types';

export interface VideoAssetBinding { role: VideoAssetIdentity['role']; filename: string; sha256: string; bytes: number; }
export function safeVideoRelativeFilename(value: string, extension: '.png' | '.safetensors') {
  if (typeof value !== 'string' || value.length > 512 || !value.toLowerCase().endsWith(extension) || value.split('/').some(part => !/^[a-z0-9][a-z0-9_. -]{0,239}$/i.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error('Video dependencies require safe relative filenames from verified private paths.');
  return value;
}
/** Graph authoring only. No model loading, right to use, availability check or backend submission occurs. */
export function buildVideoWorkflow(input: { draft: VideoDraft; actualSeed: string; sources: readonly SourceImageAsset[]; sourceFilenames: Record<string, string>; jobId: string }, bindings: readonly VideoAssetBinding[]): VideoWorkflowContract {
  const plan = planVideo(input.draft, { actualSeed: input.actualSeed, sources: input.sources });
  if (!/^[a-f0-9]{32}$/.test(input.jobId)) throw new Error('The video job identifier must be an immutable 32-character ID.');
  if (bindings.length !== plan.assets.length) throw new Error('The video candidate asset set must match the selected profile.');
  const names = new Map<string, string>();
  for (const asset of plan.assets) {
    const matches = bindings.filter(value => value.role === asset.role); const binding = matches[0];
    if (matches.length !== 1 || binding.sha256 !== asset.sha256 || binding.bytes !== asset.bytes || binding.filename.split('/').at(-1) !== asset.filename.split('/').at(-1)) throw new Error(`Video ${asset.role} identity differs from the reviewed candidate.`);
    names.set(asset.role, safeVideoRelativeFilename(binding.filename, '.safetensors'));
  }
  const filenamePrefix = `Latent_${input.jobId}_video`; const model: [string, number] = [plan.draft.attention === 'sage-auto' ? '17' : plan.draft.profile === 'turbo8' ? '16' : '1', 0];
  const workflow: ComfyWorkflow = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: names.get('diffusion')!, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: names.get('encoder')!, type: 'minimax', device: plan.sampling.textEncoderDevice } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: names.get('videoVae')! } },
    '5': { class_type: 'MiniMaxH3ImageToVideo', inputs: { clip: ['2', 0], vae: ['3', 0], prompt: plan.draft.prompt, width: plan.width, height: plan.height, length: plan.frames } },
    '6': { class_type: 'RandomNoise', inputs: { noise_seed: Number(plan.actualSeed) } },
    '7': { class_type: 'KSamplerSelect', inputs: { sampler_name: plan.sampling.sampler } },
    '8': { class_type: 'BasicScheduler', inputs: { model, scheduler: plan.sampling.scheduler, steps: plan.sampling.steps, denoise: 1 } },
    '9': { class_type: 'BasicGuider', inputs: { model, conditioning: ['5', 0] } },
    '10': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['6', 0], guider: ['9', 0], sampler: ['7', 0], sigmas: ['8', 0], latent_image: ['5', 1] } },
    '11': !plan.decode.tiled ? { class_type: 'VAEDecode', inputs: { samples: ['10', 0], vae: ['3', 0] } } : { class_type: 'VAEDecodeTiled', inputs: { samples: ['10', 0], vae: ['3', 0], tile_size: plan.decode.tileSize, overlap: plan.decode.overlap, temporal_size: plan.decode.temporalSize, temporal_overlap: plan.decode.temporalOverlap } },
    '14': { class_type: 'CreateVideo', inputs: { images: ['11', 0], fps: 24, bit_depth: 8, color_space: 'sRGB' } },
    // V3 dynamic inputs are flattened on the API wire; Comfy reconstructs nested execution dictionaries.
    '15': { class_type: 'SaveVideo', inputs: { video: ['14', 0], filename_prefix: filenamePrefix, format: 'mp4', 'format.codec': 'h264', 'format.codec.encoding': 're-encode', 'format.codec.encoding.crf': 23 } },
  };
  if (plan.draft.attention === 'sage-auto') workflow['17'] = { class_type: 'LatentVideoAttention', inputs: { model: ['1', 0], attention: 'sage-auto' } };
  if (plan.draft.audio === 'stereo-candidate') {
    workflow['4'] = { class_type: 'VAELoader', inputs: { vae_name: names.get('audioVae')! } };
    workflow['12'] = { class_type: 'VAEDecodeAudio', inputs: { samples: ['10', 0], vae: ['4', 0] } };
    workflow['14'].inputs.audio = ['12', 0];
  }
  if (plan.draft.profile === 'turbo8') workflow['16'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: names.get('turbo')!, strength_model: 1 } };
  const verifiedSourceFilenames: string[] = [];
  for (const source of plan.sources) {
    const filename = safeVideoRelativeFilename(input.sourceFilenames[source.sourceId], '.png'); const load = source.role === 'first' ? '20' : '22'; const scale = source.role === 'first' ? '21' : '23';
    workflow[load] = { class_type: 'LoadImage', inputs: { image: filename } };
    workflow[scale] = { class_type: 'ImageScale', inputs: { image: [load, 0], width: plan.width, height: plan.height, upscale_method: 'lanczos', crop: source.resize === 'center-crop' ? 'center' : 'disabled' } };
    workflow['5'].inputs[source.role === 'first' ? 'first_frame' : 'last_frame'] = [scale, 0]; verifiedSourceFilenames.push(filename);
  }
  return { schema: 1, plan, workflow, output: { nodeId: '15', filenamePrefix, extension: '.mp4', expectedCount: 1, historyKey: 'images', animated: true }, verifiedSourceFilenames: [...new Set(verifiedSourceFilenames)] };
}
type SchemaMap = Record<string, any>;
const choices = (definition: any): unknown[] => Array.isArray(definition?.[0]) ? definition[0] : definition?.[0] === 'COMBO' ? definition[1]?.options ?? [] : [];
const schemaObject = (value: any): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
/** Only the chosen dynamic branches exist on the API wire. Defaults are not
 * frozen recipe values, so even a new required field with a default must fail. */
function activeVideoInputs(definition: any, supplied: Record<string, unknown>, classType: string): Map<string, any> {
  const active = new Map<string, any>();
  const visit = (groups: any, prefix = '', depth = 0) => {
    if (!schemaObject(groups) || depth > 16) throw new Error(`The engine changed the ${classType} input schema.`);
    for (const group of ['required', 'optional']) {
      const fields = groups[group];
      if (fields === undefined) continue;
      if (!schemaObject(fields)) throw new Error(`The engine changed the ${classType} input schema.`);
      for (const [name, input] of Object.entries(fields)) {
        const path = prefix ? `${prefix}.${name}` : name;
        if (!name || name.includes('.') || active.has(path) || !Array.isArray(input) || !input.length) throw new Error(`The engine changed the ${classType}.${path} input schema.`);
        active.set(path, input);
        const present = Object.hasOwn(supplied, path);
        if (group === 'required' && !present) throw new Error(`The engine requires ${classType}.${path}, which is absent from the frozen video workflow.`);
        if (present && input[0] === 'COMFY_DYNAMICCOMBO_V3') {
          const options = input[1]?.options;
          const selected = Array.isArray(options) ? options.filter((option: any) => schemaObject(option) && option.key === supplied[path]) : [];
          if (typeof supplied[path] !== 'string' || selected.length !== 1) throw new Error(`The engine does not provide the reviewed video encoding choice at ${classType}.${path}.`);
          visit(selected[0].inputs, path, depth + 1);
        }
      }
    }
  };
  visit(definition.input);
  // Comfy supplies input.hidden itself; it is not part of the authored graph.
  return active;
}
/** Read-only capability binding. Must follow future main-process rights, source and full asset verification. */
export function bindVideoWorkflow(contract: VideoWorkflowContract, objects: SchemaMap): VideoWorkflowContract {
  if (contract.plan.draft.attention === 'sage-auto' && !objects.LatentVideoAttention) throw new Error('The private engine lacks LatentVideoAttention. Install the optional acceleration support or choose Default attention.');
  const result = structuredClone(contract); const outputs: Record<string, string[]> = { UNETLoader: ['MODEL'], CLIPLoader: ['CLIP'], VAELoader: ['VAE'], MiniMaxH3ImageToVideo: ['CONDITIONING', 'LATENT'], RandomNoise: ['NOISE'], KSamplerSelect: ['SAMPLER'], BasicScheduler: ['SIGMAS'], BasicGuider: ['GUIDER'], SamplerCustomAdvanced: ['LATENT', 'LATENT'], VAEDecodeTiled: ['IMAGE'], VAEDecode: ['IMAGE'], VAEDecodeAudio: ['AUDIO'], CreateVideo: ['VIDEO'], SaveVideo: ['VIDEO'], LoadImage: ['IMAGE', 'MASK'], ImageScale: ['IMAGE'], LoraLoaderModelOnly: ['MODEL'], LatentVideoAttention: ['MODEL'] };
  for (const node of Object.values(result.workflow)) {
    const definition = objects[node.class_type]; if (!definition || !outputs[node.class_type] || outputs[node.class_type].some((type, index) => definition.output?.[index] !== type || definition.output_is_list?.[index] === true) || definition.is_input_list === true) throw new Error(`The engine lacks the reviewed ${node.class_type} output contract.`);
    const activeInputs = activeVideoInputs(definition, node.inputs, node.class_type);
    for (const [name, value] of Object.entries(node.inputs)) {
      const input = activeInputs.get(name); if (!input) throw new Error(`The engine lacks ${node.class_type}.${name} in the selected input schema.`);
      if (Array.isArray(value)) { const source = result.workflow[value[0]]; const expected = source && objects[source.class_type]?.output?.[value[1]]; if (value.length !== 2 || typeof value[0] !== 'string' || !Number.isInteger(value[1]) || value[1] < 0 || !expected || input[0] !== expected) throw new Error(`The engine changed a video link type at ${node.class_type}.${name}.`); continue; }
      if (input[1]?.forceInput === true) throw new Error(`The engine now requires a link at ${node.class_type}.${name}.`);
      if (node.class_type === 'LoadImage' && name === 'image' && result.verifiedSourceFilenames.includes(String(value))) { if (input[1]?.multiselect === true || !Array.isArray(choices(input)) || !choices(input).length && input[0] !== 'COMBO' && !Array.isArray(input[0])) throw new Error('The source-image input is no longer a filename choice.'); continue; }
      if (input[0] === 'COMFY_DYNAMICCOMBO_V3') continue;
      if (input[0] === 'COMBO' || Array.isArray(input[0])) {
        const filename = ['UNETLoader.unet_name', 'CLIPLoader.clip_name', 'VAELoader.vae_name', 'LoraLoaderModelOnly.lora_name'].includes(`${node.class_type}.${name}`);
        const options = choices(input);
        const matches = Array.isArray(options) ? options.filter(option => filename && typeof option === 'string' && typeof value === 'string' ? option.replaceAll('\\', '/') === value : option === value) : [];
        if (input[1]?.multiselect === true || matches.length !== 1) throw new Error(`The engine does not offer the reviewed ${node.class_type}.${name}.`);
        if (filename) node.inputs[name] = matches[0] as string;
      } else if (input[0] === 'INT' || input[0] === 'FLOAT') {
        const bounds = input[1];
        if (bounds !== undefined && !schemaObject(bounds) || ['min', 'max'].some(key => bounds?.[key] !== undefined && (typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key]))) || typeof value !== 'number' || !Number.isFinite(value) || input[0] === 'INT' && !Number.isInteger(value) || value < (bounds?.min ?? -Infinity) || value > (bounds?.max ?? Infinity)) throw new Error(`The engine numeric range changed for ${node.class_type}.${name}.`);
      } else if (input[0] === 'STRING') {
        if (typeof value !== 'string') throw new Error(`The video string input ${name} is invalid.`);
      } else if (input[0] === 'BOOLEAN') {
        if (typeof value !== 'boolean') throw new Error(`The engine changed the video input type at ${node.class_type}.${name}.`);
      } else throw new Error(`The engine changed the video input type at ${node.class_type}.${name}.`);
    }
  }
  const writer = result.workflow[result.output.nodeId];
  const writerInputs = writer?.class_type === 'SaveVideo' ? activeVideoInputs(objects.SaveVideo, writer.inputs, 'SaveVideo') : undefined;
  if (!writerInputs || writer.inputs.format !== 'mp4' || writer.inputs['format.codec'] !== 'h264' || writer.inputs['format.codec.encoding'] !== 're-encode' || writer.inputs['format.codec.encoding.crf'] !== 23 || writerInputs.get('format')?.[0] !== 'COMFY_DYNAMICCOMBO_V3' || writerInputs.get('format.codec')?.[0] !== 'COMFY_DYNAMICCOMBO_V3' || writerInputs.get('format.codec.encoding')?.[0] !== 'COMFY_DYNAMICCOMBO_V3' || writerInputs.get('format.codec.encoding.crf')?.[0] !== 'FLOAT' || !objects.SaveVideo.output_node) throw new Error('The engine does not provide the reviewed MP4/H.264 output encoding contract.');
  return result;
}

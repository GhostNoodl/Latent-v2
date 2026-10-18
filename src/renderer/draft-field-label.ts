const labels: Record<string, string> = {
  prompt: 'the prompt',
  negativePrompt: 'the negative prompt',
  width: 'the width',
  height: 'the height',
  steps: 'Steps',
  cfg: 'CFG',
  seed: 'the seed',
  batchSize: 'the batch size',
  sampler: 'the sampler',
  scheduler: 'the scheduler',
  loras: 'a LoRA weight',
  hiresFix: 'the hires fix settings',
  autoFace: 'the face fix settings',
  faceDetailer: 'the face fix settings',
  upscale: 'the upscale settings',
  controlNet: 'the ControlNet settings',
  ipAdapter: 'the image reference settings',
  regionalPrompts: 'the regional prompts',
  dynamicPrompts: 'the prompt variations',
};

/** A plain name for the draft field a validation error points at, instead of a raw schema path. */
export function draftFieldLabel(path: readonly PropertyKey[]): string {
  const first = path[0];
  return (typeof first === 'string' && labels[first]) || 'one of the advanced settings';
}

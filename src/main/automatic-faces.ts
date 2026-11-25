import { DEFAULT_DRAFT } from '../shared/defaults';
import { draftSchema } from '../shared/validation';
import {
  isVideoJob,
  type GenerationDraft,
  type GenerationJob,
  type GenerationRecord,
  type StudioJob,
} from '../shared/types';
import type { FaceDetectionReceipt, FaceDetectionRequest } from '../shared/face-detailer-types';
import type { SourceImageAsset } from '../shared/source-types';
import type { FaceBox } from '../shared/face-detailer-types';
import {
  activeRegionLoras,
  activeRegionalPromptRegions,
  characterNegative,
  characterPrompt,
} from '../shared/regional-prompt-types';

/**
 * For a picture made with characters, find whose face each one is (by where its
 * centre falls) so the face fix uses that character's words and LoRAs.
 */
export function faceCharacters(record: GenerationRecord, faces: Array<{ box: FaceBox }>, withLoras: boolean) {
  const plan = record.regionalPrompts;
  if (!plan?.applied || plan.version !== 'sdxl-regional-conditioning@2') return undefined;
  const regions = activeRegionalPromptRegions(plan.settings);
  const sx = plan.canvas.width / record.width;
  const sy = plan.canvas.height / record.height;
  const scene = record.resolvedPrompt;
  const sceneNegative = record.dynamicPromptRecipe?.negative.resolved ?? record.draft.negativePrompt;
  const result = faces.map(face => {
    const cx = (face.box.x + face.box.width / 2) * sx;
    const cy = (face.box.y + face.box.height / 2) * sy;
    let best = -1;
    let bestDistance = Infinity;
    plan.regions.forEach((entry, index) => {
      const b = entry.pixelBounds;
      if (cx < b.x || cy < b.y || cx > b.x + b.width || cy > b.y + b.height) return;
      const distance = Math.hypot(cx - (b.x + b.width / 2), cy - (b.y + b.height / 2));
      if (distance < bestDistance) [best, bestDistance] = [index, distance];
    });
    const region = regions[best];
    if (!region) return null;
    return {
      prompt: characterPrompt(region, scene),
      negativePrompt: characterNegative(region, sceneNegative),
      loras: withLoras
        ? activeRegionLoras(region).flatMap(lora => {
            const file = plan.loraFiles?.find(entry => entry.modelId === lora.modelId);
            return file ? [{ filename: file.filename, weight: lora.weight, clipWeight: lora.clipWeight }] : [];
          })
        : [],
    };
  });
  return result.some(Boolean) ? result : undefined;
}

type Dependencies = {
  jobs(): StudioJob[];
  records(): readonly GenerationRecord[];
  save(job: GenerationJob): void;
  ready(): boolean;
  stopped(): boolean;
  source(record: GenerationRecord): Promise<SourceImageAsset>;
  detect(request: FaceDetectionRequest): Promise<FaceDetectionReceipt>;
  enqueue(draft: GenerationDraft): Promise<GenerationJob>;
};
export function automaticFaceDraft(record: GenerationRecord, detection: FaceDetectionReceipt): GenerationDraft {
  const settings = record.draft.autoFace;
  if (
    !settings ||
    !record.checkpoint ||
    detection.source.originGenerationId !== record.id ||
    detection.source.width !== record.width ||
    detection.source.height !== record.height
  )
    throw Error('The face refinement source does not match its saved image.');
  return draftSchema.parse({
    ...DEFAULT_DRAFT,
    family: record.draft.family,
    modelSampling: record.draft.modelSampling,
    checkpointId: record.checkpoint.id,
    loras: (settings.applyLoras === false ? [] : record.loras).map(l => ({
      modelId: l.id,
      weight: l.weight,
      clipWeight: l.clipWeight,
    })),
    assetHashes: Object.fromEntries(
      [record.checkpoint, ...(settings.applyLoras === false ? [] : record.loras)]
        .filter(a => a.sha256)
        .map(a => [a.id, a.sha256]),
    ),
    prompt: record.resolvedPrompt,
    negativePrompt: record.dynamicPromptRecipe?.negative.resolved ?? record.draft.negativePrompt,
    autoTriggers: false,
    triggerWords: Object.fromEntries(record.loras.map(l => [l.id, []])),
    width: 512,
    height: 512,
    steps: settings.steps ?? 20,
    cfg: settings.cfg ?? record.draft.cfg,
    sampler: settings.sampler ?? record.draft.sampler,
    scheduler: settings.scheduler ?? record.draft.scheduler,
    seed: record.actualSeed,
    autoFaceParentRecordId: record.id,
    variationOfRecordId: record.id,
    faceCharacters: faceCharacters(record, detection.faces, settings.applyLoras !== false),
    faceDetailer: {
      request: {
        ...(settings.classic ? { classic: true } : {}),
        detectionId: detection.id,
        faceIds: detection.faces.map(f => f.id),
        denoise: settings.strength,
        contextPadding: 32,
        seed: record.actualSeed,
      },
    },
  });
}
/** Called serially by the queue. Durable child lineage repairs a crash between acceptance and parent bookkeeping. */
export async function processAutomaticFace(deps: Dependencies): Promise<void> {
  const jobs = deps.jobs();
  for (const parent of jobs) {
    if (
      isVideoJob(parent) ||
      parent.status !== 'completed' ||
      !parent.draft.autoFace ||
      parent.autoFaceFinished ||
      parent.draft.faceDetailer ||
      parent.draft.autoFaceParentRecordId
    )
      continue;
    const records = deps
      .records()
      .filter(
        r =>
          r.jobId === parent.id &&
          parent.outputIds.includes(r.id) &&
          (!parent.draft.hiresFix || r.outputRole === 'final'),
      );
    if (!records.length) {
      parent.autoFaceFinished = true;
      deps.save(parent);
      continue;
    }
    for (const record of records) {
      if (parent.autoFaceResults?.[record.id]) continue;
      const save = (result: NonNullable<GenerationJob['autoFaceResults']>[string]) => {
        parent.autoFaceResults = { ...parent.autoFaceResults, [record.id]: result };
        parent.autoFaceFinished = records.every(r => Boolean(parent.autoFaceResults?.[r.id]));
        deps.save(parent);
      };
      const existing = jobs.find(j => !isVideoJob(j) && j.draft.autoFaceParentRecordId === record.id);
      if (existing) {
        save({ state: 'queued', jobId: existing.id });
        continue;
      }
      if (!deps.ready() || deps.stopped()) return;
      try {
        const source = await deps.source(record);
        if (deps.stopped() || !deps.ready()) return;
        const detection = await deps.detect({
          sourceId: source.id,
          sourceSha256: source.normalized.sha256,
          profile: parent.draft.autoFace.profile,
          maxFaces: 4,
          confidence: parent.draft.autoFace.profile === 'illustrated' ? 0.5 : 0.7,
          expansion: 0.15,
          feather: 12,
        });
        if (deps.stopped()) return;
        if (
          detection.source.id !== source.id ||
          detection.source.sha256 !== source.normalized.sha256 ||
          detection.source.originGenerationId !== record.id
        )
          throw Error('Face detection returned a different source.');
        if (!detection.faces.length) {
          save({ state: 'skipped', message: 'No face found; original kept.' });
          return;
        }
        const child = await deps.enqueue(automaticFaceDraft(record, detection));
        save({ state: 'queued', jobId: child.id });
      } catch (error) {
        if (deps.stopped()) return;
        save({
          state: 'failed',
          message: `Face refinement could not start; original kept. ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      return;
    }
  }
}

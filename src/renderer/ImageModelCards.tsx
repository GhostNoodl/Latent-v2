import { Download, Sparkles, Square } from 'lucide-react';
import {
  IMAGE_MODEL_IDS,
  IMAGE_MODELS,
  engineSupportsImageModel,
  imageModelFileKey,
  imageModelFiles,
  type ImageModelId,
} from '../shared/image-models';
import type { AppSnapshot } from '../shared/types';

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

export const engineVersion = (snapshot: AppSnapshot) =>
  snapshot.runtimeUpdates.current?.backendVersion ?? snapshot.backend.version;

/** Bytes still to download, counting files shared with another model only once. */
export function imageModelMissingBytes(snapshot: AppSnapshot, id: ImageModelId) {
  const ready = new Set(snapshot.imageModels.readyFiles);
  return imageModelFiles(id)
    .filter(file => !ready.has(imageModelFileKey(file)))
    .reduce((sum, file) => sum + file.bytes, 0);
}

/** Why a newer image model can't make an image right now, or '' when it can. */
export function imageModelProblem(snapshot: AppSnapshot, id: ImageModelId) {
  const model = IMAGE_MODELS[id];
  if (snapshot.imageModels.installing === id) return `${model.name} is still downloading.`;
  if (!snapshot.imageModels.ready.includes(id)) return `Download ${model.name} first. Click the model chip to get it.`;
  const engine = engineVersion(snapshot);
  if (engine && !engineSupportsImageModel(engine, id))
    return `${model.name} needs a newer engine. Click the model chip and download it again to update.`;
  const draft = snapshot.draft;
  if (draft.loras.length) return `${model.name} can't use SDXL LoRAs. Remove them first.`;
  if (
    draft.imageInput ||
    draft.controlNet ||
    draft.hiresFix ||
    draft.upscale ||
    draft.enhance ||
    draft.ipAdapter ||
    draft.autoFace ||
    draft.regionalPrompts?.settings.enabled ||
    draft.split
  )
    return `${model.name} only does text to image for now. Turn off the extra image tools.`;
  if (Math.max(draft.width, draft.height) > 2048) return 'Images can be up to 2048 pixels per side.';
  return '';
}

function cardStatus(snapshot: AppSnapshot, id: ImageModelId) {
  const status = snapshot.imageModels;
  if (status.installing === id) return `Downloading… ${Math.round(status.progress ?? 0)}%`;
  if (status.ready.includes(id)) {
    const engine = engineVersion(snapshot);
    return engine && !engineSupportsImageModel(engine, id) ? 'Click to update the engine' : 'Ready';
  }
  const missing = imageModelMissingBytes(snapshot, id);
  const engine = engineVersion(snapshot);
  const update = engine && !engineSupportsImageModel(engine, id) ? ' + engine update' : '';
  return `Click to download ${gb(missing)}${update}`;
}

export function ImageModelCards({
  snapshot,
  selected,
  query,
  onChoose,
  onDownload,
  onCancel,
}: {
  snapshot: AppSnapshot;
  selected?: ImageModelId;
  query: string;
  onChoose(id: ImageModelId): void;
  onDownload(id: ImageModelId): void;
  onCancel(): void;
}) {
  const status = snapshot.imageModels;
  const ids = IMAGE_MODEL_IDS.filter(id =>
    `${IMAGE_MODELS[id].name} ${IMAGE_MODELS[id].group} ${IMAGE_MODELS[id].blurb}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <p className="hint">
        Newer models load their own text encoder and look, so SDXL LoRAs don't carry over. Text to image only for now.
      </p>
      {status.state === 'installing' && status.installing && (
        <div className="image-model-download" role="status">
          <span>{status.message}</span>
          <progress max={100} value={status.progress ?? 0} />
          <button type="button" onClick={onCancel}>
            <Square size={13} /> Stop
          </button>
        </div>
      )}
      {status.state === 'error' && status.message && <p className="hint error-text">{status.message}</p>}
      <div className="visual-model-grid">
        {ids.map(id => {
          const model = IMAGE_MODELS[id];
          const ready = status.ready.includes(id);
          const engine = engineVersion(snapshot);
          const usable = ready && (!engine || engineSupportsImageModel(engine, id));
          return (
            <button
              type="button"
              className="visual-model-card image-model-card"
              key={id}
              aria-pressed={selected === id}
              disabled={!usable && Boolean(status.installing) && status.installing !== id}
              title={`${model.promptTip}\n\nLicense: ${model.license.name}. ${model.license.note}`}
              onClick={() => (usable ? onChoose(id) : status.installing !== id && onDownload(id))}
            >
              <span className="model-artwork placeholder" aria-hidden="true">
                {usable ? <Sparkles /> : <Download />}
              </span>
              <strong>{model.name}</strong>
              <small>{model.blurb}</small>
              <small>{cardStatus(snapshot, id)}</small>
              <small className="image-model-license">{model.license.name}</small>
            </button>
          );
        })}
      </div>
      {!ids.length && <p>No newer models match your search.</p>}
    </>
  );
}

import { thumbnailUrl } from './thumbnail-url';
import { ContextMenu } from './ContextMenu';
import { useState } from 'react';
import { ArrowUpRight, Check, Download, ExternalLink, Info, Sparkles, Square } from 'lucide-react';
import {
  IMAGE_MODEL_IDS,
  IMAGE_MODELS,
  engineSupportsImageModel,
  imageModelFileKey,
  imageModelFiles,
  imageModelSizes,
  type ImageModelId,
} from '../shared/image-models';
import type { AppSnapshot } from '../shared/types';
import { recommendedSummary } from './image-model-settings';
import { Modal } from './ui';

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
  onChoose(id: ImageModelId, options?: { recommended?: boolean }): void;
  onDownload(id: ImageModelId): void;
  onCancel(): void;
}) {
  const [details, setDetails] = useState<ImageModelId>();
  const [menu, setMenu] = useState<{ id: ImageModelId; x: number; y: number; usable: boolean }>();
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
          const example = latestImage(snapshot, id);
          return (
            <div className="image-model-card-wrap" key={id}>
              <button
                type="button"
                className="visual-model-card image-model-card"
                aria-pressed={selected === id}
                disabled={!usable && Boolean(status.installing) && status.installing !== id}
                onContextMenu={event => {
                  event.preventDefault();
                  setMenu({ id, x: event.clientX, y: event.clientY, usable });
                }}
                onKeyDown={event => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenu({ id, x: rect.left + 12, y: rect.top + 12, usable });
                  }
                }}
                onClick={() => (usable ? onChoose(id) : status.installing !== id && onDownload(id))}
              >
                {example ? (
                  <img
                    className="model-artwork"
                    src={thumbnailUrl(example)}
                    alt={`Made with ${model.name}`}
                    loading="lazy"
                  />
                ) : (
                  <span className="model-artwork placeholder" aria-hidden="true">
                    {usable ? <Sparkles /> : <Download />}
                  </span>
                )}
                <strong>{model.name}</strong>
                <small>{model.blurb}</small>
                <small>{cardStatus(snapshot, id)}</small>
              </button>
              <button type="button" className="image-model-details-link" onClick={() => setDetails(id)}>
                <Info size={13} /> Details and best settings
              </button>
            </div>
          );
        })}
      </div>
      {!ids.length && <p>No newer models match your search.</p>}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={`${IMAGE_MODELS[menu.id].name} actions`}
          onClose={() => setMenu(undefined)}
          heading={{ title: IMAGE_MODELS[menu.id].name, detail: cardStatus(snapshot, menu.id) }}
          groups={[
            menu.usable
              ? [
                  {
                    label: 'Use this model',
                    icon: <Check size={15} />,
                    primary: true,
                    onSelect: () => onChoose(menu.id),
                  },
                  {
                    label: 'Use with best settings',
                    icon: <Sparkles size={15} />,
                    onSelect: () => onChoose(menu.id, { recommended: true }),
                  },
                ]
              : [
                  status.installing !== menu.id && {
                    label: 'Download it',
                    icon: <Download size={15} />,
                    primary: true,
                    onSelect: () => onDownload(menu.id),
                  },
                ],
            [
              {
                label: 'Details and best settings',
                icon: <Info size={15} />,
                onSelect: () => setDetails(menu.id),
              },
              {
                label: "Maker's page",
                icon: <ArrowUpRight size={15} />,
                onSelect: () => void window.latent.openImageModelPage(menu.id, 'source'),
              },
            ],
          ]}
        />
      )}
      {details && (
        <ImageModelDetails
          snapshot={snapshot}
          id={details}
          selected={selected === details}
          onClose={() => setDetails(undefined)}
          onUseRecommended={() => {
            setDetails(undefined);
            onChoose(details, { recommended: true });
          }}
        />
      )}
    </>
  );
}

/** Most recent saved image made with this model, used as its card art. */
function latestImage(snapshot: AppSnapshot, id: ImageModelId) {
  return snapshot.history.find(record => record.imageModel?.id === id)?.imageUrl;
}

export function ImageModelDetails({
  snapshot,
  id,
  selected,
  onClose,
  onUseRecommended,
}: {
  snapshot: AppSnapshot;
  id: ImageModelId;
  selected: boolean;
  onClose(): void;
  onUseRecommended(): void;
}) {
  const model = IMAGE_MODELS[id];
  const { guide } = model;
  const usable = snapshot.imageModels.ready.includes(id);
  const sizes = imageModelSizes(id);
  const total = imageModelFiles(id).reduce((sum, file) => sum + file.bytes, 0);
  return (
    <Modal title={model.name} onClose={onClose}>
      <div className="image-model-details">
        <p>
          {model.blurb} <span className="muted">By {guide.maker}.</span>
        </p>
        <h3>Best settings</h3>
        <dl className="metadata">
          <dt>Steps and CFG</dt>
          <dd>{recommendedSummary(id)}</dd>
          <dt>Sampler</dt>
          <dd>
            {model.defaults.sampler} / {model.defaults.scheduler}
          </dd>
          <dt>Sizes</dt>
          <dd>
            About {guide.megapixels.ideal} MP is the sweet spot, up to {Math.min(guide.megapixels.max, 4)} MP:{' '}
            {sizes.map(size => `${size.width}×${size.height}`).join(', ')}
          </dd>
          {guide.qualityTags && (
            <>
              <dt>Quality words</dt>
              <dd>
                <code>{guide.qualityTags}</code>
              </dd>
            </>
          )}
          <dt>Negative prompt</dt>
          <dd>
            {model.negative === 'zero' || model.defaults.cfg <= 1 ? (
              'Not used at CFG 1.'
            ) : guide.negative ? (
              <code>{guide.negative}</code>
            ) : (
              'Optional.'
            )}
          </dd>
        </dl>
        <h3>Prompt tips</h3>
        <ul className="image-model-tips">
          {guide.tips.map(tip => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
        <h3>License</h3>
        <p>
          {model.license.name}. {model.license.note}
        </p>
        <p className="muted small">
          {(total / 1e9).toFixed(1)} GB across 3 files (model, text encoder, VAE). Shared files are only stored once.
        </p>
        <div className="button-row">
          {usable && (
            <button type="button" onClick={onUseRecommended}>
              <Sparkles size={14} /> {selected ? 'Reset to best settings' : 'Use with best settings'}
            </button>
          )}
          <button type="button" onClick={() => void window.latent.openImageModelPage(id, 'source')}>
            <ExternalLink size={14} /> Model page
          </button>
          <button type="button" onClick={() => void window.latent.openImageModelPage(id, 'license')}>
            <ExternalLink size={14} /> License
          </button>
        </div>
      </div>
    </Modal>
  );
}

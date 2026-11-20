import { isLoraFamilyCompatible } from '../shared/types';
import { cleanModelStem } from '../shared/model-names';
import { thumbnailUrl } from './thumbnail-url';
import { useEffect, useState } from 'react';
import { Boxes, Image, Layers, Folder, Sparkles } from 'lucide-react';
import { IMAGE_MODEL_IDS, type ImageModelId } from '../shared/image-models';
import { ImageModelCards } from './ImageModelCards';
import type { AppSnapshot, ModelAsset } from '../shared/types';
import { LocalModelMetadata } from './LocalModelMetadata';
import { Modal, type RunAction } from './ui';
import { ModelMenu } from './ModelMenu';

const NEWER = '__newer-image-models';

export const modelDisplayName = (model: ModelAsset, showCivitai = true) =>
  (showCivitai ? model.civitai?.modelName?.trim() : '') || cleanModelStem(model.name);

export function ModelArtwork({
  model,
  history = [],
  showCivitai = true,
}: {
  model: ModelAsset;
  showCivitai?: boolean;
  history: AppSnapshot['history'];
}) {
  const example = history.find(record =>
    model.kind === 'checkpoint' ? record.checkpoint?.id === model.id : record.loras.some(lora => lora.id === model.id),
  );
  const [failed, setFailed] = useState<string[]>([]);
  useEffect(() => {
    setFailed([]);
  }, [model.id, model.civitai?.fetchedAt, model.civitai?.previewUrl]);
  const remote =
    showCivitai &&
    model.civitai?.previewUrl &&
    /^https:\/\/(image|imagecache)\.civitai\.com\//.test(model.civitai.previewUrl)
      ? model.civitai.previewUrl
      : undefined;
  // Small cached copies first; the full picture only if the copy can't be made.
  const candidates = [
    ...(remote
      ? [
          { src: thumbnailUrl(remote), remote: true },
          { src: remote, remote: true },
        ]
      : []),
    ...(example
      ? [
          { src: thumbnailUrl(example.imageUrl), remote: false },
          { src: example.imageUrl, remote: false },
        ]
      : []),
  ].filter((candidate, index, all) => all.findIndex(other => other.src === candidate.src) === index);
  const shown = candidates.find(candidate => !failed.includes(candidate.src));
  if (shown)
    return (
      <img
        key={shown.src}
        className="model-artwork"
        src={shown.src}
        referrerPolicy="no-referrer"
        alt={shown.remote ? `${model.name} creator preview` : `Generated example using ${model.name}`}
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={() => setFailed(previous => [...previous, shown.src])}
      />
    );
  return (
    <span className="model-artwork placeholder" aria-label="No preview yet">
      {model.kind === 'lora' ? <Layers /> : <Image />}
    </span>
  );
}

export function ModelPicker({
  snapshot,
  kind,
  selectedIds,
  family,
  onChoose,
  onClose,
  onUpdated,
  imageModel,
  onChooseImageModel,
  onDownloadImageModel,
}: {
  snapshot: AppSnapshot;
  onUpdated?(snapshot: AppSnapshot): void;
  /** Newer image model in use (checkpoint picker only). */
  imageModel?: ImageModelId;
  onChooseImageModel?(id: ImageModelId, options?: { recommended?: boolean }): void;
  onDownloadImageModel?(id: ImageModelId): void;
  kind: 'checkpoint' | 'lora';
  selectedIds: string[];
  family?: string;
  onChoose: (model: ModelAsset) => void;
  onClose: () => void;
}) {
  const [contextModel, setContextModel] = useState<ModelAsset>();
  const [menu, setMenu] = useState<{ model: ModelAsset; x: number; y: number }>();
  const [menuError, setMenuError] = useState('');
  const runMenuAction: RunAction = async (_key, task) => {
    setMenuError('');
    try {
      await task();
      return true;
    } catch (error) {
      setMenuError(error instanceof Error ? error.message : 'That did not work. Try again.');
      return false;
    }
  };
  const [query, setQuery] = useState('');
  const newer = kind === 'checkpoint' && Boolean(onChooseImageModel);
  const [collection, setCollection] = useState(newer && imageModel ? NEWER : '');
  const collections = snapshot.collections.collections
    .filter(item => item.kind === 'model')
    .sort((a, b) => a.name.localeCompare(b.name));
  useEffect(() => {
    if (
      collection &&
      collection !== NEWER &&
      !snapshot.collections.collections.some(item => item.kind === 'model' && item.id === collection)
    )
      setCollection('');
  }, [collection, snapshot.collections]);
  const inventory = snapshot.models.filter(model => model.kind === kind);
  const count = (ids?: string[]) => inventory.filter(model => !ids || ids.includes(model.id)).length;
  const members = collections.find(item => item.id === collection)?.memberIds;
  const models = snapshot.models.filter(
    model =>
      model.kind === kind &&
      (!members || members.includes(model.id)) &&
      `${modelDisplayName(model, snapshot.settings.civitaiDisplayMetadata !== false)} ${model.name} ${model.family} ${model.triggers.join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <Modal
      title={kind === 'checkpoint' ? (newer ? 'Choose a model' : 'Choose a checkpoint') : 'Add a LoRA'}
      onClose={onClose}
    >
      <div className="model-picker-layout">
        <nav className="picker-folders" aria-label="Model folders">
          <h4>Folders</h4>
          <button type="button" className="folder-target" aria-pressed={!collection} onClick={() => setCollection('')}>
            <span>All {kind === 'lora' ? 'LoRAs' : 'checkpoints'}</span>
            <span>{count()}</span>
          </button>
          {newer && (
            <button
              type="button"
              className="folder-target"
              aria-pressed={collection === NEWER}
              onClick={() => setCollection(NEWER)}
            >
              <Sparkles size={15} />
              <span className="folder-name">Newer models</span>
              <span>{IMAGE_MODEL_IDS.length}</span>
            </button>
          )}
          {collections.map(item => (
            <button
              key={item.id}
              type="button"
              className="folder-target"
              aria-pressed={collection === item.id}
              onClick={() => setCollection(item.id)}
            >
              <Folder size={15} />
              <span className="folder-name" title={item.name}>
                {item.name}
              </span>
              <span>{count(item.memberIds)}</span>
            </button>
          ))}
        </nav>
        <div className="model-picker-results">
          <div className="picker-filters">
            <input
              autoFocus
              aria-label="Search model cards"
              placeholder="Name, family or trigger…"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </div>
          {collection === NEWER && onChooseImageModel ? (
            <ImageModelCards
              snapshot={snapshot}
              selected={imageModel}
              query={query}
              onChoose={onChooseImageModel}
              onDownload={id => onDownloadImageModel?.(id)}
              onCancel={() => void window.latent.cancelImageModelSetup()}
            />
          ) : (
            <>
              <div className="visual-model-grid">
                {models.map(model => (
                  <button
                    type="button"
                    className="visual-model-card"
                    key={model.id}
                    onContextMenu={event => {
                      event.preventDefault();
                      setMenu({ model, x: event.clientX, y: event.clientY });
                    }}
                    onKeyDown={event => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        setMenu({ model, x: rect.left + 12, y: rect.top + 12 });
                      }
                    }}
                    aria-pressed={!imageModel && selectedIds.includes(model.id)}
                    disabled={
                      model.status !== 'ready' ||
                      (kind === 'lora' &&
                        (!isLoraFamilyCompatible(model.family, family) || selectedIds.includes(model.id)))
                    }
                    onClick={() => onChoose(model)}
                  >
                    <ModelArtwork
                      model={model}
                      showCivitai={snapshot.settings.civitaiDisplayMetadata !== false}
                      history={snapshot.history}
                    />
                    <strong>{modelDisplayName(model, snapshot.settings.civitaiDisplayMetadata !== false)}</strong>
                    <small>
                      <Boxes size={12} /> {model.family} · {(model.bytes / 1e9).toFixed(1)} GB
                    </small>
                    <small>
                      {model.status !== 'ready'
                        ? 'Missing file'
                        : kind === 'lora' && !isLoraFamilyCompatible(model.family, family)
                          ? 'Different checkpoint family'
                          : model.triggers.slice(0, 3).join(', ') || (model.kind === 'lora' ? 'LoRA' : 'Checkpoint')}
                    </small>
                  </button>
                ))}
              </div>
              {!models.length && <p>No matches in this folder. Try another folder or clear your search.</p>}
            </>
          )}
        </div>
      </div>
      {menuError && (
        <p role="alert" className="inline-error">
          {menuError}
        </p>
      )}
      {menu && (
        <ModelMenu
          model={menu.model}
          name={modelDisplayName(menu.model, snapshot.settings.civitaiDisplayMetadata !== false)}
          x={menu.x}
          y={menu.y}
          showCivitai={snapshot.settings.civitaiDisplayMetadata !== false}
          onClose={() => setMenu(undefined)}
          onUse={
            menu.model.status === 'ready' &&
            !(
              kind === 'lora' &&
              (!isLoraFamilyCompatible(menu.model.family, family) || selectedIds.includes(menu.model.id))
            )
              ? () => onChoose(menu.model)
              : undefined
          }
          onDetails={() => setContextModel(menu.model)}
          run={runMenuAction}
        />
      )}
      {contextModel && (
        <LocalModelMetadata onUpdated={onUpdated} model={contextModel} onClose={() => setContextModel(undefined)} />
      )}
    </Modal>
  );
}

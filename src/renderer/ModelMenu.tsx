import { ArrowUpRight, Check, Copy, FolderOpen, Info, Plus, Tags } from 'lucide-react';
import type { ModelAsset } from '../shared/types';
import { ContextMenu } from './ContextMenu';
import { thumbnailUrl } from './thumbnail-url';
import type { RunAction } from './ui';

/** Right-click menu for a checkpoint or LoRA card: use it, copy what you need, and find the file. */
export function ModelMenu({
  model,
  name,
  x,
  y,
  showCivitai,
  onClose,
  onUse,
  useLabel,
  onDetails,
  run,
}: {
  model: ModelAsset;
  name: string;
  x: number;
  y: number;
  showCivitai: boolean;
  onClose(): void;
  /** Picks this model (Create) when the caller allows it. */
  onUse?(): void;
  useLabel?: string;
  onDetails(): void;
  run: RunAction;
}) {
  const triggers = model.triggers.filter(Boolean);
  const civitai = showCivitai ? model.civitai : undefined;
  const preview =
    civitai?.previewUrl && /^https:\/\/(image|imagecache)\.civitai\.com\//.test(civitai.previewUrl)
      ? thumbnailUrl(civitai.previewUrl)
      : undefined;
  const file = model.filename.split('/').at(-1) ?? model.filename;
  return (
    <ContextMenu
      x={x}
      y={y}
      label={`${model.kind === 'lora' ? 'LoRA' : 'Checkpoint'} actions`}
      onClose={onClose}
      heading={{
        title: name,
        detail: `${model.kind === 'lora' ? 'LoRA' : 'Checkpoint'} · ${(model.bytes / 1e9).toFixed(1)} GB${
          model.status !== 'ready' ? ' · file missing' : ''
        }`,
        image: preview,
      }}
      groups={[
        [
          onUse && {
            label: useLabel ?? (model.kind === 'lora' ? 'Add this LoRA' : 'Use this checkpoint'),
            icon: model.kind === 'lora' ? <Plus size={15} /> : <Check size={15} />,
            primary: true,
            onSelect: onUse,
          },
        ],
        [
          triggers.length > 0 && {
            label: triggers.length === 1 ? 'Copy trigger word' : 'Copy trigger words',
            icon: <Tags size={15} />,
            onSelect: () => void run('copy-triggers', () => window.latent.copyText(triggers.join(', '))),
          },
          {
            label: 'Copy file name',
            icon: <Copy size={15} />,
            onSelect: () => void run('copy-model-name', () => window.latent.copyText(file)),
          },
        ],
        [
          {
            label: 'Details and triggers',
            icon: <Info size={15} />,
            onSelect: onDetails,
          },
          civitai && {
            label: 'Open on Civitai',
            icon: <ArrowUpRight size={15} />,
            onSelect: () =>
              void run('open-civitai', () => window.latent.openCivitaiModel(civitai.modelId, civitai.versionId)),
          },
          model.status === 'ready' && {
            label: 'Show in folder',
            icon: <FolderOpen size={15} />,
            onSelect: () => void run('reveal-model', () => window.latent.revealModel(model.id)),
          },
        ],
      ]}
    />
  );
}

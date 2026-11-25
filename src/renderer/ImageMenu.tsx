import {
  ArrowLeftRight,
  ArrowUpRight,
  Clapperboard,
  Copy,
  FileImage,
  FolderHeart,
  FolderOpen,
  Hash,
  Image,
  Layers,
  PenLine,
  RotateCcw,
  SlidersHorizontal,
  Shuffle,
  Trash2,
  Type,
  Wand2,
} from 'lucide-react';
import { enhancementActionLabel } from '../shared/enhancement';
import type { GenerationRecord } from '../shared/types';
import { ContextMenu } from './ContextMenu';
import { thumbnailUrl } from './thumbnail-url';
import { variationDescription } from './variation-description';
import type { RunAction } from './ui';

export interface ImageMenuActions {
  onReuse?(record: GenerationRecord): void;
  onVariation?(record: GenerationRecord): void;
  onEnhance?(record: GenerationRecord): void;
  enhanceMax?: number;
  onEdit?(record: GenerationRecord): void;
  onVideo?(record: GenerationRecord): void;
  onView?(record: GenerationRecord): void;
  onDetails?(record: GenerationRecord): void;
  onCollections?(record: GenerationRecord): void;
  /** Extra compare entries the caller knows about (source / result, original). */
  compares?: Array<{ label: string; run(): void }>;
  /** Other versions of the same picture. */
  versions?: Array<{ label: string; run(): void }>;
  onTrash?(record: GenerationRecord): void;
  run: RunAction;
}

const canVary = (record: GenerationRecord) => !record.draft.upscale && !record.qwenEdit && !record.faceDetailer;

/** Right-click menu for a saved picture: make more, copy, look closer, file, and bin. */
export function ImageMenu({
  record,
  x,
  y,
  onClose,
  actions,
}: {
  record: GenerationRecord;
  x: number;
  y: number;
  onClose(): void;
  actions: ImageMenuActions;
}) {
  const { run } = actions;
  const prompt = (record.resolvedPrompt ?? record.draft.prompt).trim();
  const tooBig = actions.enhanceMax !== undefined && Math.max(record.width, record.height) >= actions.enhanceMax;
  return (
    <ContextMenu
      x={x}
      y={y}
      label="Image actions"
      onClose={onClose}
      heading={{
        title: prompt || (record.qwenEdit ? 'Edited picture' : 'Untitled image'),
        detail: `${record.width} × ${record.height}${record.draft.upscale ? '' : ` · Seed ${record.actualSeed}`}`,
        image: thumbnailUrl(record.imageUrl),
      }}
      groups={[
        [
          actions.onReuse && {
            label: 'Reuse settings',
            icon: <RotateCcw size={15} />,
            primary: true,
            onSelect: () => actions.onReuse!(record),
          },
          actions.onVariation &&
            canVary(record) && {
              label: 'Make a variation',
              icon: <Shuffle size={15} />,
              title: variationDescription(record.draft),
              onSelect: () => actions.onVariation!(record),
            },
          actions.onEnhance &&
            !record.qwenEdit && {
              label: enhancementActionLabel(record, actions.enhanceMax),
              icon: <Wand2 size={15} />,
              disabled: tooBig,
              title: tooBig ? `Already at the ${actions.enhanceMax} pixel limit.` : undefined,
              onSelect: () => actions.onEnhance!(record),
            },
          actions.onEdit && {
            label: record.qwenEdit ? 'Keep editing' : 'Edit this picture',
            icon: <PenLine size={15} />,
            onSelect: () => actions.onEdit!(record),
          },
          actions.onVideo && {
            label: 'Make a video from it',
            icon: <Clapperboard size={15} />,
            onSelect: () => actions.onVideo!(record),
          },
        ],
        [
          {
            label: 'Copy image',
            icon: <Copy size={15} />,
            onSelect: () => void run('copy-output', () => window.latent.copyOutput(record.id)),
          },
          {
            label: 'Copy file',
            icon: <FileImage size={15} />,
            title: 'Paste it as a file in Explorer, Discord or a chat',
            onSelect: () => void run('copy-output-file', () => window.latent.copyOutputFile(record.id)),
          },
          Boolean(prompt) && {
            label: 'Copy prompt',
            icon: <Type size={15} />,
            onSelect: () => void run('copy-prompt', () => window.latent.copyText(prompt)),
          },
          !record.draft.upscale && {
            label: 'Copy seed',
            icon: <Hash size={15} />,
            onSelect: () => void run('copy-seed', () => window.latent.copyText(String(record.actualSeed))),
          },
        ],
        [
          actions.onView && {
            label: 'View on canvas',
            icon: <Image size={15} />,
            onSelect: () => actions.onView!(record),
          },
          actions.onDetails && {
            label: 'Show settings',
            icon: <SlidersHorizontal size={15} />,
            onSelect: () => actions.onDetails!(record),
          },
          ...(actions.compares ?? []).map(item => ({
            label: item.label,
            icon: <ArrowLeftRight size={15} />,
            onSelect: item.run,
          })),
          ...(actions.versions ?? []).map(item => ({
            label: item.label,
            icon: <Layers size={15} />,
            onSelect: item.run,
          })),
          actions.onCollections && {
            label: 'Add to a collection',
            icon: <FolderHeart size={15} />,
            onSelect: () => actions.onCollections!(record),
          },
        ],
        [
          {
            label: 'Open image',
            icon: <ArrowUpRight size={15} />,
            onSelect: () => void run('open-output', () => window.latent.openOutput(record.id)),
          },
          {
            label: 'Show in folder',
            icon: <FolderOpen size={15} />,
            onSelect: () => void run('reveal-output', () => window.latent.revealOutput(record.id)),
          },
        ],
        [
          actions.onTrash && {
            label: 'Move to Recycle Bin',
            icon: <Trash2 size={15} />,
            danger: true,
            onSelect: () => actions.onTrash!(record),
          },
        ],
      ]}
    />
  );
}

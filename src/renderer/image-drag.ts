import type { DragEvent } from 'react';
import type { SourceImageAsset } from '../shared/source-types';
import type { GenerationRecord } from '../shared/types';

/** Drag type for a saved image dragged out of the Library or a strip. */
export const RECORD_DRAG_TYPE = 'application/x-latent-image';

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i;

export function startRecordDrag(event: DragEvent, record: GenerationRecord) {
  event.dataTransfer.setData(RECORD_DRAG_TYPE, record.id);
  event.dataTransfer.effectAllowed = 'copy';
  const image = (event.currentTarget as HTMLElement).querySelector('img');
  if (image?.complete) event.dataTransfer.setDragImage(image, 24, 24);
}

/** True while something we can take (a saved image or an image file) is over the target. */
export function carriesImage(event: DragEvent) {
  const types = [...event.dataTransfer.types];
  return types.includes(RECORD_DRAG_TYPE) || types.includes('Files');
}

export type DroppedImage = { kind: 'record'; record: GenerationRecord } | { kind: 'file'; file: File };

/** What was dropped: a saved image from this studio first, else the first image file. */
export function droppedImage(
  transfer: Pick<DataTransfer, 'getData' | 'files'>,
  records: GenerationRecord[],
): DroppedImage | undefined {
  const id = transfer.getData(RECORD_DRAG_TYPE);
  const record = id ? records.find(item => item.id === id) : undefined;
  if (record) return { kind: 'record', record };
  const file = [...transfer.files].find(
    item => IMAGE_FILE.test(item.name) || /^image\/(png|jpeg|webp)$/.test(item.type),
  );
  return file ? { kind: 'file', file } : undefined;
}

/** Turns a drop into a source image the editors can use. */
export async function sourceFromDrop(drop: DroppedImage): Promise<SourceImageAsset> {
  if (drop.kind === 'record') return window.latent.useOutputAsSource(drop.record.id);
  return window.latent.importDroppedImage(new Uint8Array(await drop.file.arrayBuffer()), drop.file.name);
}

/** Props that make an element accept image drops, with a hover flag for styling. */
export function imageDropProps(
  setOver: (over: boolean) => void,
  onDrop: (transfer: DataTransfer) => void,
  disabled = false,
) {
  return {
    onDragEnter(event: DragEvent) {
      if (disabled || !carriesImage(event)) return;
      event.preventDefault();
      setOver(true);
    },
    onDragOver(event: DragEvent) {
      if (disabled || !carriesImage(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave(event: DragEvent) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
    },
    onDrop(event: DragEvent) {
      setOver(false);
      if (disabled || !carriesImage(event)) return;
      event.preventDefault();
      onDrop(event.dataTransfer);
    },
  };
}

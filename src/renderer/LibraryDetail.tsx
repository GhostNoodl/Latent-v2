import { Clapperboard, Maximize2, WandSparkles } from 'lucide-react';
import type { GenerationRecord } from '../shared/types';
import { groupImageVersions } from '../shared/image-versions';
import { ImagePreview } from './ImagePreview';
import { shortDate } from './ui';

/** The side panel on Library: the picked image, its versions and the settings behind it. */
export function LibraryDetail({
  record,
  records,
  onSelect,
  onReuse,
  onOpen,
  onEdit,
  onVideo,
}: {
  record: GenerationRecord;
  records: GenerationRecord[];
  onSelect: (record: GenerationRecord) => void;
  onReuse: (record: GenerationRecord) => void;
  onOpen: (record: GenerationRecord) => void;
  onEdit: (record: GenerationRecord) => void;
  onVideo: (record: GenerationRecord) => void;
}) {
  const versions = groupImageVersions(records).find(group =>
    group.versions.some(item => item.id === record.id),
  )?.versions;
  const prompt = record.resolvedPrompt || record.draft.prompt;
  const rows: Array<[string, string]> = [
    ['Model', record.checkpoint?.name ?? (record.qwenEdit ? 'Qwen image edit' : 'Resize')],
    ...(record.loras.length
      ? [['LoRA', record.loras.map(lora => `${lora.name} · ${lora.weight}`).join(', ')] as [string, string]]
      : []),
    ['Size', `${record.width}×${record.height}`],
    ...(record.qwenEdit
      ? []
      : [['Steps · Guidance', `${record.draft.steps} · ${record.draft.cfg}`] as [string, string]]),
    ['Seed', record.actualSeed],
    ['Made', shortDate(record.createdAt)],
  ];
  return (
    <aside className="library-detail" aria-label="Image details">
      <button type="button" className="library-detail-image" onClick={() => onOpen(record)} title="Open in Create">
        <ImagePreview key={record.imageUrl} src={record.imageUrl} alt={prompt || 'Generated image'} />
      </button>
      {versions && versions.length > 1 && (
        <div className="library-versions" role="group" aria-label="Versions">
          <span>Versions</span>
          {versions.map((version, index) => (
            <button
              type="button"
              key={version.id}
              aria-pressed={version.id === record.id}
              aria-label={`Version ${index + 1}`}
              onClick={() => onSelect(version)}
            >
              <img src={version.imageUrl} alt="" />
            </button>
          ))}
        </div>
      )}
      {prompt && <p className="library-prompt">{prompt}</p>}
      <dl className="library-facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <button type="button" className="primary" onClick={() => onReuse(record)}>
        Reuse settings
      </button>
      <div className="library-detail-actions">
        <button type="button" onClick={() => onOpen(record)}>
          <Maximize2 size={15} /> Open
        </button>
        <button type="button" onClick={() => onEdit(record)}>
          <WandSparkles size={15} /> Edit
        </button>
        <button type="button" onClick={() => onVideo(record)}>
          <Clapperboard size={15} /> Video
        </button>
      </div>
    </aside>
  );
}

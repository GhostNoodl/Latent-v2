import { useEffect, useState } from 'react';
import { Download, Link2 } from 'lucide-react';
import type { CivitaiHashMatch } from '../shared/civitai-types';
import type { GenerationDraft, ModelAsset } from '../shared/types';
import { bytes, type RunAction } from './ui';

/** Points a draft at a moved copy of a model: same file contents, new place. */
export function relinkDraft(draft: GenerationDraft, from: string, to: string): Partial<GenerationDraft> {
  const rename = <T,>(record: Record<string, T> | undefined) =>
    record && Object.hasOwn(record, from)
      ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key === from ? to : key, value]))
      : record;
  return {
    ...(draft.checkpointId === from ? { checkpointId: to } : {}),
    loras: draft.loras.map(lora => (lora.modelId === from ? { ...lora, modelId: to } : lora)),
    assetHashes: rename(draft.assetHashes),
    triggerWords: rename(draft.triggerWords),
  };
}

/** A ready local file with the same checksum as a missing one. */
export function movedCopy(models: ModelAsset[], hash: string | undefined, kind: ModelAsset['kind']) {
  if (!hash) return undefined;
  return models.find(model => model.status === 'ready' && model.kind === kind && model.sha256 === hash);
}

type Lookup = { state: 'looking' } | { state: 'found'; match: CivitaiHashMatch } | { state: 'none' | 'error' };

interface Part {
  id: string;
  name: string;
  kind: ModelAsset['kind'];
  hash?: string;
}

/** What this draft needs that the studio is missing, with one-click fixes and Get all. */
export function MissingParts({
  draft,
  parts,
  models,
  onChange,
  run,
}: {
  draft: GenerationDraft;
  parts: Part[];
  models: ModelAsset[];
  onChange(change: Partial<GenerationDraft>): void;
  run: RunAction;
}) {
  const [lookups, setLookups] = useState<Record<string, Lookup>>({});
  const [getting, setGetting] = useState<Record<string, boolean>>({});
  const toLookUp = parts.filter(part => part.hash && !movedCopy(models, part.hash, part.kind));
  const key = toLookUp.map(part => part.hash).join(',');
  useEffect(() => {
    let live = true;
    for (const part of toLookUp) {
      const hash = part.hash!;
      setLookups(value => (value[hash] ? value : { ...value, [hash]: { state: 'looking' } }));
      Promise.resolve()
        .then(() => window.latent.civitaiFindByHash(hash))
        .then(match => {
          if (live) setLookups(value => ({ ...value, [hash]: match ? { state: 'found', match } : { state: 'none' } }));
        })
        .catch(() => {
          if (live) setLookups(value => ({ ...value, [hash]: { state: 'error' } }));
        });
    }
    return () => {
      live = false;
    };
    // The list of checksums is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const moved = parts
    .map(part => ({ part, copy: movedCopy(models, part.hash, part.kind) }))
    .filter((item): item is { part: Part; copy: ModelAsset } => Boolean(item.copy));
  const downloadable = parts
    .map(part => ({ part, lookup: part.hash ? lookups[part.hash] : undefined }))
    .filter(
      (item): item is { part: Part; lookup: { state: 'found'; match: CivitaiHashMatch } } =>
        item.lookup?.state === 'found' && !getting[item.part.id],
    );
  const get = (part: Part, match: CivitaiHashMatch) => {
    setGetting(value => ({ ...value, [part.id]: true }));
    void run(`get-${part.id}`, async () => {
      try {
        await window.latent.civitaiDownload({
          modelId: match.modelId,
          versionId: match.versionId,
          fileId: match.fileId,
        });
      } finally {
        setGetting(value => ({ ...value, [part.id]: false }));
      }
    });
  };
  const fixAll = () => {
    let next = draft;
    for (const { part, copy } of moved) next = { ...next, ...relinkDraft(next, part.id, copy.id) };
    if (moved.length) onChange(relinkDraftAll(draft, next));
    for (const { part, lookup } of downloadable) get(part, lookup.match);
  };
  const fixable = moved.length + downloadable.length;
  return (
    <div className="missing-parts" role="group" aria-label="Missing models">
      <div className="missing-parts-head">
        <strong>{parts.length === 1 ? 'One model is missing' : `${parts.length} models are missing`}</strong>
        {fixable > 1 && (
          <button type="button" className="primary" onClick={fixAll}>
            Get all
          </button>
        )}
      </div>
      <ul>
        {parts.map(part => {
          const copy = movedCopy(models, part.hash, part.kind);
          const lookup = part.hash ? lookups[part.hash] : undefined;
          return (
            <li key={part.id}>
              <span className="missing-name" title={part.id}>
                {part.name}
              </span>
              {copy ? (
                <button type="button" onClick={() => onChange(relinkDraft(draft, part.id, copy.id))}>
                  <Link2 size={13} /> Use {copy.filename}
                </button>
              ) : getting[part.id] ? (
                <span className="muted">Downloading… see Models</span>
              ) : lookup?.state === 'found' ? (
                <button type="button" onClick={() => get(part, lookup.match)}>
                  <Download size={13} /> Get{lookup.match.bytes ? ` · ${bytes(lookup.match.bytes)}` : ''}
                </button>
              ) : lookup?.state === 'looking' ? (
                <span className="muted">Looking on Civitai…</span>
              ) : lookup?.state === 'error' ? (
                <span className="muted">Couldn’t reach Civitai</span>
              ) : (
                <span className="muted">Not found online. Add the file in Models.</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The fields relinking touches, taken from the fully relinked draft. */
function relinkDraftAll(before: GenerationDraft, after: GenerationDraft): Partial<GenerationDraft> {
  return {
    ...(after.checkpointId !== before.checkpointId ? { checkpointId: after.checkpointId } : {}),
    loras: after.loras,
    assetHashes: after.assetHashes,
    triggerWords: after.triggerWords,
  };
}

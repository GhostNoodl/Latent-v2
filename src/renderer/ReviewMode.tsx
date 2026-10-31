import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Star, Trash2, Undo2, X } from 'lucide-react';
import type { GenerationRecord } from '../shared/types';

export type ReviewMark = 'keep' | 'bin';

/** Marks after one key press, with what it replaced so Undo can put it back. */
export function applyMark(
  marks: Record<string, ReviewMark>,
  id: string,
  mark: ReviewMark,
): { marks: Record<string, ReviewMark>; previous?: ReviewMark } {
  const previous = marks[id];
  const next = { ...marks };
  if (previous === mark) delete next[id];
  else next[id] = mark;
  return { marks: next, previous };
}

/** Full-screen keep/bin pass over a set of images, driven by the keyboard. Nothing is deleted until Done. */
export function ReviewMode({
  records,
  startId,
  keptIds,
  onDone,
  onClose,
}: {
  records: GenerationRecord[];
  startId?: string;
  keptIds: Set<string>;
  onDone(result: { keep: GenerationRecord[]; bin: GenerationRecord[] }): void;
  onClose(): void;
}) {
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      records.findIndex(record => record.id === startId),
    ),
  );
  const [marks, setMarks] = useState<Record<string, ReviewMark>>({});
  const [history, setHistory] = useState<Array<{ id: string; previous?: ReviewMark; index: number }>>([]);
  const strip = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const current = records[Math.min(index, records.length - 1)];
  const mark = (value: ReviewMark) => {
    if (!current) return;
    const result = applyMark(marks, current.id, value);
    setMarks(result.marks);
    setHistory(list => [...list, { id: current.id, previous: result.previous, index }]);
    if (result.marks[current.id]) setIndex(i => Math.min(records.length - 1, i + 1));
  };
  const undo = () => {
    const last = history.at(-1);
    if (!last) return;
    setHistory(list => list.slice(0, -1));
    setMarks(value => {
      const next = { ...value };
      if (last.previous) next[last.id] = last.previous;
      else delete next[last.id];
      return next;
    });
    setIndex(last.index);
  };
  const done = () =>
    onDone({
      keep: records.filter(record => marks[record.id] === 'keep'),
      bin: records.filter(record => marks[record.id] === 'bin'),
    });
  useEffect(() => {
    root.current?.focus();
  }, []);
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-current="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [index]);
  const counts = Object.values(marks).reduce((total, value) => ({ ...total, [value]: total[value] + 1 }), {
    keep: 0,
    bin: 0,
  });
  return (
    <div
      className="review-mode"
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Review images"
      onKeyDown={event => {
        if (event.ctrlKey && event.key.toLowerCase() === 'z') undo();
        else if (event.key === 'ArrowRight') setIndex(i => Math.min(records.length - 1, i + 1));
        else if (event.key === 'ArrowLeft') setIndex(i => Math.max(0, i - 1));
        else if (event.key === 'Home') setIndex(0);
        else if (event.key === 'End') setIndex(records.length - 1);
        else if (event.key === '+' || event.key === '=' || event.key.toLowerCase() === 'k') mark('keep');
        else if (event.key === 'Delete' || event.key === 'Backspace' || event.key.toLowerCase() === 'x') mark('bin');
        else if (event.key === 'Escape') onClose();
        else if (event.key === 'Enter') done();
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <header className="review-top">
        <strong>Review</strong>
        <span className="muted">
          {index + 1} of {records.length}
        </span>
        <span className="review-counts">
          <span className="keep">
            <Star size={13} /> {counts.keep}
          </span>
          <span className="bin">
            <Trash2 size={13} /> {counts.bin}
          </span>
        </span>
        <span className="review-keys muted">
          <kbd>←</kbd> <kbd>→</kbd> move · <kbd>+</kbd> keep · <kbd>Del</kbd> bin · <kbd>Ctrl Z</kbd> undo
        </span>
        <button type="button" onClick={undo} disabled={!history.length}>
          <Undo2 size={14} /> Undo
        </button>
        <button type="button" className="primary" onClick={done}>
          Done
        </button>
        <button type="button" className="icon-button" aria-label="Close without changes" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {current && (
        <div className={`review-stage ${marks[current.id] ?? ''}`}>
          <button
            type="button"
            className="icon-button review-nav"
            aria-label="Previous image"
            disabled={index === 0}
            onClick={() => setIndex(i => Math.max(0, i - 1))}
          >
            <ArrowLeft size={20} />
          </button>
          <figure>
            <img src={current.imageUrl} alt={current.resolvedPrompt || current.draft.prompt || 'Image'} />
            {marks[current.id] && (
              <span className={`review-badge ${marks[current.id]}`}>
                {marks[current.id] === 'keep' ? 'Keep' : 'Bin'}
              </span>
            )}
            {!marks[current.id] && keptIds.has(current.id) && <span className="review-badge kept">Kept</span>}
          </figure>
          <button
            type="button"
            className="icon-button review-nav"
            aria-label="Next image"
            disabled={index >= records.length - 1}
            onClick={() => setIndex(i => Math.min(records.length - 1, i + 1))}
          >
            <ArrowRight size={20} />
          </button>
        </div>
      )}
      <div className="review-actions">
        <button type="button" aria-pressed={marks[current?.id] === 'keep'} onClick={() => mark('keep')}>
          <Star size={15} /> Keep
        </button>
        <button type="button" aria-pressed={marks[current?.id] === 'bin'} onClick={() => mark('bin')}>
          <Trash2 size={15} /> Bin
        </button>
      </div>
      <div className="review-strip" ref={strip}>
        {records.map((record, i) => (
          <button
            type="button"
            key={record.id}
            className={marks[record.id] ?? ''}
            aria-current={i === index ? 'true' : undefined}
            aria-label={`Image ${i + 1}`}
            onClick={() => setIndex(i)}
          >
            <img src={record.imageUrl} alt="" loading="lazy" />
          </button>
        ))}
      </div>
    </div>
  );
}

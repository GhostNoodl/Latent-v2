import { useRef, useState, type KeyboardEvent } from 'react';
import { GripVertical, X } from 'lucide-react';

/** Split a prompt at top-level commas, leaving commas inside (), [] and {} alone. */
export function splitPrompt(prompt: string): string[] {
  const pieces: string[] = [];
  let depth = 0,
    current = '';
  for (const char of prompt) {
    if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth = Math.max(0, depth - 1);
    if ((char === ',' || char === '\n') && depth === 0) {
      pieces.push(current);
      current = '';
    } else current += char;
  }
  pieces.push(current);
  return pieces.map(piece => piece.trim()).filter(Boolean);
}

export function joinPrompt(pieces: string[]) {
  return pieces
    .map(piece => piece.trim())
    .filter(Boolean)
    .join(', ');
}

export function movePiece(pieces: string[], from: number, to: number) {
  if (from === to || from < 0 || from >= pieces.length) return pieces;
  const next = [...pieces];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}

/** The prompt as draggable pieces: drag or Alt+arrow to reorder, Delete to remove, Enter to edit. */
export function PromptPieces({ value, onChange }: { value: string; onChange(value: string): void }) {
  const pieces = splitPrompt(value);
  const [dragging, setDragging] = useState<number>();
  const [over, setOver] = useState<number>();
  const [editing, setEditing] = useState<number>();
  const [draftText, setDraftText] = useState('');
  const [adding, setAdding] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const commit = (next: string[], focus?: number) => {
    onChange(joinPrompt(next));
    if (focus !== undefined)
      requestAnimationFrame(() => list.current?.querySelectorAll<HTMLElement>('.prompt-piece')[focus]?.focus());
  };
  const keys = (event: KeyboardEvent<HTMLElement>, index: number) => {
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      const to = index + (event.key === 'ArrowLeft' ? -1 : 1);
      if (to >= 0 && to < pieces.length) commit(movePiece(pieces, index, to), to);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      commit(
        pieces.filter((_, i) => i !== index),
        Math.min(index, pieces.length - 2),
      );
    } else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      setEditing(index);
      setDraftText(pieces[index]);
    }
  };
  return (
    <div
      className="prompt-pieces"
      ref={list}
      role="list"
      aria-label="Prompt pieces. Drag to reorder, or Alt plus arrow keys."
    >
      {pieces.map((piece, index) =>
        editing === index ? (
          <input
            key={`edit-${index}`}
            className="prompt-piece-edit"
            aria-label="Edit piece"
            autoFocus
            value={draftText}
            size={Math.max(4, draftText.length)}
            onChange={event => setDraftText(event.target.value)}
            onBlur={() => {
              setEditing(undefined);
              commit(pieces.map((p, i) => (i === index ? draftText : p)));
            }}
            onKeyDown={event => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setDraftText(piece);
                setEditing(undefined);
              }
            }}
          />
        ) : (
          <div
            key={`${index}-${piece}`}
            role="listitem"
            tabIndex={0}
            className={`prompt-piece ${dragging === index ? 'dragging' : ''} ${
              over === index && dragging !== undefined && dragging !== index ? 'drop-target' : ''
            }`}
            draggable
            title="Drag to move · double-click to edit"
            onDragStart={event => {
              setDragging(index);
              event.dataTransfer.effectAllowed = 'move';
              event.dataTransfer.setData('text/plain', piece);
            }}
            onDragOver={event => {
              if (dragging === undefined) return;
              event.preventDefault();
              setOver(index);
            }}
            onDrop={event => {
              event.preventDefault();
              if (dragging !== undefined) commit(movePiece(pieces, dragging, index));
              setDragging(undefined);
              setOver(undefined);
            }}
            onDragEnd={() => {
              setDragging(undefined);
              setOver(undefined);
            }}
            onDoubleClick={() => {
              setEditing(index);
              setDraftText(piece);
            }}
            onKeyDown={event => keys(event, index)}
          >
            <GripVertical size={12} aria-hidden="true" />
            <span>{piece}</span>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Remove ${piece}`}
              onClick={() => commit(pieces.filter((_, i) => i !== index))}
            >
              <X size={11} />
            </button>
          </div>
        ),
      )}
      <input
        className="prompt-piece-add"
        aria-label="Add a piece"
        placeholder={pieces.length ? 'Add…' : 'Type a piece and press Enter'}
        value={adding}
        onChange={event => setAdding(event.target.value)}
        onKeyDown={event => {
          if ((event.key === 'Enter' || event.key === ',') && adding.trim()) {
            event.preventDefault();
            commit([...pieces, adding]);
            setAdding('');
          }
        }}
        onBlur={() => {
          if (adding.trim()) {
            commit([...pieces, adding]);
            setAdding('');
          }
        }}
      />
    </div>
  );
}

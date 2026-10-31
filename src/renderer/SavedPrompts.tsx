import { useCallback, useState, type CSSProperties } from 'react';
import { Bookmark, Plus, Trash2 } from 'lucide-react';
import type { AppSettings } from '../shared/types';
import { useDismissiblePanel } from './useDismissiblePanel';

export type SavedPrompt = NonNullable<AppSettings['savedPrompts']>[number];
export const SAVED_PROMPT_LIMIT = 100;

function newId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function addSavedPrompt(list: SavedPrompt[], text: string): SavedPrompt[] {
  const clean = text.trim();
  if (!clean || list.some(item => item.text === clean)) return list;
  return [{ id: newId(), text: clean }, ...list].slice(0, SAVED_PROMPT_LIMIT);
}

/** Saved prompts kept right beside the prompt box: click to use, + to add to the end. */
export function SavedPrompts({
  prompt,
  saved,
  onUse,
  onSave,
}: {
  prompt: string;
  saved: SavedPrompt[];
  onUse(text: string): void;
  onSave(list: SavedPrompt[]): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  // The prompt area scrolls, so the panel is placed against the window, just above the button.
  const [place, setPlace] = useState<CSSProperties>();
  const [error, setError] = useState('');
  const close = useCallback(() => setOpen(false), []);
  useDismissiblePanel(open, close, '.saved-prompts');
  const already = saved.some(item => item.text === prompt.trim());
  const save = async (list: SavedPrompt[]) => {
    setError('');
    try {
      await onSave(list);
    } catch {
      setError('Could not save. Try again.');
    }
  };
  return (
    <div className="saved-prompts">
      <button
        type="button"
        className="text-button"
        aria-expanded={open}
        onClick={event => {
          const rect = event.currentTarget.getBoundingClientRect();
          setPlace({
            '--panel-bottom': `${Math.round(window.innerHeight - rect.top + 8)}px`,
            '--panel-left': `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - 436)))}px`,
          } as CSSProperties);
          setOpen(value => !value);
        }}
      >
        <Bookmark size={13} />
        Saved{saved.length ? ` ${saved.length}` : ''}
      </button>
      {open && (
        <div className="saved-prompts-panel" style={place} role="group" aria-label="Saved prompts">
          <button
            type="button"
            className="saved-prompts-save"
            disabled={!prompt.trim() || already || saved.length >= SAVED_PROMPT_LIMIT}
            onClick={() => void save(addSavedPrompt(saved, prompt))}
          >
            <Plus size={13} />
            {already ? 'This prompt is saved' : 'Save this prompt'}
          </button>
          {error && <p className="inline-error small">{error}</p>}
          {saved.length === 0 ? (
            <p className="muted small">Prompts you save show up here.</p>
          ) : (
            <ul>
              {saved.map(item => (
                <li key={item.id}>
                  <button
                    type="button"
                    className="saved-prompt-use"
                    title="Use this prompt"
                    onClick={() => {
                      onUse(item.text);
                      setOpen(false);
                    }}
                  >
                    {item.text}
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title="Add to the end of the prompt"
                    aria-label="Add to the end of the prompt"
                    onClick={() => {
                      onUse(prompt.trim() ? `${prompt.trim().replace(/,\s*$/, '')}, ${item.text}` : item.text);
                      setOpen(false);
                    }}
                  >
                    <Plus size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    title="Remove"
                    aria-label="Remove saved prompt"
                    onClick={() => void save(saved.filter(other => other.id !== item.id))}
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

import { useCallback, useRef, useState, type CSSProperties } from 'react';
import { Pencil, Plus, Puzzle, Trash2 } from 'lucide-react';
import type { AppSettings } from '../shared/types';
import { useDismissiblePanel } from './useDismissiblePanel';

export type PromptSnippet = NonNullable<AppSettings['promptSnippets']>[number];
export const SNIPPET_LIMIT = 200;

function newId() {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Tidy snippet text: trimmed, no trailing comma. */
export function cleanSnippet(text: string) {
  return text.trim().replace(/[\s,]+$/, '');
}

/** A short name from the first few tags, for snippets saved without one. */
export function snippetName(text: string) {
  const name = cleanSnippet(text).split(',').slice(0, 3).join(',').trim();
  return name.length > 40 ? `${name.slice(0, 39)}…` : name;
}

/** Adds a snippet, or replaces the one with the same id. Newest first. */
export function saveSnippet(list: PromptSnippet[], snippet: { id?: string; name: string; text: string }) {
  const text = cleanSnippet(snippet.text);
  if (!text) return list;
  const name = snippet.name.trim().slice(0, 60) || snippetName(text);
  if (snippet.id && list.some(item => item.id === snippet.id))
    return list.map(item => (item.id === snippet.id ? { id: item.id, name, text } : item));
  return [{ id: newId(), name, text }, ...list].slice(0, SNIPPET_LIMIT);
}

/**
 * Puts a snippet into the prompt at the cursor (replacing any selected text),
 * adding commas around it so the tags stay separate.
 */
export function insertSnippet(value: string, start: number, end: number, snippet: string) {
  const text = cleanSnippet(snippet);
  const from = Math.max(0, Math.min(start, value.length));
  const to = Math.max(from, Math.min(end, value.length));
  const before = value.slice(0, from).replace(/[ \t]+$/, '');
  const after = value.slice(to).replace(/^[ \t]+/, '');
  const lead = !before || /[(\n]$/.test(before) ? '' : before.endsWith(',') ? ' ' : ', ';
  const tail = !after || /^[,)\n]/.test(after) ? '' : ', ';
  const head = before + lead + text;
  return { value: head + tail + after, caret: head.length };
}

/** Matches by name or tags, every word anywhere. */
export function filterSnippets(list: PromptSnippet[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list;
  return list.filter(item => {
    const hay = `${item.name} ${item.text}`.toLowerCase();
    return words.every(word => hay.includes(word));
  });
}

type Form = { id?: string; name: string; text: string };

/** Reusable sets of tags: click one to drop it into the prompt at the cursor. */
export function PromptSnippets({
  targetId,
  value,
  snippets,
  onChange,
  onSave,
}: {
  /** The textarea the snippet goes into. Without it (Pieces view) snippets go at the end. */
  targetId: string;
  value: string;
  snippets: PromptSnippet[];
  onChange(value: string): void;
  onSave(list: PromptSnippet[]): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<CSSProperties>();
  const [query, setQuery] = useState('');
  const [form, setForm] = useState<Form>();
  const [error, setError] = useState('');
  const caret = useRef<{ start: number; end: number } | undefined>(undefined);
  const close = useCallback(() => {
    setOpen(false);
    setForm(undefined);
  }, []);
  useDismissiblePanel(open, close, `.prompt-snippets[data-target="${targetId}"]`);
  const target = () => {
    const element = document.getElementById(targetId);
    return element instanceof HTMLTextAreaElement ? element : undefined;
  };
  const save = async (list: PromptSnippet[]) => {
    setError('');
    try {
      await onSave(list);
      return true;
    } catch {
      setError('Could not save. Try again.');
      return false;
    }
  };
  const use = (snippet: PromptSnippet) => {
    const at = caret.current ?? { start: value.length, end: value.length };
    const next = insertSnippet(value, at.start, at.end, snippet.text);
    onChange(next.value);
    close();
    requestAnimationFrame(() => {
      const element = target();
      if (!element) return;
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };
  const submit = () => {
    if (!form || !cleanSnippet(form.text)) return;
    void save(saveSnippet(snippets, form)).then(ok => ok && setForm(undefined));
  };
  const shown = filterSnippets(snippets, query);
  return (
    <div className="prompt-snippets" data-target={targetId}>
      <button
        type="button"
        className="text-button"
        aria-expanded={open}
        title="Reusable sets of tags"
        onClick={event => {
          const element = target();
          caret.current = element ? { start: element.selectionStart, end: element.selectionEnd } : undefined;
          const rect = event.currentTarget.getBoundingClientRect();
          setPlace({
            '--panel-bottom': `${Math.round(window.innerHeight - rect.top + 8)}px`,
            '--panel-left': `${Math.round(Math.max(8, Math.min(rect.left, window.innerWidth - 436)))}px`,
          } as CSSProperties);
          setQuery('');
          setForm(undefined);
          setOpen(was => !was);
        }}
      >
        <Puzzle size={13} />
        Snippets{snippets.length ? ` ${snippets.length}` : ''}
      </button>
      {open && (
        <div className="saved-prompts-panel snippets-panel" style={place} role="group" aria-label="Snippets">
          {form ? (
            // Not a <form>: the prompt box sits inside the Create form, and a nested form
            // submits on its own and reloads the window instead of saving.
            <div className="snippet-form" role="group" aria-label={form.id ? 'Change snippet' : 'New snippet'}>
              <input
                aria-label="Snippet name"
                placeholder="Name (optional)"
                maxLength={60}
                value={form.name}
                onChange={event => setForm({ ...form, name: event.target.value })}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    // Keeps Enter from starting an image through the Create form.
                    event.preventDefault();
                    submit();
                  }
                }}
              />
              <textarea
                aria-label="Snippet tags"
                placeholder="masterpiece, best quality, soft light"
                rows={3}
                maxLength={4000}
                autoFocus
                value={form.text}
                onChange={event => setForm({ ...form, text: event.target.value })}
                onKeyDown={event => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
              {error && <p className="inline-error small">{error}</p>}
              <div className="snippet-form-actions">
                <button type="button" className="text-button" onClick={() => setForm(undefined)}>
                  Cancel
                </button>
                <button type="button" className="primary" disabled={!cleanSnippet(form.text)} onClick={submit}>
                  {form.id ? 'Save changes' : 'Save snippet'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="snippet-top">
                {snippets.length > 0 && (
                  <input
                    aria-label="Find a snippet"
                    placeholder="Find…"
                    autoFocus
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' && shown[0]) {
                        event.preventDefault();
                        use(shown[0]);
                      }
                    }}
                  />
                )}
                <button
                  type="button"
                  className="text-button"
                  disabled={snippets.length >= SNIPPET_LIMIT}
                  title={
                    caret.current && caret.current.end > caret.current.start ? 'Save the selected text' : undefined
                  }
                  onClick={() => {
                    const at = caret.current;
                    const selected = at && at.end > at.start ? value.slice(at.start, at.end) : '';
                    setError('');
                    setForm({ name: '', text: cleanSnippet(selected) });
                  }}
                >
                  <Plus size={13} />
                  New snippet
                </button>
              </div>
              {error && <p className="inline-error small">{error}</p>}
              {snippets.length === 0 ? (
                <p className="muted small">
                  Save tags you use a lot, then add them to the prompt with one click. Tip: select text in the prompt
                  first to save it.
                </p>
              ) : shown.length === 0 ? (
                <p className="muted small">No snippets match.</p>
              ) : (
                <ul>
                  {shown.map(item => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="saved-prompt-use snippet-use"
                        title={item.text}
                        onClick={() => use(item)}
                      >
                        <strong>{item.name}</strong>
                        <span>{item.text}</span>
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        title="Change"
                        aria-label={`Change ${item.name}`}
                        onClick={() => {
                          setError('');
                          setForm({ id: item.id, name: item.name, text: item.text });
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        title="Remove"
                        aria-label={`Remove ${item.name}`}
                        onClick={() => void save(snippets.filter(other => other.id !== item.id))}
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

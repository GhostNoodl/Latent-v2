import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  ArrowUp,
  Check,
  CircleStop,
  Download,
  ImageIcon,
  LoaderCircle,
  Settings2,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { GenerationDraft } from '../../shared/types';
import type { VideoDraft } from '../../shared/video-types';
import type {
  AssistantAction,
  AssistantChatEntry,
  AssistantConversation,
  AssistantImageRef,
  AssistantOption,
  AssistantStatus,
} from '../../shared/assistant-types';
import { LOCAL_ASSISTANT_MODELS } from '../../shared/assistant-catalog';
import { actionErrorMessage } from '../../shared/action-error';
import { bytes } from '../ui';
import { wordDiff } from './word-diff';
import './assistant.css';

export interface AssistantImageChoice {
  ref: AssistantImageRef;
  label: string;
}

export interface AssistantPanelProps {
  target: 'image' | 'video';
  status: AssistantStatus;
  draft: GenerationDraft;
  videoContext?: VideoDraft;
  checkpointName?: string;
  loraNames?: string[];
  /** Pictures the assistant may look at, best first. */
  images: AssistantImageChoice[];
  /** Where the panel sits, from `assistantAnchor`. */
  place?: CSSProperties;
  onApply: (option: AssistantOption) => void;
  onClose: () => void;
  onOpenSettings: () => void;
}

const empty = (): AssistantConversation => ({ version: 2, messages: [] });
const ACTION_TEXT: Record<AssistantAction, string> = {
  chat: '',
  improve: 'Improve it',
  expand: 'Add more detail',
  shorten: 'Make it shorter',
  tags: 'Turn it into tags',
  sentences: 'Turn it into sentences',
  variations: 'Give me 3 variations',
  describe: 'Write a prompt from the picture',
  motion: 'Better motion and camera',
};

/** Places the panel next to the button that opened it: above it in the lower half of the window, below it higher up. */
export function assistantAnchor(rect: DOMRect): CSSProperties {
  const width = Math.min(580, window.innerWidth - 16);
  const left = Math.round(Math.max(8, Math.min(rect.left - 40, window.innerWidth - width - 8)));
  return rect.top > window.innerHeight / 2
    ? ({
        '--assistant-bottom': `${Math.round(window.innerHeight - rect.top + 8)}px`,
        '--assistant-left': `${left}px`,
      } as CSSProperties)
    : ({ '--assistant-top': `${Math.round(rect.bottom + 8)}px`, '--assistant-left': `${left}px` } as CSSProperties);
}

function imageUrl(ref: AssistantImageRef) {
  return `latent-asset://${ref.kind}/${encodeURIComponent(ref.id)}`;
}

function quickActions(target: 'image' | 'video', draft: GenerationDraft): AssistantAction[] {
  if (target === 'video') return ['improve', 'motion', 'expand', 'shorten', 'variations'];
  const tagStyle = draft.family === 'illustrious' || draft.imageModel?.startsWith('anima');
  return ['improve', 'expand', 'shorten', tagStyle ? 'tags' : 'sentences', 'variations'];
}
const CHIP_LABEL: Partial<Record<AssistantAction, string>> = {
  improve: 'Improve',
  expand: 'More detail',
  shorten: 'Shorter',
  tags: 'As tags',
  sentences: 'As sentences',
  variations: '3 variations',
  motion: 'Motion & camera',
};

export function AssistantPanel({
  target,
  status,
  draft,
  videoContext,
  checkpointName,
  loraNames,
  images,
  place,
  onApply,
  onClose,
  onOpenSettings,
}: AssistantPanelProps) {
  const [conversation, setConversation] = useState<AssistantConversation>(empty);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [attach, setAttach] = useState<number | undefined>(undefined);
  const [installing, setInstalling] = useState(false);
  const current = useRef(conversation);
  const dirty = useRef(false);
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    window.latent
      .getAssistantConversation(target)
      .then(saved => {
        if (!live) return;
        current.current = saved ?? empty();
        setConversation(current.current);
      })
      .catch(() => undefined)
      .finally(() => live && setLoaded(true));
    input.current?.focus();
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [target]);

  const save = useCallback(() => {
    if (!dirty.current) return;
    dirty.current = false;
    void window.latent.saveAssistantConversation(current.current, target).catch(() => {
      dirty.current = true;
    });
  }, [target]);
  const change = useCallback((next: AssistantConversation) => {
    current.current = { version: 2, messages: next.messages.slice(-40) };
    dirty.current = true;
    if (mounted.current) setConversation(current.current);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(save, 400);
    return () => window.clearTimeout(timer);
  }, [conversation, loaded, save]);
  useEffect(() => () => save(), [save]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [conversation.messages.length, status.writing?.message, status.writing?.prompt]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  // The picked picture can disappear when the source changes.
  const attached = attach !== undefined ? images[attach] : undefined;
  const canSee = status.vision && images.length > 0;

  async function send(action: AssistantAction, typed = text) {
    const instruction = typed.trim();
    if (sending || !loaded || !status.ready) return;
    if (action === 'chat' && !instruction) return;
    const image = action === 'describe' ? (attached ?? images[0])?.ref : attached?.ref;
    setError('');
    setSending(true);
    const before = current.current.messages;
    const history = before.slice(-12).map(entry => ({
      role: entry.role,
      content: entry.reply
        ? JSON.stringify({ message: entry.reply.message, prompts: entry.reply.options.slice(0, 3) }).slice(0, 7000)
        : entry.content.slice(0, 7000),
    }));
    const userEntry: AssistantChatEntry = {
      id: crypto.randomUUID(),
      role: 'user',
      content: action === 'chat' ? instruction : [ACTION_TEXT[action], instruction].filter(Boolean).join('. '),
      createdAt: new Date().toISOString(),
      ...(action !== 'chat' ? { action } : {}),
      ...(image ? { image } : {}),
    };
    change({ ...current.current, messages: [...before, userEntry] });
    setText('');
    try {
      const reply = await window.latent.assistantSuggest({
        target,
        action,
        instruction: instruction || undefined,
        draft,
        videoContext,
        checkpointName,
        loraNames: loraNames?.slice(0, 12),
        image,
        history,
      });
      change({
        ...current.current,
        messages: [
          ...current.current.messages,
          { id: reply.id, role: 'assistant', content: reply.message, createdAt: reply.createdAt, reply },
        ],
      });
      setAttach(undefined);
    } catch (reason) {
      const message = actionErrorMessage(reason);
      // Keep what they typed so they can send it again.
      change({ ...current.current, messages: current.current.messages.filter(entry => entry.id !== userEntry.id) });
      if (mounted.current) {
        if (action === 'chat') setText(instruction);
        if (!/canceled/i.test(message)) setError(message);
      }
    } finally {
      if (mounted.current) setSending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void send('chat');
  }
  function apply(entry: AssistantChatEntry, index: number) {
    const option = entry.reply?.options[index];
    if (!option) return;
    onApply(option);
    change({
      ...current.current,
      messages: current.current.messages.map(item => (item.id === entry.id ? { ...item, applied: index } : item)),
    });
  }

  const writing = status.writing;
  const localModel = LOCAL_ASSISTANT_MODELS[status.settings.localModel];
  const local = status.local;
  const progress = Math.max(0, Math.min(100, local.installProgress ?? 0));
  const thinking = sending || Boolean(writing);
  const actions = quickActions(target, draft);
  const loadingLocal = status.settings.provider === 'local' && local.state === 'starting';

  return (
    <section
      className="assistant-panel"
      style={place}
      role="dialog"
      aria-modal="false"
      aria-label={target === 'video' ? 'Assistant for the video prompt' : 'Assistant'}
    >
      <header className="assistant-head">
        <Sparkles size={16} className="assistant-spark" />
        <h2>Assistant</h2>
        <button type="button" className="assistant-brain" onClick={onOpenSettings} title="Change in Settings">
          {status.label}
          <Settings2 size={12} />
        </button>
        <span className="assistant-spacer" />
        <button
          type="button"
          className="icon-button"
          title="Clear chat"
          aria-label="Clear chat"
          disabled={thinking || !conversation.messages.length}
          onClick={() => change(empty())}
        >
          <Trash2 size={15} />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Close (Esc)"
          aria-label="Close assistant"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>

      {!status.ready ? (
        <div className="assistant-setup">
          {status.settings.provider === 'local' ? (
            <>
              <p>
                <strong>{localModel.name}</strong> runs on this PC, free and offline. {localModel.blurb}
              </p>
              {local.state === 'installing' ? (
                <div className="assistant-progress">
                  <progress value={progress} max={100} aria-label="Download progress" />
                  <small>
                    {local.message} {progress.toFixed(0)}%
                    {local.totalBytes ? ` · ${bytes(local.receivedBytes ?? 0)} of ${bytes(local.totalBytes)}` : ''}
                  </small>
                  <button type="button" onClick={() => void window.latent.assistantCancelInstall()}>
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="assistant-setup-row">
                  <button
                    type="button"
                    className="primary"
                    disabled={installing}
                    onClick={async () => {
                      setInstalling(true);
                      setError('');
                      try {
                        await window.latent.assistantInstallLocal(status.settings.localModel);
                      } catch (reason) {
                        if (mounted.current) setError(actionErrorMessage(reason));
                      } finally {
                        if (mounted.current) setInstalling(false);
                      }
                    }}
                  >
                    <Download size={15} />
                    Download · {bytes(local.downloadBytes?.[status.settings.localModel] ?? 0)}
                  </button>
                  <button type="button" className="text-button" onClick={onOpenSettings}>
                    Or use Claude, ChatGPT, Gemini…
                  </button>
                </div>
              )}
              {local.state === 'error' && <p className="assistant-error">{local.message}</p>}
            </>
          ) : (
            <>
              <p>{status.reason}</p>
              <button type="button" className="primary" onClick={onOpenSettings}>
                <Settings2 size={15} />
                Open assistant settings
              </button>
            </>
          )}
        </div>
      ) : null}

      <div className="assistant-chips" role="group" aria-label="Quick actions">
        {actions.map(action => (
          <button
            key={action}
            type="button"
            className="assistant-chip"
            disabled={thinking || !status.ready || (!draft.prompt.trim() && action !== 'expand')}
            onClick={() => void send(action)}
          >
            {CHIP_LABEL[action]}
          </button>
        ))}
        <button
          type="button"
          className="assistant-chip"
          disabled={thinking || !status.ready || !canSee}
          title={
            !images.length
              ? target === 'video'
                ? 'Add a first frame to use this'
                : 'Open a picture or add a source picture to use this'
              : !status.vision
                ? "This model can't look at pictures"
                : undefined
          }
          onClick={() => void send('describe')}
        >
          <ImageIcon size={13} />
          {target === 'video' ? 'From first frame' : 'From picture'}
        </button>
      </div>

      <div className="assistant-log" ref={log} role="log" aria-live="polite" aria-label="Chat with the assistant">
        {!conversation.messages.length && !thinking && (
          <p className="assistant-hint">
            {target === 'video'
              ? 'Tap a button above, or say what should happen: "she turns and walks into the rain, slow push in".'
              : 'Tap a button above, or just say what you want: "make it night, neon, rain on the street".'}
          </p>
        )}
        {conversation.messages.map(entry =>
          entry.role === 'user' ? (
            <div key={entry.id} className="assistant-you">
              {entry.image && <img src={imageUrl(entry.image)} alt="" />}
              <p>{entry.content}</p>
            </div>
          ) : (
            <div key={entry.id} className="assistant-reply">
              <p>{entry.content}</p>
              {entry.reply?.options.map((option, index) => (
                <OptionCard
                  key={index}
                  index={index}
                  many={entry.reply!.options.length > 1}
                  option={option}
                  target={target}
                  draft={draft}
                  applied={entry.applied === index}
                  onApply={() => apply(entry, index)}
                />
              ))}
              {entry.reply && (
                <small className="assistant-meta">
                  {entry.reply.label} · {(entry.reply.durationMs / 1000).toFixed(1)} s
                </small>
              )}
            </div>
          ),
        )}
        {thinking && (
          <div className="assistant-reply assistant-live" aria-busy="true">
            {writing?.message ? <p>{writing.message}</p> : null}
            {writing?.prompt ? <p className="assistant-live-prompt">{writing.prompt}</p> : null}
            {!writing?.message && !writing?.prompt && (
              <p className="assistant-wait">
                <LoaderCircle className="spin" size={14} />
                {loadingLocal ? `Loading ${localModel.name}…` : 'Thinking…'}
              </p>
            )}
          </div>
        )}
        {error && (
          <p className="assistant-error" role="alert">
            <TriangleAlert size={14} />
            {error}
          </p>
        )}
      </div>

      <form className="assistant-compose" onSubmit={submit}>
        {images.length > 0 && status.vision && (
          <div className="assistant-attach">
            {images.map((image, index) => (
              <button
                key={`${image.ref.kind}-${image.ref.id}`}
                type="button"
                className="assistant-attach-choice"
                aria-pressed={attach === index}
                title={
                  attach === index ? 'Picture goes with the next message' : `Send ${image.label.toLowerCase()} too`
                }
                onClick={() => setAttach(value => (value === index ? undefined : index))}
              >
                <img src={imageUrl(image.ref)} alt="" />
                {image.label}
                {attach === index && <Check size={12} />}
              </button>
            ))}
          </div>
        )}
        <div className="assistant-input">
          <textarea
            ref={input}
            value={text}
            rows={2}
            maxLength={4000}
            placeholder={status.ready ? 'Ask for anything…' : 'Set up the assistant first'}
            disabled={!loaded}
            onChange={event => setText(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          {thinking ? (
            <button
              type="button"
              className="assistant-send"
              title="Stop"
              aria-label="Stop the reply"
              onClick={() => void window.latent.assistantCancel()}
            >
              <CircleStop size={16} />
            </button>
          ) : (
            <button
              type="submit"
              className="assistant-send primary"
              title="Send (Enter)"
              aria-label="Send"
              disabled={!status.ready || !text.trim()}
            >
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function OptionCard({
  index,
  many,
  option,
  target,
  draft,
  applied,
  onApply,
}: {
  index: number;
  many: boolean;
  option: AssistantOption;
  target: 'image' | 'video';
  draft: GenerationDraft;
  applied: boolean;
  onApply: () => void;
}) {
  const same = option.prompt === draft.prompt && (target === 'video' || option.negativePrompt === draft.negativePrompt);
  const negativeChanged = target === 'image' && option.negativePrompt !== draft.negativePrompt;
  return (
    <div className={`assistant-option${applied ? ' applied' : ''}`}>
      <p className="assistant-option-text">
        {many && <span className="assistant-option-number">{index + 1}</span>}
        {wordDiff(draft.prompt, option.prompt).map((piece, key) =>
          piece.added ? <mark key={key}>{piece.text}</mark> : <span key={key}>{piece.text}</span>,
        )}
      </p>
      {negativeChanged && (
        <p className="assistant-option-negative">
          <span>Negative</span>
          {option.negativePrompt || 'Empty'}
        </p>
      )}
      {!!option.dropped?.length && (
        <p className="assistant-option-warning">
          <TriangleAlert size={12} />
          Left out: {option.dropped.join(', ')}
        </p>
      )}
      <div className="assistant-option-actions">
        <button
          type="button"
          className="text-button"
          onClick={() => void window.latent.copyText(option.prompt).catch(() => undefined)}
        >
          Copy
        </button>
        <button type="button" className={same ? '' : 'primary'} disabled={same} onClick={onApply}>
          <Check size={14} />
          {same ? 'In use' : applied ? 'Use again' : 'Use this'}
        </button>
      </div>
    </div>
  );
}

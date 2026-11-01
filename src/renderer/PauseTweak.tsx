import { Pause, Play, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { defaultPauseStep, pausedDraft } from '../shared/split-sampling';
import type { GenerationDraft, GenerationRecord } from '../shared/types';

/** Dock button: generate, but stop partway so the prompt can change before it finishes. */
export function PauseSetup({
  draft,
  disabledReason,
  onQueue,
}: {
  draft: GenerationDraft;
  disabledReason?: string;
  onQueue(draft: GenerationDraft): void;
}) {
  const [picked, setPicked] = useState<number>();
  const pop = useRef<HTMLDetailsElement>(null);
  const last = Math.max(1, draft.steps - 1);
  const step = Math.min(last, picked ?? defaultPauseStep(draft.steps));
  return (
    <details className="pause-pop" ref={pop}>
      <summary className="soft-button" title="Stop partway, tweak, then finish">
        <Pause size={16} />
        Pause
      </summary>
      <div className="pause-setup">
        <p className="muted small">
          Stop partway, look at the rough image, change the prompt, then finish it. The start stays the same.
        </p>
        <label className="pause-step">
          <span>
            Pause at step <b>{step}</b> of {draft.steps}
          </span>
          <input
            type="range"
            min={1}
            max={last}
            value={step}
            disabled={draft.steps < 2}
            aria-label="Pause at step"
            onChange={event => setPicked(Number(event.target.value))}
          />
        </label>
        {disabledReason && <p className="inline-error small">{disabledReason}</p>}
        <button
          type="button"
          className="primary"
          disabled={Boolean(disabledReason)}
          onClick={() => {
            pop.current?.removeAttribute('open');
            onQueue(pausedDraft(draft, step));
          }}
        >
          <Pause size={14} />
          Generate and pause
        </button>
      </div>
    </details>
  );
}

/** Shown under a paused image: tweak, then finish or drop it. */
export function PausedCard({
  record,
  busy,
  onFinish,
  onDrop,
}: {
  record: GenerationRecord;
  busy: boolean;
  onFinish(tweaks: { prompt: string; negativePrompt: string; cfg: number }): void;
  onDrop(): void;
}) {
  const [prompt, setPrompt] = useState(record.draft.prompt);
  const [negativePrompt, setNegativePrompt] = useState(record.draft.negativePrompt);
  const [cfg, setCfg] = useState(record.draft.cfg);
  const cfgValid = Number.isFinite(cfg) && cfg >= 0 && cfg <= 30;
  return (
    <div className="paused-card" role="group" aria-label="Paused image">
      <div className="paused-head">
        <Pause size={15} />
        <b>
          Paused at step {record.draft.split?.atStep} of {record.draft.steps}
        </b>
        <span className="muted">Change anything here, then finish.</span>
      </div>
      <div className="paused-fields">
        <textarea
          rows={2}
          aria-label="Prompt"
          placeholder="Prompt"
          value={prompt}
          onChange={event => setPrompt(event.target.value)}
        />
        <textarea
          rows={2}
          aria-label="Negative prompt"
          placeholder="Negative prompt"
          value={negativePrompt}
          onChange={event => setNegativePrompt(event.target.value)}
        />
        <label className="paused-cfg">
          <span>CFG</span>
          <input
            type="number"
            min={0}
            max={30}
            step={0.5}
            value={cfg}
            onChange={event => setCfg(Number(event.target.value))}
          />
        </label>
      </div>
      <div className="paused-actions">
        <button type="button" disabled={busy} onClick={onDrop} title="Throw this one away">
          <Trash2 size={14} />
          Drop
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || !cfgValid}
          onClick={() => onFinish({ prompt, negativePrompt, cfg })}
        >
          <Play size={14} />
          Finish
        </button>
      </div>
    </div>
  );
}

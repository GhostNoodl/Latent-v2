import { useEffect, useRef, useState } from 'react';
import { BookOpen, Dices, Layers, Lock, LockKeyhole, Shuffle, X } from 'lucide-react';
import { WildcardListsEditor } from './WildcardListsEditor';
import {
  usesDynamicPrompts,
  countPromptCombinations,
  prepareDynamicPromptDraft,
  type DynamicPromptAuthoring,
  type DynamicPromptDraft,
  type WildcardSnapshot,
} from '../shared/dynamic-prompt-recipe';
import type { DynamicPromptChoice } from '../shared/dynamic-prompts';
import { Busy, Notice } from './ui';
import './dynamic-prompts.css';

export interface DynamicPromptsProps {
  draft: DynamicPromptDraft & { seed?: string };
  wildcards: WildcardSnapshot;
  /** A concrete seed already allocated by the composer, when Random is in use. */
  previewSeed?: string;
  /** A newer model is picked: point people at the plain-English packs. */
  newerModel?: boolean;
  onApplyPrompt?(prompt: string): void;
  onChange(value: DynamicPromptAuthoring): void;
  /** Clear the freeze and allocate a new seed to request a new variation. */
  onReroll(): void;
  onSaveWildcards(entries: Record<string, string[]>): Promise<WildcardSnapshot>;
  /** Queue one image per setup, in order. Leave out to hide the make-several buttons. */
  onQueue?(setups: DynamicPromptAuthoring[]): void;
  queueDisabledReason?: string;
}
/** Most images one press of "Make all" queues. */
export const MAKE_ALL_LIMIT = 100;
const SEVERAL = [4, 8, 16];
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const randomSeed = () => String(crypto.getRandomValues(new Uint32Array(1))[0]);
interface Example {
  prompt: string;
  negativePrompt: string;
  choices: DynamicPromptChoice[];
}

export function DynamicPrompts({
  draft,
  wildcards,
  previewSeed,
  newerModel,
  onChange,
  onReroll,
  onSaveWildcards,
  onQueue,
  queueDisabledReason,
}: DynamicPromptsProps) {
  const enabled = usesDynamicPrompts(draft);
  const authoring = draft.dynamicPrompts;
  const frozen = authoring?.frozen;
  const pins = authoring?.pins ?? {};
  const fixedSeed = previewSeed ?? (draft.seed && draft.seed !== 'random' ? draft.seed : undefined);
  const [shuffle, setShuffle] = useState(randomSeed);
  const [examples, setExamples] = useState<Example[]>([]);
  const [problem, setProblem] = useState('');
  const [working, setWorking] = useState(false);
  const [combos, setCombos] = useState<{ count: number; capped: boolean }>();
  const [editorOpen, setEditorOpen] = useState(false);
  const serial = useRef(0);
  const pinKey = JSON.stringify(pins);

  useEffect(() => {
    const current = ++serial.current;
    setProblem('');
    if (!enabled) {
      setExamples([]);
      setCombos(undefined);
      return;
    }
    const timer = setTimeout(() => {
      setWorking(true);
      // With a fixed seed the first example is exactly the next image; the others are later rolls.
      const seeds = frozen
        ? [frozen.resolutionSeed]
        : fixedSeed
          ? [0, 1, 2].map(() => fixedSeed)
          : [0, 1, 2].map(index => String((Number(shuffle) + index * 7919) % 4294967296));
      const runs = seeds.map((seed, index) => {
        const roll = fixedSeed && !frozen ? (authoring?.roll ?? 0) + index : authoring?.roll;
        return prepareDynamicPromptDraft(
          {
            ...draft,
            dynamicPrompts: { ...(authoring ?? { enabled: true }), ...(roll ? { roll } : { roll: undefined }) },
          },
          seed,
          wildcards,
        );
      });
      void Promise.all(runs)
        .then(results => {
          if (current !== serial.current) return;
          setExamples(
            results.map(result => ({
              prompt: result.prompt,
              negativePrompt: result.negativePrompt,
              choices: result.recipe?.positive.choices ?? [],
            })),
          );
          try {
            setCombos(frozen ? undefined : countPromptCombinations(draft, wildcards));
          } catch {
            setCombos(undefined);
          }
        })
        .catch(error => {
          if (current !== serial.current) return;
          setExamples([]);
          setCombos(undefined);
          setProblem(errorText(error));
        })
        .finally(() => {
          if (current === serial.current) setWorking(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      serial.current++;
    };
  }, [
    enabled,
    frozen,
    draft.prompt,
    draft.negativePrompt,
    fixedSeed,
    shuffle,
    wildcards.revision,
    pinKey,
    authoring?.roll,
  ]);

  const setPins = (next: Record<string, string>) => {
    const { frozen: _frozen, ...rest } = authoring ?? { enabled: true };
    onChange({ ...rest, enabled: true, pins: Object.keys(next).length ? next : undefined });
  };
  const lockable = (examples[0]?.choices ?? []).filter(
    (choice, index, all) =>
      choice.kind === 'wildcard' &&
      choice.tag &&
      choice.source === 'authored' &&
      !choice.selectedIndices &&
      all.findIndex(other => other.tag === choice.tag && other.source === 'authored') === index,
  );
  const base = (): DynamicPromptAuthoring => ({
    enabled: true,
    ...(authoring?.selections ? { selections: authoring.selections } : {}),
    ...(authoring?.pins ? { pins: authoring.pins } : {}),
  });
  const makeSeveral = (count: number) =>
    onQueue?.(Array.from({ length: count }, (_, index) => ({ ...base(), ...(index ? { roll: index } : {}) })));
  const makeAll = () =>
    combos && onQueue?.(Array.from({ length: combos.count }, (_, combination) => ({ ...base(), combination })));
  const listCount = Object.keys(wildcards.entries).length;

  return (
    <section className={`dynamic-prompts ${enabled ? 'enabled' : ''}`} aria-label="Wildcards">
      <div className="dynamic-heading">
        <span className="muted small">
          Type <code>__</code> in the prompt to add a list
        </span>
        <button type="button" className="text-button" onClick={() => setEditorOpen(true)}>
          <BookOpen size={13} />
          Lists <span className="badge">{listCount}</span>
        </button>
      </div>
      {!enabled ? (
        <p className="muted small">
          Add <code>__species__</code> or <code>{'{sunny|misty}'}</code> to your prompt and each image picks something
          different.{' '}
          {newerModel && (
            <>
              Newer models like plain sentences: try <code>__plain_scenes__</code>.
            </>
          )}
        </p>
      ) : (
        <>
          {frozen && (
            <Notice>
              <div className="dynamic-frozen">
                <LockKeyhole size={15} />
                <div>
                  <strong>Using this image’s picks</strong>
                  <p>Changing the prompt or rolling again makes new picks.</p>
                  <button type="button" className="text-button" onClick={onReroll}>
                    <Dices size={13} />
                    Roll again
                  </button>
                </div>
              </div>
            </Notice>
          )}
          <div className="dynamic-examples" aria-label="Examples" aria-busy={working}>
            <div className="dynamic-examples-heading">
              <strong>{frozen ? 'This image' : fixedSeed ? 'Next image, then later rolls' : 'Examples'}</strong>
              {working && <Busy active />}
              {!frozen && !fixedSeed && (
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Show other examples"
                  title="Show other examples"
                  onClick={() => setShuffle(randomSeed())}
                >
                  <Shuffle size={14} />
                </button>
              )}
            </div>
            {problem ? (
              <Notice error>{problem}</Notice>
            ) : (
              <ol>
                {examples.map((example, index) => (
                  <li key={index}>{example.prompt || '(empty)'}</li>
                ))}
              </ol>
            )}
          </div>
          {!frozen && (lockable.length > 0 || Object.keys(pins).length > 0) && (
            <div className="dynamic-locks" aria-label="Lock a pick">
              <span className="muted small">Keep</span>
              {Object.entries(pins).map(([tag, value]) => (
                <span key={tag} className="dynamic-lock on">
                  <Lock size={11} />
                  <code>{tag}</code> {value}
                  <button
                    type="button"
                    aria-label={`Unlock ${tag}`}
                    onClick={() => {
                      const next = { ...pins };
                      delete next[tag];
                      setPins(next);
                    }}
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              {lockable
                .filter(choice => !Object.hasOwn(pins, choice.tag!))
                .map(choice => (
                  <button
                    type="button"
                    key={choice.tag}
                    className="dynamic-lock"
                    title="Keep this pick for every image"
                    onClick={() => setPins({ ...pins, [choice.tag!]: choice.resolvedValue })}
                  >
                    <Lock size={11} />
                    <code>{choice.tag}</code> {choice.resolvedValue || '(empty)'}
                  </button>
                ))}
            </div>
          )}
          {!frozen && onQueue && (
            <div className="dynamic-make">
              <span className="small">Make</span>
              {SEVERAL.map(count => (
                <button
                  type="button"
                  key={count}
                  disabled={!!queueDisabledReason || !!problem}
                  title={queueDisabledReason ?? `Queue ${count} images, each with new picks`}
                  onClick={() => makeSeveral(count)}
                >
                  {count}
                </button>
              ))}
              {combos && combos.count > 1 && (
                <button
                  type="button"
                  className="dynamic-make-all"
                  disabled={!!queueDisabledReason || combos.capped || combos.count > MAKE_ALL_LIMIT}
                  title={
                    queueDisabledReason ??
                    (combos.capped || combos.count > MAKE_ALL_LIMIT
                      ? `Too many to make at once (${MAKE_ALL_LIMIT} max). Use fewer choices.`
                      : 'One image for every combination of the main prompt, in order')
                  }
                  onClick={makeAll}
                >
                  <Layers size={13} />
                  {combos.capped || combos.count > MAKE_ALL_LIMIT
                    ? `${combos.capped ? `${combos.count.toLocaleString('en-US')}+` : combos.count.toLocaleString('en-US')} combinations`
                    : `All ${combos.count} combinations`}
                </button>
              )}
            </div>
          )}
        </>
      )}
      <details className="dynamic-help">
        <summary>How to write them</summary>
        <dl>
          <dt>
            <code>{'{red|blue}'}</code>
          </dt>
          <dd>pick one</dd>
          <dt>
            <code>{'{3::red|blue}'}</code>
          </dt>
          <dd>red comes up 3 times as often</dd>
          <dt>
            <code>{'{2$$red|blue|green}'}</code>
          </dt>
          <dd>pick 2 different ones</dd>
          <dt>
            <code>{'{1-3$$ and $$__colors__}'}</code>
          </dt>
          <dd>1 to 3 from a list, joined with “and”</dd>
          <dt>
            <code>__clothes/*__</code>
          </dt>
          <dd>any list in the clothes folder</dd>
          <dt>
            <code>{'${hair=!__hair_colors__}'}</code>
          </dt>
          <dd>
            pick once, then reuse it with <code>{'${hair}'}</code>
          </dd>
          <dt>
            <code>\{'{'}</code>
          </dt>
          <dd>a real brace</dd>
        </dl>
      </details>
      {editorOpen && (
        <WildcardListsEditor wildcards={wildcards} onSave={onSaveWildcards} onClose={() => setEditorOpen(false)} />
      )}
    </section>
  );
}

import { useEffect, useState } from 'react';
import { Check, Download, ExternalLink, Trash2 } from 'lucide-react';
import type {
  AssistantModelOption,
  AssistantProviderId,
  AssistantSettings as Settings,
  AssistantStatus,
  CloudProviderId,
} from '../../shared/assistant-types';
import {
  ASSISTANT_PROVIDER_IDS,
  CLOUD_PROVIDERS,
  LOCAL_ASSISTANT_MODEL_IDS,
  LOCAL_ASSISTANT_MODELS,
  providerName,
} from '../../shared/assistant-catalog';
import { Busy, Field, Notice, bytes, type RunAction } from '../ui';
import { ASSISTANT_SETTINGS_SECTION } from './open-settings';
import './assistant.css';

/** Settings, Assistant: what does the thinking for "Help me write". */
export function AssistantSettings({
  status,
  run,
  busy,
}: {
  status: AssistantStatus;
  run: RunAction;
  busy: Record<string, boolean>;
}) {
  const settings = status.settings;
  const save = (patch: Partial<Settings>, message?: string) =>
    void run('assistant-settings', () => window.latent.assistantSaveSettings(patch).then(() => undefined), message);
  return (
    <section className="settings-card assistant-settings" id={ASSISTANT_SETTINGS_SECTION}>
      <div className="section-heading">
        <div>
          <h2>Assistant</h2>
          <p>
            Helps you write prompts in Create and Video. Pick what does the thinking: a model on this PC (free, private,
            offline) or a cloud model with your own key (smarter, costs a little per message).
          </p>
        </div>
        <span className="badge">
          <span className={`status-dot ${status.ready ? 'ready' : 'stopped'}`} />
          {status.ready ? status.label : 'Not set up'}
        </span>
      </div>
      <div className="assistant-providers" role="radiogroup" aria-label="Who does the thinking">
        {ASSISTANT_PROVIDER_IDS.map(id => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={settings.provider === id}
            className="assistant-provider"
            disabled={busy['assistant-settings']}
            onClick={() => settings.provider !== id && save({ provider: id })}
          >
            <strong>{providerName(id)}</strong>
            {id !== 'local' && id !== 'custom' && status.keys[id] && <Check size={12} aria-label="key saved" />}
          </button>
        ))}
      </div>
      {settings.provider === 'local' ? (
        <LocalSettings status={status} run={run} busy={busy} save={save} />
      ) : (
        <CloudSettings
          key={settings.provider}
          provider={settings.provider}
          status={status}
          run={run}
          busy={busy}
          save={save}
        />
      )}
      <p className="muted small">
        Cloud assistants get your prompt, and a picture when you send one. Keys are locked with Windows credential
        protection and only ever go to their own provider.
      </p>
    </section>
  );
}

function LocalSettings({
  status,
  run,
  busy,
  save,
}: {
  status: AssistantStatus;
  run: RunAction;
  busy: Record<string, boolean>;
  save: (patch: Partial<Settings>, message?: string) => void;
}) {
  const local = status.local;
  const picked = status.settings.localModel;
  const progress = Math.max(0, Math.min(100, local.installProgress ?? 0));
  return (
    <div className="assistant-local">
      <div className="assistant-models" role="radiogroup" aria-label="Model on this PC">
        {LOCAL_ASSISTANT_MODEL_IDS.map(id => {
          const model = LOCAL_ASSISTANT_MODELS[id];
          const installed = local.installed.includes(id);
          return (
            <div key={id} className="assistant-model" data-picked={picked === id || undefined}>
              <button
                type="button"
                role="radio"
                aria-checked={picked === id}
                disabled={busy['assistant-settings'] || local.state === 'installing'}
                onClick={() => picked !== id && save({ localModel: id })}
              >
                <strong>
                  {model.name}
                  {local.recommended === id && <span className="badge">Best for this PC</span>}
                </strong>
                <span>{model.blurb}</span>
                <small>
                  {installed ? 'Downloaded' : `Download ${bytes(local.downloadBytes?.[id] ?? 0)}`} · Can look at
                  pictures · {model.license}
                </small>
              </button>
              {installed && (
                <button
                  type="button"
                  className="icon-button"
                  title={`Delete ${model.name}`}
                  aria-label={`Delete ${model.name}`}
                  disabled={busy['assistant-local']}
                  onClick={() =>
                    void run('assistant-local', () => window.latent.assistantRemoveLocal(id), `${model.name} deleted.`)
                  }
                >
                  <Trash2 size={15} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="setting-line">
        <div>
          <h3>Run it on</h3>
          <p>
            {local.gpu
              ? 'The graphics card is much faster. Auto uses it when the model fits next to your images.'
              : "No NVIDIA graphics card found, so it runs on the processor. That's slower but works."}
          </p>
        </div>
        <select
          aria-label="Run the local assistant on"
          value={status.settings.localDevice}
          disabled={!local.gpu || busy['assistant-settings']}
          onChange={event => save({ localDevice: event.target.value as Settings['localDevice'] })}
        >
          <option value="auto">Auto</option>
          <option value="gpu">Graphics card</option>
          <option value="cpu">Processor</option>
        </select>
      </div>
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
        <div className="button-row">
          {!local.installed.includes(picked) || (local.downloadBytes?.[picked] ?? 0) > 0 ? (
            <button
              type="button"
              className="primary"
              disabled={busy['assistant-local']}
              onClick={() =>
                void run(
                  'assistant-local',
                  () => window.latent.assistantInstallLocal(picked),
                  `${LOCAL_ASSISTANT_MODELS[picked].name} is ready.`,
                )
              }
            >
              <Download size={15} />
              Download {LOCAL_ASSISTANT_MODELS[picked].name} · {bytes(local.downloadBytes?.[picked] ?? 0)}
            </button>
          ) : null}
          {(local.state === 'ready' || local.state === 'starting') && (
            <button type="button" onClick={() => void run('assistant-local', () => window.latent.assistantStopLocal())}>
              Unload now
            </button>
          )}
        </div>
      )}
      {local.message && local.state !== 'installing' && (
        <Notice error={local.state === 'error'}>{local.message}</Notice>
      )}
      {!!local.logTail.length && local.state === 'error' && (
        <details className="assistant-logs">
          <summary>Log</summary>
          <pre>{local.logTail.slice(-15).join('\n')}</pre>
        </details>
      )}
    </div>
  );
}

function CloudSettings({
  provider,
  status,
  run,
  busy,
  save,
}: {
  provider: Exclude<AssistantProviderId, 'local'>;
  status: AssistantStatus;
  run: RunAction;
  busy: Record<string, boolean>;
  save: (patch: Partial<Settings>, message?: string) => void;
}) {
  const definition = CLOUD_PROVIDERS[provider];
  const saved = status.keys[provider];
  const [key, setKey] = useState('');
  const [url, setUrl] = useState(status.settings.customUrl);
  const [models, setModels] = useState<AssistantModelOption[]>(definition.models ?? []);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const picked = status.settings.models[provider];
  const canList = provider === 'custom' ? Boolean(status.settings.customUrl) : Boolean(saved);

  const load = async () => {
    if (definition.models) return;
    setLoading(true);
    setLoadError('');
    try {
      const list = await window.latent.assistantListModels(provider as CloudProviderId);
      setModels(list);
      if (!list.length) setLoadError('No models came back.');
    } catch (reason) {
      setLoadError(
        reason instanceof Error
          ? reason.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
          : String(reason),
      );
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (canList) void load();
    // Load once per provider and whenever a key or address appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, canList, status.settings.customUrl, saved?.last4]);

  const shown = models.filter(model =>
    !filter.trim() ? true : `${model.id} ${model.name}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  return (
    <div className="assistant-cloud">
      <p className="muted small">
        {definition.blurb}{' '}
        {definition.keyUrl && (
          <a href={definition.keyUrl} target="_blank" rel="noreferrer">
            Get a key <ExternalLink size={11} />
          </a>
        )}
      </p>
      {provider === 'custom' && (
        <form
          className="assistant-inline-form"
          onSubmit={event => {
            event.preventDefault();
            save({ customUrl: url.trim() }, 'Server address saved.');
          }}
        >
          <Field label="Server address" hint="LM Studio: http://localhost:1234/v1 · Ollama: http://localhost:11434/v1">
            <input value={url} spellCheck={false} onChange={event => setUrl(event.target.value)} maxLength={500} />
          </Field>
          <button disabled={busy['assistant-settings'] || url.trim() === status.settings.customUrl}>Save</button>
        </form>
      )}
      <form
        className="assistant-inline-form"
        onSubmit={event => {
          event.preventDefault();
          void run(
            'assistant-key',
            () => window.latent.assistantSetKey(provider as CloudProviderId, key.trim()),
            'Key saved and protected.',
          ).then(ok => ok && setKey(''));
        }}
      >
        <Field
          label={
            saved
              ? `Key (saved, ends in ${saved.last4})`
              : definition.keyRequired
                ? 'API key'
                : 'API key (if your server needs one)'
          }
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            maxLength={4096}
            placeholder={saved ? 'Paste a new key to replace it' : 'Paste your key here'}
            onChange={event => setKey(event.target.value)}
          />
        </Field>
        <button className="primary" disabled={!key.trim() || busy['assistant-key']}>
          <Busy active={busy['assistant-key']} />
          Save key
        </button>
        {saved && (
          <button
            type="button"
            disabled={busy['assistant-key']}
            onClick={() =>
              void run(
                'assistant-key',
                () => window.latent.assistantSetKey(provider as CloudProviderId, null),
                'Key removed.',
              )
            }
          >
            Remove
          </button>
        )}
      </form>
      <div className="assistant-model-pick">
        <Field label="Model">
          <select
            value={picked ?? ''}
            disabled={!models.length || busy['assistant-settings']}
            onChange={event => save({ models: { [provider]: event.target.value } })}
          >
            {!picked && (
              <option value="">{loading ? 'Loading…' : canList ? 'Pick a model' : 'Save a key first'}</option>
            )}
            {picked && !models.some(model => model.id === picked) && <option value={picked}>{picked}</option>}
            {shown.map(model => (
              <option key={model.id} value={model.id}>
                {model.name}
                {model.vision === false ? ' (no pictures)' : ''}
              </option>
            ))}
          </select>
        </Field>
        {models.length > 30 && (
          <Field label="Find a model">
            <input
              value={filter}
              onChange={event => setFilter(event.target.value)}
              placeholder="grok, deepseek, gpt…"
            />
          </Field>
        )}
        {!definition.models && (
          <button type="button" className="text-button" disabled={!canList || loading} onClick={() => void load()}>
            <Busy active={loading} />
            Refresh list
          </button>
        )}
      </div>
      {loadError && <Notice error>{loadError}</Notice>}
      {status.reason && <Notice>{status.reason}</Notice>}
    </div>
  );
}

import { useState } from 'react';
import type { TelegramSettings, TelegramStatus } from '../shared/telegram-types';
import { Busy, Field, Notice, Toggle, type RunAction } from './ui';

const stateLabel: Record<TelegramStatus['state'], string> = {
  off: 'Off',
  connecting: 'Connecting',
  online: 'Online',
  error: 'Needs attention',
};

export function TelegramRemote({ status, run, busy }: { status: TelegramStatus; run: RunAction; busy: boolean }) {
  const [token, setToken] = useState('');
  const [ids, setIds] = useState(status.allowedUserIds.join(', '));
  const save = (value: Partial<TelegramSettings>) =>
    void run('telegram', () => window.latent.saveTelegramSettings(value));
  const parsedIds = ids
    .split(/[\s,]+/)
    .map(value => value.trim())
    .filter(Boolean);
  const idsValid = parsedIds.every(value => /^[1-9]\d{0,15}$/.test(value));
  const idsChanged = parsedIds.join(',') !== status.allowedUserIds.join(',');
  return (
    <section className="settings-card">
      <div className="section-heading">
        <div>
          <h2>Telegram remote</h2>
          <p>
            Send prompts to your own Telegram bot and get the images back in the chat. Everything still runs on this PC,
            using the current Create settings. Latent checks Telegram for messages, so no ports need opening.
          </p>
        </div>
        <span className="badge">
          <span
            className={`status-dot ${status.state === 'online' ? 'ready' : status.state === 'error' ? 'error' : 'stopped'}`}
          />
          {stateLabel[status.state]}
        </span>
      </div>
      <Notice error={status.state === 'error'}>{status.message}</Notice>
      <div className="setting-line">
        <div>
          <h3>Turn on the bot</h3>
          <p>Latent only answers while it's open.</p>
        </div>
        <fieldset disabled={busy}>
          <Toggle label="Telegram remote" checked={status.enabled} onChange={enabled => save({ enabled })} />
        </fieldset>
      </div>
      <form
        onSubmit={event => {
          event.preventDefault();
          void run('telegram', () => window.latent.setTelegramToken(token.trim()), 'Bot token saved.').then(
            saved => saved && setToken(''),
          );
        }}
      >
        <Field
          label={status.hasToken ? 'Replace bot token' : 'Bot token'}
          hint="Message @BotFather in Telegram, send /newbot, and paste the token it gives you. Windows keeps it protected."
        >
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={event => setToken(event.target.value)}
            maxLength={200}
            placeholder={status.hasToken ? 'A protected token is saved' : 'Paste your bot token here'}
          />
        </Field>
        <div className="button-row">
          <button className="primary" disabled={!token.trim() || busy}>
            <Busy active={busy} />
            Save protected token
          </button>
          {status.hasToken && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void run('telegram', () => window.latent.setTelegramToken(null), 'Bot token removed.')}
            >
              Remove token
            </button>
          )}
        </div>
      </form>
      <form
        onSubmit={event => {
          event.preventDefault();
          save({ allowedUserIds: parsedIds });
        }}
      >
        <Field
          label="Who can use the bot"
          hint="Telegram user IDs, separated by commas. Anyone else gets ignored. Not sure of yours? Send /id to the bot."
        >
          <input
            inputMode="numeric"
            spellCheck={false}
            value={ids}
            onChange={event => setIds(event.target.value)}
            placeholder="123456789"
          />
        </Field>
        {!idsValid && <Notice error>Telegram user IDs are numbers only.</Notice>}
        <div className="button-row">
          <button disabled={busy || !idsValid || !idsChanged}>Save allowed users</button>
        </div>
      </form>
    </section>
  );
}

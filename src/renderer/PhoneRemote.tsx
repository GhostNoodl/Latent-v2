import { useState } from 'react';
import type { PhoneStatus } from '../shared/phone-types';
import { Field, Notice, Toggle, type RunAction } from './ui';

const stateLabel: Record<PhoneStatus['state'], string> = { off: 'Off', online: 'On', error: 'Needs attention' };

/** Settings card for the phone page on the home network. */
export function PhoneRemote({ status, run, busy }: { status: PhoneStatus; run: RunAction; busy: boolean }) {
  const [port, setPort] = useState(String(status.port));
  const portValue = Number(port);
  const portValid = Number.isInteger(portValue) && portValue >= 1024 && portValue <= 65535;
  return (
    <section className="settings-card phone-remote" id="phone-remote">
      <div className="section-heading">
        <div>
          <h2>Phone remote</h2>
          <p>
            Make images from your phone’s browser while you’re on the same Wi-Fi. Everything still runs on this PC. Use
            it on your home network only.
          </p>
        </div>
        <span className="badge">
          <span
            className={`status-dot ${status.state === 'online' ? 'ready' : status.state === 'error' ? 'error' : 'stopped'}`}
          />
          {stateLabel[status.state]}
        </span>
      </div>
      {status.state === 'error' && <Notice error>{status.message}</Notice>}
      <div className="setting-line">
        <div>
          <h3>Turn on the phone page</h3>
          <p>Windows may ask to let Latent use private networks. Allow it.</p>
        </div>
        <fieldset disabled={busy}>
          <Toggle
            label="Phone remote"
            checked={status.enabled}
            onChange={enabled => void run('phone', () => window.latent.savePhoneSettings({ enabled }))}
          />
        </fieldset>
      </div>
      {status.state === 'online' && (
        <div className="phone-pairing">
          <div>
            <small>Open on your phone</small>
            {status.urls.length ? (
              status.urls.map(url => <strong key={url}>{url}</strong>)
            ) : (
              <strong>No Wi-Fi address found</strong>
            )}
          </div>
          <div>
            <small>Pairing code</small>
            <strong className="phone-code">{status.pairingCode}</strong>
            <button type="button" className="text-button" onClick={() => void run('phone', window.latent.newPhoneCode)}>
              New code
            </button>
          </div>
        </div>
      )}
      <div className="setting-line">
        <div>
          <h3>Paired phones</h3>
          <p>
            {status.pairedPhones === 0
              ? 'None yet. A phone types the code once and stays paired.'
              : `${status.pairedPhones} ${status.pairedPhones === 1 ? 'phone' : 'phones'} can use the page.`}
          </p>
        </div>
        <button
          type="button"
          disabled={busy || status.pairedPhones === 0}
          onClick={() => void run('phone', window.latent.forgetPhones, 'All phones forgotten.')}
        >
          Forget all phones
        </button>
      </div>
      <form
        className="phone-port"
        onSubmit={event => {
          event.preventDefault();
          if (portValid) void run('phone', () => window.latent.savePhoneSettings({ port: portValue }));
        }}
      >
        <Field label="Port" hint="Change it only if another app already uses this one.">
          <input inputMode="numeric" value={port} maxLength={5} onChange={event => setPort(event.target.value)} />
        </Field>
        <button type="submit" disabled={busy || !portValid || portValue === status.port}>
          Save port
        </button>
      </form>
    </section>
  );
}

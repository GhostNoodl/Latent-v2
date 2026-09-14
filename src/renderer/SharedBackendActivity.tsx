import type { BackendActivitySnapshot } from '../shared/backend-activity-types';
import { Notice } from './ui';

export function SharedBackendActivity({ status, onOpen, canOpen, busy, showOpen = true }: { status: BackendActivitySnapshot; onOpen: () => void; canOpen: boolean; busy?: boolean; showOpen?: boolean }) {
  const foreign = (status.foreignRunning ?? 0) + (status.foreignPending ?? 0);
  if (status.state === 'ready' && !foreign) return null;
  if (status.state === 'offline') return <p className="muted small">The private image engine is stopped.</p>;
  return <Notice error={status.state === 'unknown'}><strong>{foreign ? 'Ordinary ComfyUI is using this engine' : 'Shared engine activity'}</strong><p>{status.message}</p>{foreign > 0 && <p>Studio jobs wait here until that queue is clear. Stop and Close keep this work running.</p>}{showOpen && <button type="button" className="text-button" disabled={!canOpen || busy} onClick={onOpen}>Open ComfyUI</button>}</Notice>;
}

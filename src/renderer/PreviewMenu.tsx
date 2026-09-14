import { useEffect, useRef } from 'react';
import type { GenerationRecord } from '../shared/types';
import type { RunAction } from './ui';
export function PreviewMenu({ record, x, y, onClose, onReuse, run }: { record: GenerationRecord; x: number; y: number; onClose(): void; onReuse(): void; run: RunAction }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const menu = ref.current!;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
    const previous = document.activeElement;
    menu.querySelector('button')?.focus();
    const close = (e: PointerEvent) => { if (!menu.contains(e.target as Node)) onClose(); };
    const dismiss = () => onClose();
    document.addEventListener('pointerdown', close); window.addEventListener('resize', dismiss);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('resize', dismiss); if (document.activeElement === document.body || menu.contains(document.activeElement)) if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [x, y, onClose]);
  const action = (name: string, fn: () => Promise<void>) => { onClose(); void run(name, fn); };
  return <div ref={ref} className="context-menu" role="menu" aria-label="Preview image actions" style={{left:x, top:y}} onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') { if (event.key === 'Escape') event.preventDefault(); onClose(); }
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) { event.preventDefault(); const buttons = [...ref.current!.querySelectorAll('button')]; const i = buttons.indexOf(document.activeElement as HTMLButtonElement); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (i + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus(); }
  }}><button type="button" role="menuitem" onClick={() => action('copy-output', () => window.latent.copyOutput(record.id))}>Copy image</button><button type="button" role="menuitem" onClick={() => action('open-output', () => window.latent.openOutput(record.id))}>Open image</button><button type="button" role="menuitem" onClick={() => action('reveal-output', () => window.latent.revealOutput(record.id))}>Show in folder</button><button type="button" role="menuitem" onClick={() => {onClose(); onReuse();}}>Reuse parameters</button></div>;
}

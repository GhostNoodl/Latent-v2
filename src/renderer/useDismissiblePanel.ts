import { useEffect } from 'react';
/** Activity panels are nonmodal. Their toggles count as inside clicks. */
export function useDismissiblePanel(open: boolean, onClose: () => void, inside: string) {
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => { if (event.target instanceof Element && !event.target.closest(inside)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && !(event.target instanceof Element && event.target.closest('[role="dialog"]'))) { event.preventDefault(); onClose(); } };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', pointer); document.removeEventListener('keydown', key); };
  }, [open, onClose, inside]);
}

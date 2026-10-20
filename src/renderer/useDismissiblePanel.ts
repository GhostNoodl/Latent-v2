import { useEffect } from 'react';
/** Activity panels are nonmodal. Their toggles count as inside clicks. */
export function useDismissiblePanel(open: boolean, onClose: () => void, inside: string) {
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest(inside)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        !(event.target instanceof Element && event.target.closest('[role="dialog"]'))
      ) {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, [open, onClose, inside]);
}

const FLYOUT = 'details.tune-flyout';
const FLYOUT_INSIDE = `${FLYOUT}, [role="dialog"], [role="menu"], .tag-suggestions`;
/** Tune extras open as flyouts beside the drawer: one at a time, closed by Escape or a click elsewhere. */
export function useTuneFlyouts() {
  useEffect(() => {
    const openFlyouts = () => [...document.querySelectorAll<HTMLDetailsElement>(`${FLYOUT}[open]`)];
    const toggle = (event: Event) => {
      const opened = event.target;
      if (!(opened instanceof HTMLDetailsElement) || !opened.open || !opened.matches(FLYOUT)) return;
      for (const other of openFlyouts()) if (other !== opened && !other.contains(opened)) other.open = false;
    };
    const pointer = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(FLYOUT_INSIDE)) return;
      for (const flyout of openFlyouts()) flyout.open = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (event.target instanceof Element && event.target.closest('[role="dialog"]')) return;
      const flyout = openFlyouts().at(-1);
      if (!flyout) return;
      event.preventDefault();
      flyout.open = false;
      flyout.querySelector('summary')?.focus();
    };
    document.addEventListener('toggle', toggle, true);
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('toggle', toggle, true);
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, []);
}

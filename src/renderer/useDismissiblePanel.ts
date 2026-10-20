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
    /** Pins the panel beside its row: below the row's top in the upper half of the window, above its bottom lower down. */
    const place = (flyout: HTMLDetailsElement) => {
      const row = flyout.querySelector('summary')?.getBoundingClientRect();
      if (!row) return;
      const below = row.top + row.height / 2 < window.innerHeight / 2;
      flyout.dataset.flyoutSide = below ? 'down' : 'up';
      flyout.style.setProperty('--flyout-top', `${Math.round(row.top)}px`);
      flyout.style.setProperty('--flyout-bottom', `${Math.round(window.innerHeight - row.bottom)}px`);
      flyout.style.setProperty('--flyout-left', `${Math.round(row.left)}px`);
    };
    const toggle = (event: Event) => {
      const opened = event.target;
      if (!(opened instanceof HTMLDetailsElement) || !opened.open || !opened.matches(FLYOUT)) return;
      place(opened);
      for (const other of openFlyouts()) if (other !== opened && !other.contains(opened)) other.open = false;
    };
    const follow = () => openFlyouts().forEach(place);
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
    document.addEventListener('scroll', follow, true);
    window.addEventListener('resize', follow);
    document.addEventListener('pointerdown', pointer);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('toggle', toggle, true);
      document.removeEventListener('scroll', follow, true);
      window.removeEventListener('resize', follow);
      document.removeEventListener('pointerdown', pointer);
      document.removeEventListener('keydown', key);
    };
  }, []);
}

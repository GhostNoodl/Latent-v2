import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  onSelect(): void;
  /** Red text, for actions that remove something. */
  danger?: boolean;
  /** Accent text, for the action most people want. */
  primary?: boolean;
  disabled?: boolean;
  title?: string;
}
/** A group of actions; groups are split by a thin line. Falsy entries are skipped, so callers can write `cond && {...}`. */
export type MenuGroup = Array<MenuAction | false | null | undefined>;

/**
 * The app's one right-click menu: an optional heading, then grouped actions.
 * Opens at the pointer, stays on screen, and works with arrow keys, Home/End, Escape and Tab.
 */
export function ContextMenu({
  x,
  y,
  label,
  heading,
  groups,
  onClose,
}: {
  x: number;
  y: number;
  label: string;
  heading?: { title: string; detail?: string; image?: string };
  groups: MenuGroup[];
  onClose(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  useLayoutEffect(() => {
    const menu = ref.current!;
    const width = menu.offsetWidth || 260;
    const height = menu.offsetHeight || 0;
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
  }, [x, y]);
  useEffect(() => {
    const menu = ref.current!;
    const opener = document.activeElement;
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node)) closeRef.current();
    };
    const dismiss = () => closeRef.current();
    const wheel = (event: WheelEvent) => {
      if (!menu.contains(event.target as Node)) closeRef.current();
    };
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    document.addEventListener('wheel', wheel, { passive: true, capture: true });
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      document.removeEventListener('wheel', wheel, { capture: true });
      if (
        (document.activeElement === document.body ||
          !document.activeElement ||
          menu.contains(document.activeElement)) &&
        opener instanceof HTMLElement &&
        opener.isConnected
      )
        opener.focus();
    };
  }, []);
  const shown = groups
    .map(group => group.filter((item): item is MenuAction => Boolean(item)))
    .filter(group => group.length > 0);
  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      aria-label={label}
      style={{ left: x, top: y }}
      onContextMenu={event => event.preventDefault()}
      onKeyDown={event => {
        if (event.key === 'Escape' || event.key === 'Tab') {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
          }
          onClose();
          return;
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [...ref.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      {heading && (
        <div className="context-heading">
          {heading.image && <img src={heading.image} alt="" aria-hidden="true" draggable={false} />}
          <div>
            <strong title={heading.title}>{heading.title}</strong>
            {heading.detail && <small>{heading.detail}</small>}
          </div>
        </div>
      )}
      {shown.map((group, index) => (
        <div className="context-group" role="group" key={index}>
          {group.map(item => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? 'danger-menuitem' : item.primary ? 'accent-text' : undefined}
              disabled={item.disabled}
              title={item.title}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

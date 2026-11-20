import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';

/** A small panel that opens beside the chip that opened it, and closes on Escape or a click away. */
export function Popover({
  open,
  onClose,
  children,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      const anchor = box.current?.parentElement;
      if (anchor && !anchor.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('pointerdown', away);
      window.removeEventListener('keydown', escape);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={box} className={`ed-pop ${className}`} role="dialog">
      {children}
    </div>
  );
}

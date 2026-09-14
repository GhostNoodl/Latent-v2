import { Children, cloneElement, isValidElement, useEffect, useId, useRef, type ReactNode } from 'react';
import { LoaderCircle, X } from 'lucide-react';

export type RunAction = (key: string, task: () => Promise<unknown>, success?: string) => Promise<boolean>;
export function bytes(value: number) {
  if (!value) return '0 B';
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
}
export function shortDate(value: string) {
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function Field({ label, children, hint, className = '' }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  const labelId = useId(), hintId = useId();
  let connected = false;
  type ControlProps = { children?: ReactNode; type?: string; 'aria-label'?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string };
  // A field can wrap its input in a layout container (for example Seed's dice button).
  // Connect only the first form control; preserve explicit names and descriptions.
  const describe = (nodes: ReactNode): ReactNode => Children.map(nodes, child => {
    if (connected || !isValidElement<ControlProps>(child)) return child;
    if (typeof child.type === 'string' && ['input', 'select', 'textarea'].includes(child.type) && child.props.type !== 'hidden') {
      connected = true;
      if (!hint) return child;
      return cloneElement(child, {
        'aria-labelledby': child.props['aria-labelledby'] ?? (child.props['aria-label'] ? undefined : labelId),
        'aria-describedby': [child.props['aria-describedby'], hintId].filter(Boolean).join(' '),
      });
    }
    return child.props.children ? cloneElement(child, {}, describe(child.props.children)) : child;
  });
  return <label className={`field ${className}`}><span id={labelId}>{label}</span>{describe(children)}{hint && <small id={hintId}>{hint}</small>}</label>;
}
export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="toggle"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>;
}
export function Busy({ active }: { active?: boolean }) { return active ? <LoaderCircle className="spin" size={16} aria-label="Working" /> : null; }
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : undefined}>{children}</div>;
}
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const selector = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]';
    if (!node.contains(document.activeElement)) node.querySelector<HTMLElement>('input, select, textarea')?.focus();
    if (!node.contains(document.activeElement)) node.querySelector<HTMLElement>(selector)?.focus();
    const keydown = (event: KeyboardEvent) => {
      // Let text composition and child controls handle their own keyboard action.
      if (event.isComposing || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(selector)).filter(item => item.tabIndex >= 0 && item.getClientRects().length > 0);
      if (!items.length) { event.preventDefault(); return; }
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); items[items.length - 1].focus(); }
      else if (!event.shiftKey && (index < 0 || index === items.length - 1)) { event.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (opener.current?.isConnected) opener.current.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={ref} className="modal" role="dialog" aria-modal="true" aria-label={title}><div className="section-heading"><h3>{title}</h3><button type="button" className="icon-button" onClick={onClose} aria-label="Close dialog"><X size={18} /></button></div>{children}</section></div>;
}

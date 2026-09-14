import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ImageOff, RefreshCw } from 'lucide-react';
import { reportPreviewRecovery } from './image-preview-recovery';

/** Key by src at the call site so a newly selected image gets fresh load state. */
export function ImagePreview({ src, alt, className, style, width, height, saved = true }: { src: string; alt: string; className?: string; style?: CSSProperties; width?: number; height?: number; saved?: boolean }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retryButton = useRef<HTMLButtonElement>(null);
  const restoreRetryFocus = useRef(false);
  useEffect(() => {
    if (!failed || !restoreRetryFocus.current) return;
    restoreRetryFocus.current = false;
    if (document.activeElement === document.body) retryButton.current?.focus();
  }, [failed]);
  if (failed) return <div className="image-preview-unavailable" role="status"><ImageOff size={28} aria-hidden="true" /><strong>Preview unavailable</strong><p>{saved ? 'The image could not be loaded. Its saved parameters are still available.' : 'The live preview could not be loaded. Check the queue for generation progress.'}</p><button ref={retryButton} type="button" className="soft-button" onClick={event => { restoreRetryFocus.current = document.activeElement === event.currentTarget; setAttempt(value => value + 1); setFailed(false); }}><RefreshCw size={14} />Retry preview</button></div>;
  return <img key={attempt} src={src} alt={alt} className={className} style={style} width={width} height={height} onLoad={() => { restoreRetryFocus.current = false; if (saved && attempt > 0) reportPreviewRecovery(src); }} onError={() => setFailed(true)} />;
}

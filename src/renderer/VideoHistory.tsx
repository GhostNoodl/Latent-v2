import { useEffect, useRef, useState } from 'react';
import type { VideoHistoryRecord } from '../shared/video-types';
import { Notice } from './ui';
export function safeVideoHistoryUrl(record: VideoHistoryRecord) {
  if (!/^[a-f0-9]{32}$/.test(record.id)) return undefined;
  try { const url = new URL(record.mediaUrl); return url.protocol === 'latent-asset:' && url.hostname === 'video' && !url.username && !url.password && !url.port && url.pathname === `/${record.id}` && !url.search && !url.hash ? url.toString() : undefined; } catch { return undefined; }
}
export interface VideoHistoryProps { studio?: boolean; records: readonly VideoHistoryRecord[]; selectedId?: string; title?: string; loading?: boolean; error?: string; warnings?: readonly string[]; reuseDisabled?: boolean; playbackVisible?: boolean; onRefresh?(): void; onSelect(id: string): void; onReuse(id: string): void; onReveal(id: string): void; }
/** ID-only media routes supplied by main. No autoplay, remote media, hidden upload, or draft mutation. */
export function VideoHistory({ studio = false, records, selectedId, title = 'Video history', loading = false, error, warnings = [], reuseDisabled = false, playbackVisible = true, onRefresh, onSelect, onReuse, onReveal }: VideoHistoryProps) {
  const [contextId, setContextId] = useState<string>(); const [playbackErrorId, setPlaybackErrorId] = useState<string>(); const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const menu = useRef<HTMLDivElement>(null); const origin = useRef<HTMLButtonElement | null>(null);
  const selected = records.find(record => record.id === selectedId); const url = selected && safeVideoHistoryUrl(selected);
  const closeMenu = (restoreFocus = true) => { setContextId(undefined); if (restoreFocus) origin.current?.focus(); };
  const openMenu = (id: string, button: HTMLButtonElement) => { origin.current = button; onSelect(id); setContextId(id); };
  useEffect(() => { if (contextId) menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(); }, [contextId]);
  useEffect(() => { if (contextId && !records.some(record => record.id === contextId)) setContextId(undefined); }, [contextId, records]);
  return <section className={`${studio ? 'video-history-split' : 'settings-card'} video-history ${title === 'Video history' ? 'video-history-primary' : ''}`}><aside className="video-history-rail"><div className="section-heading"><h2>{title}</h2>{onRefresh && <button type="button" disabled={loading} onClick={onRefresh}>{loading ? 'Refreshing videos…' : error ? 'Retry video history' : 'Refresh video history'}</button>}</div>
    {error && <Notice error>{error} Previously loaded records and recipes remain available.</Notice>}
    {warnings.length > 0 && <Notice><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></Notice>}
    {loading && <p role="status">Loading saved videos…</p>}
    {!records.length && !loading && !error && <p>No saved videos yet. Your generated videos will appear here.</p>}
    {selectedId && !selected && !loading && <Notice>The selected video is unavailable in this history listing. Its saved selection is retained; refresh to check again.</Notice>}
    <div className="history-grid">{records.map(record => <button type="button" key={record.id} aria-pressed={record.id === selectedId} aria-haspopup="menu" aria-expanded={contextId === record.id} onClick={() => onSelect(record.id)} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); openMenu(record.id, event.currentTarget); } }} onContextMenu={event => { event.preventDefault(); openMenu(record.id, event.currentTarget); }}>{playbackVisible && safeVideoHistoryUrl(record) && <video className="video-thumbnail" src={safeVideoHistoryUrl(record)} muted playsInline preload="metadata" onLoadedMetadata={event => { if (event.currentTarget.currentTime === 0) event.currentTarget.currentTime = 0.01; }} aria-label={`Preview of ${record.title}`} />}<strong>{record.title}</strong><span>{record.media.width} × {record.media.height} · {record.media.durationSeconds.toFixed(3)} s</span><small>{record.evidenceKind === 'synthetic-fixture' ? 'Synthetic playback fixture — not generated' : new Date(record.createdAt).toLocaleString()}</small></button>)}</div>
    {contextId && <div ref={menu} role="menu" aria-label="Video actions" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu(false); }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]; const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}><button type="button" role="menuitem" disabled={reuseDisabled || !records.find(record => record.id === contextId)?.plan} onClick={() => { onReuse(contextId); closeMenu(); }}>Reuse video parameters</button><button type="button" role="menuitem" onClick={() => { onReveal(contextId); closeMenu(); }}>Show saved video</button><button type="button" role="menuitem" onClick={() => closeMenu()}>Close menu</button></div>}
    </aside>
    {!selected && studio && <div className="video-preview-empty"><FilmPlaceholder /><h2>A little room for motion</h2><p>Describe your video and generate, or select a recent video to play it here.</p></div>}
    {selected && <article className="video-preview">{selected.evidenceKind === 'synthetic-fixture' && <Notice>Synthetic fixture for codec, playback and seeking checks. This is not MiniMax H3 output.</Notice>}
      {url ? playbackVisible && <video key={`${selected.id}:${playbackAttempt}`} src={url} controls playsInline preload="metadata" onError={() => setPlaybackErrorId(selected.id)} onLoadedMetadata={() => setPlaybackErrorId(undefined)} style={{ display: 'block', width: '100%', maxHeight: '65vh', background: '#16151a' }} aria-label={selected.title} /> : <Notice error>The saved video URL is invalid or unavailable.</Notice>}
      {playbackErrorId === selected.id && <Notice error>The video could not be played. Check the saved file and codec support; the record and recipe are retained. {url && <button type="button" onClick={() => { setPlaybackErrorId(undefined); setPlaybackAttempt(value => value + 1); }}>Retry playback</button>}</Notice>}
      <details className="video-media-details"><summary>Video details</summary><dl className="metadata"><dt>Video</dt><dd>{selected.media.videoCodec} · {selected.media.width} × {selected.media.height} · {selected.media.frames} frames · {selected.media.fps.numerator}/{selected.media.fps.denominator} fps · {selected.media.durationSeconds.toFixed(4)} s</dd><dt>Audio</dt><dd>{selected.media.audio.length ? selected.media.audio.map(track => `${track.codec}, ${track.channels} channels, ${track.sampleRate} Hz`).join('; ') : 'No audio track'}</dd><dt>File identity</dt><dd>{selected.media.sha256}</dd></dl></details>
      {selected.plan && <details><summary>Saved video recipe</summary><p>{selected.plan.draft.prompt}</p><p>Seed {selected.plan.actualSeed} · {selected.plan.sampling.steps} steps · {selected.plan.sampling.sampler} / {selected.plan.sampling.scheduler} · {selected.plan.workflowVersion}</p><p>Requested {selected.plan.draft.requestedDurationSeconds} s; resolved {selected.plan.frames} frames / {selected.plan.durationSeconds.toFixed(4)} s.</p><p>{selected.plan.sources.length ? selected.plan.sources.map(source => `${source.role} frame: ${source.sourceId}, ${source.resize}, SHA ${source.sha256}`).join('; ') : 'Text to video; no image references.'}</p></details>}
      <div className="button-row"><button type="button" disabled={reuseDisabled || !selected.plan} onClick={() => onReuse(selected.id)}>Reuse video parameters</button><button type="button" onClick={() => onReveal(selected.id)}>Show saved video</button></div>
    </article>}
  </section>;
}

function FilmPlaceholder() { return <span aria-hidden="true" className="video-empty-icon">▷</span>; }

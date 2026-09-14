import { PackageSetupStorage } from './PackageSetupStorage';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CircleStop, Cpu, Download, LoaderCircle, MessageCircle, Play, RotateCcw, Send, Sparkles, Trash2 } from 'lucide-react';
import type { GenerationDraft } from '../shared/types';
import type { AssistantConversation, AssistantStatus, AssistantSuggestion } from '../shared/assistant-types';
import { bytes, Modal, Notice, shortDate, type RunAction } from './ui';
import './assistant.css';
import { actionErrorMessage as message } from '../shared/action-error';

interface PromptAssistantProps {
  target?: 'image' | 'video';
  videoContext?: import('../shared/video-types').VideoDraft;
  status: AssistantStatus;
  draft: GenerationDraft;
  onApply: (suggestion: AssistantSuggestion) => void;
  onClose: () => void;
  run: RunAction;
}
const emptyConversation = (): AssistantConversation => ({ version: 1, messages: [], instruction: '' });
const samePrompts = (a: GenerationDraft, b: GenerationDraft) => a.prompt === b.prompt && a.negativePrompt === b.negativePrompt;

export function PromptAssistant({ target = 'image', videoContext, status, draft, onApply, onClose, run }: PromptAssistantProps) {
  const [conversation, setConversation] = useState<AssistantConversation>(emptyConversation);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving'>('saved');
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const current = useRef(conversation);
  const currentDraft = useRef(draft); currentDraft.current = draft;
  const currentStatus = useRef(status); currentStatus.current = status;
  const revision = useRef(0);
  const savedRevision = useRef(0);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const hydrated = useRef(false);
  const loadEpoch = useRef(0);
  const closing = useRef(false);
  const requesting = useRef<Promise<void> | null>(null);
  const cancelled = useRef(false);
  const log = useRef<HTMLDivElement>(null);
  const instructionInput = useRef<HTMLTextAreaElement>(null);
  const actions = useRef(new Set<string>());
  const criticalActions = useRef(new Set<Promise<boolean>>());

  const changeConversation = useCallback((next: AssistantConversation) => {
    const retained = new Set(next.messages.flatMap(entry => entry.suggestion ? [entry.suggestion.id] : []));
    current.current = structuredClone({ ...next, selectedSuggestionId: next.selectedSuggestionId && retained.has(next.selectedSuggestionId) ? next.selectedSuggestionId : undefined, appliedSuggestionId: next.appliedSuggestionId && retained.has(next.appliedSuggestionId) ? next.appliedSuggestionId : undefined }); revision.current++;
    if (mounted.current) { setConversation(current.current); setSaveState('pending'); setSaveError(''); }
  }, []);
  const persist = useCallback((snapshot: AssistantConversation, version: number): Promise<void> => {
    const work = saveQueue.current.catch(() => {}).then(async () => {
      if (version <= savedRevision.current) return;
      if (mounted.current) setSaveState('saving');
      await window.latent.saveAssistantConversation(snapshot, target);
      savedRevision.current = version;
      if (mounted.current) { setSaveError(''); setSaveState(version === revision.current ? 'saved' : 'pending'); }
    });
    saveQueue.current = work;
    return work.catch(reason => { if (mounted.current) { setSaveError(message(reason)); setSaveState('pending'); } throw reason; });
  }, []);
  const flush = useCallback(async () => {
    if (!hydrated.current) return;
    // Selection can change while IPC is saving. Close must drain those newer
    // revisions before the panel unmounts and cancels its debounce timer.
    do { await persist(structuredClone(current.current), revision.current); }
    while (savedRevision.current < revision.current);
  }, [persist]);

  const load = useCallback(async () => {
    const epoch = ++loadEpoch.current;
    if (!window.latent?.getAssistantConversation) { setLoading(false); setError('The desktop assistant bridge is unavailable. Open this panel in the updated desktop app.'); return; }
    setLoading(true); setError('');
    try {
      const saved = await window.latent.getAssistantConversation(target);
      if (!mounted.current || epoch !== loadEpoch.current) return;
      current.current = saved ?? emptyConversation(); setConversation(current.current);
      hydrated.current = true; setLoaded(true);
    } catch (reason) { if (mounted.current && epoch === loadEpoch.current) setError(`Conversation could not be loaded: ${message(reason)}`); }
    finally { if (mounted.current && epoch === loadEpoch.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true; void load();
    return () => { mounted.current = false; loadEpoch.current++; };
  }, [load]);
  useEffect(() => {
    if (!loaded || closing.current || revision.current <= savedRevision.current) return;
    const timer = window.setTimeout(() => { void flush().catch(() => {}); }, 300);
    return () => window.clearTimeout(timer);
  }, [conversation, loaded, flush]);
  useEffect(() => {
    const hidden = () => { if (!closing.current && document.visibilityState === 'hidden') void flush().catch(() => {}); };
    document.addEventListener('visibilitychange', hidden);
    const resetClose = () => { closing.current = false; if (mounted.current) setPending(value => ({ ...value, close: false })); };
    const unsubscribe = window.latent?.onBeforeClose?.(async () => {
      closing.current = true; if (mounted.current) setPending(value => ({ ...value, close: true }));
      try {
        if (requesting.current || currentStatus.current.state === 'thinking') { cancelled.current = true; await window.latent.cancelAssistant(); await requesting.current; }
        await Promise.all([...criticalActions.current]);
        await flush();
      } catch (reason) { resetClose(); throw reason; }
    });
    const unsubscribeCancelled = window.latent?.onCloseCancelled?.(resetClose);
    return () => { document.removeEventListener('visibilitychange', hidden); unsubscribe?.(); unsubscribeCancelled?.(); };
  }, [flush]);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [conversation.messages.length, pending.suggest]);

  const action = useCallback(async (key: string, task: () => Promise<void>, success?: string) => {
    if (closing.current || actions.current.has(key)) return false;
    actions.current.add(key); if (mounted.current) { setPending(value => ({ ...value, [key]: true })); setError(''); }
    const work = run(`assistant-${key}`, async () => {
      try { await task(); }
      catch (reason) { if (mounted.current) setError(message(reason)); throw reason; }
    }, success);
    if (key === 'apply' || key === 'clear') criticalActions.current.add(work);
    try { return await work; }
    finally { criticalActions.current.delete(work); actions.current.delete(key); if (mounted.current) setPending(value => ({ ...value, [key]: false })); }
  }, [run]);

  const selected = conversation.messages.find(entry => entry.suggestion?.id === conversation.selectedSuggestionId)?.suggestion
    ?? [...conversation.messages].reverse().find(entry => entry.suggestion)?.suggestion;
  const diverged = selected ? JSON.stringify(draft) !== JSON.stringify(selected.originalDraft) : false;
  const alreadyMatches = selected ? samePrompts(draft, selected.proposedDraft) : false;
  const applied = selected?.id === conversation.appliedSuggestionId && alreadyMatches;
  const thinking = pending.suggest || status.state === 'thinking';
  const changingRuntime = pending.setup || pending.start || pending.stop || status.state === 'installing' || status.state === 'starting';
  const disabled = !loaded || pending.close || pending.apply || pending.clear;
  const progress = Math.max(0, Math.min(100, status.installProgress ?? 0));

  async function close() {
    if (actions.current.has('close') || actions.current.has('apply') || actions.current.has('clear')) return;
    if (!hydrated.current) { onClose(); return; }
    await action('close', async () => {
      if (requesting.current || currentStatus.current.state === 'thinking') {
        cancelled.current = true; await window.latent.cancelAssistant(); await requesting.current;
      }
      await flush(); closing.current = true; onClose();
    });
  }
  async function cancelReply() {
    cancelled.current = true;
    await action('cancel', async () => { await window.latent.cancelAssistant(); await requesting.current; setNotice('Reply cancelled. Your conversation and instruction are kept.'); });
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const instruction = current.current.instruction.trim();
    if (closing.current || !instruction || instruction.length > 4000 || disabled || currentStatus.current.state !== 'ready' || requesting.current || changingRuntime || ['close', 'apply', 'clear'].some(key => actions.current.has(key))) return;
    setNotice(''); cancelled.current = false;
    const before = structuredClone(current.current);
    const requestDraft = structuredClone(currentDraft.current);
    const history = before.messages.slice(-8).map(entry => ({
      role: entry.role,
      content: entry.suggestion ? JSON.stringify({ explanation: entry.suggestion.explanation.slice(0, 1200), prompt: entry.suggestion.proposedDraft.prompt.slice(0, 2100), negativePrompt: entry.suggestion.proposedDraft.negativePrompt.slice(0, 2100) }) : entry.content.slice(0, 6000),
    }));
    changeConversation({ ...before, instruction: '', messages: [...before.messages, { id: crypto.randomUUID(), role: 'user' as const, content: instruction, createdAt: new Date().toISOString() }].slice(-30) });
    const request = action('suggest', async () => {
      let accepted = false;
      try {
        await flush();
        if (cancelled.current) return;
        const suggestion = await window.latent.suggestPrompt({ instruction, draft: requestDraft, history, target, videoContext });
        if (cancelled.current) return;
        const latest = current.current;
        changeConversation({ ...latest, selectedSuggestionId: suggestion.id, messages: [...latest.messages, { id: suggestion.id, role: 'assistant' as const, content: suggestion.explanation, createdAt: suggestion.createdAt, suggestion }].slice(-30) });
        accepted = true;
        await flush();
      } catch (reason) {
        if (!cancelled.current) throw reason;
      } finally {
        // Cancellation may happen before inference starts or after its result
        // arrives. Keep retry text in either case without erasing newer typing.
        if (!accepted && !current.current.instruction) changeConversation({ ...current.current, instruction });
      }
    }).then(() => {});
    requesting.current = request;
    void request.finally(() => { if (requesting.current === request) requesting.current = null; });
  }
  async function apply() {
    if (!selected || alreadyMatches || disabled || thinking) return;
    await action('apply', async () => {
      await flush();
      if (closing.current) throw new Error('Applying prompts was interrupted because the app is closing. Your proposal is retained for review.');
      // The proposal stays immutable in conversation history. Apply its two text
      // fields to the current draft, including edits made after the request began.
      onApply({ ...structuredClone(selected), proposedDraft: { ...structuredClone(currentDraft.current), prompt: selected.proposedDraft.prompt, negativePrompt: selected.proposedDraft.negativePrompt } });
      changeConversation({ ...current.current, appliedSuggestionId: selected.id });
      await flush(); setNotice(target === 'video' ? 'Prompt applied to Video. Undo is available in Video.' : 'Prompts applied to Create. Undo is available in Create.');
    });
  }
  async function clear() {
    if (thinking || disabled) return;
    await action('clear', async () => { changeConversation(emptyConversation()); await flush(); setNotice('Conversation cleared.'); instructionInput.current?.focus(); });
  }

  return <div className="prompt-assistant"><Modal title={target === 'video' ? 'Shape your video prompt' : 'Your prompt, a little more possibility'} onClose={() => { void close(); }}>
    <div className="assistant-intro"><span className="assistant-emblem"><Sparkles size={22} /></span><div><p>Talk through an idea with Qwen3, then review the words together.</p><span>Local assistant · CPU · no paid API</span></div><span className={`assistant-state state-${status.state}`}><Cpu size={14} />{status.state === 'ready' ? 'Ready when you are' : status.state === 'thinking' ? 'Writing a proposal' : status.state.replaceAll('-', ' ')}</span></div>
      {['not-installed', 'error', 'installing'].includes(status.state) && <PackageSetupStorage packageId="assistant" />}
    <section className="assistant-runtime" aria-label="Local assistant controls">
      <div className="assistant-runtime-message"><strong>{status.message}</strong>{status.state === 'not-installed' && <p>One-time download: about 2.5 GB. Install the model, then start it when you want help.</p>}{status.state === 'installing' && <><progress value={progress} max={100} aria-label="Assistant installation progress" /><small>{progress.toFixed(0)}%{status.totalBytes ? ` · ${bytes(status.receivedBytes ?? 0)} / ${bytes(status.totalBytes)}` : ''}</small></>}</div>
      <div className="button-row">
        {['not-installed', 'error'].includes(status.state) && <button className="soft-button" disabled={changingRuntime || thinking || disabled} onClick={() => { void action('setup', () => window.latent.setupAssistant(status.state === 'error')); }}><Download size={15} />{status.state === 'error' ? 'Verify / repair installation' : 'Install · 2.5 GB'}</button>}
        {['not-installed', 'stopped', 'error'].includes(status.state) && <button className="soft-button" title={!status.installationAvailable ? 'Finish or repair installation before starting.' : undefined} disabled={!status.installationAvailable || status.state === 'not-installed' || changingRuntime || thinking || disabled} onClick={() => { void action('start', () => window.latent.startAssistant()); }}><Play size={15} />Start assistant</button>}
        {['ready', 'thinking', 'starting', 'installing'].includes(status.state) && <button disabled={pending.stop || pending.close || !loaded} onClick={() => { cancelled.current = true; void action('stop', async () => { await window.latent.stopAssistant(); await requesting.current; setNotice('Local assistant stopped.'); }); }}><CircleStop size={15} />{status.state === 'installing' ? 'Cancel installation' : status.state === 'starting' ? 'Cancel startup' : 'Stop assistant'}</button>}
      </div>
    </section>
    {error && <Notice error>{error}{!loaded && !loading && <button className="text-button" onClick={() => { void load(); }}><RotateCcw size={13} />Retry loading conversation</button>}</Notice>}
    {saveError && <Notice error>Conversation could not be saved: {saveError} <button className="text-button" onClick={() => { void action('save', flush); }} disabled={pending.save}>Retry save</button></Notice>}
    {notice && <p className="assistant-feedback" role="status">{notice}</p>}
    <div className="assistant-workspace">
      <section className="assistant-chat" aria-label="Conversation">
        <div className="assistant-section-title"><h4><MessageCircle size={16} />Let's shape the idea</h4><button className="icon-button" title="Clear conversation" aria-label="Clear conversation" disabled={disabled || thinking || (!conversation.messages.length && !conversation.instruction)} onClick={() => { void clear(); }}><Trash2 size={15} /></button></div>
        <div className="assistant-messages" ref={log} role="log" aria-label="Prompt conversation" aria-live="polite" aria-relevant="additions text" tabIndex={0}>
          {loading ? <div className="assistant-chat-empty"><LoaderCircle className="spin" size={20} /><p>Opening your conversation…</p></div> : !conversation.messages.length ? <div className="assistant-chat-empty"><Sparkles size={27} /><h4>A second pair of words.</h4><p>{target === 'video' ? 'Describe the action and camera movement, or refine your current video prompt.' : 'Describe the scene, ask for a mood, or refine the prompt already in Create.'}</p><button disabled={disabled} onClick={() => { changeConversation({ ...current.current, instruction: target === 'video' ? 'Help me refine the motion and camera movement while preserving my subjects and style.' : 'Help me refine the atmosphere and lighting while preserving my subjects and style.' }); instructionInput.current?.focus(); }}>{target === 'video' ? 'Refine motion & camera' : 'Refine atmosphere & lighting'} <ArrowRight size={13} /></button></div> : conversation.messages.map(entry => <article key={entry.id} className={`assistant-message message-${entry.role}`}><div className="assistant-message-meta"><strong>{entry.role === 'user' ? 'You' : 'Qwen3'}</strong><time dateTime={entry.createdAt}>{shortDate(entry.createdAt)}</time></div><p>{entry.content}</p>{entry.suggestion && <button className={entry.suggestion.id === selected?.id ? 'assistant-review-button selected' : 'assistant-review-button'} aria-pressed={entry.suggestion.id === selected?.id} disabled={Boolean(pending.apply)} onClick={() => changeConversation({ ...current.current, selectedSuggestionId: entry.suggestion!.id })}><Sparkles size={13} />{entry.suggestion.id === selected?.id ? 'Reviewing this proposal' : 'Review this proposal'}<ArrowRight size={12} /></button>}</article>)}
          {thinking && <div className="assistant-thinking" role="status"><LoaderCircle className="spin" size={16} /><span>Qwen3 is writing on your CPU…</span></div>}
        </div>
        <form className="assistant-composer" onSubmit={submit}>
          <label htmlFor="assistant-instruction">What would you like to change?</label>
          <textarea id="assistant-instruction" ref={instructionInput} value={conversation.instruction} maxLength={4000} disabled={!loaded || pending.close || pending.clear} onChange={event => changeConversation({ ...current.current, instruction: event.target.value })} placeholder="Make the scene feel like a quiet, rainy afternoon…" rows={3} onKeyDown={event => { if (!event.nativeEvent.isComposing && !event.defaultPrevented && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <div className="assistant-composer-actions"><small>{conversation.instruction.length.toLocaleString()} / 4,000 · Ctrl+Enter</small>{thinking ? <button type="button" disabled={pending.cancel || pending.close} onClick={() => { void cancelReply(); }}><CircleStop size={15} />{pending.cancel ? 'Cancelling…' : 'Cancel reply'}</button> : <button type="submit" className="primary" disabled={disabled || changingRuntime || status.state !== 'ready' || !conversation.instruction.trim()}><Send size={14} />Ask Qwen3</button>}</div>
          {status.state !== 'ready' && !thinking && <small className="assistant-composer-help">{status.state === 'not-installed' ? 'Install and start the assistant above to send a message.' : 'Start the assistant when you are ready to send.'}</small>}
        </form>
      </section>
      <section className="assistant-review" aria-label="Review prompt changes">
        <div className="assistant-section-title"><h4><Sparkles size={16} />Review before applying</h4>{applied && <span className="assistant-applied"><Check size={13} />Applied</span>}</div>
        {selected ? <>
          {diverged && !applied && <div className="assistant-divergence" role="status">Create has changed since this proposal began. Applying replaces the positive and negative prompts currently shown in the middle column.</div>}
          <div className="assistant-compare-head" aria-hidden="true"><span>Original at request</span><span>Current in Create</span><span className="assistant-proposal-label">Proposed by Qwen3</span></div>
          <PromptComparison target={target} title={target === 'video' ? 'Video prompt' : 'Positive prompt'} original={selected.originalDraft.prompt} current={draft.prompt} proposed={selected.proposedDraft.prompt} />
          {target !== 'video' && <PromptComparison title="Negative prompt" original={selected.originalDraft.negativePrompt} current={draft.negativePrompt} proposed={selected.proposedDraft.negativePrompt} />}
          <div className="assistant-apply-row"><p>{target === 'video' ? 'Applies the motion prompt to Video.' : 'Applies both prompts to Create.'}<br /><span>Undo is available after applying.</span></p><button className="primary" disabled={disabled || thinking || alreadyMatches} onClick={() => { void apply(); }}>{pending.apply ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{pending.apply ? 'Applying…' : applied ? `Applied to ${target === 'video' ? 'Video' : 'Create'}` : alreadyMatches ? 'Already matches' : diverged ? 'Apply to current draft' : 'Apply prompts'}</button></div>
          <details className="assistant-provenance"><summary>About this proposal</summary><dl><dt>Model</dt><dd>{selected.modelId}</dd><dt>Revision</dt><dd>{selected.modelRevision}</dd><dt>Created</dt><dd>{shortDate(selected.createdAt)}</dd><dt>Local generation</dt><dd>{(selected.durationMs / 1000).toFixed(1)} seconds · {selected.promptTokens.toLocaleString()} input tokens{selected.completionTokens !== undefined ? ` · ${selected.completionTokens.toLocaleString()} output tokens` : ''}</dd><dt>Conversation context</dt><dd>{selected.historyTurnsUsed} earlier messages used</dd></dl></details>
        </> : <div className="assistant-review-empty"><div className="assistant-review-swatch"><Sparkles size={32} /></div><h4>Every change gets a preview.</h4><p>Your original, current, and proposed prompts will appear side by side here. Choose Apply when the wording feels right.</p><div className="assistant-current-preview"><span>{target === 'video' ? 'Current video prompt' : 'Current positive prompt'}</span><p>{draft.prompt || 'No positive prompt yet.'}</p>{target !== 'video' && <><span>Current negative prompt</span><p>{draft.negativePrompt || 'No negative prompt yet.'}</p></>}</div></div>}
      </section>
    </div>
    <footer className="assistant-footer"><p><span className={saveError ? 'assistant-save-error' : ''}>{loading ? 'Loading conversation…' : !loaded ? 'Conversation unavailable' : saveError ? 'Unsaved conversation' : saveState === 'saving' ? 'Saving locally…' : saveState === 'pending' ? 'Changes waiting to save' : 'Conversation saved locally'}</span><small>Latest 30 messages are retained until Clear conversation. Image and video conversations are saved separately.</small></p><button disabled={pending.close || pending.apply || pending.clear} onClick={() => { void close(); }}>{pending.close && <LoaderCircle className="spin" size={14} />}{thinking ? 'Cancel reply & close' : 'Done'}</button></footer>
    {!!status.logTail.length && <details className="assistant-logs"><summary>Assistant activity</summary><pre>{status.logTail.slice(-20).join('\n')}</pre></details>}
  </Modal></div>;
}

function PromptComparison({ target = 'image', title, original, current, proposed }: { target?: 'image' | 'video'; title: string; original: string; current: string; proposed: string }) {
  return <fieldset className="assistant-comparison"><legend>{title}</legend><div className="assistant-comparison-grid">{[{ label: 'Original at request', text: original }, { label: target === 'video' ? 'Current in Video' : 'Current in Create', text: current }, { label: 'Proposed by Qwen3', text: proposed }].map((item, index) => <label key={item.label} className={index === 2 ? 'assistant-proposed' : ''}><span>{item.label}</span><textarea readOnly aria-label={`${title} — ${item.label}`} value={item.text} placeholder="No text" rows={5} spellCheck={false} /></label>)}</div></fieldset>;
}

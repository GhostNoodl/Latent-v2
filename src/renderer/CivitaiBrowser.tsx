import { UrlDownload } from './UrlDownload';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Download, ExternalLink, Globe, KeyRound, Search, Settings2, X } from 'lucide-react';
import type { AppSnapshot, ModelAsset, ModelKind } from '../shared/types';
import type { CivitaiDownloadRequest, CivitaiModel, CivitaiPermissions, CivitaiReadResult, CivitaiSearchPage, CivitaiSearchRequest, CivitaiSettings, CivitaiVersion } from '../shared/civitai-types';
import { Busy, Field, Notice, bytes } from './ui';
import { actionErrorMessage } from '../shared/action-error';
import { DownloadStorage } from './DownloadStorage';
import { MODEL_DOWNLOAD_RESERVE_BYTES } from '../shared/model-download-space';
import './civitai.css';

const refreshDownloadStorage = () => window.latent.getModelDownloadStorage();

// Keep the browser's connected preload contract explicit.
interface CivitaiAPI {
  civitaiSearch(request: CivitaiSearchRequest): Promise<CivitaiReadResult<CivitaiSearchPage>>;
  civitaiDetail(modelId: number): Promise<CivitaiReadResult<CivitaiModel>>;
  civitaiDownload(request: CivitaiDownloadRequest): Promise<ModelAsset>;
  cancelCivitai(): Promise<void>;
  getCivitaiSettings(): Promise<CivitaiSettings>;
  setCivitaiKey(value: string | null): Promise<void>;
  openCivitaiModel(modelId: number, versionId?: number): Promise<void>;
}
const api = () => window.latent as typeof window.latent & CivitaiAPI;
function workflowIssue(model: CivitaiModel, version: CivitaiVersion) {
  if (version.family === 'unknown') return 'Unknown or unsupported base family';
  if (!['SDXL 1.0', 'Illustrious'].includes(version.baseModel)) return 'Requires a different generation workflow';
  if (model.kind === 'checkpoint' && version.baseModelType !== 'Standard') return 'Requires an explicitly Standard checkpoint';
  if (model.kind === 'lora' && version.baseModelType && version.baseModelType !== 'Standard') return 'Requires a different checkpoint workflow';
  return null;
}
function ModelRequirements({ model, version, models }: { model: CivitaiModel; version: CivitaiVersion; models: ModelAsset[] }) {
  const issue = workflowIssue(model, version);
  const candidates = models.filter(asset => asset.kind === 'checkpoint' && asset.status === 'ready' && version.family !== 'unknown' && asset.family === version.family);
  return <section aria-label="Dependencies and compatibility"><h3>Dependencies and compatibility</h3>
    {issue ? <p className="small">This version needs a workflow that Create does not support.</p> : model.kind === 'lora' ? <>
      <p className="small">Requires a compatible {version.baseModel} checkpoint. A LoRA cannot generate images on its own.</p>
      {candidates.length ? <><p className="small">Installed checkpoints tagged with this family:</p><ul>{candidates.map(asset => <li key={asset.id}>{asset.name}</li>)}</ul><p className="muted small">Family tags identify candidates; check the creator’s notes for the exact checkpoint and settings.</p></> : <p className="small">No ready checkpoint with this family tag is installed. Add one in Models before generating with this LoRA.</p>}
    </> : <p className="small">Create uses this checkpoint with the managed image-generation workflow. Optional features have their own setup requirements.</p>}
    <p className="muted small">Additional creator requirements may appear in Model notes or Version notes. An absent requirement is not confirmation that no extra setup is needed.</p>
  </section>;
}
function CreatorPreview({ url, name, refresh }: { url?: string; name: string; refresh: unknown }) {
  const [failedUrl, setFailedUrl] = useState<string>();
  useEffect(() => { setFailedUrl(undefined); }, [refresh]);
  if (!url || failedUrl === url) return <span className="civitai-no-preview" role="img" aria-label={url ? 'Creator preview unavailable' : 'No creator preview'} title={url ? 'Creator preview unavailable' : 'No creator preview'}><Globe size={26} /></span>;
  return <img loading="lazy" referrerPolicy="no-referrer" src={url} alt={name + ' creator preview'} onError={() => setFailedUrl(url)} />;
}
const yesNo = (value: boolean | null) => value === null ? 'Not declared' : value ? 'Allowed' : 'Not allowed';
function Permissions({ value }: { value: CivitaiPermissions }) {
  return <dl className="civitai-permissions"><dt>Use without credit</dt><dd>{yesNo(value.allowNoCredit)}</dd><dt>Derivatives</dt><dd>{yesNo(value.allowDerivatives)}</dd><dt>Different license</dt><dd>{yesNo(value.allowDifferentLicense)}</dd><dt>Commercial use</dt><dd>{value.allowCommercialUse === null ? 'Not declared' : value.allowCommercialUse.length ? value.allowCommercialUse.join(', ') : 'None declared'}</dd></dl>;
}

export function CivitaiBrowser({ snapshot, receive, onUse, onBack }: { snapshot: AppSnapshot; receive: (snapshot: AppSnapshot) => void; onUse: (model: ModelAsset) => void; onBack: () => void }) {
  const [sort, setSort] = useState<NonNullable<CivitaiSearchRequest['sort']>>('Most Downloaded');
  const [period, setPeriod] = useState<NonNullable<CivitaiSearchRequest['period']>>('AllTime');
  const [username, setUsername] = useState('');
  const [tag, setTag] = useState('');
  const [includeMature, setIncludeMature] = useState(true);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ModelKind | 'all'>('all');
  const [family, setFamily] = useState<'all' | 'sdxl' | 'illustrious'>('all');
  const [results, setResults] = useState<CivitaiReadResult<CivitaiSearchPage>>();
  const [lastRequest, setLastRequest] = useState<CivitaiSearchRequest>();
  const [searchFailed, setSearchFailed] = useState(false);
  const [detail, setDetail] = useState<CivitaiReadResult<CivitaiModel>>();
  const [versionId, setVersionId] = useState<number>();
  const [working, setWorking] = useState<'search' | 'detail' | 'key' | null>(null);
  const [downloading, setDownloading] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<CivitaiSettings>({ hasApiKey: false });
  const [key, setKey] = useState('');
  const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const serial = useRef(0);
  const intent = useRef(0), keyRevision = useRef(0), settingsRevision = useRef(0);
  const alive = useRef(true), closing = useRef(false), cancellingRef = useRef(false), downloadingRef = useRef(false);
  const workingRef = useRef<typeof working>(null);
  function work(value: typeof working) { workingRef.current = value; setWorking(value); }
  function editKey(value: string) { keyRevision.current++; setKey(value); }
  const active = () => alive.current && !closing.current;
  useEffect(() => {
    alive.current = true;
    const requestedSettings = settingsRevision.current;
    void api().getCivitaiSettings().then(value => { if (alive.current && requestedSettings === settingsRevision.current) setSettings(value); }).catch(error => { if (alive.current && requestedSettings === settingsRevision.current) setError(actionErrorMessage(error)); });
    const before = window.latent.onBeforeClose?.(async () => { closing.current = true; serial.current++; intent.current++; });
    const cancelled = window.latent.onCloseCancelled?.(() => { closing.current = false; if (workingRef.current !== 'key') work(null); });
    return () => { alive.current = false; workingRef.current = null; serial.current++; intent.current++; before?.(); cancelled?.(); };
  }, []);
  useEffect(() => { void search(); }, []);
  const selectedVersion = detail?.data.versions.find(version => version.id === versionId);
  const activeDownloads = snapshot.downloads.filter(item => ['downloading', 'verifying'].includes(item.state) && item.name.startsWith('civitai_'));
  async function search(more = false, creator?: string) {
    if (!active() || workingRef.current || cancellingRef.current || more && !results?.data.nextCursor) return;
    const request: CivitaiSearchRequest = more && lastRequest ? { ...lastRequest, cursor: results?.data.nextCursor ?? undefined } : { query: creator ? '' : query, username: creator ?? (username || undefined), tag: creator ? undefined : tag || undefined, period, includeMature, kind: kind === 'all' ? undefined : kind, family: family === 'all' ? undefined : family, limit: 20, sort };
    const current = ++serial.current; intent.current++; work('search'); setError(''); setMessage('');
    try {
      const incoming = await api().civitaiSearch(request); if (current !== serial.current) return;
      setResults(previous => more && previous ? { ...incoming, data: { ...incoming.data, items: [...new Map([...previous.data.items, ...incoming.data.items].map(model => [model.id, model])).values()] } } : incoming);
      setSearchFailed(false);
      setLastRequest({ ...request, cursor: undefined }); if (!more) { setDetail(undefined); setVersionId(undefined); }
    } catch (error) { if (current === serial.current) { setSearchFailed(true); setError(actionErrorMessage(error)); } }
    finally { if (current === serial.current) work(null); }
  }
  async function openDetail(modelId: number) {
    if (!active() || workingRef.current || cancellingRef.current) return;
    const current = ++serial.current; intent.current++; work('detail'); setError(''); setMessage('');
    try { const next = await api().civitaiDetail(modelId); if (current !== serial.current) return; setDetail(next); setVersionId(next.data.versions[0]?.id); }
    catch (error) { if (current === serial.current) setError(actionErrorMessage(error)); }
    finally { if (current === serial.current) work(null); }
  }
  async function install(request: CivitaiDownloadRequest, useAfter = false) {
    if (!active() || workingRef.current || downloadingRef.current || cancellingRef.current) return;
    downloadingRef.current = true;
    const requestedIntent = intent.current;
    const identity = `${request.modelId}:${request.versionId}:${request.fileId}`; setDownloading(identity); setError(''); setMessage('');
    try {
      const installed = await api().civitaiDownload(request);
      if (!active()) return;
      const refreshed = await window.latent.refreshModels();
      if (!active()) return;
      receive(refreshed);
      if (requestedIntent !== intent.current) return;
      setMessage(`${installed.name} is in your studio. Its exact file identity is saved with the model.`);
      if (useAfter) onUse(installed);
    } catch (error) { if (active() && requestedIntent === intent.current) setError(actionErrorMessage(error)); }
    finally { downloadingRef.current = false; if (alive.current) setDownloading(undefined); }
  }
  async function saveKey(remove = false) {
    if (!active() || workingRef.current || cancellingRef.current || !remove && !key) return;
    const requestedKeyRevision = keyRevision.current; settingsRevision.current++; intent.current++;
    const submitted = remove ? null : key; work('key'); setError('');
    try {
      await api().setCivitaiKey(submitted);
      if (alive.current && requestedKeyRevision === keyRevision.current) setKey('');
      // The successful main-process write confirms presence. Retain it through
      // cancelled shutdown without starting another IPC request after closing.
      if (alive.current) setSettings({ hasApiKey: !remove });
      if (!active()) return;
      setMessage(remove ? 'Civitai key removed. Browsing anonymously.' : 'Civitai key protected with Windows secure storage.');
    } catch (error) { if (active()) setError(actionErrorMessage(error)); }
    finally { if (alive.current) work(null); }
  }
  async function cancel() {
    if (!active() || cancellingRef.current || workingRef.current === 'key') return;
    cancellingRef.current = true; setCancelling(true); serial.current++; intent.current++;
    try { await api().cancelCivitai(); if (active()) setMessage('Civitai activity cancelled. Incomplete downloads remain resumable.'); }
    catch (error) { if (active()) setError(actionErrorMessage(error)); }
    finally { cancellingRef.current = false; if (alive.current) { setCancelling(false); work(null); } }
  }
  function closeDetail() { intent.current++; setDetail(undefined); if (workingRef.current === 'detail') { serial.current++; work(null); } }
  function leave() { closing.current = true; serial.current++; intent.current++; onBack(); }
  async function externalAction(task: () => Promise<void>) { if (!active()) return; try { await task(); } catch (error) { if (active()) setError(actionErrorMessage(error)); } }

  return <div className="page-content civitai-browser">
    <header className="civitai-heading"><div><button className="text-button" onClick={leave}><ArrowLeft size={14} />Your model library</button><h2><Globe size={20} />Browse Civitai</h2><p className="muted small">Find a version, check its family, and bring the exact file into your studio.</p></div><button aria-expanded={settingsOpen} onClick={() => { setSettingsOpen(!settingsOpen); editKey(''); }}><Settings2 size={16} />Civitai settings</button></header>
    <UrlDownload />
    {settingsOpen && <section className="settings-card civitai-key-panel" aria-label="Civitai settings"><div className="section-heading"><h3><KeyRound size={16} />{settings.hasApiKey ? 'A protected API key is saved' : 'Browse anonymously or add your API key'}</h3><button className="icon-button" aria-label="Close Civitai settings" onClick={() => { setSettingsOpen(false); editKey(''); }}><X size={16} /></button></div><p className="muted small">Some creators require an account to download. Your key is protected by Windows and stays outside model metadata and browser history.</p><form onSubmit={event => { event.preventDefault(); void saveKey(); }}><Field label={settings.hasApiKey ? 'Replace API key' : 'Civitai API key'}><input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => editKey(event.target.value)} maxLength={4096} placeholder="Paste your key here" /></Field><div className="button-row"><button className="primary" disabled={!key || !!working || cancelling}><Busy active={working === 'key'} />Save protected key</button>{settings.hasApiKey && <button type="button" disabled={!!working || cancelling} onClick={() => void saveKey(true)}>Remove saved key</button>}</div></form></section>}
    <form className="civitai-search" onSubmit={event => { event.preventDefault(); void search(); }}><Field label="Search Civitai"><input value={query} maxLength={200} onChange={event => setQuery(event.target.value)} placeholder="Try pixel art, watercolor, or a model name" /></Field><Field label="Resource"><select value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="all">Checkpoints and LoRAs</option><option value="checkpoint">Checkpoints</option><option value="lora">LoRAs</option></select></Field><Field label="Base family"><select value={family} onChange={event => setFamily(event.target.value as typeof family)}><option value="illustrious">Illustrious</option><option value="sdxl">SDXL 1.0</option><option value="all">All bases</option></select></Field><Field label="Model listings"><select value={includeMature ? "all" : "sfw"} onChange={e => setIncludeMature(e.target.value === "all")}><option value="all">Include mature listings</option><option value="sfw">SFW listings only</option></select></Field><Field label="Sort"><select value={sort} onChange={e => setSort(e.target.value as typeof sort)}>{['Most Downloaded','Highest Rated','Newest'].map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Period"><select value={period} onChange={e => setPeriod(e.target.value as typeof period)}>{['AllTime','Year','Month','Week','Day'].map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Creator"><input value={username} maxLength={100} onChange={e => setUsername(e.target.value)} placeholder="Username" /></Field><Field label="Tag"><input value={tag} maxLength={100} onChange={e => setTag(e.target.value)} placeholder="Style or subject" /></Field><button className="primary" disabled={!!working || cancelling}><Busy active={working === 'search'} />{working !== 'search' && <Search size={16} />}Search</button>{(working !== 'key' && (working || downloading || activeDownloads.length > 0)) && <button type="button" disabled={cancelling} onClick={() => void cancel()}><X size={15} />Cancel</button>}</form>
    {error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
    {results && <p className="civitai-read-status" role="status">{working === 'search' ? 'Searching… Showing previous results until the search finishes.' : searchFailed ? 'The latest search failed. Showing previous results; press Search to try again.' : results.stale ? `Offline / cached results from ${new Date(results.fetchedAt).toLocaleString()}. ${results.warning ?? ''}` : `Live results checked ${new Date(results.fetchedAt).toLocaleTimeString()}.`} {settings.hasApiKey ? 'Using your saved key.' : 'Browsing anonymously.'}</p>}
    {activeDownloads.map(item => <div className="download-item" key={item.id}><div><strong>{item.name}</strong><p>{item.state} · {bytes(item.receivedBytes)}{item.totalBytes ? ` / ${bytes(item.totalBytes)}` : ''}</p><progress aria-label={`${item.name} download`} value={item.totalBytes ? item.receivedBytes : undefined} max={item.totalBytes || undefined} /></div><button onClick={() => { intent.current++; void externalAction(() => window.latent.cancelDownload(item.id)); }}><X size={15} />Cancel download</button></div>)}
    <div className={`civitai-layout ${detail ? 'has-detail' : ''}`}>
      <section className="civitai-results" aria-label="Civitai search results">
        {!results && <div className="page-empty"><Globe size={28} /><h3>Explore models and styles</h3><p>Search to load creator-published versions. Downloads are checked before they appear in Create.</p></div>}
        {results && results.data.items.length === 0 && <div className="page-empty"><Search size={26} /><h3>No matching resources</h3><p>Try a broader name or another family. Civitai availability can vary by region.</p></div>}
        {results?.data.items.map(model => {
          const preview = model.versions.flatMap(version => version.previews)[0];
          return <button className={`civitai-result ${detail?.data.id === model.id ? 'selected' : ''}`} disabled={!!working || cancelling} onClick={() => void openDetail(model.id)} key={model.id}><CreatorPreview url={preview?.url} name={model.name} refresh={results} /><span className="civitai-result-text"><strong>{model.name}</strong><span>{model.creator || 'Creator not listed'}</span><span className="badge">{model.kind === 'checkpoint' ? 'Checkpoint' : 'LoRA'} · {model.versions[0]?.baseModel || 'Unknown base'}</span><small>{model.versions.length} {model.versions.length === 1 ? 'version' : 'versions'} · Model {model.id}</small></span><ArrowRight size={15} /></button>;
        })}
        {results?.data.nextCursor && <button className="civitai-more" disabled={!!working || cancelling} onClick={() => void search(true)}><Busy active={working === 'search'} />Load more results</button>}
      </section>
      {detail && <section className="civitai-detail" aria-label="Civitai model details"><div className="section-heading"><h2>{detail.data.name}</h2><button className="icon-button" aria-label="Close model details" onClick={closeDetail}><X size={17} /></button></div><p className="muted small">{detail.data.creator ? <button type="button" className="text-button" onClick={() => { setUsername(detail.data.creator); setQuery(''); setTag(''); void search(false, detail.data.creator); }}>More by {detail.data.creator}</button> : 'Creator not listed'} · Model {detail.data.id}</p><button className="text-button" onClick={() => void externalAction(() => api().openCivitaiModel(detail.data.id, versionId))}>Creator’s page and license <ExternalLink size={12} /></button>{detail.stale && <Notice>Cached details from {new Date(detail.fetchedAt).toLocaleString()}. Reconnect before downloading.</Notice>}<Field label="Exact version"><select value={versionId ?? ''} disabled={!!working || cancelling} onChange={event => { intent.current++; setVersionId(Number(event.target.value)); }}>{detail.data.versions.map(version => <option key={version.id} value={version.id}>{version.name} · {version.baseModel || 'Unknown base'} · #{version.id}</option>)}</select></Field>
        {selectedVersion && <><div className="model-badges"><span className="badge">{selectedVersion.baseModel || 'Unknown base'}</span><span>{selectedVersion.baseModelType || 'Subtype not declared'}</span><span>{selectedVersion.availability || 'Availability unknown'}</span></div>{workflowIssue(detail.data, selectedVersion) && <Notice>{workflowIssue(detail.data, selectedVersion)}. This version cannot be added to the current Create workflow.</Notice>}{!selectedVersion.publiclyListed && <Notice>This version is restricted or in early access. Latent does not purchase or unlock model access.</Notice>}<div><h3>Creator’s trigger words</h3><p className="small">{selectedVersion.trainedWords.length ? selectedVersion.trainedWords.join(', ') : 'No trigger words declared.'}</p></div><ModelRequirements model={detail.data} version={selectedVersion} models={snapshot.models} /><details><summary>Model notes</summary><p className="civitai-description">{detail.data.description || 'No model notes supplied.'}</p></details><details><summary>Version notes</summary><p className="civitai-description">{selectedVersion.description || 'No version notes supplied.'}</p></details><details><summary>Creator’s permission flags</summary><Permissions value={detail.data.permissions} /><p className="muted small">Read the creator’s complete license and usage notes before using the model.</p></details>
          <div className="civitai-files"><h3>Files in this version</h3>{selectedVersion.files.length === 0 && <p className="muted small">No public files are listed.</p>}{selectedVersion.files.map(file => {
            const identity = `${detail.data.id}:${selectedVersion.id}:${file.id}`;
            const installed = file.sha256 ? snapshot.models.find(model => model.kind === detail.data.kind && model.sha256 === file.sha256 && model.status === 'ready') : undefined;
            const blockedReason = detail.stale ? 'Reconnect and refresh these cached details before downloading.'
              : workflowIssue(detail.data, selectedVersion) || (!selectedVersion.publiclyListed ? 'This version is not currently available as a public download.'
              : !file.safeTensor ? 'This file is not identified as a safetensors model.'
              : !file.sha256 ? 'Civitai has not supplied a complete SHA-256 checksum.'
              : !file.downloadUrl ? 'Civitai has not supplied a valid download URL for this exact file.'
              : !file.estimatedBytes ? 'Civitai has not supplied the file size.'
              : !['Model', 'Pruned Model'].includes(file.type) ? 'This is not an installable model file.' : undefined);
            const eligible = !blockedReason;
            return <article key={file.id} className="civitai-file"><strong>{file.name || `File ${file.id}`}</strong><p className="muted small">File {file.id} · {file.format || 'Unknown format'} {file.fp} · {file.estimatedBytes ? `about ${bytes(file.estimatedBytes)}` : 'Size unavailable'}</p>{eligible && !installed && <DownloadStorage kind={detail.data.kind} requiredBytes={file.estimatedBytes ?? undefined} estimated refresh={refreshDownloadStorage} />}<details><summary>SHA-256 and identity</summary><code>{file.sha256 ?? 'No complete SHA-256 supplied.'}</code><p className="muted small">Model {detail.data.id} / Version {selectedVersion.id} / File {file.id}</p></details><div className="button-row"><button className="primary" disabled={!eligible || !!downloading || !!working || cancelling} onClick={() => void install({ modelId: detail.data.id, versionId: selectedVersion.id, fileId: file.id })}>{downloading === identity ? <Busy active /> : installed ? <Check size={14} /> : <Download size={14} />}{downloading === identity ? 'Checking / downloading…' : installed ? 'Reuse installed file' : 'Download this file'}</button>{installed && <button disabled={!eligible || !!downloading || !!working || cancelling} onClick={() => void install({ modelId: detail.data.id, versionId: selectedVersion.id, fileId: file.id }, true)}>Use in Create <ArrowRight size={13} /></button>}</div>{!eligible && <p className="muted small">{blockedReason}</p>}</article>;
          })}</div></>}
      </section>}
    </div>
  </div>;
}



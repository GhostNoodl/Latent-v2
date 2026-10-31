/** The phone page: one small HTML file and one script, no outside requests. */
export const PHONE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Latent</title>
<style>
:root { --bg:#121216; --panel:#1b1b21; --inset:#24242c; --border:#2f2f39; --text:#ecebf2; --muted:#9a98a8; --accent:#9d85f2; --danger:#ef6f6f; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; padding:16px 16px calc(16px + env(safe-area-inset-bottom)); }
h1 { font-size:18px; margin:0 0 14px; display:flex; align-items:center; gap:8px; }
h1 span { width:10px; height:10px; border-radius:50%; background:var(--accent); display:inline-block; }
h2 { font-size:13px; color:var(--muted); font-weight:600; margin:22px 0 8px; text-transform:uppercase; letter-spacing:.04em; }
.card { background:var(--panel); border:1px solid var(--border); border-radius:14px; padding:14px; }
textarea, input, select, button { font:inherit; color:inherit; }
textarea, input, select { width:100%; background:var(--inset); border:1px solid var(--border); border-radius:10px; padding:10px 12px; }
textarea { min-height:96px; resize:vertical; }
button { background:var(--inset); border:1px solid var(--border); border-radius:10px; padding:10px 14px; }
button.primary { background:var(--accent); border-color:var(--accent); color:#16131f; font-weight:650; width:100%; padding:13px; margin-top:12px; }
button:disabled { opacity:.5; }
.row { display:flex; gap:8px; margin-top:10px; }
.row > * { flex:1; min-width:0; }
.chips { display:flex; gap:6px; flex-wrap:wrap; margin-top:10px; }
.chips button { flex:1; padding:8px 6px; font-size:13px; }
.chips button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); }
.muted { color:var(--muted); font-size:13px; }
.error { color:var(--danger); font-size:13px; margin-top:8px; }
.job { display:flex; align-items:center; gap:10px; padding:9px 0; border-top:1px solid var(--border); }
.job:first-child { border-top:0; }
.job p { margin:0; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
.job small { color:var(--muted); }
.job button { padding:6px 10px; font-size:13px; }
.grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:6px; }
.grid button { padding:0; aspect-ratio:1; overflow:hidden; border-radius:8px; background:var(--inset); }
.grid img { width:100%; height:100%; object-fit:cover; display:block; }
.viewer { position:fixed; inset:0; background:rgba(0,0,0,.92); display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; padding:16px; }
.viewer img { max-width:100%; max-height:78vh; border-radius:8px; }
.viewer p { margin:0; font-size:13px; color:var(--muted); text-align:center; }
.code { letter-spacing:.4em; text-align:center; font-size:26px; }
[hidden] { display:none !important; }
</style>
</head>
<body>
<h1><span></span>Latent</h1>
<section id="pair" class="card" hidden>
  <p>Type the pairing code shown on the PC in <b>Settings &gt; Phone remote</b>.</p>
  <input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
  <button id="pairButton" class="primary">Pair this phone</button>
  <p id="pairError" class="error" hidden></p>
</section>
<main id="app" hidden>
  <section class="card">
    <textarea id="prompt" placeholder="Describe the picture"></textarea>
    <div class="row">
      <select id="model" aria-label="Model"></select>
    </div>
    <div class="chips" id="sizes" aria-label="Size"></div>
    <div class="chips" id="batch" aria-label="How many"></div>
    <button id="make" class="primary">Make image</button>
    <p id="makeError" class="error" hidden></p>
  </section>
  <h2>Queue</h2>
  <section class="card" id="jobs"><p class="muted">Nothing running.</p></section>
  <h2>Recent</h2>
  <section class="grid" id="images"></section>
  <p class="muted" style="margin-top:18px">Runs on the PC. Keep Latent open there.</p>
</main>
<div id="viewer" class="viewer" hidden>
  <img id="viewerImage" alt="">
  <p id="viewerPrompt"></p>
  <div class="row" style="width:100%;max-width:420px">
    <button id="viewerUse">Use prompt</button>
    <button id="viewerSave">Save</button>
    <button id="viewerClose">Close</button>
  </div>
</div>
<script src="/app.js"></script>
</body>
</html>`;

export const PHONE_PAGE_SCRIPT = `'use strict';
const $ = id => document.getElementById(id);
const KEY = 'latent-phone-token';
let token = '';
try { token = localStorage.getItem(KEY) || ''; } catch {}
let state = null;
let size = null;
let batch = 1;
let viewing = null;
const blobs = new Map();

async function api(path, body) {
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) { showPair(); throw new Error('Pair this phone first.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
async function image(id) {
  if (blobs.has(id)) return blobs.get(id);
  const response = await fetch('/api/image/' + id, { headers: { Authorization: 'Bearer ' + token } });
  if (!response.ok) throw new Error('Image unavailable');
  const url = URL.createObjectURL(await response.blob());
  blobs.set(id, url);
  return url;
}
function showPair() { $('pair').hidden = false; $('app').hidden = true; }
function showApp() { $('pair').hidden = true; $('app').hidden = false; }
function error(el, text) { el.textContent = text || ''; el.hidden = !text; }

$('pairButton').onclick = async () => {
  error($('pairError'), '');
  try {
    const response = await fetch('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Pairing failed.');
    token = data.token;
    try { localStorage.setItem(KEY, token); } catch {}
    showApp();
    refresh();
  } catch (e) { error($('pairError'), e.message); }
};

function chips(el, items, current, pick) {
  el.textContent = '';
  for (const item of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = item.label;
    b.setAttribute('aria-pressed', String(item.key === current));
    b.onclick = () => pick(item);
    el.append(b);
  }
}
function render() {
  if (!state) return;
  const select = $('model');
  if (!select.options.length) {
    for (const m of state.models) select.add(new Option(m.name, m.id));
    select.value = state.studio.checkpointId;
  }
  const studioSize = state.studio.width + 'x' + state.studio.height;
  const sizes = [
    { key: null, label: 'Studio ' + state.studio.width + '×' + state.studio.height },
    { key: '1024x1024', label: 'Square' },
    { key: '832x1216', label: 'Portrait' },
    { key: '1216x832', label: 'Wide' },
  ].filter(item => item.key !== studioSize);
  chips($('sizes'), sizes, size, item => { size = item.key; render(); });
  chips($('batch'), [1, 2, 3, 4].map(n => ({ key: n, label: n + (n === 1 ? ' image' : ' images') })), batch, item => { batch = item.key; render(); });

  const jobs = $('jobs');
  jobs.textContent = '';
  const live = state.jobs.filter(j => j.status === 'queued' || j.status === 'running' || j.status === 'failed').slice(0, 5);
  if (!live.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'Nothing running.'; jobs.append(p); }
  for (const job of live) {
    const row = document.createElement('div'); row.className = 'job';
    const p = document.createElement('p'); p.textContent = job.prompt;
    const s = document.createElement('small');
    s.textContent = job.status === 'running' ? job.progress + '%' : job.status === 'queued' ? 'Waiting' : 'Failed';
    if (job.error) s.title = job.error;
    row.append(p, s);
    if (job.status !== 'failed') {
      const c = document.createElement('button'); c.textContent = 'Cancel';
      c.onclick = () => api('/api/cancel', { jobId: job.id }).then(refresh).catch(e => alert(e.message));
      row.append(c);
    }
    jobs.append(row);
  }

  const grid = $('images');
  const ids = state.images.map(i => i.id).join(',');
  if (grid.dataset.ids !== ids) {
    grid.dataset.ids = ids;
    grid.textContent = '';
    for (const item of state.images) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', item.prompt);
      const img = document.createElement('img'); img.alt = '';
      b.append(img);
      b.onclick = () => open(item);
      grid.append(b);
      image(item.id).then(url => { img.src = url; }).catch(() => {});
    }
  }
}
async function open(item) {
  viewing = item;
  $('viewerPrompt').textContent = item.prompt;
  $('viewerImage').src = '';
  $('viewer').hidden = false;
  try { $('viewerImage').src = await image(item.id); } catch {}
}
$('viewerClose').onclick = () => { $('viewer').hidden = true; viewing = null; };
$('viewerUse').onclick = () => { if (viewing) $('prompt').value = viewing.prompt; $('viewer').hidden = true; window.scrollTo(0, 0); };
$('viewerSave').onclick = () => {
  if (!viewing || !blobs.has(viewing.id)) return;
  const a = document.createElement('a'); a.href = blobs.get(viewing.id); a.download = 'latent-' + viewing.id.slice(0, 8) + '.png'; a.click();
};
$('make').onclick = async () => {
  error($('makeError'), '');
  const prompt = $('prompt').value.trim();
  if (!prompt) return error($('makeError'), 'Type a prompt first.');
  const body = { prompt, batchSize: batch };
  if ($('model').value && $('model').value !== state.studio.checkpointId) body.checkpointId = $('model').value;
  if (size) { const [w, h] = size.split('x').map(Number); body.width = w; body.height = h; }
  $('make').disabled = true;
  try { await api('/api/generate', body); await refresh(); }
  catch (e) { error($('makeError'), e.message); }
  finally { $('make').disabled = false; }
};
async function refresh() {
  try { state = await api('/api/state'); showApp(); render(); } catch {}
}
if (token) refresh(); else showPair();
setInterval(() => { if (token && document.visibilityState === 'visible') refresh(); }, 2500);
`;

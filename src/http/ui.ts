/**
 * The dashboard, as one self-contained page.
 *
 * No build step, no framework, no bundle: the whole UI is a string served by
 * the same process that serves the API. That keeps `npx hoppr` light and means
 * the dashboard can never be out of date with the server it talks to.
 */
export function dashboardHtml(token: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hoppr</title>
<style>
  :root {
    --bg:#0e0f11; --panel:#16181b; --line:#24272c; --fg:#e6e8ea; --dim:#8b9099;
    --accent:#7dd3a0; --warn:#e6c07b; --raw:#6b8cc4; --bad:#e06c75;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fbfbfa; --panel:#fff; --line:#e4e4e2; --fg:#1a1a19; --dim:#75756f;
            --accent:#2f7d52; --warn:#8a6d1f; --raw:#3a5f9e; --bad:#b3261e; }
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg); font-size:13px; line-height:1.55 }
  header { display:flex; align-items:center; gap:16px; padding:12px 18px;
           border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:5 }
  h1 { font-size:14px; margin:0; letter-spacing:.5px }
  h1 span { color:var(--dim); font-weight:400 }
  #root { color:var(--dim); font-size:11px; max-width:38ch; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  select { background:var(--panel); color:var(--fg); border:1px solid var(--line);
           border-radius:5px; padding:3px 8px; font:inherit; font-size:12px }
  nav { display:flex; gap:2px; margin-left:auto; flex-wrap:wrap }
  nav button { background:none; border:1px solid transparent; color:var(--dim);
               padding:4px 10px; cursor:pointer; font:inherit; border-radius:4px }
  nav button.on { color:var(--fg); border-color:var(--line); background:var(--panel) }
  main { padding:18px; max-width:1100px; margin:0 auto }
  input[type=search] { width:100%; padding:9px 12px; background:var(--panel); color:var(--fg);
                       border:1px solid var(--line); border-radius:6px; font:inherit }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:8px;
          padding:12px 14px; margin:10px 0 }
  .card h3 { margin:0 0 4px; font-size:13px; font-weight:600 }
  .meta { color:var(--dim); font-size:11px; display:flex; gap:10px; flex-wrap:wrap; margin-bottom:6px }
  .snippet { color:var(--dim) }
  .tag { color:var(--accent) }
  .kind { padding:1px 6px; border-radius:3px; border:1px solid var(--line) }
  .kind.raw { color:var(--raw) } .kind.curated { color:var(--accent) }
  .stats { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:8px }
  .stat { background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:10px 12px }
  .stat b { display:block; font-size:20px; font-weight:500 }
  .stat span { color:var(--dim); font-size:11px }
  table { width:100%; border-collapse:collapse; font-size:12px }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid var(--line); vertical-align:top }
  th { color:var(--dim); font-weight:500 }
  pre { white-space:pre-wrap; word-break:break-word; margin:0 }
  /* Health colours: a stuck queue or a dead daemon should be visible from
     across the room, not something you find by reading a number. */
  .stat.warn b { color:var(--warn) } .stat.bad b { color:var(--bad) }
  .card.bad { border-color:var(--bad) }
  .meta .bad { color:var(--bad) }
  h3 { font-size:12px; font-weight:600; color:var(--dim); margin:18px 0 6px;
       text-transform:uppercase; letter-spacing:.04em }
  pre.log { background:var(--panel); border:1px solid var(--line); border-radius:6px;
            padding:10px 12px; font-size:11px; line-height:1.6; max-height:50vh;
            overflow:auto; color:var(--dim) }
  .empty { color:var(--dim); padding:24px 0; text-align:center }
  a { color:inherit }
</style></head><body>
<header>
  <h1>hoppr</h1>
  <select id="hopper" title="which hoppr"></select>
  <span id="root"></span>
  <nav id="nav"></nav>
</header>
<main>
  <div id="view"></div>
</main>
<script type="module">
const TOKEN = ${JSON.stringify(token)}
let HOPPER = ''
// Every request names its hoppr, so switching is a query param rather than a
// different server.
const api = async (p, opts={}) => {
  const u = new URL(p, location.origin)
  if (HOPPER) u.searchParams.set('hopper', HOPPER)
  const r = await fetch(u.pathname + u.search, { ...opts, headers: { authorization: 'Bearer ' + TOKEN,
    'content-type': 'application/json', ...(opts.headers||{}) } })
  if (!r.ok) throw new Error((await r.json().catch(()=>({error:r.statusText}))).error || r.statusText)
  return (await r.json()).data
}
const el = (h) => { const d = document.createElement('div'); d.innerHTML = h; return d }
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const view = document.getElementById('view')

const TABS = {
  search: 'Search', wiki: 'Wiki', tables: 'Tables', skills: 'Skills', tags: 'Tags',
  status: 'Status', daemon: 'Daemon',
}
let current = 'search'
const nav = document.getElementById('nav')
for (const [k, label] of Object.entries(TABS)) {
  const b = document.createElement('button')
  b.textContent = label; b.onclick = () => go(k); b.dataset.k = k
  nav.appendChild(b)
}
function go(k) {
  current = k
  for (const b of nav.children) b.className = b.dataset.k === k ? 'on' : ''
  location.hash = k
  render()
}

function rel(ms) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return s + 's ago'
  if (s < 3600) return Math.round(s / 60) + 'm ago'
  if (s < 86400) return Math.round(s / 3600) + 'h ago'
  return Math.round(s / 86400) + 'd ago'
}
function fmt(n) {
  n = n || 0
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

async function render() {
  view.innerHTML = '<div class="empty">…</div>'
  try { await VIEWS[current]() } catch (e) { view.innerHTML = '<div class="empty">' + esc(e.message) + '</div>' }
}

const VIEWS = {
  async search() {
    view.innerHTML = '<input type="search" id="q" placeholder="ask a question — hybrid keyword + semantic">' +
      '<div id="hits"></div>'
    const q = document.getElementById('q'), hits = document.getElementById('hits')
    q.focus()
    let t
    const run = async () => {
      // Keep the query in the URL so a search is a link you can share or bookmark.
      const u = new URL(location.href)
      if (q.value.trim()) u.searchParams.set('q', q.value); else u.searchParams.delete('q')
      history.replaceState(null, '', u)
      if (!q.value.trim()) { hits.innerHTML = ''; return }
      const rows = await api('/search?scope=all&limit=20&q=' + encodeURIComponent(q.value))
      hits.innerHTML = rows.length ? rows.map(h =>
        '<div class="card"><h3>' + esc(h.title || '(untitled)') + '</h3>' +
        '<div class="meta"><span class="kind ' + esc(h.tier) + '">' + esc(h.kind) + '</span>' +
        (h.confidence ? '<span>' + esc(h.confidence) + '</span>' : '') +
        (h.tags?.length ? '<span class="tag">#' + h.tags.map(esc).join(' #') + '</span>' : '') +
        (h.matchedInSource ? '<span>matched in source</span>' : '') + '</div>' +
        '<div class="snippet">' + esc(h.snippet) + '</div></div>').join('')
        : '<div class="empty">no hits</div>'
    }
    q.oninput = () => { clearTimeout(t); t = setTimeout(run, 180) }
    const initial = new URL(location.href).searchParams.get('q')
    if (initial) { q.value = initial; await run() }
  },

  async wiki() {
    const pages = await api('/pages')
    if (!pages.length) return void (view.innerHTML = '<div class="empty">nothing curated yet</div>')
    const byType = {}
    for (const p of pages) (byType[p.type] ??= []).push(p)
    view.innerHTML = Object.entries(byType).map(([type, ps]) =>
      '<h3>' + esc(type) + 's <span style="color:var(--dim)">' + ps.length + '</span></h3>' +
      ps.map(p => '<div class="card"><h3>' + esc(p.title) + '</h3>' +
        '<div class="meta"><span>' + esc(p.confidence) + '</span><span>' + esc(p.updated) + '</span>' +
        (p.tags?.length ? '<span class="tag">#' + p.tags.map(esc).join(' #') + '</span>' : '') + '</div>' +
        '<div class="snippet">' + esc(p.summary || '') + '</div></div>').join('')
    ).join('')
  },

  async tables() {
    view.innerHTML = '<input type="search" id="sql" placeholder="SELECT * FROM v_&lt;table&gt; — read-only">' +
      '<div id="out"></div>'
    const box = document.getElementById('sql'), out = document.getElementById('out')
    const run = async () => {
      // Same as search: a query belongs in the URL so it can be shared.
      const u = new URL(location.href)
      if (box.value.trim()) u.searchParams.set('sql', box.value); else u.searchParams.delete('sql')
      history.replaceState(null, '', u)
      try {
        const r = await api('/sql', { method: 'POST', body: JSON.stringify({ query: box.value }) })
        out.innerHTML = r.rows.length
          ? '<table><thead><tr>' + r.columns.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' +
            r.rows.map(row => '<tr>' + r.columns.map(c =>
              '<td>' + esc(typeof row[c] === 'string' ? row[c] : JSON.stringify(row[c])) + '</td>').join('') +
              '</tr>').join('') + '</tbody></table>'
          : '<div class="empty">(no rows)</div>'
      } catch (err) { out.innerHTML = '<div class="empty">' + esc(err.message) + '</div>' }
    }
    box.onkeydown = (e) => { if (e.key === 'Enter') run() }
    const initial = new URL(location.href).searchParams.get('sql')
    if (initial) { box.value = initial; await run() }
  },

  async skills() {
    const rows = await api('/skills')
    view.innerHTML = rows.length ? rows.map(s =>
      '<div class="card"><h3>' + esc(s.name) + '</h3>' +
      '<div class="meta"><span class="kind">' + esc(s.state) + '</span>' +
      '<span>' + s.evidence_count + ' sessions</span>' +
      '<span>confidence ' + Number(s.confidence).toFixed(2) + '</span></div>' +
      '<div class="snippet">' + esc(s.description) + '</div></div>').join('')
      : '<div class="empty">no skills yet — run <code>hoppr deep</code> to mine them</div>'
  },

  async tags() {
    const rows = await api('/tags')
    view.innerHTML = rows.length
      ? '<table><thead><tr><th>tag</th><th>count</th><th>description</th></tr></thead><tbody>' +
        rows.map(t => '<tr><td class="tag">' + esc(t.tag) + '</td><td>' + t.count + '</td><td>' +
          esc(t.description || '') + '</td></tr>').join('') + '</tbody></table>'
      : '<div class="empty">no tags yet</div>'
  },

  async status() {
    const [s, hp] = await Promise.all([api('/stats'), api('/health')])
    document.getElementById('root').textContent = s.root ?? ''

    // The queue first: "is anything waiting or wedged" is the question this
    // page exists to answer, and row counts do not answer it.
    const queue = [
      ['captures', hp.captures, ''],
      ['awaiting curation', hp.pending, hp.pending ? 'warn' : ''],
      ['stuck (3 strikes)', hp.stuck, hp.stuck ? 'bad' : ''],
      ['wiki pages', hp.pages, ''],
    ]
    let html = '<div class="stats">' + queue.map(([k, v, cls]) =>
      '<div class="stat ' + cls + '"><b>' + v + '</b><span>' + esc(k) + '</span></div>').join('') + '</div>'

    if (hp.lastError) {
      html += '<div class="card bad"><div class="meta"><span>most recent failure</span></div>' +
        '<div class="snippet">' + esc(hp.lastError) + '</div></div>'
    }

    const d = hp.deep || {}
    html += '<h3>Nightly deep pass</h3><div class="card"><div class="meta">' +
      '<span>last run ' + rel(d.lastFiredAt) + '</span>' +
      '<span>last success ' + rel(d.lastSuccessAt) + '</span>' +
      '<span>curated through ' + rel(d.curatedThrough) + '</span>' +
      (d.failures ? '<span class="bad">' + d.failures + ' consecutive failures</span>' : '') +
      '</div></div>'

    const sp = hp.spend || {}
    html += '<h3>Model spend</h3><div class="card"><div class="meta">' +
      '<span>' + (sp.calls || 0) + ' calls</span>' +
      (sp.failed ? '<span class="bad">' + sp.failed + ' failed</span>' : '') +
      '<span>$' + (sp.usd || 0).toFixed(4) + '</span>' +
      '<span>' + fmt(sp.tokensIn) + ' in / ' + fmt(sp.tokensOut) + ' out</span>' +
      '</div></div>'

    html += '<h3>Recent passes</h3>'
    html += hp.passes?.length
      ? '<table><thead><tr><th>when</th><th>pass</th><th>created</th><th>updated</th><th>touched</th></tr></thead><tbody>' +
        hp.passes.map(p => '<tr><td>' + rel(p.started) + '</td><td>' + esc(p.passId.slice(0, 10)) +
          '</td><td>' + (p.created || 0) + '</td><td>' + (p.updated || 0) + '</td><td>' +
          esc(p.kinds || '') + '</td></tr>').join('') + '</tbody></table>'
      : '<div class="empty">no curate passes yet</div>'

    html += '<div class="card"><div class="meta"><span>driver ' + esc(s.driver) +
      '</span><span>vectors ' + (s.vector ? 'on' : 'off') + '</span></div></div>'
    view.innerHTML = html
  },

  async daemon() {
    const d = await api('/daemon')
    let html = '<div class="card ' + (d.running ? '' : 'bad') + '"><div class="meta">' +
      '<span>' + (d.running ? 'running' : 'not running') + '</span>' +
      (d.pid ? '<span>pid ' + d.pid + '</span>' : '') +
      (d.port ? '<span>port ' + d.port + '</span>' : '') +
      (d.startedAt ? '<span>up since ' + rel(d.startedAt) + '</span>' : '') +
      '</div>' + (d.running ? '' :
        '<div class="snippet">Start it with <code>hoppr daemon start</code>. ' +
        'Capture and search work without it; only curation is paused.</div>') + '</div>'

    html += '<h3>Managing ' + (d.managed?.length || 0) + ' hopper' +
      (d.managed?.length === 1 ? '' : 's') + '</h3>' +
      (d.managed?.length
        ? '<div class="stats">' + d.managed.map(n =>
            '<div class="stat"><b>' + esc(n) + '</b><span>hoppr</span></div>').join('') + '</div>'
        : '<div class="empty">none</div>')

    html += '<h3>Activity</h3>' + (d.log?.length
      ? '<pre class="log">' + d.log.map(esc).join('\\n') + '</pre>'
      : '<div class="empty">no log yet</div>')
    view.innerHTML = html
  },
}

const sel = document.getElementById('hopper')
sel.onchange = () => {
  HOPPER = sel.value
  const u = new URL(location.href); u.searchParams.set('hopper', HOPPER)
  history.replaceState(null, '', u)
  refreshRoot(); render()
}
async function refreshRoot() {
  try { document.getElementById('root').textContent = (await api('/stats')).root ?? '' }
  catch { document.getElementById('root').textContent = '' }
}
fetch('/healthz').then(r => r.json()).then((hz) => {
  const names = hz.hoppers ?? []
  HOPPER = new URL(location.href).searchParams.get('hopper') || names[0] || ''
  sel.innerHTML = names.map((n) => '<option' + (n === HOPPER ? ' selected' : '') + '>' + esc(n) + '</option>').join('')
  if (names.length < 2) sel.style.display = 'none'
}).catch(() => {}).finally(() => {
  refreshRoot()
  go(location.hash.slice(1) in TABS ? location.hash.slice(1) : 'search')
})
</script></body></html>`
}

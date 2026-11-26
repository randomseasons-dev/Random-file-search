'use strict';
/* Internet File Searcher – frontend.
   All network requests go through the Rust side (http_get / probe_file / download_try),
   so there are no browser CORS limits. */

const TAURI = window.__TAURI__;
const invoke = TAURI.core.invoke;
const listen = TAURI.event.listen;

const $ = id => document.getElementById(id);
const MAX_ROWS = 50;
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const enc = encodeURIComponent;
const html = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };
const stripHtml = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

/* ---------------- settings ---------------- */
// Depth = how far / how long to look. level: 1 Quick, 2 Normal, 3 Deep, 4 Maximum
const DEPTH = {
  1: {apiPages:1,  enginePages:1, crawlLevels:1, pageBudget:80,   hostCap:8},
  2: {apiPages:3,  enginePages:2, crawlLevels:1, pageBudget:250,  hostCap:15},
  3: {apiPages:8,  enginePages:3, crawlLevels:2, pageBudget:800,  hostCap:30},
  4: {apiPages:25, enginePages:5, crawlLevels:3, pageBudget:2500, hostCap:60},
};
const LANES = {engine:5, crawl:6, api:4, probe:3};
const PROBE_BUDGET = {loose:150, standard:150, strict:400};

const MODE_HELP = {
  loose:    'Loose – related results: most of the words (about 60%), anywhere in the file name, link, page title, address or nearby text; small spelling slips are allowed. Also lists pages that offer the file.',
  standard: 'Standard – all words, in any order, in the file name, link text, page title or address, with at least one word in the file name.',
  strict:   'Strict – precise only: all words as whole words in the file name (or in the file\'s own title), and the file is opened to check it is real and working.',
};

const SOURCES = {
  ddg:       {label:'DuckDuckGo', kind:'engine'},
  bing:      {label:'Bing', kind:'engine'},
  brave:     {label:'Brave', kind:'engine'},
  startpage: {label:'Startpage', kind:'engine'},
  mojeek:    {label:'Mojeek', kind:'engine'},
  web:       {label:'Web crawl', kind:'crawl'},
  ia:        {label:'Internet Archive', kind:'api'},
  commons:   {label:'Wikimedia Commons', kind:'api'},
  zenodo:    {label:'Zenodo', kind:'api'},
  openalex:  {label:'OpenAlex', kind:'api'},
  github:    {label:'GitHub', kind:'api'},
};

const ENGINES = {
  ddg: {
    label:'DuckDuckGo', gap:3500,
    url:(q, p) => 'https://html.duckduckgo.com/html/?q=' + enc(q) + (p > 1 ? '&s=' + (p - 1) * 30 + '&dc=' + ((p - 1) * 30 + 1) : ''),
    own:/(^|\.)duckduckgo\.com$/,
  },
  bing: {
    label:'Bing', gap:3000,
    url:(q, p) => 'https://www.bing.com/search?q=' + enc(q) + '&setlang=en' + (p > 1 ? '&first=' + ((p - 1) * 10 + 1) : ''),
    own:/(^|\.)(bing|microsoft|msn|live|microsofttranslator)\.com$|(^|\.)bing\.net$/,
  },
  brave: {
    label:'Brave', gap:4000,
    url:(q, p) => 'https://search.brave.com/search?q=' + enc(q) + '&source=web' + (p > 1 ? '&offset=' + (p - 1) : ''),
    own:/(^|\.)brave\.com$/,
  },
  startpage: {
    label:'Startpage', gap:4000,
    url:(q, p) => 'https://www.startpage.com/sp/search?query=' + enc(q) + '&cat=web&language=english' + (p > 1 ? '&page=' + p : ''),
    own:/(^|\.)startpage\.(com|nl)$/,
  },
  mojeek: {
    label:'Mojeek', gap:3000,
    url:(q, p) => 'https://www.mojeek.com/search?q=' + enc(q) + (p > 1 ? '&s=' + ((p - 1) * 10 + 1) : ''),
    own:/(^|\.)mojeek\.(com|co\.uk)$/,
  },
};

// Extensions that mean "web page", not a file.
const PAGE_EXT = new Set(['', 'html','htm','xhtml','shtml','php','php3','asp','aspx','jsp','jspx','cfm','cgi','pl','do','action','mvc','jhtml']);
const SKIP_HOSTS = /(^|\.)(facebook|twitter|x|instagram|linkedin|pinterest|tiktok|reddit|youtube|google|gstatic|googleapis|doubleclick|apple|amazon|t)\.(com|co)$/;
// Sites that show documents but keep the download behind a login or a script button.
const WALLED = /(^|\.)(scribd\.com|musescore\.com|issuu\.com|yumpu\.com|academia\.edu|docplayer\.(net|org|info)|pdfcoffee\.com|slideshare\.net|coursehero\.com|studocu\.com|dokumen\.pub|vdocuments\.(mx|net|site)|pdfdrive\.com|sheetmusicplus\.com|musicnotes\.com)$/;
const DOC_SITES = ['archive.org', 'scribd.com', 'issuu.com', 'docplayer.net', 'pdfcoffee.com', 'github.com'];
const TITLE_TYPES = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'epub', 'odt']);

/* ---------------- throttling (global, shared by search + downloads) ---------------- */
const slots = {};
// Waits for this bucket's next free slot. `stopped()` aborts the wait (Stop button).
async function throttle(bucket, gap, stopped){
  const now = Date.now();
  const s = Math.max(now, slots[bucket] || 0);
  slots[bucket] = s + gap;
  while (Date.now() < s){
    if (stopped && stopped()) throw new Error('stopped');
    await sleep(Math.min(200, s - Date.now()));
  }
  if (stopped && stopped()) throw new Error('stopped');
}
// `run` = the search this request belongs to; Stop cancels its waits and in-flight requests.
async function get(url, {bucket, gap = 1000, referer = null, maxBytes = 2000000, json = false, run = null, headers = null} = {}){
  await throttle(bucket || 'h:' + hostOf(url), gap, run ? () => run.stopped : null);
  return invoke('http_get', {url, referer, maxBytes, acceptJson: json, runId: run ? run.id : null, headers});
}
async function safeGet(url, opts){ try { return await get(url, opts); } catch { return null; } }

/* ---------------- input parsing ---------------- */
function splitList(s){
  return [...new Set(String(s).split(',').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean))];
}
function parseTypes(s){
  return [...new Set(splitList(s).map(t => t.replace(/^\*?\./, '').toLowerCase()).filter(Boolean))];
}
function lastSegment(name){
  let n = String(name || '');
  n = n.split(/[?#]/)[0];
  n = n.split(/[\/\\]/).pop();
  try { n = decodeURIComponent(n); } catch {}
  return n.replace(/\+/g, ' ').trim();
}
function splitExt(full){
  const m = full.match(/^(.+)\.([A-Za-z0-9]{1,8})$/);
  return m ? {base:m[1], ext:m[2].toLowerCase()} : {base:full, ext:''};
}
function urlExt(u){
  const seg = lastSegment(u.pathname);
  const m = seg.match(/\.([A-Za-z0-9]{1,8})$/);
  return m ? m[1].toLowerCase() : '';
}

/* ---------------- words: split, normalise, compare ---------------- */
const ROMAN = {ii:'2', iii:'3', iv:'4', vi:'6', vii:'7', viii:'8', ix:'9'};
const NUM_TO_ROMAN = Object.fromEntries(Object.entries(ROMAN).map(([k, v]) => [v, k]));

// "PromiseReprise_v2 (Akira Yamaoka).pdf" -> Promise Reprise v 2 Akira Yamaoka pdf
function rawTokens(s){
  s = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ');
  s = s.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
       .replace(/(\p{L})(\p{N})/gu, '$1 $2').replace(/(\p{N})(\p{L})/gu, '$1 $2');
  return s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
// Comparable form of a word. Strict: exact (case-folded unless Match case). Others: II = 2, manuals = manual.
function canon(t, mode, keepCase){
  let x = keepCase ? t : t.toLowerCase();
  if (/^\d+$/.test(x)) x = x.replace(/^0+(?=\d)/, '');
  if (mode === 'strict') return x;
  const low = x.toLowerCase();
  if (ROMAN[low]) return ROMAN[low];
  if (x.length > 3 && /s$/i.test(x) && !/ss$/i.test(x)) x = x.slice(0, -1);
  return x;
}
function fieldIndex(s, mode, keepCase){
  const raw = rawTokens(s);
  const joined = raw.join('');
  return {toks: raw.map(t => canon(t, mode, keepCase)), joined: keepCase ? joined : joined.toLowerCase()};
}
function lev(a, b, max){
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++){
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++){
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function buildMatcher(pack, mode, keepCase){
  const raw = rawTokens(pack);
  if (!raw.length) return null;
  const joined = raw.join('');
  return {
    pack, raw,
    words: raw.map(t => canon(t, mode, keepCase)),
    rawCmp: raw.map(t => keepCase ? t : t.toLowerCase()),
    joined: keepCase ? joined : joined.toLowerCase(),
    lowWords: raw.map(t => t.toLowerCase()).filter(w => w.length >= 3),
  };
}
// How word i of the query appears in a field: 'x' exact word, 'p' inside a longer word, 'f' near-miss spelling.
function wordHit(m, i, F, mode){
  const w = m.words[i];
  if (F.toks.includes(w)) return 'x';
  if (mode === 'strict') return null;
  const rw = m.rawCmp[i];
  if (rw.length >= 4 && F.joined.includes(rw)) return 'p';
  if (mode === 'loose'){
    const max = w.length >= 9 ? 2 : w.length >= 5 ? 1 : 0;
    if (max && F.toks.some(t => lev(t, w, max) <= max)) return 'f';
  }
  return null;
}

const FIELD_ORDER = ['name', 'ftitle', 'link', 'title', 'path', 'near'];
const FIELD_LABEL = {name:'name', ftitle:'file title', link:'link', title:'page', path:'address', near:'nearby text'};

// Where each query word was found, and whether that is enough for the mode.
function evaluate(m, F, mode){
  const n = m.words.length;
  const where = new Array(n).fill(null), how = new Array(n).fill(null);
  for (const f of FIELD_ORDER){
    const X = F[f];
    if (!X || (f === 'near' && mode !== 'loose')) continue;
    // "annualreport" = annual + report (strict: only as a whole word)
    const phrase = n > 1 && (mode === 'strict' ? X.toks.includes(m.joined) : X.joined.includes(m.joined));
    for (let i = 0; i < n; i++){
      if (where[i]) continue;
      const h = phrase ? 'x' : wordHit(m, i, X, mode);
      if (h){ where[i] = f; how[i] = h; }
    }
  }
  const found = where.filter(Boolean).length;
  const inName = where.filter(w => w === 'name' || w === 'ftitle').length;
  let ok;
  if (mode === 'strict') ok = inName === n;
  else if (mode === 'standard') ok = found === n && inName >= 1;
  else ok = found >= Math.max(1, Math.ceil(0.6 * n)) && where.some(w => w === 'name' || w === 'ftitle' || w === 'link');
  if (!ok) return null;

  const nameToks = F.name ? F.name.toks : [];
  let inOrder = true, last = -1;
  for (let i = 0; i < n && inOrder; i++){
    if (where[i] !== 'name') continue;
    const k = nameToks.indexOf(m.words[i], last + 1);
    if (k < 0) inOrder = false; else last = k;
  }
  const extra = Math.max(0, nameToks.length - where.filter(w => w === 'name').length);
  const parts = [];
  for (const f of FIELD_ORDER){
    const ws = m.raw.filter((_, i) => where[i] === f).map((w, _, __) => w);
    if (!ws.length) continue;
    const marked = m.raw.map((w, i) => where[i] === f ? w + (how[i] === 'f' ? '~' : '') : null).filter(Boolean);
    parts.push(FIELD_LABEL[f] + ': ' + marked.join(', '));
  }
  const missing = m.raw.filter((_, i) => !where[i]);
  if (missing.length) parts.push('missing: ' + missing.join(', '));
  return {pack: m.pack, n, found, inName, allName: inName === n, inOrder, extra,
          tierBase: inName === n ? 2 : found === n ? 3 : 4, why: parts.join(' · ')};
}
// Lower = better.
function cmpEval(a, b){
  return (a.tier ?? a.tierBase) - (b.tier ?? b.tierBase) || (b.found / b.n) - (a.found / a.n) ||
         (b.inOrder - a.inOrder) || a.extra - b.extra;
}

/* ---------------- run state + job lanes ---------------- */
let run = null;
let renderPending = false;

function currentMode(){ return document.querySelector('input[name=mode]:checked')?.value || 'standard'; }
function braveKey(){ try { return (localStorage.getItem('braveKey') || '').trim(); } catch { return ''; } }

function newRun(){
  const mode = currentMode();
  const matchCase = $('optCase').checked;
  const packs = splitList($('qName').value);
  const level = +$('optDepth').value;
  const sources = [...document.querySelectorAll('.src:checked')].map(x => x.value);
  const matchers = {};
  for (const md of ['loose', 'standard', 'strict']) matchers[md] = packs.map(p => buildMatcher(p, md, matchCase)).filter(Boolean);
  const r = {
    id: 'run' + Date.now() + '_' + Math.random().toString(36).slice(2),
    mode, opts: {matchCase}, packs, level, cfg: DEPTH[level],
    types: parseTypes($('qType').value),
    matchers, sources,
    lanes: Object.fromEntries(Object.keys(LANES).map(k => [k, {q:[], active:0}])),
    stopped:false, done:false, probeTimer:null, probesUsed:0, seq:0,
    seenUrl:new Set(), seenItem:new Set(), visited:new Set(),
    hostPages:{}, pagesUsed:0, engBlocked:{}, ghBlocked:false,
    groups:new Map(), pages:new Map(), newest:null, view:[], visibleCount:0,
    stats:{requests:0, scanned:0, pages:0, probed:0},
    src:{}, started:Date.now(),
  };
  const engines = sources.filter(s => ENGINES[s]);
  r.chips = [...engines, ...(engines.length ? ['web'] : []), ...sources.filter(s => !ENGINES[s])];
  for (const s of r.chips) r.src[s] = {req:0, files:0, err:0, pages:0, links:0, state:'running', last:''};
  return r;
}

function enqueue(r, lane, src, fn, front = false){
  if (r.stopped) return;
  const L = r.lanes[lane];
  front ? L.q.unshift({fn, src}) : L.q.push({fn, src});
  pump(r, lane);
}
function pump(r, lane){
  const L = r.lanes[lane];
  while (!r.stopped && L.active < LANES[lane] && L.q.length){
    const job = L.q.shift();
    L.active++;
    job.fn().catch(e => {
      if (r.stopped) return;
      const st = r.src[job.src];
      if (!st) return;
      if (job.src === 'github' && (e.status === 403 || e.status === 429)){
        r.ghBlocked = true; st.state = 'limit'; st.last = 'GitHub rate limit reached (60 requests/hour without login)'; return;
      }
      st.err++; st.last = e.message || String(e);
    }).finally(() => {
      L.active--;
      if (!r.stopped) pump(r, lane);
      checkDone(r);
    });
  }
}
function checkDone(r){
  if (r.done) return;
  if (r.probeTimer) return;
  const busy = Object.values(r.lanes).some(L => L.active > 0 || (!r.stopped && L.q.length));
  if (busy) return;
  r.done = true;
  for (const s of Object.values(r.src)) if (s.state === 'running') s.state = (s.req && s.err >= s.req) ? 'err' : 'done';
  finishUi(r);
}
function httpErr(status){ const e = new Error('HTTP ' + status); e.status = status; return e; }

async function getJSON(r, url, bucket, gap, src){
  if (r.stopped) throw new Error('stopped');
  r.stats.requests++; r.src[src].req++;
  const res = await get(url, {bucket, gap, maxBytes: 30000000, json: true, run: r});
  if (r.stopped) throw new Error('stopped');
  if (res.status >= 400) throw httpErr(res.status);
  try { return JSON.parse(res.body); } catch { throw new Error('bad JSON answer'); }
}

/* ---------------- candidates: files grouped by name, each with its copies (mirrors) ---------------- */
function mirrorFields(r, mi, mode){
  const t = mi.probe?.title || '';
  mi.F = mi.F || {};
  if (!mi.F[mode] || mi.F[mode]._t !== t){
    const kc = r.opts.matchCase;
    const f = {_t: t, name: fieldIndex(mi.base, mode, kc)};
    if (t) f.ftitle = fieldIndex(t, mode, kc);
    for (const k of ['link', 'title', 'path', 'near']) if (mi.ctx[k]) f[k] = fieldIndex(mi.ctx[k], mode, kc);
    mi.F[mode] = f;
  }
  return mi.F[mode];
}
function evalMirror(r, mi, mode = r.mode){
  const F = mirrorFields(r, mi, mode);
  let best = null;
  for (const m of r.matchers[mode]){
    const e = evaluate(m, F, mode);
    if (e && (!best || cmpEval(e, best) < 0)) best = e;
  }
  return best;
}

function consider(r, src, names, info){
  if (r.stopped || !info.url || r.seenUrl.has(info.url)) return;
  r.seenUrl.add(info.url);
  r.stats.scanned++;
  if (r.src[src]) r.src[src].files++;
  let path = '';
  try { const segs = decodeURIComponent(new URL(info.url).pathname).split('/'); segs.pop(); path = segs.join(' '); } catch {}
  const ctx = {link: info.linkText || '', title: info.container || '', path, near: r.mode === 'loose' ? (info.near || '') : ''};
  let pick = null;
  for (const cand of names){
    const full = lastSegment(cand.name);
    if (!full) continue;
    const low = full.toLowerCase();
    let type;
    if (r.types.length){ type = r.types.find(t => low.endsWith('.' + t)); if (!type) continue; }
    else { type = splitExt(full).ext; if (PAGE_EXT.has(type)) continue; }
    const base = full.slice(0, full.length - type.length - 1);
    const mi = {url: info.url, src, srcLabel: SOURCES[src].label, container: info.container || '', containerUrl: info.containerUrl || '',
                size: info.size || 0, name: full, type, base, ctx, label: cand.label || '', probe: null, probing: false};
    const ev = evalMirror(r, mi);
    if (ev){ if (!pick || !pick.ev || cmpEval(ev, pick.ev) < 0) pick = {mi, ev}; }
    else if (!pick && r.mode === 'strict' && TITLE_TYPES.has(type) && evalMirror(r, mi, 'standard')) pick = {mi, ev: null}; // may match by its own title
  }
  if (pick) addMirror(r, pick.mi);
}

// A link from a web page: its own filename, plus link text / query values that look like file names.
function considerLink(r, url, text, info){
  let u; try { u = new URL(url); } catch { return; }
  const names = [{name: lastSegment(u.pathname)}];
  const t = (text || '').trim();
  if (t && t.length < 200 && /\.[A-Za-z0-9]{1,8}$/.test(t)) names.push({name: t, label: 'link text'});
  for (const v of u.searchParams.values()){
    if (/^[^\/\\]{1,200}\.[A-Za-z0-9]{1,8}$/.test(v)) names.push({name: v, label: 'from link'});
  }
  consider(r, 'web', names, {url: u.href, linkText: t, ...info});
}

function addMirror(r, mi){
  const key = mi.name.toLowerCase();
  let g = r.groups.get(key);
  if (!g){ g = {key, name: mi.name, type: mi.type, mirrors: [], best: null, main: null, dead: false, verified: false, hosts: 0, size: 0, seq: ++r.seq}; r.groups.set(key, g); }
  g.mirrors.push(mi);
  recompute(r, g);
  if (visible(r, g)) r.newest = g.key;
  scheduleRender();
  scheduleProbes(r);
}
function recompute(r, g){
  const alive = g.mirrors.filter(m => !(m.probe && m.probe.dead));
  g.dead = !alive.length;
  let best = null, main = null;
  for (const m of alive){
    const e = evalMirror(r, m);
    if (!e) continue;
    const verified = !!(m.probe && m.probe.ok);
    const cand = {...e, verified, tier: e.allName && verified ? 1 : e.tierBase};
    if (!best || cmpEval(cand, best) < 0 || (cmpEval(cand, best) === 0 && verified && !best.verified)){ best = cand; main = m; }
  }
  g.best = best;
  g.main = main || alive[0] || g.mirrors[0];
  g.verified = alive.some(m => m.probe && m.probe.ok);
  g.size = g.main.probe?.size || g.main.size || alive.map(m => m.probe?.size || m.size).find(Boolean) || 0;
  g.hosts = new Set(alive.map(m => hostOf(m.url))).size;
}
function visible(r, g){ return !g.dead && !!g.best && (r.mode !== 'strict' || g.best.verified); }
function cmpGroups(a, b){
  return cmpEval(a.best, b.best) || b.hosts - a.hosts || (b.size > 0) - (a.size > 0) || a.seq - b.seq;
}
function buildView(r){
  const vis = [];
  for (const g of r.groups.values()) if (visible(r, g)) vis.push(g);
  vis.sort(cmpGroups);
  r.visibleCount = vis.length;
  r.view = vis.slice(0, MAX_ROWS);
  return r.view;
}

/* ---------------- live check of the best candidates ---------------- */
function scheduleProbes(r){
  if (r.probeTimer || r.stopped) return;
  r.probeTimer = setTimeout(() => { r.probeTimer = null; feedProbes(r); checkDone(r); }, 300);
}
function nextMirrorToProbe(g){
  if (g.dead || (g.best && g.best.verified)) return null;
  const order = [g.main, ...g.mirrors.filter(m => m !== g.main)];
  return order.find(m => m && !m.probe && !m.probing && !(m.probe && m.probe.dead)) || null;
}
function feedProbes(r){
  if (r.stopped) return;
  const L = r.lanes.probe;
  const room = () => LANES.probe - (L.q.length + L.active);
  if (room() <= 0) return;
  let list;
  if (r.mode === 'strict'){
    // strict shows checked files only: check candidates in order of promise
    list = [...r.groups.values()].filter(g => !g.dead)
      .sort((a, b) => ((a.best ? a.best.tierBase : 3.5) - (b.best ? b.best.tierBase : 3.5)) || a.seq - b.seq);
  } else {
    list = buildView(r);
  }
  for (const g of list){
    if (room() <= 0 || r.probesUsed >= PROBE_BUDGET[r.mode]) break;
    const m = nextMirrorToProbe(g);
    if (!m) continue;
    m.probing = true;
    r.probesUsed++;
    enqueue(r, 'probe', 'probe', () => probeMirror(r, g, m));
  }
}
async function probeMirror(r, g, m){
  try {
    await throttle('h:' + hostOf(m.url), 800, () => r.stopped);
    m.probe = await invoke('probe_file', {url: m.url, referer: m.containerUrl || null, runId: r.id, expectExt: m.type});
  } catch (e) {
    if (r.stopped){ m.probing = false; return; }
    m.probe = {ok: false, dead: false, note: String(e.message || e)};
  }
  m.probing = false;
  if (m.probe.size) m.size = m.probe.size;
  r.stats.probed++;
  recompute(r, g);
  if (visible(r, g)) r.newest = g.key;
  scheduleRender();
  scheduleProbes(r);
}

/* ---------------- "pages that offer it" (login / button sites) ---------------- */
function addPage(r, url, text){
  if (r.mode === 'strict' || r.pages.has(url)) return;
  let path = '';
  try { path = decodeURIComponent(new URL(url).pathname); } catch {}
  const kc = r.opts.matchCase;
  const F = {link: fieldIndex(text, r.mode, kc), path: fieldIndex(path, r.mode, kc)};
  let best = 0;
  for (const m of r.matchers[r.mode]){
    let found = 0;
    for (let i = 0; i < m.words.length; i++){
      if ([F.link, F.path].some(X => (m.words.length > 1 && X.joined.includes(m.joined)) || wordHit(m, i, X, r.mode))) found++;
    }
    const need = r.mode === 'loose' ? Math.ceil(0.6 * m.words.length) : m.words.length;
    if (found >= need) best = Math.max(best, found / m.words.length);
  }
  if (!best) return;
  r.pages.set(url, {url, text: text || url, host: hostOf(url).replace(/^www\./, ''), cov: best, seq: r.pages.size});
  scheduleRender();
}

/* ---------------- web search engines ---------------- */
function variantOf(pack){
  let changed = false;
  const out = pack.split(' ').map(w => {
    const l = w.toLowerCase();
    if (NUM_TO_ROMAN[l]){ changed = true; return NUM_TO_ROMAN[l].toUpperCase(); }
    if (ROMAN[l]){ changed = true; return ROMAN[l]; }
    if (w === '&'){ changed = true; return 'and'; }
    if (l === 'and'){ changed = true; return '&'; }
    return w;
  }).join(' ');
  return changed ? out : null;
}
function engineQueries(r, pack){
  const out = [];
  const add = q => { if (!out.includes(q)) out.push(q); };
  const T = r.types;
  if (r.mode === 'strict'){
    const q = '"' + pack + '"';
    if (T.length) for (const t of T) add(q + ' filetype:' + t); else add(q);
    return out;
  }
  if (T.length) for (const t of T){ add(pack + ' filetype:' + t); add(pack + ' ' + t); } else add(pack);
  if (T.length) for (const t of T) add('intitle:"index of" ' + pack + ' ' + t); else add('intitle:"index of" ' + pack);
  if (r.mode === 'loose'){
    const words = pack.split(' ').filter(Boolean);
    const extra = [];
    if (words.length >= 3) for (let i = 0; i < Math.min(words.length, 3); i++) extra.push(words.filter((_, j) => j !== i).join(' '));
    const v = variantOf(pack);
    if (v) extra.push(v);
    for (const q of extra){ if (T.length) for (const t of T) add(q + ' filetype:' + t); else add(q); }
    add(pack + ' (' + DOC_SITES.map(s => 'site:' + s).join(' OR ') + ')');
  }
  return out;
}
// Blocked = refused status, or a page with (almost) no results that shows a CAPTCHA / bot check.
function isBlockPage(res, linkCount){
  if (res.status === 429 || res.status === 403) return true;
  if (linkCount >= 3) return false;
  const b = (res.body || '').slice(0, 300000).toLowerCase();
  return b.includes('anomaly-modal') || b.includes('bots use duckduckgo') || b.includes('captcha') ||
    b.includes('unusual traffic') || /captcha|challenge/.test((res.final_url || '').toLowerCase());
}
function unwrapEngineLink(href){
  let u; try { u = new URL(href); } catch { return null; }
  if (/duckduckgo\.com$/.test(u.hostname) && u.searchParams.get('uddg')) return u.searchParams.get('uddg');
  if (/bing\.com$/.test(u.hostname) && u.pathname.startsWith('/ck/')){
    let v = u.searchParams.get('u') || '';
    if (v.startsWith('a1')){
      v = v.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      while (v.length % 4) v += '=';
      try { return decodeURIComponent(escape(atob(v))); } catch { return null; }
    }
  }
  return u.href;
}
function collectLinks(doc, base){
  const out = [], seen = new Set();
  const push = (raw, text, near) => {
    if (!raw) return;
    raw = raw.trim();
    if (/^(javascript|mailto|tel|data|about):/i.test(raw) || raw.startsWith('#')) return;
    let u; try { u = new URL(raw, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = '';
    if (seen.has(u.href)) return;
    seen.add(u.href);
    out.push({url: u.href, text: (text || '').replace(/\s+/g, ' ').trim().slice(0, 300), near: near || ''});
  };
  for (const a of doc.querySelectorAll('a[href], area[href]')){
    const near = (a.parentElement?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    push(a.getAttribute('href'), a.textContent || a.getAttribute('title') || '', near);
  }
  for (const e of doc.querySelectorAll('iframe[src], embed[src], source[src], video[src], audio[src]')) push(e.getAttribute('src'), '');
  for (const e of doc.querySelectorAll('object[data]')) push(e.getAttribute('data'), '');
  for (const m of doc.querySelectorAll('meta[http-equiv]')){
    if (/refresh/i.test(m.getAttribute('http-equiv'))){
      const c = m.getAttribute('content') || '';
      const mm = c.match(/url\s*=\s*['"]?([^'"]+)/i);
      if (mm) push(mm[1], 'refresh');
    }
  }
  return out.slice(0, 3000);
}
function engineLinks(E, body, base){
  const doc = new DOMParser().parseFromString(body, 'text/html');
  const out = [], seen = new Set();
  for (const l of collectLinks(doc, base)){
    const real = unwrapEngineLink(l.url);
    if (!real) continue;
    let u; try { u = new URL(real); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || E.own.test(u.hostname) || SKIP_HOSTS.test(u.hostname)) continue;
    u.hash = '';
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    out.push({url: u.href, text: l.text});
  }
  return out;
}
async function engineSearch(r, key, query, page){
  if (r.stopped || r.engBlocked[key]) return;
  const E = ENGINES[key], st = r.src[key];
  r.stats.requests++; st.req++;
  let links;
  const apiKey = key === 'brave' ? braveKey() : '';
  if (apiKey){
    // Brave Search API (optional key): reliable, no CAPTCHA.
    const url = 'https://api.search.brave.com/res/v1/web/search?q=' + enc(query) + '&count=20' + (page > 1 ? '&offset=' + (page - 1) : '');
    const res = await get(url, {bucket: 'eng-braveapi', gap: 1100, json: true, run: r, maxBytes: 4000000, headers: {'X-Subscription-Token': apiKey}});
    if (r.stopped) return;
    if ([401, 403, 422].includes(res.status)){ r.engBlocked[key] = true; st.state = 'limit'; st.last = 'Brave API key was refused (HTTP ' + res.status + ') – check the key.'; return; }
    if (res.status === 429){ r.engBlocked[key] = true; st.state = 'limit'; st.last = 'Brave API limit reached (HTTP 429).'; return; }
    if (res.status >= 400) throw httpErr(res.status);
    let j; try { j = JSON.parse(res.body); } catch { throw new Error('bad answer from Brave API'); }
    links = (j?.web?.results || []).map(x => ({url: x.url, text: stripHtml((x.title || '') + ' ' + (x.description || ''))}));
  } else {
    const res = await get(E.url(query, page), {bucket: 'eng-' + key, gap: E.gap, maxBytes: 3000000, run: r});
    if (r.stopped) return;
    links = res.status < 400 ? engineLinks(E, res.body, res.final_url) : [];
    if (isBlockPage(res, links.length)){
      r.engBlocked[key] = true; st.state = 'limit';
      st.last = E.label + ' asked for a CAPTCHA / blocked automated searches – skipped for this search. Try again later.';
      return;
    }
    if (res.status >= 400) throw httpErr(res.status);
  }
  st.links += links.length;
  for (const l of links){
    if (WALLED.test(hostOf(l.url))){ addPage(r, l.url, l.text); continue; }
    enqueue(r, 'crawl', 'web', () => visit(r, l.url, 0, l.text, E.label + ' result', '', ''));
  }
  if (links.length >= 5 && page < r.cfg.enginePages) enqueue(r, 'engine', key, () => engineSearch(r, key, query, page + 1));
}

/* ---------------- robots.txt (polite crawling) ---------------- */
const robotsCache = new Map();
function parseRobots(text){
  const rules = [];
  let applies = false, inAgents = false;
  for (let line of text.split(/\r?\n/)){
    line = line.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === 'user-agent'){
      if (!inAgents) applies = false;
      inAgents = true;
      if (v === '*') applies = true;
    } else {
      inAgents = false;
      if (!applies) continue;
      if (k === 'disallow' && v) rules.push([false, v]);
      else if (k === 'allow' && v) rules.push([true, v]);
    }
  }
  return rules;
}
function robotsPattern(p){
  return new RegExp('^' + p.split('*').map(esc).join('.*').replace(/\\\$$/, '$'));
}
async function robotsOk(u){
  const o = u.origin;
  if (!robotsCache.has(o)){
    robotsCache.set(o, (async () => {
      const res = await safeGet(o + '/robots.txt', {maxBytes: 300000});
      if (!res || res.status >= 400 || !res.is_text) return [];
      return parseRobots(res.body).map(([allow, p]) => [allow, p, robotsPattern(p)]);
    })());
  }
  const rules = await robotsCache.get(o);
  const path = u.pathname + u.search;
  let best = null;
  for (const [allow, p, re] of rules) if (re.test(path) && (!best || p.length > best[1].length)) best = [allow, p];
  return !best || best[0];
}

/* ---------------- web crawler ---------------- */
const FOLLOW_WORDS = /download|mirror|files?\b|documents?|attachments?|library|archive|pdf|resources?|manuals?|papers?/i;
function relevant(r, s){
  const low = s.toLowerCase();
  return r.matchers[r.mode].some(m => m.lowWords.length && m.lowWords.some(w => low.includes(w)));
}
function shouldFollow(r, lu, text, baseU, isIndex){
  if (SKIP_HOSTS.test(lu.hostname) || WALLED.test(lu.hostname)) return false;
  if (/(login|signin|sign-in|signup|register|cart|checkout|account|logout|privacy|terms|cookie)/i.test(lu.pathname)) return false;
  const sameHost = lu.hostname === baseU.hostname;
  if (isIndex){
    // open directory listing: go into sub-folders only
    return sameHost && lu.pathname.endsWith('/') && lu.pathname.startsWith(baseU.pathname) && lu.pathname !== baseU.pathname && !lu.search;
  }
  let path = lu.pathname; try { path = decodeURIComponent(path); } catch {}
  const rel = relevant(r, text + ' ' + path);
  if (sameHost) return rel || FOLLOW_WORDS.test(text);
  return rel && FOLLOW_WORDS.test(text + ' ' + path);
}
async function visit(r, url, level, linkText, foundVia, referer, near){
  if (r.stopped) return;
  let u; try { u = new URL(url); } catch { return; }
  if (!/^https?:$/.test(u.protocol)) return;
  u.hash = '';
  if (r.visited.has(u.href)) return;
  r.visited.add(u.href);
  if (!PAGE_EXT.has(urlExt(u))){
    // the link itself is a file
    considerLink(r, u.href, linkText, {container: foundVia, containerUrl: referer || '', size: 0, near});
    return;
  }
  const host = u.hostname;
  if (r.pagesUsed >= r.cfg.pageBudget || (r.hostPages[host] || 0) >= r.cfg.hostCap) return;
  if (!(await robotsOk(u)) || r.stopped) return;
  r.hostPages[host] = (r.hostPages[host] || 0) + 1;
  r.pagesUsed++;
  const st = r.src.web;
  r.stats.requests++; st.req++;
  let res;
  try { res = await get(u.href, {referer: referer || null, maxBytes: 1500000, gap: 1200, run: r}); }
  catch (e) { if (!r.stopped){ st.err++; st.last = e.message || String(e); } return; }
  if (r.stopped) return;
  if (res.status >= 400){ st.err++; st.last = 'HTTP ' + res.status + ' ' + host; return; }
  st.pages++; r.stats.pages++;
  if (!res.is_text){
    // the "page" turned out to be a file download
    const name = res.filename || lastSegment(new URL(res.final_url).pathname);
    if (name && /\.[A-Za-z0-9]{1,8}$/.test(name))
      consider(r, 'web', [{name}], {url: u.href, linkText, container: foundVia, containerUrl: referer || '', size: res.length || 0, near});
    return;
  }
  if (!/html|xml/.test(res.content_type) && !/^\s*</.test(res.body)) return;
  const doc = new DOMParser().parseFromString(res.body, 'text/html');
  const base = res.final_url || u.href;
  const baseU = new URL(base);
  const title = (doc.title || '').replace(/\s+/g, ' ').trim() || host;
  const h1 = (doc.querySelector('h1')?.textContent || '').trim();
  const isIndex = /^index of\b/i.test(title) || /^index of\b/i.test(h1);
  for (const l of collectLinks(doc, base)){
    let lu; try { lu = new URL(l.url); } catch { continue; }
    if (!PAGE_EXT.has(urlExt(lu))){
      considerLink(r, l.url, l.text, {container: title, containerUrl: base, size: 0, near: l.near});
    } else if (WALLED.test(lu.hostname)){
      addPage(r, l.url, l.text);
    } else if (level < r.cfg.crawlLevels && shouldFollow(r, lu, l.text, baseU, isIndex)){
      enqueue(r, 'crawl', 'web', () => visit(r, l.url, level + 1, l.text, title, base, l.near), isIndex);
    }
  }
}

/* ---------------- file sites (APIs) ---------------- */
function apiQuery(r, pack){ return r.mode === 'strict' ? '"' + pack + '"' : pack.split(' ').join(' AND '); }

async function iaSearch(r, pack, page){
  const url = 'https://archive.org/advancedsearch.php?q=' + enc(apiQuery(r, pack)) +
    '&fl[]=identifier&fl[]=title&rows=50&page=' + page + '&sort[]=' + enc('downloads desc') + '&output=json';
  const d = await getJSON(r, url, 'ia', 150, 'ia');
  const docs = d?.response?.docs || [];
  for (const doc of docs){
    if (r.seenItem.has('ia:' + doc.identifier)) continue;
    r.seenItem.add('ia:' + doc.identifier);
    enqueue(r, 'api', 'ia', () => iaItem(r, doc), true);
  }
  if (docs.length === 50 && page < r.cfg.apiPages && page * 50 < (d.response.numFound || 0))
    enqueue(r, 'api', 'ia', () => iaSearch(r, pack, page + 1));
}
async function iaItem(r, doc){
  const id = doc.identifier;
  const d = await getJSON(r, 'https://archive.org/metadata/' + enc(id), 'ia', 150, 'ia');
  const title = Array.isArray(doc.title) ? doc.title[0] : doc.title;
  for (const f of d?.files || []){
    if (!f.name || f.source === 'metadata') continue;
    consider(r, 'ia', [{name: f.name}], {
      url: 'https://archive.org/download/' + enc(id) + '/' + f.name.split('/').map(enc).join('/'),
      container: title || id, containerUrl: 'https://archive.org/details/' + enc(id), size: +f.size || 0,
    });
  }
}
async function commonsSearch(r, pack, page, cont){
  const q = r.mode === 'strict' ? 'intitle:"' + pack + '"' : pack;
  let url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search' +
    '&gsrnamespace=6&gsrlimit=50&gsrsearch=' + enc(q) + '&prop=imageinfo&iiprop=url|size';
  if (cont) for (const k in cont) url += '&' + enc(k) + '=' + enc(cont[k]);
  const d = await getJSON(r, url, 'commons', 300, 'commons');
  for (const p of Object.values(d?.query?.pages || {})){
    const ii = p.imageinfo && p.imageinfo[0];
    if (!ii || !ii.url) continue;
    consider(r, 'commons', [{name: p.title.replace(/^File:/, '')}], {url: ii.url, container: 'Commons file page', containerUrl: ii.descriptionurl, size: ii.size || 0});
  }
  if (d?.continue && page < r.cfg.apiPages) enqueue(r, 'api', 'commons', () => commonsSearch(r, pack, page + 1, d.continue));
}
async function zenodoSearch(r, pack, page){
  const d = await getJSON(r, 'https://zenodo.org/api/records?q=' + enc(apiQuery(r, pack)) + '&size=25&page=' + page, 'zenodo', 1100, 'zenodo');
  const hits = d?.hits?.hits || [];
  for (const h of hits){
    const recUrl = h.links?.self_html || h.links?.html || ('https://zenodo.org/records/' + h.id);
    for (const f of h.files || []){
      const name = f.key || f.filename;
      if (!name) continue;
      consider(r, 'zenodo', [{name}], {url: f.links?.self || (recUrl + '/files/' + enc(name)), container: h.metadata?.title || h.title || 'Zenodo record', containerUrl: recUrl, size: f.size || 0});
    }
  }
  if (hits.length === 25 && page < r.cfg.apiPages * 2) enqueue(r, 'api', 'zenodo', () => zenodoSearch(r, pack, page + 1));
}
async function openalexSearch(r, pack, page){
  const url = 'https://api.openalex.org/works?search=' + enc(pack) + '&filter=is_oa:true&per-page=50&page=' + page + '&select=id,display_name,best_oa_location,doi';
  const d = await getJSON(r, url, 'openalex', 200, 'openalex');
  const works = d?.results || [];
  for (const w of works){
    const loc = w.best_oa_location || {};
    if (!loc.pdf_url) continue;
    const names = [{name: lastSegment(loc.pdf_url)}];
    if (w.display_name) names.push({name: w.display_name.replace(/[\/\\]/g, ' ') + '.pdf', label: 'paper title'});
    consider(r, 'openalex', names, {url: loc.pdf_url, container: w.display_name || 'Paper', containerUrl: loc.landing_page_url || w.doi || w.id, size: 0});
  }
  if (works.length === 50 && page < r.cfg.apiPages) enqueue(r, 'api', 'openalex', () => openalexSearch(r, pack, page + 1));
}
async function ghSearch(r, pack, page){
  if (r.ghBlocked) return;
  const d = await getJSON(r, 'https://api.github.com/search/repositories?q=' + enc(pack) + '&per_page=10&page=' + page, 'gh-search', 6500, 'github');
  const items = d?.items || [];
  for (const repo of items){
    if (r.seenItem.has('gh:' + repo.full_name)) continue;
    r.seenItem.add('gh:' + repo.full_name);
    enqueue(r, 'api', 'github', () => ghTree(r, repo), true);
  }
  if (items.length === 10 && page < r.cfg.apiPages) enqueue(r, 'api', 'github', () => ghSearch(r, pack, page + 1));
}
async function ghTree(r, repo){
  if (r.ghBlocked) return;
  const br = repo.default_branch || 'main';
  const d = await getJSON(r, 'https://api.github.com/repos/' + repo.full_name + '/git/trees/' + enc(br) + '?recursive=1', 'gh-core', 800, 'github');
  for (const t of d?.tree || []){
    if (t.type !== 'blob') continue;
    const p = t.path.split('/').map(enc).join('/');
    consider(r, 'github', [{name: t.path}], {
      url: 'https://github.com/' + repo.full_name + '/blob/' + enc(br) + '/' + p,
      container: repo.full_name + (t.path.includes('/') ? ' / ' + t.path.slice(0, t.path.lastIndexOf('/')) : ''),
      containerUrl: repo.html_url, size: t.size || 0,
    });
  }
}
const API_STARTERS = {
  ia:       (r, p) => iaSearch(r, p, 1),
  commons:  (r, p) => commonsSearch(r, p, 1, null),
  zenodo:   (r, p) => zenodoSearch(r, p, 1),
  openalex: (r, p) => openalexSearch(r, p, 1),
  github:   (r, p) => ghSearch(r, p, 1),
};

/* ---------------- downloads: try many ways ---------------- */
const downloads = new Map(); // group key -> download state
let dlSeq = 0;
let dlDir = '';

function rewrites(url, ext){
  const out = [];
  let u; try { u = new URL(url); } catch { return out; }
  const h = u.hostname;
  let m;
  if (h === 'github.com' && (m = u.pathname.match(/^\/([^\/]+)\/([^\/]+)\/blob\/(.+)$/)))
    out.push({url: 'https://raw.githubusercontent.com/' + m[1] + '/' + m[2] + '/' + m[3], how: 'GitHub raw file'});
  if (/(^|\.)drive\.google\.com$/.test(h)){
    const id = (u.pathname.match(/\/file\/d\/([^\/]+)/) || [])[1] || u.searchParams.get('id');
    if (id){
      out.push({url: 'https://drive.usercontent.google.com/download?id=' + enc(id) + '&export=download&confirm=t', how: 'Google Drive direct download'});
      out.push({url: 'https://drive.google.com/uc?export=download&id=' + enc(id), how: 'Google Drive export link'});
    }
  }
  if (h === 'docs.google.com' && (m = u.pathname.match(/^\/(document|spreadsheets|presentation)\/d\/([^\/]+)/))){
    const fmt = ext || {document:'pdf', spreadsheets:'xlsx', presentation:'pptx'}[m[1]];
    out.push({url: 'https://docs.google.com/' + m[1] + '/d/' + m[2] + '/export?format=' + enc(fmt), how: 'Google Docs export as .' + fmt});
  }
  if (/(^|\.)dropbox\.com$/.test(h)){
    const v = new URL(u.href); v.searchParams.set('dl', '1'); out.push({url: v.href, how: 'Dropbox direct link'});
  }
  if (h === 'zenodo.org' && u.pathname.includes('/files/') && !u.searchParams.has('download')){
    const v = new URL(u.href); v.searchParams.set('download', '1'); out.push({url: v.href, how: 'Zenodo download link'});
  }
  if (/(^|\.)sourceforge\.net$/.test(h) && u.pathname.includes('/files/') && !u.pathname.endsWith('/download'))
    out.push({url: u.href.replace(/\/?$/, '/download'), how: 'SourceForge download link'});
  if (h === 'archive.org' && u.pathname.startsWith('/details/'))
    out.push({url: u.href.replace('/details/', '/download/'), how: 'Internet Archive download path'});
  if (/(^|\.)arxiv\.org$/.test(h) && u.pathname.startsWith('/abs/'))
    out.push({url: u.href.replace('/abs/', '/pdf/'), how: 'arXiv PDF'});
  if (u.protocol === 'http:') out.push({url: u.href.replace(/^http:/, 'https:'), how: 'same link over https'});
  else out.push({url: u.href.replace(/^https:/, 'http:'), how: 'same link over http'});
  return out;
}

// Links on a page that probably lead to the wanted file, best first.
function scrapeDownloadLinks(body, base, d, ext){
  const doc = new DOMParser().parseFromString(body, 'text/html');
  const fname = d.name.toLowerCase();
  const fbase = splitExt(d.name).base.toLowerCase();
  const cands = collectLinks(doc, base);
  // GET forms (e.g. "download anyway" confirmation pages)
  for (const f of doc.querySelectorAll('form')){
    const method = (f.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'get') continue;
    const txt = (f.textContent || '') + ' ' + (f.getAttribute('action') || '') + ' ' + (f.id || '');
    if (!/download|confirm/i.test(txt)) continue;
    try {
      const a = new URL(f.getAttribute('action') || base, base);
      for (const i of f.querySelectorAll('input[name]')) if ((i.getAttribute('type') || 'text') !== 'submit' || i.value) a.searchParams.set(i.getAttribute('name'), i.value || '');
      cands.push({url: a.href, text: 'download form'});
    } catch {}
  }
  // raw URLs in scripts / attributes that mention the file
  for (const mm of body.matchAll(/https?:\\?\/\\?\/[^\s"'<>()]+/g)){
    const raw = mm[0].replace(/\\\//g, '/');
    const low = raw.toLowerCase();
    if ((ext && low.split(/[?#]/)[0].endsWith('.' + ext)) || low.includes(enc(fname).toLowerCase()) || low.includes(fname))
      cands.push({url: raw, text: 'link in page code'});
  }
  const scored = [], seen = new Set([base]);
  for (const c of cands){
    let u; try { u = new URL(c.url); } catch { continue; }
    if (seen.has(u.href)) continue;
    seen.add(u.href);
    const seg = lastSegment(u.pathname).toLowerCase();
    const uext = urlExt(u);
    const text = (c.text || '').toLowerCase();
    let s = 0;
    if (seg === fname) s += 10;
    else if (ext && uext === ext) s += 5;
    if (/download|\bdl\b|get file|mirror|confirm/.test(text + ' ' + u.href.toLowerCase())) s += 3;
    if (fbase.length > 2 && (text.includes(fbase) || seg.includes(fbase))) s += 2;
    if (PAGE_EXT.has(uext) && s < 10) s -= 1;
    if (SKIP_HOSTS.test(u.hostname)) s -= 5;
    if (s >= 5) scored.push({url: u.href, s});
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, 8).map(x => x.url);
}

async function engineLookup(key, q){
  const E = ENGINES[key];
  const res = await safeGet(E.url(q, 1), {bucket: 'eng-' + key, gap: E.gap, maxBytes: 3000000});
  if (!res || res.status >= 400) return [];
  const links = engineLinks(E, res.body, res.final_url);
  return isBlockPage(res, links.length) ? [] : links;
}

// What a download needs, from a result group (or an earlier download entry, for Retry).
function dlSpec(x){
  if (x.mirrors && x.main){
    const alive = x.mirrors.filter(m => !(m.probe && m.probe.dead));
    return {key: x.key, url: x.main.url, name: x.name, type: x.type, containerUrl: x.main.containerUrl || '',
            others: alive.filter(m => m !== x.main).map(m => ({url: m.url, containerUrl: m.containerUrl || ''}))};
  }
  return {key: x.key, url: x.url, name: x.name, type: x.type, containerUrl: x.containerUrl, others: x.others || []};
}
function startDownload(x){
  const spec = dlSpec(x);
  let d = downloads.get(spec.key);
  if (d && d.state === 'working') return;
  if (d && d.state === 'done'){ invoke('open_path', {path: d.path}).catch(() => {}); return; }
  d = {...spec, id: 'dl' + (++dlSeq) + '_' + Date.now(), state: 'working', got: 0, total: 0, tried: 0,
       method: '', status: 'starting…', log: [], path: '', cancel: false};
  downloads.delete(spec.key);
  downloads.set(spec.key, d);
  renderAll();
  runDownload(d).catch(e => { d.state = 'failed'; d.log.push('error: ' + (e.message || e)); }).finally(() => {
    if (d.state === 'working') d.state = 'failed';
    d.status = d.state === 'done' ? 'saved' : d.state === 'cancelled' ? 'cancelled' : 'failed – tried ' + d.tried + ' way' + (d.tried === 1 ? '' : 's');
    renderAll();
  });
}

async function runDownload(d){
  const dir = await getDlDir();
  const ext = (d.type || splitExt(d.name).ext || '').toLowerCase();
  const queue = [], tried = new Set();
  const add = (url, referer, how) => {
    if (!url) return;
    try { url = new URL(url).href; } catch { return; }
    if (tried.has(url) || queue.some(q => q.url === url)) return;
    queue.push({url, referer, how});
  };
  add(d.url, d.containerUrl, 'direct link');
  for (const a of rewrites(d.url, ext)) add(a.url, d.containerUrl, a.how);
  // other copies of the same file found during the search
  for (const o of d.others){
    add(o.url, o.containerUrl, 'copy on ' + hostOf(o.url));
    for (const a of rewrites(o.url, ext).slice(0, 1)) add(a.url, o.containerUrl, a.how + ' (' + hostOf(o.url) + ')');
  }

  const phases = [
    async () => {
      d.status = 'checking the page where it was found…'; renderAll();
      if (!/^https?:/.test(d.containerUrl)) return;
      const res = await safeGet(d.containerUrl, {maxBytes: 3000000});
      if (res && res.is_text) for (const l of scrapeDownloadLinks(res.body, res.final_url, d, ext)) add(l, d.containerUrl, 'link on the page it was found');
    },
    async () => {
      d.status = 'asking the Wayback Machine…'; renderAll();
      const res = await safeGet('https://archive.org/wayback/available?url=' + enc(d.url), {bucket: 'ia', gap: 300, json: true});
      try {
        const s = JSON.parse(res.body)?.archived_snapshots?.closest;
        if (s?.available && s.timestamp) add('https://web.archive.org/web/' + s.timestamp + 'id_/' + d.url, null, 'Wayback Machine copy (' + s.timestamp.slice(0, 8) + ')');
      } catch {}
      add('https://web.archive.org/web/2id_/' + d.url, null, 'Wayback Machine (latest copy)');
    },
    async () => {
      d.status = 'searching the web for mirrors…'; renderAll();
      const pages = [];
      for (const key of Object.keys(ENGINES)){
        if (d.cancel) return;
        for (const l of await engineLookup(key, '"' + d.name + '"')){
          let u; try { u = new URL(l.url); } catch { continue; }
          if (lastSegment(u.pathname).toLowerCase() === d.name.toLowerCase()) add(l.url, null, 'mirror found by ' + ENGINES[key].label);
          else if (PAGE_EXT.has(urlExt(u)) && !WALLED.test(u.hostname) && pages.length < 4 && !pages.includes(l.url)) pages.push(l.url);
        }
      }
      for (const p of pages){
        if (d.cancel) return;
        const res = await safeGet(p, {maxBytes: 2000000});
        if (res && res.is_text) for (const l of scrapeDownloadLinks(res.body, res.final_url, d, ext).slice(0, 3)) add(l, p, 'link on ' + hostOf(p));
      }
    },
  ];

  let phase = 0;
  while (!d.cancel){
    if (!queue.length){
      if (phase >= phases.length) break;
      await phases[phase++]().catch(() => {});
      continue;
    }
    const t = queue.shift();
    tried.add(t.url);
    d.tried++; d.method = t.how; d.got = 0; d.total = 0;
    d.status = 'way ' + d.tried + ': ' + t.how; renderAll();
    await throttle('h:' + hostOf(t.url), 800);
    let res;
    try {
      res = await invoke('download_try', {job: d.id, url: t.url, referer: t.referer || null, dir, filename: d.name, expectExt: ext});
    } catch (e) { res = {ok: false, reason: String(e)}; }
    if (res.ok){
      d.state = 'done'; d.path = res.path; d.got = res.bytes;
      d.log.push('✓ ' + t.how + ' – saved ' + fmtSize(res.bytes));
      return;
    }
    d.log.push('✗ ' + t.how + ' – ' + res.reason);
    if (res.reason === 'cancelled' || d.cancel){ d.state = 'cancelled'; return; }
    if (res.html){
      const from = res.final_url || t.url;
      for (const l of scrapeDownloadLinks(res.html, from, d, ext).slice(0, 6)) add(l, from, 'download link on ' + hostOf(from));
    }
    if (d.tried >= 30) break;
  }
  d.state = d.cancel ? 'cancelled' : 'failed';
}

function cancelDownload(key){
  const d = downloads.get(key);
  if (!d || d.state !== 'working') return;
  d.cancel = true;
  invoke('cancel_download', {job: d.id}).catch(() => {});
}

async function getDlDir(){
  if (dlDir) return dlDir;
  try { dlDir = localStorage.getItem('dlDir') || ''; } catch {}
  if (!dlDir) dlDir = await invoke('default_dir');
  $('dlDir').textContent = dlDir;
  return dlDir;
}

/* ---------------- rendering ---------------- */
function fmtSize(b){
  if (!b) return '';
  const u = ['B','KB','MB','GB','TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1){ b /= 1024; i++; }
  return (i ? b.toFixed(b < 10 ? 1 : 0) : b) + ' ' + u[i];
}
function scheduleRender(){
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => { renderPending = false; renderRows(); renderPages(); renderDownloads(); });
}
const renderAll = scheduleRender;

const LEVELS = {
  1: ['Best', 'All words in the file name, and the file was opened and checked'],
  2: ['Name', 'All words in the file name (not checked yet)'],
  3: ['All words', 'All words found, some only in the link text, page title or address'],
  4: ['Partial', 'Most of the words found (Loose mode)'],
};
const KIND = {pdf: 'PDF', zip: 'file (zip-based)', ole: 'Office file', other: 'file'};

function checkText(g){
  const m = g.main;
  if (!m) return '';
  if (m.probing) return '<span class="chk wait">checking…</span>';
  if (!m.probe) return '';
  if (m.probe.ok){
    const t = m.probe.title ? ' · title: “' + html(m.probe.title.slice(0, 90)) + '”' : '';
    return '<span class="chk ok">✓ real ' + html(KIND[m.probe.kind] || 'file') + (m.probe.size ? ', ' + fmtSize(m.probe.size) : '') + '</span>' + t;
  }
  return '<span class="chk bad">✗ ' + html(m.probe.note || 'could not check') + '</span>';
}
function dlCell(key){
  const d = downloads.get(key);
  const k = html(key);
  if (!d) return `<button class="dlbtn" data-act="dl" data-key="${k}">Download</button>`;
  if (d.state === 'working'){
    const pct = d.total ? Math.floor(d.got * 100 / d.total) + '%' : d.got ? fmtSize(d.got) : '…';
    return `<button class="dlbtn working" disabled>${pct}</button><button class="x" data-act="cancel" data-key="${k}" title="Cancel">✕</button><div class="dlinfo">${html(d.status)}</div>`;
  }
  if (d.state === 'done') return `<button class="dlbtn done" data-act="dl" data-key="${k}" title="${html(d.path)}">Open</button><div class="dlinfo">via ${html(d.method)}</div>`;
  return `<button class="dlbtn failed" data-act="dl" data-key="${k}" title="${html(d.log.join('\n'))}">Retry</button><div class="dlinfo">${html(d.status)}</div>`;
}
function link(url, text, cls = 'ext'){
  return url && /^https?:/.test(url) ? `<a class="${cls}" data-href="${html(url)}">${html(text)}</a>` : html(text);
}
function renderRows(){
  const r = run;
  const tb = $('rows');
  const view = r ? buildView(r) : [];
  if (!view.length){
    const msg = !r ? 'Type a file name and press Search.'
      : !r.done ? (r.mode === 'strict' ? 'Searching… files appear here once they are checked.' : 'Searching… no matching files yet.')
      : 'No matching files found.' + (r.mode !== 'loose' ? ' Try Loose mode for related results.' : '');
    tb.innerHTML = '<tr><td colspan="8" class="empty">' + msg + '</td></tr>';
    return;
  }
  tb.innerHTML = view.map((g, i) => {
    const t = g.best.tier;
    const m = g.main;
    const label = m.label ? ' <span class="tag">' + html(m.label) + '</span>' : '';
    return `
    <tr class="${g.key === r.newest ? 'new' : ''}">
      <td class="n">${i + 1}</td>
      <td class="lv"><span class="lvl l${t}" title="${html(LEVELS[t][1])}">${t} · ${LEVELS[t][0]}</span></td>
      <td class="name">${link(m.url, g.name)}${label}${g.hosts > 1 ? `<div class="sub">found on ${g.hosts} sites</div>` : ''}</td>
      <td>${g.type ? '<span class="tag">' + html(g.type) + '</span>' : ''}</td>
      <td style="white-space:nowrap">${fmtSize(g.size)}</td>
      <td class="why"><span class="tag">${html(g.best.pack)}</span><div class="sub">${html(g.best.why)}</div><div class="sub">${checkText(g)}</div></td>
      <td class="src">${html(m.srcLabel)}<br>${link(m.containerUrl, m.container || '')}</td>
      <td class="dl">${dlCell(g.key)}</td>
    </tr>`;
  }).join('');
}
function renderPages(){
  const r = run;
  const box = $('pagesBox');
  if (!r || r.mode === 'strict' || !r.pages.size){ box.hidden = true; return; }
  box.hidden = false;
  const list = [...r.pages.values()].sort((a, b) => b.cov - a.cov || a.seq - b.seq).slice(0, 40);
  $('pagesSum').textContent = 'Pages that offer it (' + r.pages.size + ') – these sites need a login or a button to download';
  $('pagesList').innerHTML = list.map(p => `<div class="pg">${link(p.url, p.text.slice(0, 160) || p.url)} <span class="tag">${html(p.host)}</span></div>`).join('');
}
function renderDownloads(){
  const list = [...downloads.values()].reverse();
  $('dlPanel').hidden = !list.length;
  if (!list.length) return;
  $('dlList').innerHTML = list.map(d => {
    const pct = d.total ? Math.floor(d.got * 100 / d.total) : 0;
    const cls = d.state === 'done' ? 'ok' : d.state === 'failed' ? 'bad' : '';
    const st = d.state === 'done' ? 'Saved ' + fmtSize(d.got) + ' via ' + d.method + ' → ' + d.path
      : d.state === 'working' ? (d.total ? pct + '% of ' + fmtSize(d.total) : d.got ? fmtSize(d.got) : '') + ' · ' + d.status
      : d.status;
    const btn = d.state === 'working'
      ? `<button class="small" data-act="cancel" data-key="${html(d.key)}">Cancel</button>`
      : `<button class="small" data-act="dl" data-key="${html(d.key)}">${d.state === 'done' ? 'Show file' : 'Retry'}</button>`;
    return `<div class="dlitem">
      <div><div class="nm">${html(d.name)}</div><div class="st ${cls}">${html(st)}</div></div>
      <div>${btn}</div>
      ${d.state === 'working' && d.total ? `<div class="prog"><i style="width:${pct}%"></i></div>` : ''}
      ${d.log.length ? `<details><summary>${d.log.length} attempt${d.log.length === 1 ? '' : 's'}</summary><ol>${d.log.map(l => '<li>' + html(l) + '</li>').join('')}</ol></details>` : ''}
    </div>`;
  }).join('');
}
function renderStatus(){
  const r = run;
  if (!r) return;
  const secs = Math.round((Date.now() - r.started) / 1000);
  const s = r.stats;
  const txt = `${s.requests} requests · ${s.pages} web pages · ${s.scanned.toLocaleString()} files seen · ${r.visibleCount} matches · ${s.probed} checked live · ${secs}s`;
  $('status').innerHTML = (r.done ? (r.stopped ? 'Stopped. ' : 'Finished. ') : '<span class="spin"></span>') + txt;
  $('sourceChips').innerHTML = r.chips.map(k => {
    const st = r.src[k];
    const cls = st.state === 'limit' ? 'limit' : st.state === 'err' ? 'err' : st.state === 'done' ? 'done' : '';
    const tip = st.last ? ' title="' + html(st.last) + '"' : '';
    const kind = SOURCES[k].kind;
    const label = SOURCES[k].label + (k === 'brave' && braveKey() ? ' API' : '');
    const body = kind === 'engine' ? `${st.links} results · ${st.req} req`
      : kind === 'crawl' ? `${st.pages} pages · ${st.files.toLocaleString()} file links`
      : `${st.files.toLocaleString()} files · ${st.req} req`;
    return `<span class="chip ${cls}"${tip}><b>${html(label)}</b> · ${body}${st.err ? ' · ' + st.err + ' errors' : ''}${st.state === 'limit' ? ' · blocked' : ''}</span>`;
  }).join('');
  // Problems in plain sight (not only as a hover tooltip).
  const probs = r.chips.filter(k => r.src[k].last && (r.src[k].err || r.src[k].state === 'limit'))
    .map(k => `<div><b>${SOURCES[k].label}:</b> ${html(r.src[k].last)}${r.src[k].err > 1 ? ' <span class="cnt">(' + r.src[k].err + ' errors, last shown)</span>' : ''}</div>`);
  $('srcErrors').innerHTML = probs.join('');
  $('srcErrors').hidden = !probs.length;
}
let statusTimer = null;
function finishUi(r){
  if (r !== run) return;
  clearInterval(statusTimer);
  $('btnSearch').disabled = false;
  $('btnStop').disabled = true;
  r.newest = null;
  renderStatus(); scheduleRender();
}

/* ---------------- search control ---------------- */
function startSearch(){
  if (!splitList($('qName').value).length){ $('status').textContent = 'Type at least one file name.'; $('qName').focus(); return; }
  if (run && !run.done) stopSearch();
  const r = newRun();
  if (!r.sources.length){ $('status').textContent = 'Tick at least one source.'; return; }
  if (!r.matchers[r.mode].length){ $('status').textContent = 'The file name needs at least one letter or number.'; return; }
  run = r;
  $('btnSearch').disabled = true;
  $('btnStop').disabled = false;
  $('pagesBox').open = r.mode === 'loose';
  scheduleRender(); renderStatus();
  clearInterval(statusTimer);
  statusTimer = setInterval(renderStatus, 400);
  for (const p of r.packs){
    for (const s of r.sources){
      if (ENGINES[s]) for (const q of engineQueries(r, p)) enqueue(r, 'engine', s, () => engineSearch(r, s, q, 1));
      else if (API_STARTERS[s]) enqueue(r, 'api', s, () => API_STARTERS[s](r, p));
    }
  }
}
function stopSearch(){
  const r = run;
  if (!r || r.done) return;
  r.stopped = true;
  clearTimeout(r.probeTimer); r.probeTimer = null;
  invoke('cancel_run', {runId: r.id}).catch(() => {});
  for (const L of Object.values(r.lanes)) L.q.length = 0;
  for (const s of Object.values(r.src)) if (s.state === 'running') s.state = 'done';
  // End the search in the UI right away; jobs still unwinding are ignored (r.stopped).
  r.done = true;
  finishUi(r);
}

/* ---------------- wiring ---------------- */
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-href]');
  if (a){ e.preventDefault(); invoke('open_url', {url: a.dataset.href}).catch(() => {}); return; }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const key = b.dataset.key;
  if (b.dataset.act === 'cancel') return cancelDownload(key);
  if (b.dataset.act === 'dl'){
    const x = run?.groups.get(key) || downloads.get(key);
    if (x) startDownload(x);
  }
});
$('btnSearch').addEventListener('click', startSearch);
$('btnStop').addEventListener('click', stopSearch);
for (const id of ['qName', 'qType']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') startSearch(); });
function showModeHelp(){ $('modeHelp').textContent = MODE_HELP[currentMode()]; }
for (const el of document.querySelectorAll('input[name=mode]')) el.addEventListener('change', showModeHelp);
$('btnDir').addEventListener('click', async () => {
  const p = await invoke('pick_folder').catch(() => null);
  if (!p) return;
  dlDir = p;
  try { localStorage.setItem('dlDir', p); } catch {}
  $('dlDir').textContent = p;
});
$('btnOpenDir').addEventListener('click', async () => { invoke('open_path', {path: await getDlDir()}).catch(() => {}); });
$('braveKey').addEventListener('change', () => {
  try { localStorage.setItem('braveKey', $('braveKey').value.trim()); } catch {}
  $('braveKeyState').textContent = braveKey() ? 'key saved – Brave uses the API' : '';
});
$('braveKeyLink').addEventListener('click', e => { e.preventDefault(); invoke('open_url', {url: 'https://brave.com/search/api/'}).catch(() => {}); });

listen('dl-progress', ev => {
  const p = ev.payload;
  for (const d of downloads.values()) if (d.id === p.job){ d.got = p.got; d.total = p.total; scheduleRender(); break; }
});

// Remember the last options.
try {
  const saved = JSON.parse(localStorage.getItem('opts2') || 'null');
  if (saved){
    if (saved.mode){ const el = document.querySelector('input[name=mode][value="' + saved.mode + '"]'); if (el) el.checked = true; }
    $('optCase').checked = !!saved.matchCase;
    if (saved.depth) $('optDepth').value = saved.depth;
    if (saved.sources) for (const c of document.querySelectorAll('.src')) c.checked = saved.sources.includes(c.value);
  }
  $('braveKey').value = braveKey();
  $('braveKeyState').textContent = braveKey() ? 'key saved – Brave uses the API' : '';
} catch {}
showModeHelp();
document.addEventListener('change', () => {
  try {
    localStorage.setItem('opts2', JSON.stringify({
      mode: currentMode(), matchCase: $('optCase').checked, depth: $('optDepth').value,
      sources: [...document.querySelectorAll('.src:checked')].map(x => x.value),
    }));
  } catch {}
});

(async () => {
  try {
    const info = await invoke('app_info');
    $('appTitle').innerHTML = html(info.name) + ' <small>' + html(info.version) + '</small>';
    document.title = info.name + ' ' + info.version;
  } catch {}
  getDlDir().catch(() => {});
  $('qName').focus();
})();

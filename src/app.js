'use strict';
/* Internet File Searcher – frontend.
   All network requests go through the Rust side (http_get / download_try), so there are no browser CORS limits. */

const TAURI = window.__TAURI__;
const invoke = TAURI.core.invoke;
const listen = TAURI.event.listen;

const $ = id => document.getElementById(id);
const MAX_ROWS = 50;
const SEP = "[\\s_\\-.+,;:~'()\\[\\]]";
const SEP_RE = new RegExp(SEP);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const enc = encodeURIComponent;
const html = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };

/* ---------------- settings per depth level ---------------- */
// level: 1 Quick, 2 Normal, 3 Deep, 4 Maximum
const DEPTH = {
  1: {apiPages:1,  enginePages:1, crawlLevels:1, pageBudget:80,   hostCap:8},
  2: {apiPages:3,  enginePages:2, crawlLevels:1, pageBudget:250,  hostCap:15},
  3: {apiPages:8,  enginePages:3, crawlLevels:2, pageBudget:800,  hostCap:30},
  4: {apiPages:25, enginePages:5, crawlLevels:3, pageBudget:2500, hostCap:60},
};
const LANES = {engine:3, crawl:6, api:4};

const SOURCES = {
  ddg:      {label:'DuckDuckGo', kind:'engine'},
  bing:     {label:'Bing', kind:'engine'},
  mojeek:   {label:'Mojeek', kind:'engine'},
  web:      {label:'Web crawl', kind:'crawl'},
  ia:       {label:'Internet Archive', kind:'api'},
  commons:  {label:'Wikimedia Commons', kind:'api'},
  zenodo:   {label:'Zenodo', kind:'api'},
  openalex: {label:'OpenAlex', kind:'api'},
  github:   {label:'GitHub', kind:'api'},
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
  mojeek: {
    label:'Mojeek', gap:3000,
    url:(q, p) => 'https://www.mojeek.com/search?q=' + enc(q) + (p > 1 ? '&s=' + ((p - 1) * 10 + 1) : ''),
    own:/(^|\.)mojeek\.(com|co\.uk)$/,
  },
};

// Extensions that mean "web page", not a file.
const PAGE_EXT = new Set(['', 'html','htm','xhtml','shtml','php','php3','asp','aspx','jsp','jspx','cfm','cgi','pl','do','action','mvc','jhtml']);
const SKIP_HOSTS = /(^|\.)(facebook|twitter|x|instagram|linkedin|pinterest|tiktok|reddit|youtube|google|gstatic|googleapis|doubleclick|apple|amazon|t)\.(com|co)$/;

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
async function get(url, {bucket, gap = 1000, referer = null, maxBytes = 2000000, json = false, run = null} = {}){
  await throttle(bucket || 'h:' + hostOf(url), gap, run ? () => run.stopped : null);
  return invoke('http_get', {url, referer, maxBytes, acceptJson: json, runId: run ? run.id : null});
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

/* ---------------- matching + scoring ---------------- */
function buildMatcher(pack, opts){
  const words = pack.split(' ').filter(Boolean);
  const fl = opts.matchCase ? 'u' : 'iu';
  const body = words.map(esc).join(SEP + '*');
  const chars = [...words.join('')];
  return {
    pack, words, chars,
    phrase:  new RegExp(body, fl),
    bounded: new RegExp('(?:^|' + SEP + ')' + body + '(?:$|' + SEP + ')', fl),
    strict:  new RegExp('^' + SEP + '*' + body + SEP + '*$', fl),
    needle:  opts.matchCase ? chars : chars.map(c => c.toLowerCase()),
    lowWords: words.map(w => w.toLowerCase()).filter(w => w.length >= 3),
    // one regex per word; very short words must stand alone so "a" / "of" don't match everything
    wordRes: words.map(w => w.length <= 2
      ? new RegExp('(?:^|' + SEP + ')' + esc(w) + '(?:$|' + SEP + ')', fl)
      : new RegExp(esc(w), fl)),
  };
}
function subsequenceSpan(hay, needle){
  let best = Infinity;
  for (let i = 0; i < hay.length; i++){
    if (hay[i] !== needle[0]) continue;
    let k = 1, j = i + 1;
    for (; j < hay.length && k < needle.length; j++) if (hay[j] === needle[k]) k++;
    if (k === needle.length) best = Math.min(best, j - i);
    else break;
  }
  return best;
}
function scoreName(base, m, opts){
  if (!base) return null;
  const L = [...base].length;
  if (m.strict.test(base)) return {score:100, how:'exact name'};
  if (opts.strict) return null;
  const extra = 1 - Math.min(1, m.chars.length / L);
  const pm = base.match(m.phrase);
  if (pm){
    const connected = m.words.length > 1 && !SEP_RE.test(pm[0]);
    let s, how;
    if (m.bounded.test(base)){ s = connected ? 86 : 90; how = connected ? 'joined words' : 'whole words'; }
    else { s = 78; how = 'inside a longer word'; }
    if (pm.index === 0) s += 3;
    s -= 22 * extra;
    return {score: Math.round(s), how};
  }
  if (opts.matchWords) return null;
  const hay = opts.matchCase ? [...base] : [...base.toLowerCase()];
  const span = subsequenceSpan(hay, m.needle);
  if (!isFinite(span)) return null;
  return {score: Math.round(25 + 40 * (m.chars.length / span) - 15 * extra), how:'letters in order'};
}

// Match words = "Name + page title": every word must appear somewhere – in the file name,
// the link text, the web address or the page/item title – in any order. At least one word
// must be in the file name or link text. File-name hits score higher. Never used in Strict mode.
function scoreSpread(base, ctx, m, opts){
  if (opts.strict || !base) return null;
  const inName = [], inLink = [], inPage = [];
  for (let i = 0; i < m.words.length; i++){
    const re = m.wordRes[i], w = m.words[i];
    if (re.test(base)) inName.push(w);
    else if (ctx.link && re.test(ctx.link)) inLink.push(w);
    else if ((ctx.path && re.test(ctx.path)) || (ctx.title && re.test(ctx.title))) inPage.push(w);
    else return null;
  }
  if (!inName.length && !inLink.length) return null;
  const n = m.words.length;
  const nameChars = [...inName.join('')].length;
  const extra = 1 - Math.min(1, nameChars / [...base].length);
  const score = 40 + 30 * inName.length / n + 10 * inLink.length / n - 12 * extra;
  const parts = [];
  if (inName.length) parts.push('name: ' + inName.join(', '));
  if (inLink.length) parts.push('link: ' + inLink.join(', '));
  if (inPage.length) parts.push('page: ' + inPage.join(', '));
  return {score: Math.round(score), how: parts.join(' · ')};
}

/* ---------------- run state + job lanes ---------------- */
let run = null;
let renderPending = false;

function newRun(){
  const opts = {matchWords: $('optWords').checked, matchCase: $('optCase').checked, strict: $('optStrict').checked};
  const packs = splitList($('qName').value);
  const level = +$('optDepth').value;
  const sources = [...document.querySelectorAll('.src:checked')].map(x => x.value);
  const r = {
    id: 'run' + Date.now() + '_' + Math.random().toString(36).slice(2),
    opts, packs, level, cfg: DEPTH[level],
    types: parseTypes($('qType').value),
    matchers: packs.map(p => buildMatcher(p, opts)),
    sources,
    lanes: Object.fromEntries(Object.keys(LANES).map(k => [k, {q:[], active:0}])),
    stopped:false, done:false,
    seenUrl:new Set(), seenItem:new Set(), visited:new Set(),
    hostPages:{}, pagesUsed:0, engBlocked:{}, ghBlocked:false,
    results:[], byUrl:new Map(), newest:null,
    stats:{requests:0, scanned:0, matched:0, pages:0},
    src:{}, started:Date.now(),
  };
  const engines = sources.filter(s => ENGINES[s]);
  const chips = [...engines, ...(engines.length ? ['web'] : []), ...sources.filter(s => !ENGINES[s])];
  r.chips = chips;
  for (const s of chips) r.src[s] = {req:0, files:0, err:0, pages:0, links:0, state:'running', last:''};
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

/* ---------------- candidate handling ---------------- */
function consider(r, src, names, info){
  if (r.stopped || !info.url || r.seenUrl.has(info.url)) return;
  r.seenUrl.add(info.url);
  r.stats.scanned++;
  if (r.src[src]) r.src[src].files++;
  let best = null;
  let path = '';
  try { path = decodeURIComponent(new URL(info.url).pathname).replace(/[\/]+/g, ' '); } catch {}
  const ctx = {link: info.linkText || '', path, title: info.container || ''};
  for (const cand of names){
    const full = lastSegment(cand.name);
    if (!full) continue;
    const low = full.toLowerCase();
    for (const t of (r.types.length ? r.types : [''])){
      if (t && !low.endsWith('.' + t)) continue;
      const base = t ? full.slice(0, full.length - t.length - 1) : splitExt(full).base;
      for (const m of r.matchers){
        const a = scoreName(base, m, r.opts);
        const b = scoreSpread(base, ctx, m, r.opts);
        const res = a && (!b || a.score >= b.score) ? a : b;
        if (!res) continue;
        const score = Math.max(1, Math.min(100, res.score - (cand.penalty || 0) + (info.size ? 1 : 0)));
        if (!best || score > best.score)
          best = {score, how: res.how + (cand.label ? ' (' + cand.label + ')' : ''), pack: m.pack, type: t || splitExt(full).ext, name: full};
      }
    }
  }
  if (!best) return;
  r.stats.matched++;
  const row = {...info, ...best, src: SOURCES[src].label, key: r.stats.matched};
  r.results.push(row);
  r.results.sort((a, b) => b.score - a.score || a.name.length - b.name.length || (b.size || 0) - (a.size || 0));
  if (r.results.length > MAX_ROWS) r.results.length = MAX_ROWS;
  r.byUrl = new Map(r.results.map(x => [x.url, x]));
  if (r.byUrl.has(row.url)) r.newest = row.key;
  scheduleRender();
}

// A link from a web page: its own filename, plus link text / query values that look like file names.
function considerLink(r, url, text, info){
  let u; try { u = new URL(url); } catch { return; }
  const names = [{name: lastSegment(u.pathname)}];
  const t = (text || '').trim();
  if (t && t.length < 200 && /\.[A-Za-z0-9]{1,8}$/.test(t)) names.push({name: t, penalty: 6, label: 'link text'});
  for (const v of u.searchParams.values()){
    if (/^[^\/\\]{1,200}\.[A-Za-z0-9]{1,8}$/.test(v)) names.push({name: v, penalty: 4, label: 'from link'});
  }
  consider(r, 'web', names, {url: u.href, linkText: t, ...info});
}

/* ---------------- web search engines ---------------- */
// Loose words like a normal Google search; only Strict mode asks for the exact phrase.
function quoted(r, pack){ return r.opts.strict ? '"' + pack + '"' : pack; }
function engineQueries(r, pack){
  const q = quoted(r, pack);
  const out = [];
  if (r.types.length){
    for (const t of r.types){ out.push(q + ' filetype:' + t); out.push(q + ' ' + t); out.push('intitle:"index of" ' + q + ' ' + t); }
  } else {
    out.push(q); out.push('intitle:"index of" ' + q);
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
  const push = (raw, text) => {
    if (!raw) return;
    raw = raw.trim();
    if (/^(javascript|mailto|tel|data|about):/i.test(raw) || raw.startsWith('#')) return;
    let u; try { u = new URL(raw, base); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    u.hash = '';
    if (seen.has(u.href)) return;
    seen.add(u.href);
    out.push({url: u.href, text: (text || '').replace(/\s+/g, ' ').trim().slice(0, 300)});
  };
  for (const a of doc.querySelectorAll('a[href], area[href]')) push(a.getAttribute('href'), a.textContent || a.getAttribute('title') || '');
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
  const res = await get(E.url(query, page), {bucket: 'eng-' + key, gap: E.gap, maxBytes: 3000000, run: r});
  if (r.stopped) return;
  const links = res.status < 400 ? engineLinks(E, res.body, res.final_url) : [];
  if (isBlockPage(res, links.length)){
    r.engBlocked[key] = true; st.state = 'limit';
    st.last = E.label + ' asked for a CAPTCHA / blocked automated searches – skipped for this search. Try again later.';
    return;
  }
  if (res.status >= 400) throw httpErr(res.status);
  st.links += links.length;
  for (const l of links) enqueue(r, 'crawl', 'web', () => visit(r, l.url, 0, l.text, E.label + ' result', ''));
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
  return r.matchers.some(m => m.lowWords.length && m.lowWords.some(w => low.includes(w)));
}
function shouldFollow(r, lu, text, baseU, isIndex){
  if (SKIP_HOSTS.test(lu.hostname)) return false;
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
async function visit(r, url, level, linkText, foundVia, referer){
  if (r.stopped) return;
  let u; try { u = new URL(url); } catch { return; }
  if (!/^https?:$/.test(u.protocol)) return;
  u.hash = '';
  if (r.visited.has(u.href)) return;
  r.visited.add(u.href);
  if (!PAGE_EXT.has(urlExt(u))){
    // the link itself is a file
    considerLink(r, u.href, linkText, {container: foundVia, containerUrl: referer || '', size: 0});
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
      consider(r, 'web', [{name}], {url: u.href, container: foundVia, containerUrl: referer || '', size: res.length || 0});
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
      considerLink(r, l.url, l.text, {container: title, containerUrl: base, size: 0});
    } else if (level < r.cfg.crawlLevels && shouldFollow(r, lu, l.text, baseU, isIndex)){
      enqueue(r, 'crawl', 'web', () => visit(r, l.url, level + 1, l.text, title, base), isIndex);
    }
  }
}

/* ---------------- file sites (APIs) ---------------- */
function apiQuery(r, pack){ return r.opts.strict ? '"' + pack + '"' : pack.split(' ').join(' AND '); }

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
  const q = r.opts.strict ? 'intitle:"' + pack + '"' : pack;
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
    if (w.display_name) names.push({name: w.display_name.replace(/[\/\\]/g, ' ') + '.pdf', penalty: 10, label: 'paper title'});
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
const downloads = new Map(); // url -> download state
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

function startDownload(row){
  let d = downloads.get(row.url);
  if (d && d.state === 'working') return;
  if (d && d.state === 'done'){ invoke('open_path', {path: d.path}).catch(() => {}); return; }
  d = {
    id: 'dl' + (++dlSeq) + '_' + Date.now(), url: row.url, name: row.name, type: row.type,
    containerUrl: row.containerUrl || '', state: 'working', got: 0, total: 0, tried: 0,
    method: '', status: 'starting…', log: [], path: '', cancel: false,
  };
  downloads.delete(row.url);
  downloads.set(row.url, d);
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
          else if (PAGE_EXT.has(urlExt(u)) && pages.length < 4 && !pages.includes(l.url)) pages.push(l.url);
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

function cancelDownload(url){
  const d = downloads.get(url);
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
  requestAnimationFrame(() => { renderPending = false; renderRows(); renderDownloads(); });
}
const renderAll = scheduleRender;

function dlCell(url){
  const d = downloads.get(url);
  const u = html(url);
  if (!d) return `<button class="dlbtn" data-act="dl" data-url="${u}">Download</button>`;
  if (d.state === 'working'){
    const pct = d.total ? Math.floor(d.got * 100 / d.total) + '%' : d.got ? fmtSize(d.got) : '…';
    return `<button class="dlbtn working" disabled>${pct}</button><button class="x" data-act="cancel" data-url="${u}" title="Cancel">✕</button><div class="dlinfo">${html(d.status)}</div>`;
  }
  if (d.state === 'done') return `<button class="dlbtn done" data-act="dl" data-url="${u}" title="${html(d.path)}">Open</button><div class="dlinfo">via ${html(d.method)}</div>`;
  return `<button class="dlbtn failed" data-act="dl" data-url="${u}" title="${html(d.log.join('\n'))}">Retry</button><div class="dlinfo">${html(d.status)}</div>`;
}
function link(url, text, cls = 'ext'){
  return url && /^https?:/.test(url) ? `<a class="${cls}" data-href="${html(url)}">${html(text)}</a>` : html(text);
}
function renderRows(){
  const r = run;
  const tb = $('rows');
  if (!r || !r.results.length){
    tb.innerHTML = '<tr><td colspan="8" class="empty">' + (r && !r.done ? 'Searching… no matching files yet.' : r ? 'No matching files found.' : 'Type a file name and press Search.') + '</td></tr>';
    return;
  }
  tb.innerHTML = r.results.map((x, i) => `
    <tr class="${x.key === r.newest ? 'new' : ''}">
      <td class="n">${i + 1}</td>
      <td class="sc"><span class="bar"><i style="width:${x.score}%"></i></span>${x.score}</td>
      <td class="name">${link(x.url, x.name)}</td>
      <td>${x.type ? '<span class="tag">' + html(x.type) + '</span>' : ''}</td>
      <td style="white-space:nowrap">${fmtSize(x.size)}</td>
      <td><span class="tag">${html(x.pack)}</span><div class="sub">${html(x.how)}</div></td>
      <td class="src">${html(x.src)}<br>${link(x.containerUrl, x.container || '')}</td>
      <td class="dl">${dlCell(x.url)}</td>
    </tr>`).join('');
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
      ? `<button class="small" data-act="cancel" data-url="${html(d.url)}">Cancel</button>`
      : `<button class="small" data-act="dl" data-url="${html(d.url)}">${d.state === 'done' ? 'Show file' : 'Retry'}</button>`;
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
  const txt = `${s.requests} requests · ${s.pages} web pages · ${s.scanned.toLocaleString()} files checked · ${s.matched} matches (showing best ${Math.min(MAX_ROWS, r.results.length)}) · ${secs}s`;
  $('status').innerHTML = (r.done ? (r.stopped ? 'Stopped. ' : 'Finished. ') : '<span class="spin"></span>') + txt;
  $('sourceChips').innerHTML = r.chips.map(k => {
    const st = r.src[k];
    const cls = st.state === 'limit' ? 'limit' : st.state === 'err' ? 'err' : st.state === 'done' ? 'done' : '';
    const tip = st.last ? ' title="' + html(st.last) + '"' : '';
    const kind = SOURCES[k].kind;
    const body = kind === 'engine' ? `${st.links} results · ${st.req} req`
      : kind === 'crawl' ? `${st.pages} pages · ${st.files.toLocaleString()} file links`
      : `${st.files.toLocaleString()} files · ${st.req} req`;
    return `<span class="chip ${cls}"${tip}><b>${SOURCES[k].label}</b> · ${body}${st.err ? ' · ' + st.err + ' errors' : ''}${st.state === 'limit' ? ' · blocked' : ''}</span>`;
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
  run = r;
  $('btnSearch').disabled = true;
  $('btnStop').disabled = false;
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
  const url = b.dataset.url;
  if (b.dataset.act === 'cancel') return cancelDownload(url);
  if (b.dataset.act === 'dl'){
    const row = run?.byUrl.get(url) || downloads.get(url);
    if (row) startDownload(row);
  }
});
$('btnSearch').addEventListener('click', startSearch);
$('btnStop').addEventListener('click', stopSearch);
for (const id of ['qName', 'qType']) $(id).addEventListener('keydown', e => { if (e.key === 'Enter') startSearch(); });
$('optStrict').addEventListener('change', () => { if ($('optStrict').checked) $('optWords').checked = true; });
$('optWords').addEventListener('change', () => { if (!$('optWords').checked) $('optStrict').checked = false; });
$('btnDir').addEventListener('click', async () => {
  const p = await invoke('pick_folder').catch(() => null);
  if (!p) return;
  dlDir = p;
  try { localStorage.setItem('dlDir', p); } catch {}
  $('dlDir').textContent = p;
});
$('btnOpenDir').addEventListener('click', async () => { invoke('open_path', {path: await getDlDir()}).catch(() => {}); });

listen('dl-progress', ev => {
  const p = ev.payload;
  for (const d of downloads.values()) if (d.id === p.job){ d.got = p.got; d.total = p.total; scheduleRender(); break; }
});

// Remember the last options.
const OPT_IDS = ['optWords', 'optCase', 'optStrict'];
try {
  const saved = JSON.parse(localStorage.getItem('opts') || 'null');
  if (saved){
    for (const id of OPT_IDS) if (id in saved) $(id).checked = saved[id];
    if (saved.depth) $('optDepth').value = saved.depth;
    if (saved.sources) for (const c of document.querySelectorAll('.src')) c.checked = saved.sources.includes(c.value);
  }
} catch {}
document.addEventListener('change', () => {
  try {
    localStorage.setItem('opts', JSON.stringify({
      ...Object.fromEntries(OPT_IDS.map(id => [id, $(id).checked])),
      depth: $('optDepth').value,
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

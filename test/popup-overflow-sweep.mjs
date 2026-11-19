// Measurement sweep: when does the popup get a scrollbar (content taller than 600px), and does
// anything ever overflow sideways? Drives the REAL built popup against local test pages, the same
// way test/manga-e2e.mjs does. Nothing is asserted: one line per scenario, then a table by height.
//
// Rows marked [stub] replace a page-script reply (a4k-list / a4k-manga-status) inside the popup,
// as openChapter() in manga-e2e.mjs does; everything else is real pages and real storage.
//
// Needs ffmpeg on PATH, Playwright (global or local), Brave/Chrome/Edge, and a fresh `npm run build`.
//
//   node test/popup-overflow-sweep.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" <output dir> [name filter]

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const [exe, outDir, only] = process.argv.slice(2);
if (!exe || !outDir) { console.error('usage: node test/popup-overflow-sweep.mjs <path to Brave/Chrome/Edge> <output dir> [name filter]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const { chromium } = loadPlaywright();

const POPUP_W = 387; // 380, and the 7px lane the real popup window grows by while its content scrolls
const POPUP_MAX = 600;
const SETTLE_MS = 1300; // the popup repaints every 500 ms: more than two repaints

// --- fixtures ------------------------------------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-sweep-'));
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const still = (size, name, extra = []) => ff(['-f', 'lavfi', '-i', `testsrc2=size=${size}`, '-frames:v', '1', ...extra, '-q:v', '8', path.join(work, name)]);
const clip = (size, rate, secs, name) => ff(['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${secs}`, '-c:v', 'libx264', '-preset', 'ultrafast',
  '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(work, name)]);
still('600x860', 'pg.jpg');
still('900x1300', 'colour.jpg');
still('3400x4900', 'huge.jpg'); // 16.7 megapixels: over the page limit
still('800x12000', 'toon.jpg'); // a webtoon strip
clip('640x360', 24, 10, 'v.mp4');
clip('1920x1080', 24, 4, 'v1080.mp4');
clip('2560x1440', 60, 3, 'v1440.mp4');
clip('3840x2160', 24, 2, 'v2160.mp4');

const routes = new Map(); // pathname -> html
const onceSeen = new Set();
const handler = (req, res) => {
  const u = new URL(req.url, 'http://x');
  const cors = u.searchParams.has('cors') ? { 'Access-Control-Allow-Origin': '*' } : {};
  if (/\.(mp4|jpg|png)$/.test(u.pathname)) {
    if (u.searchParams.has('missing')) { res.writeHead(404).end(); return; }
    // once=1: the page gets the image, whoever fetches the same URL again gets an error.
    if (u.searchParams.has('once')) { if (onceSeen.has(req.url)) { res.writeHead(500).end(); return; } onceSeen.add(req.url); }
    const file = path.join(work, path.basename(u.pathname));
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    const type = file.endsWith('.mp4') ? 'video/mp4' : file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': fs.statSync(file).size, ...cors });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const html = routes.get(u.pathname);
  if (html === undefined) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
};
const serve = (addr) => new Promise((ok) => { const s = http.createServer(handler).listen(0, addr, () => ok(s)); });
const pages = await serve('127.0.0.1');
const images = await serve('127.0.0.1'); // another origin, no CORS headers: the background fetch path
const second = await serve('127.0.0.2'); // player frames and streams on another address
const P1 = pages.address().port; const P2 = second.address().port; const P3 = images.address().port;
const H1 = `127.0.0.1:${P1}`;
const base = `http://${H1}`;
const imgBase = `http://127.0.0.1:${P3}`;
const base2 = `http://127.0.0.2:${P2}`;

const LONG_HOST = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(40)}.localhost`;
const HYPHEN_HOST = `${'very-long-anime-streaming-site-name-with-many-hyphens-in-it'}.${'another-long-label-with-hyphens-for-the-wrapping-case-here'}.${'third-label-also-long-and-hyphenated'}.localhost`;
const SITE_HOST = 'watch.very-long-anime-streaming-site.example';
const PLAYER_HOST = 'player.very-long-cdn-hostname-for-streams.example';
const STREAM_HOST = `${'stream-edge-node-0042-eu-central'}.${'x'.repeat(63)}.${'y'.repeat(50)}.cdn.test`;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const words = (n, seed = 'The Reincarnated Aristocrat Who Was Exiled Uses His Appraisal Skill To Rise In The World And Build The Strongest Territory ') => seed.repeat(Math.ceil(n / seed.length)).slice(0, n).trim();
const video = (src = '/v.mp4', w = 640, h = 360, attrs = '') => `<video src="${src}" muted autoplay loop playsinline style="width:${w}px;height:${h}px" ${attrs}></video>`;
let pageNo = 0;
/** Registers a page and returns its URL. `at` fixes the path (and query); `host` the host name. */
function addPage(html, { at, host = H1 } = {}) {
  const p = at ?? `/p/${++pageNo}`;
  routes.set(p.split('?')[0], html);
  return `http://${host}${p}`;
}
const watchHtml = ({ title = 'Some Show Episode 3', head = '', videos = [video()], script = '' } = {}) => `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>${head}
  <body style="margin:0;background:#000">${videos.join('\n')}<script>${script}</script></body>`;
const mediaSession = (m) => `navigator.mediaSession.metadata = new MediaMetadata(${JSON.stringify(m)});`;
const readerHtml = ({ title, n = 9, img = 'pg.jpg', head = '', extra = '', imgHost = imgBase, src } = {}) => `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>${head}
  <body style="margin:0;background:#222">${extra}<div style="width:800px">
  ${Array.from({ length: n }, (_, i) => `<img class="pg" src="${src ? src(i) : `${imgHost}/${img}?p=${i + 1}`}" style="width:800px;display:block">`).join('')}</div></body>`;
const BLOG = addPage(`<!doctype html><title>My trip to Kyoto - Travel Notes</title><body style="margin:0">
  <h1>My trip to Kyoto</h1><img src="${imgBase}/colour.jpg" style="width:420px"><img src="${imgBase}/colour.jpg?b=2" style="width:420px"></body>`, { at: '/blog/kyoto' });
const WATCH = addPage(watchHtml(), { at: '/watch/some-show-3' });
const reader = (n, title = 'Chainsaw Man Chapter 172 - MangaReader', opts = {}) => addPage(readerHtml({ title, n, ...opts }), { at: opts.at ?? `/manga/series-${++pageNo}/chapter-172` });

// --- what the popup looks like: run inside the popup ------------------------------------------
function probe() {
  const body = document.body; const de = document.documentElement;
  const r1 = (v) => Math.round(v * 10) / 10;
  const shown = (el) => { const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0; };
  const h = (el) => (el && shown(el) ? r1(el.getBoundingClientRect().height) : 0);
  const lineCount = (el) => {
    const range = document.createRange(); range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((q) => q.width > 0.5 && q.height > 0.5).sort((a, b) => a.top - b.top);
    let n = 0; let bottom = -1e9;
    for (const q of rects) { if ((q.top + q.bottom) / 2 > bottom) { n += 1; bottom = q.bottom; } else bottom = Math.max(bottom, q.bottom); }
    return n;
  };
  const bRect = body.getBoundingClientRect();
  const edge = bRect.left + body.clientLeft + body.clientWidth; // right end of the area the panels may use
  // Lines each text is designed for; more lines or a cut text is reported.
  const DESIGN = [['.bar > .chip:not(.mode)', 1], ['#mode', 1], ['#whatsnew', 1], ['.rate-top', 1], ['#rate-big', 1], ['#rate-l1', 1], ['#rate-l2', 1], ['.rate-go', 1], ['.rate-done', 1],
    ['.panel-head', 1], ['.source .title', 1], ['.source .episode', 1], ['.source .meta', 1], ['.source .state', 1], ['.mp-foot', 1], ['.mc-counts b', 1], ['.mc-counts span', 1],
    ['#empty', 2], ['.kv span', 1], ['.kv b', 1], ['#legend', 1], ['.tile b', 1], ['.tile small', 1], ['.pill', 1], ['.pcell', 1], ['#pmap-count', 1], ['#mp-done', 1]];
  const texts = [];
  for (const [sel, designed] of DESIGN) {
    for (const el of document.querySelectorAll(sel)) {
      if (!shown(el) || !el.textContent.trim()) continue;
      // A long title without episode data is designed for two lines (the lines after them are clamped away).
      const clamped = el.matches('.two-line .title');
      const design = clamped ? 2 : designed;
      const lines = clamped ? Math.min(lineCount(el), Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight))) : lineCount(el);
      const range = document.createRange(); range.selectNodeContents(el);
      const box = el.getBoundingClientRect();
      const inkRight = Math.max(...[...range.getClientRects()].map((q) => q.right), box.right);
      const cut = el.clientWidth > 0 && (el.scrollWidth > el.clientWidth + 1 || inkRight > box.right + 1 || (clamped && el.scrollHeight > el.clientHeight + 1));
      if (lines > design || cut) texts.push({ sel, lines, design, cut, ellipsis: clamped || getComputedStyle(el).textOverflow === 'ellipsis' || !!el.querySelector('.host') || !!el.querySelector('.epname') && getComputedStyle(el.querySelector('.epname')).textOverflow === 'ellipsis', need: Math.max(el.scrollWidth, Math.round(inkRight - box.left)), has: el.clientWidth, text: el.textContent.trim().slice(0, 40) });
    }
  }
  for (const row of document.querySelectorAll('.pills, .bar, .kv, .mc-counts')) {
    if (!shown(row)) continue;
    const kids = [...row.children].filter(shown).map((el) => el.getBoundingClientRect()).sort((a, b) => a.top - b.top);
    let n = 0; let bottom = -1e9;
    for (const q of kids) { if ((q.top + q.bottom) / 2 > bottom) { n += 1; bottom = q.bottom; } else bottom = Math.max(bottom, q.bottom); }
    const tops = { size: n };
    const want = row.matches('.kv:not(.two)') ? 2 : 1;
    if (tops.size > want) texts.push({ sel: `${row.id ? `#${row.id}` : `.${row.className.split(' ')[0]}`} row`, lines: tops.size, design: want, cut: false, text: '' });
  }
  // Anything whose box passes the right or left end of the popup's content area.
  const past = [];
  for (const el of body.querySelectorAll('*')) {
    if (el.closest('#tip, #mode-list, script') || !shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || (r.right <= edge + 0.5 && r.left >= bRect.left - 0.5)) continue;
    if (past.some((p) => p.el.contains(el))) continue;
    let clippedBy = '';
    for (let a = el.parentElement; a && a !== body; a = a.parentElement) {
      if (getComputedStyle(a).overflowX !== 'visible' && a.getBoundingClientRect().right <= edge + 0.5) { clippedBy = a.id ? `#${a.id}` : `.${a.className.split(' ')[0]}`; break; }
    }
    past.push({ el, what: `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : el.className ? `.${String(el.className).split(' ')[0]}` : ''}`, right: r1(r.right), clippedBy });
  }
  const switches = [...document.querySelectorAll('.source')].filter(shown).map((card) => {
    const s = card.querySelector('.switch input').getBoundingClientRect(); const c = card.getBoundingClientRect();
    return s.right <= c.right && s.left >= c.left;
  });
  const innerSideways = [...body.querySelectorAll('*')].filter((el) => shown(el) && !el.closest('#tip') && /auto|scroll/.test(getComputedStyle(el).overflowX) && el.scrollWidth > el.clientWidth + 1)
    .map((el) => (el.id ? `#${el.id}` : `.${el.className}`));
  const panels = [...document.querySelectorAll('section.panel')];
  const [now, pmap, perf, preset] = [panels[0], document.getElementById('pmap'), document.getElementById('perf'), panels[panels.length - 1]];
  const bars = document.getElementById('bars');
  const limit = bars.querySelector('s');
  const tip = document.getElementById('tip');
  let tipInfo = null;
  if (shown(tip)) {
    const t = tip.getBoundingClientRect(); const range = document.createRange(); range.selectNodeContents(tip);
    const ink = [...range.getClientRects()];
    tipInfo = { text: tip.textContent, w: r1(t.width), h: r1(t.height), left: r1(t.left), top: r1(t.top), lines: lineCount(tip),
      inside: t.left >= bRect.left && t.right <= bRect.right && t.top >= bRect.top && t.bottom <= Math.min(bRect.bottom, innerHeight),
      spill: r1(Math.max(0, Math.max(...ink.map((q) => q.right)) - t.right)), coversBar: t.top < document.querySelector('.bar').getBoundingClientRect().bottom && t.height > 40 };
  }
  const list = document.getElementById('mode-list');
  let listInfo = null;
  if (shown(list)) {
    const l = list.getBoundingClientRect();
    listInfo = { w: r1(l.width), h: r1(l.height), top: r1(l.top), inside: l.left >= bRect.left && l.right <= bRect.right && l.top >= bRect.top && l.bottom <= Math.min(bRect.bottom, innerHeight) };
  }
  const txt = (sel) => [...document.querySelectorAll(sel)].filter(shown).map((el) => el.textContent.trim());
  return {
    height: body.scrollHeight, exact: r1(preset.getBoundingClientRect().bottom - bRect.top + body.scrollTop + 10), clientH: body.clientHeight, scrollsV: body.scrollHeight > body.clientHeight,
    docW: [de.scrollWidth, de.clientWidth], bodyW: [body.scrollWidth, body.clientWidth], view: [innerWidth, innerHeight],
    docScrollsV: de.scrollHeight > de.clientHeight, bodyBottom: r1(bRect.bottom), bodyRight: r1(bRect.right),
    texts, past: past.map(({ what, right, clippedBy }) => ({ what, right, clippedBy })), switches, innerSideways,
    parts: {
      bar: h(document.querySelector('.bar')), banner: 0 /* the update note is a chip in the header row now */, rate: h(document.getElementById('rate')),
      now: h(now), pmap: h(pmap), perf: h(perf), preset: h(preset),
      cards: [...document.querySelectorAll('#sources .source')].filter(shown).map(h), preview: h(document.getElementById('mp-preview')), manga: h(document.getElementById('manga-card')),
      grid: h(document.getElementById('pmap-grid')), legend: h(document.getElementById('legend')), upscaleRow: h(document.getElementById('upscale')),
    },
    // left gap / gap up to the scrollbar's lane (or the popup's edge when nothing scrolls)
    sideGaps: [...new Set(panels.filter(shown).map((p) => { const r = p.getBoundingClientRect(); return `${r1(r.left - bRect.left)}/${r1(edge - r.right)}`; }))],
    ui: {
      chips: [...txt('#mode'), ...txt('.bar > .chip:not(.mode)')].join(' | '), count: txt('#count').join(''), titles: txt('.source .title').map((t) => t.slice(0, 30)),
      // a video card's state is its data-state (the dot of a compact card) and, for the open card, the performance heading
      states: [...[...document.querySelectorAll('#sources .source')].filter(shown).map((c) => `${c.classList.contains('compact') ? 'compact' : 'open'}:${c.dataset.state}`), ...txt('.source .state')], metas: txt('.source .meta'),
      tags: txt('.source .tag'), names: txt('.source .epname').map((t) => t.slice(0, 60)), tiles: txt('.kv b').join(' | '), labels: txt('.kv span').join(' | '), verdict: txt('#verdict').join(''),
      legend: document.getElementById('bars').dataset.tip ?? '' /* the legend is the tooltip of the graph */, barsH: h(bars), limit: shown(limit) ? limit.style.bottom : 'hidden', over: bars.querySelectorAll('i.over').length,
      mapClass: document.getElementById('pmap-grid').className, cells: document.querySelectorAll('#pmap-grid .pcell').length, mapCount: txt('#pmap-count').join(''),
      blocks: document.getElementById('mc-pages').children.length, shares: document.getElementById('mc-pages').classList.contains('shares'),
      minBlock: Math.min(...[...document.getElementById('mc-pages').children].filter(shown).map((el) => el.getBoundingClientRect().width), 999), counts: txt('.mc-counts b').join('/'),
      rate: txt('#rate-big, #rate-l1, #rate-l2, #rate-badge').join(' ; '), empty: txt('#empty').join(''),
      titleBox: [...document.querySelectorAll('.source .title')].filter(shown).map((el) => `${lineCount(el)}×${r1(el.getBoundingClientRect().height / Math.max(1, lineCount(el)))}px`),
      scrollTop: body.scrollTop,
    },
    tip: tipInfo, list: listInfo,
  };
}

// --- browser ------------------------------------------------------------------------------------
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-sweep-prof-')), {
  headless: !process.env.A4K_SHOW, // headless by default; A4K_SHOW=1 opens a real window
  ignoreDefaultArgs: ['--hide-scrollbars'], // headless hides scrollbars by default; the popup's scrollbar lane is measured
  executablePath: exe,
  viewport: { width: 1000, height: 900 },
  // Headless by default (A4K_SHOW=1: real windows, parked off-screen). Occlusion checks are off so the page tab
  // keeps rendering while the popup's own window exists beside it.
  args: ['--window-position=-32000,-32000', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
    '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    `--host-resolver-rules=MAP *.localhost 127.0.0.1, MAP ${SITE_HOST} 127.0.0.1, MAP ${PLAYER_HOST} 127.0.0.2, MAP *.cdn.test 127.0.0.2`],
});
const rows = [];
const notRun = [];
let fonts = '';
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  const popupErrors = [];

  // The popup lives in a window of its own (also off-screen): a real popup does not hide its tab,
  // and a hidden tab pauses its video. One page, reloaded for every scenario.
  const mainWindow = await sw.evaluate(async () => (await chrome.tabs.query({}))[0].windowId);
  const browserCdp = await ctx.browser().newBrowserCDPSession();
  const popupOpened = ctx.waitForEvent('page');
  const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, left: -30000, top: -32000, width: 500, height: 800 });
  const popup = await popupOpened;
  const { bounds } = await browserCdp.send('Browser.getWindowForTarget', { targetId });
  if (bounds.left > -20000) throw new Error(`popup window is not off-screen (${JSON.stringify(bounds)})`);
  await popup.setViewportSize({ width: POPUP_W, height: POPUP_MAX });
  popup.on('pageerror', (e) => popupErrors.push(e.message));
  // Every run of the popup reads its target tab and its stubs from the URL fragment.
  await popup.addInitScript(() => {
    if (location.protocol !== 'chrome-extension:' || !location.hash) return;
    const cfg = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active ? [cfg.tab] : query(info));
    if (!cfg.chapter && !cfg.manga && !cfg.stale && !cfg.stats && !cfg.video) return;
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (...args) => {
      let reply = await send(...args);
      const type = args[1]?.type;
      if (type === 'a4k-manga-status' && reply) {
        if (cfg.chapter) {
          // As openChapter() in manga-e2e.mjs: three quarters loaded, half of those done, two in progress, the 7th failed.
          const total = cfg.chapter; const loaded = Math.floor(total * 0.75);
          const marks = Array.from({ length: loaded }, (_, i) => (i === 6 ? 'fail' : i < loaded / 2 ? 'done' : i < loaded / 2 + 2 ? 'now' : 'todo'));
          reply = { ...reply, on: true, total, marks, first: 0, loading: 2, done: marks.filter((m) => m === 'done').length, failed: 1, lastError: 'fetch failed', pageMs: 420 };
        }
        if (cfg.manga) reply = { ...reply, ...cfg.manga };
        if (cfg.stale) { delete reply.protocol; delete reply.total; delete reply.reasons; }
      }
      if (type === 'a4k-list' && Array.isArray(reply) && (cfg.stats || cfg.video)) {
        const blank = { gpuMs: 1, samples: [], cpuMs: 1, fps: 24, passes: 9, textureBytes: 1e8, outputWidth: 1280, outputHeight: 720, timerSupported: true, sourceFps: 24 };
        reply = reply.map((v) => ({ ...v, ...cfg.video, stats: cfg.stats ? { ...(v.stats ?? blank), ...cfg.stats } : v.stats }));
      }
      return reply;
    };
  });

  // --- storage ---
  const DEFAULTS = { mode: 'auto', preset: 'A', darkenLines: false, thinLines: false, upscale: 'auto' };
  const setSettings = (s) => sw.evaluate(async (v) => { await chrome.storage.sync.set({ anime4k: v }); }, { ...DEFAULTS, ...s });
  const setLocal = (items) => sw.evaluate(async (v) => { await chrome.storage.local.set(v); }, items);
  const reset = async () => {
    await setSettings({});
    await sw.evaluate(async () => { await chrome.storage.local.remove(['a4k-manga', 'anime4k-sources', 'anime4k-rate', 'anime4k-whats-new']); });
  };
  const mangaOn = (host = '127.0.0.1') => setLocal({ 'a4k-manga': { [host]: true } });
  const banner = (v = '1.2.6') => setLocal({ 'anime4k-whats-new': v });
  const RATE_LEVEL = { 1: [3, 7200], 2: [12, 36000], 3: [48, 120000], 4: [200, 400000] };
  const rate = (level, clicked, over = {}) => setLocal({ 'anime4k-rate': { episodes: RATE_LEVEL[level][0], seconds: RATE_LEVEL[level][1], shown: 0, clicked, rated: false, returning: false, ...over } });

  // --- tabs ---
  let open = [];
  /** A new front tab in the main window (ctx.newPage() could land in the popup's window). */
  const blankTab = async () => {
    const opened = ctx.waitForEvent('page');
    const id = await sw.evaluate(async (windowId) => (await chrome.tabs.create({ windowId, url: 'about:blank', active: true })).id, mainWindow);
    return Object.assign(await opened, { tabId: id });
  };
  /** Opens a page in the main window (it stays the visible tab) and returns { page, id, url }. */
  const tab = async (url, waitMs = 1200) => {
    const page = await blankTab();
    const id = page.tabId;
    await page.goto(url, { waitUntil: 'load' }).catch((e) => { throw new Error(`cannot open ${url.slice(0, 80)}: ${e.message.split('\n')[0]}`); });
    await page.waitForTimeout(waitMs);
    const t = { page, id, url: page.url() };
    open.push(t);
    return t;
  };
  const videosOf = (t) => sw.evaluate(async (id) => {
    const frames = (await chrome.webNavigation.getAllFrames({ tabId: id })) ?? [];
    const out = [];
    for (const f of frames) {
      try { for (const v of (await chrome.tabs.sendMessage(id, { type: 'a4k-list' }, { frameId: f.frameId })) ?? []) out.push(v); } catch { /* no script in this frame */ }
    }
    return out;
  }, t.id);
  const mangaOf = (t) => sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'a4k-manga-status' }, { frameId: 0 }).catch(() => null), t.id);
  const until = async (fn, timeout = 20000, step = 300) => {
    const end = Date.now() + timeout;
    for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await popup.waitForTimeout(step); }
  };
  /** Switches on every video source of the tab (or those `pick` accepts) and waits for `want`. */
  const enable = async (t, { pick = () => true, want = (vs) => vs.some((v) => v.status === 'Active' && v.stats), timeout = 25000 } = {}) => {
    const vs = await until(async () => { const l = await videosOf(t); return l.length ? l : null; }, 8000);
    if (!vs) throw new Error('no video reported by the page');
    await setLocal({ 'anime4k-sources': Object.fromEntries(vs.filter(pick).map((v) => [v.key, true])) });
    return until(async () => { const l = await videosOf(t); return want(l) ? l : null; }, timeout);
  };
  const watchOn = async (url = WATCH, opts) => { const t = await tab(url); const vs = await enable(t, opts); if (!vs) throw new Error('video did not reach the wanted state'); return t; };

  // --- popup ---
  let nonce = 0;
  const openPopup = async (t, cfg = {}, settle = SETTLE_MS) => {
    await popup.goto(`chrome-extension://${extId}/popup.html?n=${++nonce}#${encodeURIComponent(JSON.stringify({ tab: { id: t.id, url: t.url }, ...cfg }))}`);
    await popup.waitForTimeout(settle);
  };
  const refs = {}; // baseline part heights by kind
  const shot = async (name, suffix = '') => {
    const file = path.join(outDir, `${name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 90)}${suffix}.png`);
    await popup.screenshot({ path: file });
    return file;
  };
  const wrapNotes = (m) => {
    const best = new Map();
    for (const t of m.texts) { const cur = best.get(t.sel); if (!cur || t.lines > cur.lines || (t.cut && !cur.cut)) best.set(t.sel, t); }
    const out = [...best.values()].map((t) => `${t.sel} ${t.lines > t.design ? `${t.lines} lines (design ${t.design})` : ''}${t.cut ? `${t.lines > t.design ? ', ' : ''}cut${t.ellipsis ? ' with ellipsis' : ''} (needs ${t.need}px, has ${t.has}px)` : ''}`);
    for (const p of m.past) out.push(`${p.what} reaches x=${p.right}${p.clippedBy ? ` (clipped by ${p.clippedBy})` : ' (NOT clipped)'}`);
    if (m.switches.includes(false)) out.push('switch pushed out of its card');
    for (const s of m.innerSideways) out.push(`${s} scrolls sideways inside`);
    return out.join('; ');
  };
  const stack = (m) => {
    const p = m.parts;
    const inNow = [...p.cards.map((c) => `card ${c}`), p.preview ? `preview ${p.preview}` : '', p.manga ? `manga card ${p.manga}` : ''].filter(Boolean).join(', ');
    const list = [['bar', p.bar], ['banner', p.banner], ['rate card', p.rate], [`now${inNow ? ` (${inNow})` : ''}`, p.now], ['page map', p.pmap], ['performance', p.perf], [`preset${p.upscaleRow ? '' : ' (no upscale row)'}`, p.preset]];
    return list.filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(' + ');
  };
  const grew = (m) => {
    const kind = m.parts.cards.length ? 'video' : m.parts.manga ? 'reader' : 'blog';
    const ref = refs[kind];
    if (!ref) return '';
    const d = ['bar', 'banner', 'rate', 'now', 'pmap', 'perf', 'preset'].map((k) => [k, Math.round((m.parts[k] - ref.parts[k]) * 10) / 10]).filter(([, v]) => Math.abs(v) >= 1);
    return d.length ? `; vs ${kind} baseline (${ref.height}px): ${d.map(([k, v]) => `${k} ${v > 0 ? '+' : ''}${v}`).join(', ')}` : `; same parts as ${kind} baseline`;
  };
  /**
   * Measures the popup as it is now and records a row. opts.detail(m): extra words for the row;
   * opts.broken(m): also counts as broken; opts.ref: store as the baseline of that kind.
   */
  const snap = async (name, opts = {}) => {
    const m = await popup.evaluate(probe);
    const sideways = m.docW[0] > m.docW[1] || m.bodyW[0] > m.bodyW[1] || m.past.some((p) => !p.clippedBy) || m.innerSideways.length > 0;
    const notes = wrapNotes(m);
    const broken = sideways || m.switches.includes(false) || m.past.length > 0 || m.texts.some((t) => t.cut && !t.ellipsis) || !!opts.broken?.(m);
    if (opts.ref) refs[opts.ref] = m;
    const row = {
      scenario: name, ran: true, contentHeight: m.height, scrollsVertically: m.scrollsV, scrollsSideways: sideways, clippedOrWrapped: notes || 'none',
      cause: `${m.scrollsV ? `over by ${Math.round((m.exact - POPUP_MAX) * 10) / 10}px` : `${Math.round((POPUP_MAX - m.exact) * 10) / 10}px spare`} (content ${m.exact}px): ${stack(m)} + 20 padding and gaps${grew(m)}${opts.detail ? `; ${opts.detail(m)}` : ''}`,
    };
    if (m.scrollsV || broken) {
      row.screenshot = await shot(name);
      if (m.scrollsV && !opts.noBottom) {
        await popup.evaluate(() => { document.body.scrollTop = document.body.scrollHeight; });
        await popup.waitForTimeout(150);
        await shot(name, '-bottom');
        await popup.evaluate(() => { document.body.scrollTop = 0; });
      }
    }
    rows.push(row);
    console.log(`${String(m.height).padStart(4)}px ${m.scrollsV ? 'SCROLLBAR' : 'fits     '} ${sideways ? 'SIDEWAYS' : '        '} ${name}${notes ? ` | ${notes}` : ''}${opts.detail ? ` | ${opts.detail(m)}` : ''}`);
    return m;
  };
  const scenario = async (name, fn) => {
    if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
    try { await reset(); await fn(); } catch (e) {
      const why = e.message.split('\n')[0];
      rows.push({ scenario: name, ran: false, cause: why });
      console.log(`  --  NOT RUN ${name}: ${why}`);
    } finally {
      for (const t of open) await t.page.close().catch(() => {});
      open = [];
      await popup.setViewportSize({ width: POPUP_W, height: POPUP_MAX });
    }
  };
  const ui = (keys) => (m) => keys.map((k) => `${k}=${JSON.stringify(m.ui[k])}`).join(' ');
  /** Hovers an element, waits for the popup's own tooltip and records it. */
  const tipRow = async (name, selector, { focus = false } = {}) => {
    const before = await popup.evaluate(() => [document.body.scrollHeight, document.body.scrollWidth]);
    await popup.locator(selector).first().scrollIntoViewIfNeeded();
    await popup.waitForTimeout(250);
    if (focus) { await popup.keyboard.press('Shift'); await popup.focus(selector); } else await popup.hover(selector, { force: true });
    await popup.waitForTimeout(750);
    await snap(name, {
      noBottom: true,
      broken: (m) => !m.tip || !m.tip.inside || m.tip.spill > 0.5 || m.tip.coversBar,
      detail: (m) => (m.tip ? `tooltip ${m.tip.w}×${m.tip.h}px, ${m.tip.lines} line(s), at ${m.tip.left},${m.tip.top}, inside popup: ${m.tip.inside}, text past its box: ${m.tip.spill}px, covers header: ${m.tip.coversBar}, popup size changed: ${m.height !== before[0] || m.bodyW[0] !== before[1]}, text "${m.tip.text.slice(0, 70)}${m.tip.text.length > 70 ? '…' : ''}" (${m.tip.text.length} chars)` : 'tooltip did not show'),
    });
    await popup.mouse.move(375, 5);
    await popup.waitForTimeout(100);
  };

  // The fonts really used (the stack names fonts that may not be installed).
  const fontsOf = async (selector) => {
    const cdp = await ctx.newCDPSession(popup);
    try {
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const { root: doc } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.nodeId, selector });
      if (!nodeId) return 'n/a';
      const { fonts: list } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
      return list.map((f) => `${f.familyName} (${f.glyphCount} glyphs)`).join(', ');
    } finally { await cdp.detach().catch(() => {}); }
  };

  // =============================================================================================
  // Baselines
  // =============================================================================================
  await scenario('baseline: no video page (blog)', async () => {
    const t = await tab(BLOG);
    await openPopup(t);
    fonts = await fontsOf('#hint');
    console.log(`INFO fonts used for the popup text: ${fonts}; computed font-family: ${await popup.evaluate(() => getComputedStyle(document.body).fontFamily)}`);
    await snap('baseline: no video page (blog), mode auto', { ref: 'blog', detail: ui(['empty', 'legend']) });
    await popup.click('#mode');
    await popup.waitForTimeout(250);
    await snap('baseline: blog, mode list open', { broken: (m) => !m.list?.inside, detail: (m) => `list ${m.list?.w}×${m.list?.h}px inside popup: ${m.list?.inside}` });
  });
  await scenario('baseline: browser page without content script', async () => {
    const t = await tab('chrome://version');
    await openPopup({ id: t.id });
    await snap('baseline: browser internal page (no content script, no host)', { detail: ui(['empty']) });
    await popup.click('#mode');
    await popup.waitForTimeout(250);
    await snap('baseline: browser internal page, mode list open', { broken: (m) => !m.list?.inside, detail: (m) => `list inside popup: ${m.list?.inside}` });
  });
  await scenario('baseline: one video', async () => {
    const t = await tab(WATCH);
    await openPopup(t);
    await snap('baseline: one video, off', { detail: ui(['states', 'legend']) });
    await popup.click('#mode');
    await popup.waitForTimeout(250);
    await snap('baseline: one video off, mode list open', { broken: (m) => !m.list?.inside, detail: (m) => `list inside popup: ${m.list?.inside}` });
    await popup.keyboard.press('Escape');
    // Loading: switched on from the popup, measured at once and again shortly after.
    await popup.click('#sources .source .meta');
    await snap('video state: just switched on (first repaint)', { detail: ui(['states', 'chips']) });
    await popup.waitForTimeout(150);
    await snap('video state: Starting… (150 ms after switching on)', { detail: ui(['states', 'chips', 'verdict']) });
    await until(async () => (await videosOf(t)).some((v) => v.status === 'Active' && v.stats), 25000);
    await popup.waitForTimeout(3000);
    await snap('baseline: one video, on and upscaling for 3 s (preset A, upscale auto)', { ref: 'video', detail: ui(['states', 'metas', 'tiles', 'legend', 'chips']) });
    for (const preset of ['B', 'C', 'AA', 'BB', 'CA']) {
      await popup.click(`[data-preset="${preset}"]`);
      await until(async () => (await videosOf(t)).some((v) => v.status === 'Active' && v.stats), 25000);
      await popup.waitForTimeout(1500);
      await snap(`one video on, preset ${preset}`, { detail: ui(['chips', 'tiles']) });
    }
    await popup.click('[data-field="darkenLines"]');
    await popup.click('[data-field="thinLines"]');
    await until(async () => (await videosOf(t)).some((v) => v.status === 'Active' && v.stats), 25000);
    await popup.waitForTimeout(1500);
    await snap('one video on, preset CA, darken lines + thin lines on', { detail: ui(['chips', 'tiles']) });
  });
  await scenario('baseline: reader', async () => {
    const two = addPage(`<!doctype html><title>Chainsaw Man Chapter 172 - MangaReader</title><body style="margin:0;background:#222">
      <div><img src="${imgBase}/colour.jpg"></div><div style="width:900px"><img src="${imgBase}/colour.jpg?g=1" style="width:100%"></div></body>`, { at: '/manga/chainsaw-man/chapter-172' });
    let t = await tab(two);
    await openPopup(t);
    await snap('baseline: reader, 2 pages, site off', { detail: ui(['states', 'names', 'mapCount']) });
    await popup.click('#manga-card');
    await snap('reader state: "● starting…" right after switching on', { detail: ui(['states']) });
    await until(async () => (await mangaOf(t))?.done === 2, 30000);
    await popup.waitForTimeout(1000);
    await snap('baseline: reader, 2 pages, on and finished', { detail: ui(['names', 'counts', 'mapCount', 'chips']) });
    await reset();
    const twelve = addPage(readerHtml({ title: '[Maraparte (Kojima Shoutarou)] Matsuri no Yoru ni (Black Clover)', n: 12, extra: '<div style="position:fixed;bottom:10px;left:10px;color:#fff"><span>1 / 12</span> <a href="/read/next">Next chapter</a></div>' }), { at: '/read/oneshot' });
    t = await tab(twelve);
    await openPopup(t);
    await snap('baseline: reader, 12 pages (one map row), site off', { detail: ui(['titles', 'names', 'mapCount']) });
    await mangaOn();
    await until(async () => (await mangaOf(t))?.done >= 3, 30000);
    await popup.waitForTimeout(1000);
    await snap('baseline: reader, 12 pages (one map row), on and upscaling', { ref: 'reader', detail: ui(['names', 'counts', 'mapCount', 'chips']) });
  });

  // =============================================================================================
  // Notices: update banner and rating card (real storage keys)
  // =============================================================================================
  await scenario('update banner on one video', async () => {
    const t = await watchOn();
    for (const v of ['1.2.6', '1.2.10', '10.20.30']) {
      await banner(v);
      await openPopup(t);
      await snap(`update banner v${v} + one video on`, { detail: ui(['states']) });
    }
    await banner('1.2.6');
    const off = await tab(WATCH);
    await sw.evaluate(async () => { await chrome.storage.local.remove('anime4k-sources'); });
    await popup.waitForTimeout(600);
    await openPopup(off);
    await snap('update banner + one video off');
  });
  await scenario('rate card levels on one video', async () => {
    const t = await watchOn();
    for (const level of [1, 2, 3, 4]) for (const clicked of [false, true]) {
      let tallest = null;
      const seen = new Set();
      for (let i = 0; i < 5; i += 1) {
        await rate(level, clicked);
        await openPopup(t, {}, 700);
        const m = await popup.evaluate(probe);
        seen.add(m.ui.rate);
        if (!tallest || m.parts.rate > tallest.parts.rate) tallest = m;
        if (m.texts.some((x) => x.sel.startsWith('#rate'))) break;
      }
      await popup.waitForTimeout(600);
      await snap(`rate card level ${level}${clicked ? ' with "already rated" button' : ''} + one video on`, { detail: (m) => `${ui(['rate'])(m)}; ${seen.size} copy variants seen in 5 opens, tallest card ${tallest.parts.rate}px` });
    }
  });
  await scenario('rate card with large totals', async () => {
    const t = await watchOn();
    for (const [label, over] of [['200 episodes · 120 h (level 4, days line)', { episodes: 200, seconds: 432000, shown: 3 }], ['12345 episodes · 10000 h', { episodes: 12345, seconds: 36000000, shown: 3 }]]) {
      let m;
      for (let i = 0; i < 6; i += 1) { // the lines are random picks: keep opening until the long pair shows, at most 6 times
        await rate(4, true, over);
        await openPopup(t, {}, 700);
        m = await popup.evaluate(probe);
        if (/days of sharper|senpai now/.test(m.ui.rate)) break;
      }
      await popup.waitForTimeout(600);
      await snap(`rate card, ${label}, "already rated" button + one video on`, { detail: ui(['rate']) });
    }
  });
  await scenario('banner and rate card together', async () => {
    const t = await watchOn();
    await banner(); await rate(3, true);
    await openPopup(t);
    await snap('update banner + rate card level 3 ("already rated") + one video on', { detail: ui(['rate']) });
    const b = await tab(BLOG);
    await banner(); await rate(3, true);
    await openPopup(b);
    await snap('update banner + rate card level 3 on a page without video', { detail: ui(['rate']) });
    await rate(3, true);
    await openPopup(b);
    await snap('rate card level 3 alone on a page without video');
    await banner();
    await sw.evaluate(async () => { await chrome.storage.local.remove('anime4k-rate'); });
    await openPopup(b);
    await snap('update banner alone on a page without video');
  });

  // =============================================================================================
  // Several videos
  // =============================================================================================
  const manyVideos = (n) => addPage(watchHtml({ title: 'Some Show Episode 3', videos: Array.from({ length: n }, (_, i) => video(`/v.mp4?n=${i}`, 300, 170)) }));
  await scenario('videos on one page: 2, 3, 4, 6 in the top frame', async () => {
    for (const n of [2, 3, 4, 6]) {
      const t = await tab(manyVideos(n));
      await openPopup(t);
      await snap(`${n} videos on one page, all off`, { detail: ui(['count']) });
      await enable(t, { want: (vs) => vs.filter((v) => v.status === 'Active' && v.stats).length >= 2 });
      await popup.waitForTimeout(SETTLE_MS);
      await snap(`${n} videos on one page, all on`, { detail: ui(['count', 'states', 'chips']) });
      await t.page.close();
      await sw.evaluate(async () => { await chrome.storage.local.remove('anime4k-sources'); });
    }
  });
  await scenario('two videos: main + preview', async () => {
    // The second video plays from a blob: URL, so it has a source key of its own and can be on or off by itself.
    const url = addPage(watchHtml({ videos: [video('/v.mp4', 640, 360), '<video id="b" muted autoplay loop playsinline style="width:320px;height:180px"></video>'],
      script: "fetch('/v.mp4').then((r) => r.blob()).then((b) => { document.getElementById('b').src = URL.createObjectURL(b); });" }));
    const t = await tab(url, 2000);
    await openPopup(t);
    await snap('two videos (main + small preview), both off', { detail: ui(['count', 'states']) });
    await enable(t, { pick: (v) => !v.key.endsWith('blob:') });
    await popup.waitForTimeout(SETTLE_MS);
    await snap('two videos, main on, preview off', { detail: ui(['states']) });
    await enable(t, { want: (vs) => vs.filter((v) => v.status === 'Active' && v.stats).length === 2 });
    await popup.waitForTimeout(SETTLE_MS);
    await snap('two videos, both on', { detail: ui(['states', 'chips']) });
    await banner();
    await openPopup(t);
    await snap('two videos, both on + update banner');
  });
  const frameVideo = (src, host = `127.0.0.2:${P2}`) => addPage(`<!doctype html><title>player</title><body style="margin:0;background:#000">${video(src, 300, 170)}</body>`, { host });
  let fiveVideos = null; // reused by the dropdown and tooltip scenarios
  await scenario('videos in iframes: 3 and 5 with mixed states', async () => {
    const top = (frames) => addPage(watchHtml({
      videos: [video('/v.mp4', 300, 170), '<video id="b" muted autoplay loop playsinline style="width:300px;height:170px"></video>',
        ...frames.map((f) => `<iframe src="${f}" style="width:300px;height:170px;border:0"></iframe>`)],
      script: "fetch('/v.mp4').then((r) => r.blob()).then((b) => { document.getElementById('b').src = URL.createObjectURL(b); });",
    }));
    const blocked = frameVideo(`${imgBase}/v.mp4`); // stream on another origin without CORS
    const mixed = async (frames, label) => {
      const t = await tab(top(frames), 2500);
      await enable(t, { pick: (v) => !v.key.endsWith('blob:'), want: (vs) => vs.some((v) => v.status === 'Active' && v.stats) && (!frames.includes(blocked) || vs.some((v) => v.status === 'Unavailable')) });
      const playing = t.page.frames().filter((f) => f.url().includes('/p/') && f !== t.page.mainFrame());
      if (playing.length > 1) await playing[1].evaluate(() => document.querySelector('video').pause()).catch(() => {});
      await openPopup(t);
      const want = (await videosOf(t)).length;
      await snap(label, { broken: (m) => m.parts.cards.length !== want, detail: (m) => `${m.parts.cards.length} cards for ${want} videos${m.parts.cards.length !== want ? ' (videos in frames of one host share a card: their ids are host#number)' : ''}; ${ui(['count', 'states'])(m)} side gaps ${m.sideGaps}` });
      return t;
    };
    await mixed([blocked], '3 videos (2 top frame, 1 iframe): one on, one off, one not possible');
    await mixed([blocked, frameVideo('/v.mp4?f=1'), frameVideo('/v.mp4?f=2')], '5 videos, the 3 iframes on ONE host');
    await mixed([frameVideo('/v.mp4?s=1', H1), frameVideo('/v.mp4?s=2', H1)], '4 videos: 2 top frame + 2 same-origin iframes');
    const frames5 = [blocked, frameVideo('/v.mp4?f=1', `p1.cdn.test:${P2}`), frameVideo('/v.mp4?f=2', `p2.cdn.test:${P2}`)];
    fiveVideos = top(frames5);
    await mixed(frames5, '5 videos (2 top frame, 3 iframes on 3 hosts): on, off, paused, not possible');
    await popup.evaluate(() => { document.body.scrollTop = document.body.scrollHeight; });
    await popup.waitForTimeout(300);
    await snap('5 videos, popup scrolled to the bottom', { noBottom: true, detail: (m) => `scrollTop ${m.ui.scrollTop}, side gaps left/right ${m.sideGaps}, body width ${m.bodyW}` });
    await tipRow('5 videos, scrolled to the bottom: tooltip of the 32× pill (flips above)', '[data-upscale="32x"]');
    await popup.evaluate(() => { document.body.scrollTop = 0; });
    await tipRow('5 videos: tooltip of an iframe video\'s info line (frame host and stream host)', '#sources .source:nth-child(3)');
  });

  // =============================================================================================
  // Long titles on a video page
  // =============================================================================================
  const T300 = words(300);
  const E300 = words(300, 'The Long Awaited Reunion At The Border Fortress Where Everything Finally Changes For Our Heroes ');
  const oneVideo = async (name, html, { detail = ui(['titleBox', 'tags', 'states']), host, at, opts } = {}) => {
    const t = await watchOn(addPage(html, { host, at }), opts);
    await openPopup(t);
    return [t, await snap(name, { detail })];
  };
  await scenario('long video titles', async () => {
    await oneVideo('video title: 300-char Media Session album + 300-char episode name (title and episode both wrap)',
      watchHtml({ title: T300, script: mediaSession({ title: E300, album: T300, artist: words(300, 'Studio Name Production Committee ') }) }));
    await oneVideo('video title: realistic long page title (95 chars)', watchHtml({ title: 'That Time I Got Reincarnated as a Slime: The Movie - Scarlet Bond Episode 12 - Watch Online Free' }));
    await oneVideo('video title: 190-char page title', watchHtml({ title: `${words(170)} Episode 12` }));
    await oneVideo('video title: long series + long episode name from Media Session',
      watchHtml({ title: 'Watch online', script: mediaSession({ album: words(110), title: words(120, 'The Long Awaited Reunion At The Border Fortress '), artist: 'Some Studio' }) }));
    const token = 'Some_Show_S01E05_1080p_x265_10bit_AAC_5.1_MultiSub_BluRay_Remux_HEVC_HDR10_DolbyVision_GroupName_ABCDEF12_final_v2_fixed.mkv';
    await oneVideo(`video title: one unbroken ${token.length}-char word (release file name)`, watchHtml({ title: token, script: mediaSession({ title: token }) }));
  });
  await scenario('long hostnames', async () => {
    const bare = `<!doctype html><meta charset="utf-8"><title></title><body style="margin:0;background:#000">${video()}</body>`;
    await oneVideo(`host name as title: dotted ${LONG_HOST.length + String(P1).length + 1}-char host (no break points)`, bare, { host: `${LONG_HOST}:${P1}`, at: '/', detail: ui(['titleBox', 'metas']) });
    await oneVideo('host name as title: long hyphenated host (wraps)', bare, { host: `${HYPHEN_HOST}:${P1}`, at: '/', detail: ui(['titleBox', 'metas']) });
  });
  await scenario('season and episode extremes', async () => {
    const ld = { '@context': 'https://schema.org', '@type': 'TVEpisode', name: E300, episodeNumber: 1234, partOfSeason: { '@type': 'TVSeason', seasonNumber: 12 }, partOfSeries: { '@type': 'TVSeries', name: T300 } };
    await oneVideo('JSON-LD: S12 E1234, 300-char series and 300-char episode name', watchHtml({ title: 'Watch', head: `<script type="application/ld+json">${JSON.stringify(ld)}</script>` }), { detail: ui(['titleBox', 'tags']) });
    await oneVideo('title only: "Show Season 10 Episode 1071 - <long name>"', watchHtml({ title: `Show Season 10 Episode 1071 - ${words(150, 'The Long Awaited Reunion At The Border Fortress ')}` }), { detail: ui(['titleBox', 'tags', 'names']) });
  });
  const SCRIPTS = [
    ['ASCII reference (60 chars)', 'That Time I Got Reincarnated as a Slime Second Season Part 2', 'That Time I Got Reincarnated as a Slime Second Part Chapter 12'],
    ['CJK (60 full-width chars)', `${'転生したらスライムだった件 第2期 '.repeat(4).slice(0, 60)}`, `${'転生したらスライムだった件'.repeat(4)} 第 12 話`],
    ['emoji with flags and ZWJ sequences', '👨‍👩‍👧‍👦 Family Adventure 🇯🇵🇰🇷🇺🇸 ✨🔥 Super Fun Time 🏳️‍🌈 🎌🎌🎌 👩‍🚀🧑‍🎤👨‍🍳 Best Moments', '👨‍👩‍👧‍👦 Family Adventure 🇯🇵🇰🇷🇺🇸 ✨🔥 Super Fun Time 🏳️‍🌈 🎌🎌🎌 Chapter 5'],
    ['Korean', '나 혼자만 레벨업 시즌 2 어라이즈 프롬 더 섀도우 완전판 특별편', '나 혼자만 레벨업 179화'],
    ['Arabic (RTL) mixed with Latin', 'هجوم العمالقة الموسم الأخير الجزء الثالث Attack on Titan الحلقة الخاصة S2 E5 مترجم اون لاين بجودة عالية', 'هجوم العمالقة الموسم الأخير الجزء الثالث Attack on Titan مترجم اون لاين Chapter 139'],
    ['Hebrew (RTL)', 'מתקפת הטיטאנים העונה האחרונה חלק שלישי S2 E5 פרק מיוחד עם כתוביות', 'מתקפת הטיטאנים העונה האחרונה Chapter 139'],
  ];
  await scenario('scripts: CJK, emoji, Korean, RTL titles', async () => {
    for (const [label, vTitle, mTitle] of SCRIPTS) {
      const t = await watchOn(addPage(watchHtml({ title: vTitle, head: label.startsWith('Arabic') ? '<meta property="og:site_name" content="أنمي العرب">' : '', script: mediaSession({ title: vTitle }) })));
      await openPopup(t);
      const used = await fontsOf('#sources .source .title');
      await snap(`video title in ${label}`, { detail: (m) => `${ui(['titleBox', 'tags'])(m)} fonts: ${used}` });
      await t.page.close();
      const r = await tab(reader(9, mTitle));
      await mangaOn();
      await until(async () => (await mangaOf(r))?.done >= 2, 20000);
      await openPopup(r);
      await snap(`reader series name in ${label}`, { detail: ui(['titleBox', 'tags']) });
      await r.page.close();
      await sw.evaluate(async () => { await chrome.storage.local.remove(['a4k-manga', 'anime4k-sources']); });
    }
  });

  // =============================================================================================
  // Status lines and the info line
  // =============================================================================================
  const unavailable = { want: (vs) => vs.some((v) => v.status === 'Unavailable') };
  await scenario('long failure reasons', async () => {
    await oneVideo('video state: cross-origin stream without CORS ("Not possible — …")', watchHtml({ videos: [video(`${imgBase}/v.mp4`)] }), { opts: unavailable, detail: ui(['states', 'metas', 'verdict']) });
    await oneVideo('video state: 2160p source ("Source is 2160p; up to 1440p…")', watchHtml({ videos: [video('/v2160.mp4', 960, 540)] }), { opts: unavailable, detail: ui(['states', 'metas']) });
    await oneVideo('video state: 2160p source + 300-char title and episode name',
      watchHtml({ title: T300, videos: [video('/v2160.mp4', 960, 540)], script: mediaSession({ title: E300, album: T300, artist: 'x' }) }), { opts: unavailable, detail: ui(['titleBox', 'states']) });
  });
  await scenario('info line with cap note', async () => {
    for (const [upscale, src, host, label] of [
      ['auto', '/v.mp4', H1, '360p, upscale auto, host 127.0.0.1'], ['32x', '/v1080.mp4', H1, '1080p, upscale 32×, host 127.0.0.1'],
      ['32x', '/v1080.mp4', `${SITE_HOST}:${P1}`, `1080p, upscale 32×, host ${SITE_HOST}`], ['32x', '/v.mp4', `${SITE_HOST}:${P1}`, `360p, upscale 32×, host ${SITE_HOST}`],
      ['16x', '/v.mp4', `${SITE_HOST}:${P1}`, `360p, upscale 16×, host ${SITE_HOST}`], ['8x', '/v.mp4', `${SITE_HOST}:${P1}`, `360p, upscale 8×, host ${SITE_HOST}`],
    ]) {
      await setSettings({ upscale, preset: 'A' });
      const t = await watchOn(addPage(watchHtml({ videos: [video(src, 960, 540)] }), { host }));
      await openPopup(t);
      await snap(`info line: ${label}`, { detail: ui(['metas', 'states']) });
      await t.page.close();
    }
  });
  await scenario('paused, waiting and hidden-tab states', async () => {
    let t = await watchOn();
    await popup.waitForTimeout(3000);
    await t.page.evaluate(() => document.querySelector('video').pause());
    await openPopup(t);
    await snap('video state: paused after 3 s (graph kept, legend "… · last run")', { detail: (m) => `${ui(['states', 'legend', 'tiles'])(m)} legend height ${m.parts.legend}px` });
    await t.page.close();
    t = await tab(addPage(watchHtml({ videos: ['<video muted playsinline style="width:640px;height:360px;background:#123"></video>'] })));
    const vs = await enable(t, { want: (l) => l.some((v) => v.status === 'Waiting'), timeout: 6000 }).catch(() => null);
    await openPopup(t);
    await snap(`video state: switched on with no source yet (${vs ? 'Waiting' : 'page reported no video'})`, { detail: ui(['states', 'metas', 'legend']) });
    await t.page.close();
    // Suspended: the video is scrolled out of view (same card text as picture-in-picture, fullscreen or a hidden tab).
    t = await watchOn(addPage(watchHtml({ videos: [video(), '<div style="height:4000px"></div>'] })));
    await t.page.evaluate(() => scrollTo(0, 3000));
    const sus = await until(async () => (await videosOf(t)).some((v) => v.status === 'Suspended'), 8000);
    await openPopup(t);
    await snap(`video state: Suspended, video scrolled out of view (${sus ? 'real' : 'state not reached'})`, { detail: ui(['states', 'legend', 'tiles']) });
  });

  // =============================================================================================
  // Heavy load: performance tiles, graph, header chips
  // =============================================================================================
  const HEAVY = { preset: 'CA', upscale: '32x', darkenLines: true, thinLines: true };
  const graph = (m) => `${ui(['tiles', 'verdict', 'chips', 'legend', 'metas'])(m)} bars ${m.ui.barsH}px tall, ${m.ui.over} of 48 red, limit line at ${m.ui.limit}`;
  await scenario('heavy GPU load', async () => {
    await setSettings(HEAVY);
    const heavy = addPage(watchHtml({ videos: [video('/v1440.mp4', 960, 540)] }));
    const t = await watchOn(heavy, { timeout: 40000 });
    await popup.waitForTimeout(5000);
    await openPopup(t);
    await snap('heavy: real 1440p60 video, preset C+A, 32×, darken + thin lines, after 5 s', { detail: graph });
    const alt = Array.from({ length: 48 }, (_, i) => (i % 2 ? 950 : 2));
    await openPopup(t, { stats: { samples: alt, gpuMs: 123.4, fps: 144, sourceFps: 23.976, outputWidth: 7680, outputHeight: 4320 }, video: { sourceFps: 23.976, playing: true } });
    await snap('[stub] heavy graph: bars alternate 2 and 950 ms, gpu 123.4 ms, 144 fps, output 7680×4320', { detail: graph });
    await openPopup(t, { stats: { samples: Array.from({ length: 48 }, (_, i) => 1100 + i * 3), gpuMs: 208.4, fps: 4, sourceFps: 60, outputWidth: 7680, outputHeight: 4320 }, video: { sourceFps: 60, playing: true } });
    await snap('[stub] heavy graph: every bar late (1100 to 1241 ms), gpu 208.4 ms at 60 fps: "1250%", "1171 · 1241"', { detail: graph });
    await openPopup(t, { stats: { samples: Array.from({ length: 48 }, () => 9999), gpuMs: 9999.9, fps: 1, sourceFps: 144, outputWidth: 15360, outputHeight: 8640 }, video: { sourceFps: 144, playing: true } });
    await snap('[stub] widest figures: 9999.9 ms at 144 fps: "144000%", "9999 · 9999", output 15360×8640', { detail: graph });
    await t.page.close();
    const three = await tab(addPage(watchHtml({ videos: [0, 1, 2].map((i) => video(`/v1440.mp4?n=${i}`, 320, 180)) })));
    await enable(three, { timeout: 40000 });
    await popup.waitForTimeout(3000);
    await openPopup(three);
    await snap('heavy: three real 1440p60 videos on (chip shows the sum)', { detail: graph });
    await openPopup(three, { stats: { gpuMs: 416.8, samples: alt, fps: 20, sourceFps: 60 }, video: { status: 'Active', playing: true, enabled: true, sourceFps: 60 } });
    await snap('[stub] three videos at 416.8 ms each: chip "gpu 1250.4 ms"', { detail: graph });
  });
  await scenario('no GPU timer tiles', async () => {
    const t = await watchOn();
    await openPopup(t, { stats: { timerSupported: false, gpuMs: null, passes: 12, textureBytes: 1.9e9, fps: 23, sourceFps: 24, samples: [] }, video: { sourceFps: 24 } });
    await snap('[stub] no GPU timer (Firefox-style tiles): "Passes · VRAM" = "12 · 1812 MB", bars hidden', { detail: (m) => `${ui(['labels', 'tiles', 'legend', 'chips'])(m)} bars ${m.ui.barsH}px` });
    await openPopup(t, { stats: { timerSupported: false, gpuMs: null, passes: 128, textureBytes: 1.6e10, fps: 143, sourceFps: 144, samples: [] }, video: { sourceFps: 144 } });
    await snap('[stub] no GPU timer, widest: "128 · 15259 MB", 144 fps', { detail: ui(['labels', 'tiles', 'chips']) });
  });

  // =============================================================================================
  // Manga reader
  // =============================================================================================
  const mapInfo = (m) => `${ui(['mapClass', 'cells', 'mapCount', 'blocks', 'shares', 'counts', 'chips'])(m)} map ${m.parts.grid}px, smallest bar block ${m.ui.minBlock === 999 ? 'n/a' : Math.round(m.ui.minBlock * 10) / 10}px`;
  await scenario('reader page counts (real pages)', async () => {
    for (const n of [1, 12, 13, 24, 25, 36, 37, 80, 81]) {
      const t = await tab(reader(n, 'Chainsaw Man Chapter 172 - MangaReader', n === 1 ? { img: 'colour.jpg' } : {}), 1500);
      await openPopup(t);
      await snap(`reader, ${n} page${n === 1 ? '' : 's'} (real), site off`, { detail: mapInfo });
      await mangaOn();
      await until(async () => (await mangaOf(t))?.done >= 1, 20000);
      await popup.waitForTimeout(SETTLE_MS);
      await snap(`reader, ${n} page${n === 1 ? '' : 's'} (real), on and upscaling`, { detail: mapInfo });
      await t.page.close();
      await sw.evaluate(async () => { await chrome.storage.local.remove('a4k-manga'); });
    }
    for (const n of [300, 1000]) {
      // The chapter length comes from the reader's own page counter; 12 pages are on the page.
      const t = await tab(reader(12, 'Chainsaw Man Chapter 172 - MangaReader', { extra: `<div style="position:fixed;bottom:10px;left:10px;color:#fff"><span>1 / ${n}</span></div>` }), 1500);
      await mangaOn();
      await until(async () => (await mangaOf(t))?.done >= 1, 20000);
      await openPopup(t);
      await snap(`reader, ${n}-page chapter from the page counter (real), on`, { detail: mapInfo });
      await popup.evaluate(() => { const g = document.getElementById('pmap-grid'); g.scrollTop = g.scrollHeight; });
      await popup.waitForTimeout(200);
      await snap(`reader, ${n}-page chapter, page map scrolled to its last row (cell "${n}")`, { detail: mapInfo, noBottom: true });
      await t.page.close();
      await sw.evaluate(async () => { await chrome.storage.local.remove('a4k-manga'); });
    }
  });
  let chapterTab = null;
  await scenario('reader long chapter [stub]', async () => {
    const t = await tab(reader(9));
    await mangaOn();
    for (const n of [12, 13, 24, 25, 36, 37, 80, 81, 200, 1000]) {
      await openPopup(t, { chapter: n });
      await snap(`[stub] reader running, ${n}-page chapter (done / active / failed / queued)`, { detail: mapInfo });
    }
    await openPopup(t, { chapter: 2000, manga: { marks: Array.from({ length: 2000 }, (_, i) => (i % 2 ? 'fail' : 'done')), done: 1000, failed: 1000, loading: 0 } });
    await snap('[stub] reader, 2000 pages, counts 1000 / 0 / 1000 / 0 (4-digit numbers in every box)', { detail: mapInfo });
    await banner();
    await openPopup(t, { chapter: 48 });
    await snap('[stub] reader running, 48 pages + update banner', { detail: mapInfo });
    await rate(2, true);
    await openPopup(t, { chapter: 48 });
    await snap('[stub] reader running, 48 pages + rate card level 2 ("already rated")');
    await banner(); await rate(2, true);
    await openPopup(t, { chapter: 48 });
    await snap('[stub] reader running, 48 pages + update banner + rate card');
    await sw.evaluate(async () => { await chrome.storage.local.remove('anime4k-rate'); });
    for (const [w, hh] of [[5000, 7000], [10000, 14000]]) {
      await openPopup(t, { chapter: 200, manga: { size: { w, h: hh }, grey: false, perPageMs: 12345, pageMs: 65000, done: 150, imageHost: `${STREAM_HOST}:${P2}` } });
      await snap(`[stub] reader, 200 pages of ${w}×${hh}, 65 s per page`, { detail: (m) => `${ui(['names', 'tiles', 'chips'])(m)}` });
      await tipRow(`[stub] tooltip of the card line: sizes and a ${STREAM_HOST.length + 6}-char image host`, '#manga-name');
    }
    await openPopup(t, { chapter: 48, manga: { lastError: `Failed to fetch https://${STREAM_HOST}/chapters/0172/pages/${'0123456789abcdef'.repeat(6)}.webp: net::ERR_CONNECTION_RESET`.slice(0, 200) } });
    await tipRow('[stub] tooltip of "failed": last error of 200 chars with a long URL', '.mc-counts [data-k="fail"]');
    await tipRow('tooltip of the last page-map cell (right edge)', '#pmap-grid .pcell:last-child');
    await tipRow('tooltip of the manga title ("Detected: …")', '#manga-title');
    await tipRow('tooltip of the report (bug) chip, top right', '#report');
    await tipRow('tooltip of the mode chip by keyboard focus', '#mode', { focus: true });
    chapterTab = true;
  });
  const SERIES_LONG = 'The Reincarnated Aristocrat Who Was Exiled Uses His Appraisal Skill To Rise In The World And Build The Strongest Territory';
  await scenario('reader long series names', async () => {
    const run = async (label, title, n = 12, opts = {}) => {
      const t = await tab(reader(n, title, opts), 1500);
      await openPopup(t);
      await snap(`${label}, site off`, { detail: ui(['titleBox', 'tags', 'names', 'states']) });
      await popup.click('#manga-card');
      await snap(`${label}, "starting…" right after switching on`, { detail: ui(['titleBox', 'states']) });
      await until(async () => (await mangaOf(t))?.done >= 2, 20000);
      await popup.waitForTimeout(SETTLE_MS);
      await snap(`${label}, on and upscaling`, { detail: ui(['titleBox', 'tags', 'names', 'counts']) });
      await t.page.close();
      await sw.evaluate(async () => { await chrome.storage.local.remove('a4k-manga'); });
    };
    await run('reader: short series name (reference), 12 pages', 'Chainsaw Man Chapter 281: The Reunion - MangaReader');
    await run('reader: 280-char series name + chapter title, 12 pages', `${words(280)} Chapter 281: The Long Awaited Reunion At The Border Fortress`);
    await run('reader: realistic long series, "Vol. 12 Chapter 172.5: <title>", 30 pages', `${SERIES_LONG} Vol. 12 Chapter 172.5: The Long Awaited Reunion At The Border Fortress - MangaReader`, 30);
    await run('reader: long doujinshi title "[Circle (Artist)] <title> (Parody)"', `[Some Very Long Circle Name (Artist One, Artist Two)] ${words(150, 'Matsuri no Yoru ni Kimi to Futari de Hanabi wo Miageta Ano Natsu no Hi ')} (Black Clover)`, 12,
      { at: '/read/doujin-long', extra: '<div style="position:fixed;bottom:10px;left:10px;color:#fff"><span>1 / 12</span> <a href="/read/next">Next chapter</a></div>' });
  });
  await scenario('reader chapter tag extremes', async () => {
    const slug = 'volume-12-chapter-104-the-very-long-arc-name-part-two-of-three';
    let t = await tab(reader(9, 'Reader', { at: `/read?chapter=${slug}` }), 1500);
    await openPopup(t);
    await snap(`reader: chapter from the URL query, a ${slug.length}-char slug as the tag`, { detail: ui(['titles', 'tags', 'names']) });
    await mangaOn();
    await until(async () => (await mangaOf(t))?.done >= 2, 20000);
    await popup.waitForTimeout(SETTLE_MS);
    await snap('reader: long chapter slug as the tag, on and upscaling', { detail: ui(['tags', 'names', 'counts']) });
    await t.page.close();
    t = await tab(reader(9, 'Series Vol.123 Ch.1234.5'), 1500);
    await openPopup(t);
    await snap('reader: "Series Vol.123 Ch.1234.5" (tag "vol 123 · ch 1234.5")', { detail: ui(['titles', 'tags', 'names']) });
  });
  const canvasReader = (title) => addPage(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="margin:0;background:#000"><div style="width:800px">
    ${[0, 1, 2].map(() => '<canvas width="1080" height="1620" style="width:800px;display:block"></canvas>').join('')}</div>
    <script>for (const c of document.querySelectorAll('canvas')) { const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1080, 1620); g.fillStyle = '#000'; g.font = 'bold 120px sans-serif'; g.fillText('PAGE', 200, 400); }</script></body>`,
  { at: `/viewer/${++pageNo}` });
  await scenario('reader state lines: stale and canvas', async () => {
    for (const [label, title] of [['short series name', 'Chainsaw Man Chapter 172 - MangaReader'], ['long series name', `${SERIES_LONG} Chapter 172 - MangaReader`]]) {
      let t = await tab(reader(30, title), 1500);
      await openPopup(t, { stale: true });
      await snap(`[stub] reader state: page script from before an update ("reload this page to finish"), ${label}, 30 pages`, { detail: ui(['states', 'titleBox']) });
      await t.page.close();
      t = await tab(canvasReader(title), 1500);
      await openPopup(t);
      await snap(`reader state: pages drawn on a canvas (not supported), ${label}`, { detail: ui(['states', 'titleBox', 'names', 'legend']) });
      await t.page.close();
    }
  });
  await scenario('reader failed pages and big pages', async () => {
    // Half the pages can be shown but not fetched again (the upscaler's download fails); one is over the size limit.
    const t = await tab(reader(12, 'Broken Scans Chapter 7 - MangaReader', { src: (i) => (i === 0 ? `${imgBase}/huge.jpg` : `${imgBase}/pg.jpg?p=${i}${i % 2 ? '&once=1' : ''}`),
      extra: '<div style="position:fixed;bottom:10px;left:10px;color:#fff"><span>1 / 300</span></div>' }), 2500);
    await mangaOn();
    const st = await until(async () => { const s = await mangaOf(t); return s?.failed >= 2 ? s : null; }, 25000);
    await openPopup(t);
    await snap(`reader with failed pages (real: ${st ? `${st.failed} failed, last error "${st.lastError}"` : 'no page failed in time'}), 300-page chapter`, { detail: mapInfo });
    await tipRow('tooltip of "failed" (real last error)', '.mc-counts [data-k="fail"]');
    await tipRow('tooltip of the manga title (real detection reasons)', '#manga-title');
    await t.page.close();
    await sw.evaluate(async () => { await chrome.storage.local.remove('a4k-manga'); });
    const toon = await tab(reader(3, 'Tall Toon Episode 45 - Webtoons', { img: 'toon.jpg', imgHost: `http://${STREAM_HOST}:${P2}`, at: '/webtoon/tall-toon/episode-45' }), 2500);
    await mangaOn();
    const ts = await until(async () => { const s = await mangaOf(toon); return s && (s.done >= 1 || s.failed >= 1) ? s : null; }, 40000);
    await openPopup(toon);
    await snap(`reader: webtoon strips 800×12000 from a ${STREAM_HOST.length + 6}-char image host (real: ${ts ? `${ts.done} done, ${ts.failed} failed${ts.lastError ? `, "${ts.lastError}"` : ''}` : 'nothing finished in time'})`, { detail: ui(['names', 'tags', 'chips']) });
    await tipRow('tooltip of the card line: real sizes and the long image host', '#manga-name');
  });

  // =============================================================================================
  // Reader and video on one page; mode suggestion
  // =============================================================================================
  const mixedPage = (title = 'Chainsaw Man Chapter 172 - MangaReader', n = 9, at) => addPage(readerHtml({ title, n, extra: video('/v.mp4', 640, 360) }), { at: at ?? `/manga/mixed-${++pageNo}/chapter-172` });
  const mixInfo = ui(['states', 'chips', 'count', 'mapCount']);
  await scenario('reader plus video on one page', async () => {
    const t = await tab(mixedPage(), 1500);
    await openPopup(t);
    await snap('reader (9 pages) + video, mode auto: both off', { detail: mixInfo });
    await mangaOn();
    await until(async () => (await mangaOf(t))?.done >= 2, 20000);
    await popup.waitForTimeout(SETTLE_MS);
    await snap('reader + video, mode auto: manga on, video off', { detail: mixInfo });
    await popup.click('#sources .source .switch'); // the card is compact beside a reader: its switch flips it
    await popup.waitForTimeout(150);
    await snap('reader + video, mode auto: video starting', { detail: mixInfo });
    await until(async () => (await videosOf(t)).some((v) => v.status === 'Active' && v.stats), 25000);
    await popup.waitForTimeout(2500);
    await snap('reader + video, mode auto: both running', { detail: mixInfo });
    await setSettings({ mode: 'manga' });
    await popup.waitForTimeout(SETTLE_MS);
    await snap('reader + video, mode manga: video card "Paused: manga mode", manga running', { detail: mixInfo });
    await setSettings({ mode: 'anime' });
    await until(async () => (await videosOf(t)).some((v) => v.status === 'Active' && v.stats), 25000);
    await popup.waitForTimeout(SETTLE_MS);
    await snap('reader + video, mode anime: suggestion preview above the running video card', { detail: mixInfo });
    await popup.click('#mp-go');
    await popup.waitForTimeout(700);
    await snap('reader + video: "now in manga mode" confirmation showing (first 4 s after the switch)', { detail: mixInfo });
    await popup.waitForTimeout(4200);
    await snap('reader + video: after the confirmation (mode manga)', { detail: mixInfo });
  });
  await scenario('worst stack: reader + video + rate card + banner', async () => {
    const t = await tab(mixedPage('Long Series Chapter 12 - MangaReader', 30, '/manga/long-series/chapter-12'), 1500);
    await mangaOn();
    await enable(t);
    await until(async () => (await mangaOf(t))?.done >= 2, 20000);
    await banner('9.9.9');
    await setLocal({ 'anime4k-rate': { seconds: 36000, episodes: 12, shown: 0, clicked: true, rated: false, returning: false } });
    await openPopup(t);
    await snap('worst stack: update banner + rate card ("already rated") + video on + reader 30 pages on', { detail: mixInfo });
    const long = await tab(mixedPage(`${SERIES_LONG} Chapter 172 - MangaReader`, 30), 1500);
    await until(async () => (await mangaOf(long))?.done >= 2, 20000);
    await banner('9.9.9');
    await openPopup(long);
    await snap('worst stack + long series name (title wraps in both cards)', { detail: ui(['titleBox', 'states']) });
  });
  await scenario('mode manga on a video page (preview)', async () => {
    await setSettings({ mode: 'manga' });
    let t = await tab(WATCH);
    await enable(t, { want: (vs) => vs.some((v) => v.status === 'Suspended'), timeout: 8000 });
    await openPopup(t);
    await snap('mode manga on a video page: preview stands in for the card', { detail: mixInfo });
    await popup.focus('#mp-go');
    await popup.keyboard.press('Escape');
    await popup.waitForTimeout(SETTLE_MS);
    await snap('mode manga on a video page, after Esc: the paused card is back', { detail: mixInfo });
    await t.page.close();
    t = await tab(addPage(watchHtml({ title: `${words(170)} Episode 12` })));
    await openPopup(t);
    await snap('mode manga on a video page: preview with a 190-char title', { detail: ui(['titleBox', 'names']) });
    await t.page.close();
    t = await tab(addPage(watchHtml({ title: T300, script: mediaSession({ title: E300, album: T300, artist: 'x' }), videos: [video('/v.mp4?n=1', 480, 270), video('/v.mp4?n=2', 480, 270)] })));
    await openPopup(t);
    await snap('mode manga, 2 videos, 300-char Media Session title: preview only', { detail: ui(['titleBox', 'count']) });
    await popup.focus('#mp-go');
    await popup.keyboard.press('Escape');
    await popup.waitForTimeout(SETTLE_MS);
    await snap('mode manga, 2 videos, 300-char title, after Esc: two paused cards', { detail: ui(['titleBox', 'states']) });
    await t.page.close();
    t = await tab(manyVideos(2));
    await openPopup(t);
    await popup.focus('#mp-go');
    await popup.keyboard.press('Escape');
    await popup.waitForTimeout(SETTLE_MS);
    await snap('mode manga, 2 videos, short title, after Esc: two paused cards', { detail: mixInfo });
  });
  await scenario('mode anime on a reader page (preview)', async () => {
    await setSettings({ mode: 'anime' });
    let t = await tab(reader(9), 1500);
    await openPopup(t);
    await snap('mode anime on a reader page: preview only, performance "no video", upscale row back', { detail: ui(['titleBox', 'names', 'legend']) });
    await popup.click('#mp-auto');
    await popup.waitForTimeout(700);
    await snap('mode anime on a reader page: "use auto" pressed, confirmation showing', { detail: mixInfo });
    await popup.waitForTimeout(4200);
    await snap('reader page after "use auto" (confirmation gone)', { detail: mixInfo });
    await t.page.close();
    await setSettings({ mode: 'anime' });
    t = await tab(reader(30, `${words(280)} Chapter 281: The Long Awaited Reunion At The Border Fortress`), 1500);
    await openPopup(t);
    await snap('mode anime on a reader page: preview with a 280-char series name', { detail: ui(['titleBox', 'names']) });
    await popup.click('#mp-go');
    await popup.waitForTimeout(700);
    await snap('280-char series: "switch to manga" pressed, confirmation showing', { detail: ui(['titleBox', 'states']) });
  });

  // =============================================================================================
  // Mode list and tooltips on tall popups
  // =============================================================================================
  await scenario('mode list on tall popups', async () => {
    if (!fiveVideos) throw new Error('the five-video page was not built (its scenario did not run)');
    const t = await tab(fiveVideos, 2500);
    await openPopup(t);
    const before = await popup.evaluate(() => document.body.scrollHeight);
    await popup.click('#mode');
    await popup.waitForTimeout(250);
    await snap('5 videos: mode list open at the top', { noBottom: true, broken: (m) => !m.list?.inside || m.height !== before, detail: (m) => `list inside popup: ${m.list?.inside}, height ${before} -> ${m.height}` });
    await popup.keyboard.press('Escape');
    await popup.evaluate(() => { document.body.scrollTop = document.body.scrollHeight; });
    await popup.waitForTimeout(200);
    await popup.evaluate(() => document.getElementById('mode').focus({ preventScroll: true }));
    await popup.keyboard.press('ArrowDown');
    await popup.waitForTimeout(250);
    await snap('5 videos, scrolled to the bottom: mode list opened by keyboard', { noBottom: true, broken: (m) => !m.list?.inside, detail: (m) => `list on screen: ${m.list?.inside} (list top at ${m.list?.top}px, popup scrollTop ${m.ui.scrollTop}), height ${before} -> ${m.height}` });
    await popup.keyboard.press('Escape');
    const b = await tab(BLOG);
    await banner(); await rate(3, true);
    await openPopup(b);
    await popup.click('#mode');
    await popup.waitForTimeout(250);
    await snap('blog + banner + rate card: mode list open', { broken: (m) => !m.list?.inside, detail: (m) => `list inside popup: ${m.list?.inside}` });
  });
  await scenario('tooltips with long host names', async () => {
    const frame = addPage(`<!doctype html><title>player</title><body style="margin:0;background:#000">${video(`http://${STREAM_HOST}:${P2}/v.mp4?cors=1`, 640, 360)}</body>`, { host: `${PLAYER_HOST}:${P2}` });
    const t = await tab(addPage(watchHtml({ videos: [`<iframe src="${frame}" style="width:640px;height:360px;border:0"></iframe>`] })), 2500);
    const vs = await enable(t, { want: (l) => l.some((v) => v.status === 'Active' || v.status === 'Unavailable'), timeout: 15000 });
    await openPopup(t);
    await snap(`video in a cross-origin iframe, stream from a ${STREAM_HOST.length + 6}-char host (real state: ${vs?.[0]?.status ?? 'unknown'})`, { detail: ui(['states', 'metas']) });
    await tipRow('tooltip of the info line: "player frame: <host> · stream: <long host>"', '#sources .source .meta');
    await tipRow('tooltip of the 32× pill (bottom right, 94 chars)', '[data-upscale="32x"]');
    await tipRow('tooltip of the 32× pill by keyboard focus', '[data-upscale="32x"]', { focus: true });
  });

  // =============================================================================================
  // Smaller popup box (browser zoom 125 %): an approximation, see the summary
  // =============================================================================================
  await scenario('popup at browser zoom 125 % (approximation)', async () => {
    const targets = [['no video', await tab(BLOG)], ['one video on', await watchOn()], ['reader 12 pages', await tab(reader(12), 1500)]];
    const box = (m) => `viewport ${m.view.join('×')}, body ${m.clientH}px tall, body bottom at ${m.bodyBottom}px, body right at ${m.bodyRight}px, document scrollable: ${m.docScrollsV}, cut off below: ${Math.max(0, Math.round(m.bodyBottom - m.view[1]))}px, cut off right: ${Math.max(0, Math.round(m.bodyRight - m.view[0]))}px`;
    for (const [w, hh] of [[POPUP_W, 480], [304, 480]]) {
      await popup.setViewportSize({ width: w, height: hh });
      for (const [label, t] of targets) {
        await t.page.bringToFront();
        await openPopup(t);
        await snap(`[approximation] ${label} in a ${w}×${hh} box (popup at zoom 125 %)`, { broken: (m) => m.bodyBottom > m.view[1] + 0.5 || m.bodyRight > m.view[0] + 0.5, noBottom: true, detail: box });
      }
    }
    await popup.setViewportSize({ width: POPUP_W, height: POPUP_MAX });
    const [, t] = targets[1];
    await t.page.bringToFront();
    await openPopup(t);
    const zoom = await sw.evaluate(async (ext) => {
      const p = (await chrome.tabs.query({})).find((x) => x.url?.startsWith(`chrome-extension://${ext}/popup.html`));
      if (!p) return 'popup tab not found';
      try { await chrome.tabs.setZoomSettings(p.id, { scope: 'per-tab' }); await chrome.tabs.setZoom(p.id, 1.25); return `zoom ${await chrome.tabs.getZoom(p.id)}`; } catch (e) { return `refused: ${e.message}`; }
    }, extId);
    await popup.waitForTimeout(800);
    await snap(`[approximation] one video on, chrome.tabs.setZoom(1.25) on the popup tab (${zoom})`, { broken: (m) => m.bodyBottom > m.view[1] + 0.5, noBottom: true, detail: box });
    await sw.evaluate(async (ext) => {
      const p = (await chrome.tabs.query({})).find((x) => x.url?.startsWith(`chrome-extension://${ext}/popup.html`));
      if (p) await chrome.tabs.setZoom(p.id, 1).catch(() => {});
    }, extId);
  });

  if (popupErrors.length) console.log(`INFO uncaught errors in the popup: ${[...new Set(popupErrors)].join(' | ')}`);
  void chapterTab;
} finally {
  await ctx.close();
  pages.close(); images.close(); second.close();
}

notRun.push(
  'Suspended through real picture-in-picture, native fullscreen or a hidden tab: PiP and fullscreen would put a visible window on the screen, and Playwright keeps every tab "visible"; the same card text was produced with a video scrolled out of view.',
  'Stale page script through a real extension reload (chrome.runtime.reload closes the popup and the test connection): the old reply shape is stubbed in the popup, as manga-e2e.mjs does.',
  'Exact browser zoom / Windows text scaling of a real toolbar popup: a popup in a tab has no 600px cap of its own; run as a smaller viewport and as chrome.tabs.setZoom, both marked [approximation].',
  'Heavy-load figures such as "1250%" on this GPU: the real 1440p60 run is reported as measured; the extreme values are [stub] replies.',
);

// --- report -------------------------------------------------------------------------------------
const ran = rows.filter((r) => r.ran).sort((a, b) => b.contentHeight - a.contentHeight);
console.log(`\n${'height'.padEnd(7)} ${'scrollbar'.padEnd(9)} ${'sideways'.padEnd(8)} scenario`);
for (const r of ran) console.log(`${String(r.contentHeight).padEnd(7)} ${(r.scrollsVertically ? 'YES' : 'no').padEnd(9)} ${(r.scrollsSideways ? 'YES' : 'no').padEnd(8)} ${r.scenario}`);
for (const r of rows.filter((x) => !x.ran)) console.log(`not run ${r.scenario}: ${r.cause}`);
console.log(`\n${ran.length} measured, ${ran.filter((r) => r.scrollsVertically).length} with a scrollbar, ${ran.filter((r) => r.scrollsSideways).length} with sideways overflow, ${rows.length - ran.length} not run`);
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ fonts, rows, notRun }, null, 2));
process.exit(0);

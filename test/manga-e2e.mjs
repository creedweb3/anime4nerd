// End-to-end check of manga mode (local prototype) in a real Chromium browser with the built
// extension. A reader page shows two page images from another origin (no CORS headers, so the
// background fetch path runs) plus a small icon that must be left alone; a blog page on the same
// site has portrait photos and must never be touched (the detection safety stop).
//
// Needs ffmpeg on PATH, Playwright (global or local), Brave/Chrome/Edge, and a fresh `npm run build`.
//
//   node test/manga-e2e.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" [screenshot dir]

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const [exe, shots] = process.argv.slice(2);
if (!exe) { console.error('usage: node test/manga-e2e.mjs <path to Brave/Chrome/Edge> [screenshot dir]'); process.exit(2); }

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const { chromium } = loadPlaywright();

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-manga-'));
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=900x1300', '-frames:v', '1', '-q:v', '4', path.join(work, 'colour.jpg')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=900x1300', '-frames:v', '1', '-vf', 'format=gray', '-q:v', '4', path.join(work, 'grey.jpg')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=3400x4900', '-frames:v', '1', '-q:v', '12', path.join(work, 'huge.jpg')]); // 16.7 megapixels
ff(['-f', 'lavfi', '-i', 'testsrc2=size=64x64', '-frames:v', '1', path.join(work, 'icon.png')]);

const serve = (handler) => new Promise((ok) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => ok(s)); });
let blindHits = 0; // requests that must never be made
let swapHits = 0;
const images = await serve((req, res) => {
  if (req.url.startsWith('/nothing')) { res.writeHead(204).end(); return; }
  if (req.url.includes('blind=1')) blindHits++;
  const to = (url) => res.writeHead(302, { Location: url }).end();
  if (req.url.startsWith('/to-local')) return to(`http://127.0.0.2:${images2.address().port}/colour.jpg?blind=1`);
  if (req.url.startsWith('/to-trick')) return to(`http://trick.mangatest.example:${images2.address().port}/colour.jpg`);
  if (req.url.startsWith('/to-ok')) return to(`http://same.mangatest.example:${images.address().port}/colour.jpg#frag`);
  if (req.url.startsWith('/loop')) return to('/loop');
  if (req.url.startsWith('/slow')) { setTimeout(() => res.writeHead(404).end(), 4000); return; }
  // The page shows a normal image; whoever fetches the same URL again gets a huge one.
  if (req.url.startsWith('/swap.jpg')) req.url = swapHits++ ? '/huge.jpg' : '/colour.jpg';
  const file = path.join(work, path.basename(req.url.split('?')[0]));
  if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.png') ? 'image/png' : 'image/jpeg' }); // no CORS headers on purpose
  fs.createReadStream(file).pipe(res);
});
const imgBase = `http://127.0.0.1:${images.address().port}`;
// The same files on a second loopback address, for the DNS trick check.
const images2 = await new Promise((ok) => { const srv = http.createServer((req, res) => images.emit('request', req, res)).listen(0, '127.0.0.2', () => ok(srv)); });
const pages = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.url.startsWith('/read')) {
    // A reader with no chapter number: a doujinshi title, reader controls, a page counter, and
    // most pages lazy-loaded far below (built-in loading="lazy").
    const lazy = Array.from({ length: 6 }, (_, i) => `<img class="pg" loading="lazy" src="${imgBase}/colour.jpg?p=${i + 3}" style="width:800px;display:block">`).join('');
    res.end(`<!doctype html><title>[Maraparte (Kojima Shoutarou)] Matsuri no Yoru ni (Black Clover)</title><body style="margin:0;background:#111">
      <div style="width:800px">
        <img class="pg" src="${imgBase}/colour.jpg?p=1" style="width:800px;display:block"><img class="pg" src="${imgBase}/colour.jpg?p=2" style="width:800px;display:block">
        <div style="height:30000px"></div>${lazy}
      </div>
      <div style="position:fixed;bottom:10px;left:10px;color:#fff"><span>1 / 12</span> <a href="/read/next">Next chapter</a></div></body>`);
    return;
  }
  if (req.url.startsWith('/viewer')) {
    // Like MANGA Plus: pages are made in the page and shown from blob: URLs revoked right after loading.
    res.end(`<!doctype html><title>[#001] Haikyu!! | MANGA Plus</title><body style="margin:0;background:#000">
      <h1>Haikyu!!</h1><div id="pages" style="width:800px"></div>
      <script>
        for (let i = 0; i < 3; i++) {
          const c = document.createElement('canvas'); c.width = 1080; c.height = 1620;
          const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1080, 1620);
          g.fillStyle = '#000'; g.font = 'bold 120px sans-serif'; g.fillText('PAGE ' + (i + 1), 200, 400);
          for (let y = 600; y < 1500; y += 9) for (let x = 60; x < 1020; x += 9) { g.beginPath(); g.arc(x, y, 2.5, 0, 7); g.fill(); }
          c.toBlob((b) => {
            const img = document.createElement('img'); img.className = 'zao-image'; img.id = 'm' + i; img.style.width = '100%';
            const url = URL.createObjectURL(b);
            img.onload = () => URL.revokeObjectURL(url); // the site drops its own URL
            img.src = url;
            document.getElementById('pages').append(img);
          }, 'image/png');
        }
      </script></body>`);
    return;
  }
  if (req.url.includes('/swap/')) {
    res.end(`<!doctype html><title>Swap Scans Chapter 4 - MangaReader</title><body style="margin:0;background:#222">
      <div style="width:900px"><img id="s1" src="${imgBase}/swap.jpg" style="width:100%"><img id="s2" src="${imgBase}/colour.jpg" style="width:100%"></div></body>`);
    return;
  }
  if (req.url.includes('/huge/')) {
    res.end(`<!doctype html><title>Big Scans Chapter 3 - MangaReader</title><body style="margin:0;background:#222">
      <div style="width:900px"><img id="h1" src="${imgBase}/huge.jpg" style="width:100%"><img id="h2" src="${imgBase}/colour.jpg" style="width:100%"></div></body>`);
    return;
  }
  if (req.url.startsWith('/blog')) {
    // Same site, ordinary article: two portrait photos side by side, no chapter anywhere.
    res.end(`<!doctype html><title>My trip to Kyoto - Travel Notes</title><body style="margin:0">
      <h1>My trip to Kyoto</h1><img id="b1" src="${imgBase}/colour.jpg" style="width:420px"><img id="b2" src="${imgBase}/grey.jpg" style="width:420px"></body>`);
    return;
  }
  res.end(`<!doctype html><title>Chainsaw Man Chapter 172 - MangaReader</title><body style="margin:0;background:#222">
    <img id="icon" src="${imgBase}/icon.png">
    <div><img id="p1" src="${imgBase}/colour.jpg"></div>
    <div style="width:900px"><img id="p2" src="${imgBase}/grey.jpg" style="width:100%"></div></body>`);
});
const base = `http://127.0.0.1:${pages.address().port}`;
const pageUrl = `${base}/manga/chainsaw-man/chapter-172`;

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-manga-prof-')), {
  headless: false,
  executablePath: exe,
  viewport: { width: 1000, height: 900 },
  // A real window (real GPU), parked off-screen so it does not pop up; A4K_SHOW=1 shows it.
  args: [...(process.env.A4K_SHOW ? [] : ['--window-position=-32000,-32000']), `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
    // Public-looking names that resolve to this machine, like a hostile DNS record would.
    '--host-resolver-rules=MAP reader.mangatest.example 127.0.0.1, MAP same.mangatest.example 127.0.0.1, MAP trick.mangatest.example 127.0.0.2'],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  const setManga = (sites) => sw.evaluate(async (v) => { await chrome.storage.local.set({ 'a4k-manga': v }); }, sites);
  const getManga = () => sw.evaluate(async () => (await chrome.storage.local.get('a4k-manga'))['a4k-manga'] ?? {});
  const setPreset = (preset) => sw.evaluate(async (p) => {
    const cur = (await chrome.storage.sync.get('anime4k')).anime4k ?? {};
    await chrome.storage.sync.set({ anime4k: { ...cur, preset: p } });
  }, preset);
  const statusOf = (url) => sw.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    return chrome.tabs.sendMessage(tab.id, { type: 'a4k-manga-status' }, { frameId: 0 });
  }, url);
  await setPreset('CA');
  // Any uncaught error in a popup (like the one on brave://extensions) fails the run.
  const popupErrors = [];
  ctx.on('page', (pg) => pg.on('pageerror', (e) => { if (pg.url().startsWith('chrome-extension://')) popupErrors.push(e.message); }));

  const page = await ctx.newPage();
  await page.goto(pageUrl);
  await page.waitForFunction(() => document.images.length === 3 && [...document.images].every((i) => i.complete));
  const state = () => page.evaluate(() => Object.fromEntries([...document.images].map((i) => [i.id, {
    src: i.currentSrc, nw: i.naturalWidth, w: Math.round(i.getBoundingClientRect().width),
  }])));
  const before = await state();
  const blobs = (s) => ['p1', 'p2'].every((id) => s[id].src.startsWith('blob:'));

  // 0. Detected while off, with the series and chapter; nothing touched.
  await page.waitForTimeout(1500);
  const off0 = await statusOf(pageUrl);
  check('reader page detected while off', off0?.kind === 'images' && off0.marks.length === 2 && !off0.on, JSON.stringify({ kind: off0?.kind, n: off0?.marks.length }));
  check('series and chapter from the title', off0?.meta.series === 'Chainsaw Man' && off0.meta.chapter === '172', JSON.stringify(off0?.meta));
  check('off by default', !blobs(await state()));

  // Popup pointed at the reader tab (the real popup asks for the active tab; here that would be itself).
  const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, pageUrl);
  const popup = await ctx.newPage();
  await popup.addInitScript(({ id, url }) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active ? [{ id, url }] : query(info));
  }, { id: tabId, url: pageUrl });
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForTimeout(800);
  const card = () => popup.evaluate(() => ({
    shown: getComputedStyle(document.getElementById('manga-card')).display !== 'none',
    title: document.getElementById('manga-title').textContent,
    tag: document.getElementById('manga-tag').textContent,
    name: document.getElementById('manga-name').textContent,
    strip: document.getElementById('manga-pages').children.length,
    done: document.querySelectorAll('#manga-pages i.done').length,
    state: document.getElementById('manga-state').textContent,
    label: document.getElementById('nowLabel').textContent,
    hint: document.getElementById('hint').textContent,
    empty: !document.getElementById('empty').hidden,
    perfLabel: document.querySelector('#k-load').previousElementSibling.textContent,
    tip: /2×/.test(document.getElementById('legend').textContent),
    height: Math.ceil(document.body.getBoundingClientRect().height),
  }));
  const c0 = await card();
  check('popup shows the chapter card', c0.shown && c0.title === 'Chainsaw Man' && c0.tag === 'ch 172' && c0.strip === 2, JSON.stringify(c0));
  check('popup says it is off and how to start', /off · switch on/.test(c0.state) && c0.label === 'reading now' && c0.hint === 'manga' && !c0.empty);
  check('popup performance panel shows manga figures', c0.perfLabel === 'GPU / page' && c0.tip);
  // Browsers cap extension popups at 600 px and add a scrollbar beyond that: the popup must fit.
  const POPUP_MAX = 600;
  check('manga popup fits without a scrollbar (off)', c0.height <= POPUP_MAX, `${c0.height}px`);

  // 1. Switch on by clicking the card.
  await popup.click('#manga-card');
  await popup.waitForTimeout(300);
  check('clicking the card switches the site on', (await getManga())['127.0.0.1'] === true);
  await page.waitForFunction(() => ['p1', 'p2'].every((id) => document.getElementById(id).currentSrc.startsWith('blob:')
    && document.getElementById(id).naturalWidth > 1000), null, { timeout: 30000 }).catch(() => {});
  const on = await state();
  check('both pages swapped for upscaled ones', blobs(on));
  check('upscaled pages are 2x', on.p1.nw === before.p1.nw * 2 && on.p2.nw === before.p2.nw * 2, `${before.p1.nw} -> ${on.p1.nw}`);
  check('layout unchanged (no CSS width)', on.p1.w === before.p1.w, `${before.p1.w} -> ${on.p1.w}`);
  check('layout unchanged (CSS width)', on.p2.w === before.p2.w, `${before.p2.w} -> ${on.p2.w}`);
  check('small icon left alone', on.icon.src === before.icon.src);
  await popup.waitForTimeout(800);
  const c1 = await card();
  check('manga popup fits without a scrollbar (upscaling)', c1.height <= POPUP_MAX, `${c1.height}px`);
  check('popup shows progress', c1.done === 2 && /2 \/ 2 pages upscaled/.test(c1.state) && c1.hint === 'manga · ca', JSON.stringify({ done: c1.done, state: c1.state, hint: c1.hint }));
  if (shots) await popup.screenshot({ path: path.join(shots, 'manga-popup-on.png') });
  // No double work: once done, idle scans (every 1.5 s) and scrolling render nothing more.
  await page.bringToFront();
  await page.mouse.wheel(0, 900); await page.waitForTimeout(500); await page.mouse.wheel(0, -900);
  await page.waitForTimeout(4000);
  const idle = await statusOf(pageUrl);
  check('each page rendered exactly once; idle scans and scrolling add nothing', idle.renders === 2, `renders=${idle.renders}`);

  const tint = () => page.evaluate(() => Object.fromEntries(['p1', 'p2'].map((id) => {
    const img = document.getElementById(id); const cv = document.createElement('canvas');
    cv.width = 200; cv.height = 200; const g = cv.getContext('2d'); g.drawImage(img, 0, 0, 200, 200);
    try {
      const d = g.getImageData(0, 0, 200, 200).data; let max = 0;
      for (let i = 0; i < d.length; i += 4) max = Math.max(max, Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]));
      return [id, max];
    } catch (e) { return [id, `unreadable: ${e.message}`]; }
  })));
  const t = await tint();
  check('black-and-white page stays grey', t.p2 <= 2, `max channel spread ${t.p2}`);
  check('colour page keeps colour', t.p1 > 50, `max channel spread ${t.p1}`);

  // 2. Alt+M shows the originals, and again the upscaled pages.
  await page.bringToFront();
  await page.keyboard.press('Alt+KeyM');
  await page.waitForTimeout(500);
  const orig = await state();
  check('Alt+M shows the originals', orig.p1.src === before.p1.src && orig.p2.src === before.p2.src);
  check('originals keep the layout', orig.p1.w === before.p1.w && orig.p2.w === before.p2.w);
  await page.keyboard.press('Alt+KeyM');
  await page.waitForTimeout(500);
  check('Alt+M again shows the upscaled pages', blobs(await state()));
  check('Alt+M does not re-render', (await statusOf(pageUrl)).renders === 2);

  // 3. A preset change re-renders.
  const prev = (await state()).p1.src;
  await setPreset('A');
  await page.waitForFunction((p) => document.getElementById('p1').currentSrc !== p && document.getElementById('p1').currentSrc.startsWith('blob:'), prev, { timeout: 20000 }).catch(() => {});
  check('preset change re-renders the pages', (await state()).p1.src !== prev);
  await page.waitForTimeout(3000);
  const afterPreset = await statusOf(pageUrl);
  check('preset change renders each page once more, not more', afterPreset.renders === 4, `renders=${afterPreset.renders}`);

  // Reload: nothing is remembered between loads, so the originals are upscaled fresh to 2x (never 4x).
  await page.reload();
  await page.waitForFunction(() => ['p1', 'p2'].every((id) => document.getElementById(id).currentSrc.startsWith('blob:')
    && document.getElementById(id).naturalWidth > 1000), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const reloaded = await state();
  const rs = await statusOf(pageUrl);
  check('after a reload pages are upscaled again from the originals', blobs(reloaded) && reloaded.p1.nw === before.p1.nw * 2 && reloaded.p2.nw === before.p2.nw * 2, `${before.p1.nw} -> ${reloaded.p1.nw}`);
  check('after a reload each page renders once', rs.renders === 2 && rs.done === 2, `renders=${rs.renders} done=${rs.done}`);
  check('after a reload the layout is unchanged', reloaded.p1.w === before.p1.w && reloaded.p2.w === before.p2.w);

  // 4. Safety stop: an ordinary page on the same switched-on site is never touched.
  const blog = await ctx.newPage();
  await blog.goto(`${base}/blog/kyoto`);
  await blog.waitForFunction(() => [...document.images].every((i) => i.complete));
  await blog.waitForTimeout(3500);
  const blogSrcs = await blog.evaluate(() => [...document.images].map((i) => i.currentSrc));
  check('ordinary page on a switched-on site is left alone', blogSrcs.every((s) => !s.startsWith('blob:')));
  const blogStatus = await statusOf(`${base}/blog/kyoto`);
  check('ordinary page is not detected as manga', blogStatus?.kind === null, JSON.stringify({ kind: blogStatus?.kind }));
  // ...and its popup is the normal anime popup, with no manga card, labels or tip.
  const blogTab = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, `${base}/blog/kyoto`);
  const popup2 = await ctx.newPage();
  await popup2.addInitScript(({ id, url }) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active ? [{ id, url }] : query(info));
  }, { id: blogTab, url: `${base}/blog/kyoto` });
  await popup2.goto(`chrome-extension://${extId}/popup.html`);
  await popup2.waitForTimeout(800);
  const normal = await popup2.evaluate(() => ({
    card: getComputedStyle(document.getElementById('manga-card')).display !== 'none',
    upscaleRow: getComputedStyle(document.getElementById('upscale')).display !== 'none',
    label: document.getElementById('nowLabel').textContent,
    hint: document.getElementById('hint').textContent,
    empty: document.getElementById('empty').hidden ? null : document.getElementById('empty').textContent,
    perfLabels: [...document.querySelectorAll('.kv span')].map((x) => x.textContent).join(','),
    verdict: document.getElementById('verdict').textContent,
    legend: document.getElementById('legend').textContent,
    height: Math.ceil(document.body.getBoundingClientRect().height),
  }));
  check('no manga: popup is the normal anime popup', !normal.card && normal.upscaleRow && normal.label === 'playing now' && normal.hint === 'off'
    && /No video found/.test(normal.empty ?? '') && normal.perfLabels.startsWith('GPU,Per frame') && normal.legend === 'no video', JSON.stringify(normal));
  check('normal popup fits without a scrollbar', normal.height <= POPUP_MAX, `${normal.height}px`);
  if (shots) await popup2.screenshot({ path: path.join(shots, 'popup-no-manga.png') });
  await popup2.close();
  await blog.close();

  // 4b. A MANGA Plus-style reader: blob: pages whose URLs are already revoked.
  const mp = await ctx.newPage();
  const mpUrl = `${base}/viewer/1000331`;
  await mp.goto(mpUrl);
  await mp.waitForFunction(() => document.querySelectorAll('img.zao-image').length === 3 && [...document.images].every((i) => i.complete && i.naturalWidth));
  const mpStatus0 = await statusOf(mpUrl);
  check('MANGA Plus style: series and chapter', mpStatus0?.meta.series === 'Haikyu!!' && mpStatus0.meta.chapter === '1', JSON.stringify(mpStatus0?.meta));
  await mp.waitForFunction(() => [...document.querySelectorAll('img.zao-image')].every((i) => i.currentSrc.startsWith('blob:') && i.naturalWidth === 2160),
    null, { timeout: 30000 }).catch(() => {});
  const mpOn = await mp.evaluate(() => [...document.querySelectorAll('img.zao-image')].map((i) => ({ nw: i.naturalWidth, w: Math.round(i.getBoundingClientRect().width) })));
  const mpStatus = await statusOf(mpUrl);
  check('MANGA Plus style: revoked blob pages are upscaled', mpOn.every((x) => x.nw === 2160 && x.w === 800) && mpStatus.done === 3 && mpStatus.failed === 0,
    JSON.stringify({ mpOn, done: mpStatus.done, failed: mpStatus.failed, err: mpStatus.lastError }));
  await mp.keyboard.press('Alt+KeyM');
  await mp.waitForTimeout(600);
  const mpOrig = await mp.evaluate(() => [...document.querySelectorAll('img.zao-image')].map((i) => i.naturalWidth));
  check('MANGA Plus style: Alt+M shows working originals', mpOrig.every((w) => w === 1080), JSON.stringify(mpOrig));
  await mp.keyboard.press('Alt+KeyM');
  await mp.waitForTimeout(600);
  check('MANGA Plus style: and back to upscaled', (await mp.evaluate(() => [...document.querySelectorAll('img.zao-image')].map((i) => i.naturalWidth))).every((w) => w === 2160));
  await mp.close();

  // 4c. Reader signals: no chapter number, but chapter navigation and a page counter; lazy pages load early.
  const rd = await ctx.newPage();
  const rdUrl = `${base}/read/oneshot`;
  await rd.goto(rdUrl);
  await rd.waitForTimeout(1500);
  const rs0 = await statusOf(rdUrl);
  check('reader signals: detected without a chapter number', rs0?.kind === 'images' && rs0.reasons.includes('chapter navigation'), JSON.stringify(rs0?.reasons));
  check('reader signals: total from the page counter', rs0?.total === 12, `total=${rs0?.total}`);
  check('doujinshi title parsed', rs0?.meta.series === 'Matsuri no Yoru ni', JSON.stringify(rs0?.meta));
  await rd.waitForFunction(() => [...document.querySelectorAll('img.pg')].every((i) => i.complete && i.naturalWidth === 1800), null, { timeout: 40000 }).catch(() => {});
  const lazyState = await rd.evaluate(() => [...document.querySelectorAll('img.pg')].map((i) => `${i.loading}:${i.naturalWidth}`));
  check('lazy pages far below are loaded early and upscaled', lazyState.every((x) => x.endsWith(':1800')) && lazyState.slice(2).every((x) => x.startsWith('eager')), lazyState.join(' '));
  // A page the site adds while reading is counted as soon as its image loads (not on the next periodic scan).
  const before9 = (await statusOf(rdUrl)).marks.length;
  const loadedAt = await rd.evaluate(async (src) => {
    const img = document.createElement('img'); img.className = 'pg'; img.style.cssText = 'width:800px;display:block';
    const done = new Promise((ok) => { img.onload = () => ok(performance.timeOrigin + performance.now()); });
    img.src = src; document.querySelector('img.pg:last-of-type').after(img);
    return done;
  }, `${imgBase}/colour.jpg?p=9`);
  let countedAt = 0;
  for (let i = 0; i < 40 && !countedAt; i++) {
    if ((await statusOf(rdUrl)).marks.length > before9) countedAt = Date.now();
    else await rd.waitForTimeout(50);
  }
  const lag = countedAt ? countedAt - loadedAt : Infinity;
  check('a newly loaded page is counted within half a second', lag < 500, `${Math.round(lag)} ms after its image loaded`);
  const rdTab = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, rdUrl);
  const popup3 = await ctx.newPage();
  await popup3.addInitScript(({ id, url }) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active ? [{ id, url }] : query(info));
  }, { id: rdTab, url: rdUrl });
  await popup3.goto(`chrome-extension://${extId}/popup.html`);
  await popup3.waitForTimeout(800);
  const c3 = await popup3.evaluate(() => ({
    title: document.getElementById('manga-title').textContent,
    why: document.getElementById('manga-title').title,
    name: document.getElementById('manga-name').textContent,
    height: Math.ceil(document.body.getBoundingClientRect().height),
  }));
  check('popup: doujinshi title, real total, and why it was detected', c3.title === 'Matsuri no Yoru ni' && /^12 pages · /.test(c3.name) && /chapter navigation/.test(c3.why), JSON.stringify(c3));
  check('popup fits without a scrollbar on this page', c3.height <= POPUP_MAX, `${c3.height}px`);
  if (shots) await popup3.screenshot({ path: path.join(shots, 'manga-popup-reader.png') });
  await popup3.close();

  // A tab still running a page script from before an extension update answers in an older shape
  // (no version, missing fields): the popup asks for a reload and keeps working.
  const popup4 = await ctx.newPage();
  await popup4.addInitScript(({ id, url }) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active ? [{ id, url }] : query(info));
    const send = chrome.tabs.sendMessage.bind(chrome.tabs);
    chrome.tabs.sendMessage = async (...args) => {
      const reply = await send(...args);
      if (args[1]?.type === 'a4k-manga-status' && reply) { delete reply.protocol; delete reply.total; delete reply.reasons; }
      return reply;
    };
  }, { id: rdTab, url: rdUrl });
  await popup4.goto(`chrome-extension://${extId}/popup.html`);
  await popup4.waitForTimeout(800);
  const c4 = await popup4.evaluate(() => ({
    state: document.getElementById('manga-state').textContent,
    label: document.getElementById('nowLabel').textContent,
    empty: getComputedStyle(document.getElementById('empty')).display !== 'none',
    perf: document.querySelector('#k-load').previousElementSibling.textContent,
  }));
  check('old page script: popup asks for a reload and still draws', /reload this page/.test(c4.state) && c4.label === 'reading now' && !c4.empty && c4.perf === 'GPU / page', JSON.stringify(c4));
  await popup4.close();
  await rd.close();

  // 5. Switch off by clicking the card again: originals back.
  await popup.bringToFront();
  await popup.click('#manga-card');
  await page.waitForTimeout(1000);
  const off = await state();
  check('switching off restores the originals', off.p1.src === before.p1.src && off.p2.src === before.p2.src && off.p1.w === before.p1.w);
  check('switch state stored as off', (await getManga())['127.0.0.1'] === undefined);
  // 6. DNS trick: a page on a public-looking name asks for an image whose public-looking name
  // resolves to a private address. The response address decides, not the name.
  const dns = await ctx.newPage();
  const dnsUrl = `http://reader.mangatest.example:${pages.address().port}/blog`;
  await dns.goto(dnsUrl);
  const ask = (url, page = dnsUrl) => sw.evaluate(async ({ page, url }) => {
    const [tab] = await chrome.tabs.query({ url: page });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (u) => chrome.runtime.sendMessage({ type: 'a4k-fetch-image', url: u }), args: [url] });
    return r.result;
  }, { page, url });
  const tricked = await ask(`http://trick.mangatest.example:${images2.address().port}/colour.jpg`);
  check('public name resolving to a private address is refused', !tricked?.dataUrl && /local address/i.test(tricked?.error ?? ''), JSON.stringify(tricked).slice(0, 80));
  const samePlace = await ask(`http://same.mangatest.example:${images.address().port}/colour.jpg`);
  check('image from the same address as the page still loads (proxy case)', !!samePlace?.dataUrl?.startsWith('data:image/jpeg'), JSON.stringify(samePlace).slice(0, 80));
  // A navigation that answers 204 leaves the document in place: it must not change what the frame may read.
  await dns.evaluate((u) => { location.href = u; }, `http://127.0.0.2:${images2.address().port}/nothing`);
  await dns.waitForTimeout(700);
  const spoofed = await ask(`http://trick.mangatest.example:${images2.address().port}/colour.jpg`);
  check('a 204 navigation to a private address does not unlock it', dns.url() === dnsUrl && !spoofed?.dataUrl && /local address/i.test(spoofed?.error ?? ''), JSON.stringify(spoofed).slice(0, 80));
  // Redirects are followed by hand: a local target is refused before it is requested.
  const viaSame = `http://same.mangatest.example:${images.address().port}`;
  const toLocal = await ask(`${viaSame}/to-local`);
  check('redirect to a local address is refused without requesting it', !toLocal?.dataUrl && /redirected to a local/i.test(toLocal?.error ?? '') && blindHits === 0, `${JSON.stringify(toLocal).slice(0, 70)} hits=${blindHits}`);
  const toTrick = await ask(`${viaSame}/to-trick`);
  check('redirect to a name resolving to a private address is refused', !toTrick?.dataUrl && /local address/i.test(toTrick?.error ?? ''), JSON.stringify(toTrick).slice(0, 80));
  const toOk = await ask(`${viaSame}/to-ok`);
  check('an allowed redirect is still followed', !!toOk?.dataUrl?.startsWith('data:image/jpeg'), JSON.stringify(toOk).slice(0, 80));
  const loop = await ask(`${viaSame}/loop`);
  check('a redirect loop stops', /too many redirects/i.test(loop?.error ?? ''), JSON.stringify(loop).slice(0, 80));
  // One tab filling its fetch slots does not make another tab wait.
  const other = await ctx.newPage();
  const otherUrl = `${dnsUrl}?other`;
  await other.goto(otherUrl);
  const slow = [1, 2, 3, 4].map((i) => ask(`${viaSame}/slow?${i}`));
  await dns.waitForTimeout(300);
  const tOther = Date.now();
  const quick = await ask(`${viaSame}/colour.jpg`, otherUrl);
  check('a busy tab does not hold up another tab', !!quick?.dataUrl && Date.now() - tOther < 2000, `${Date.now() - tOther} ms`);
  await Promise.all(slow);
  await other.close();
  await dns.close();
  // 7. A page over the size cap is left alone; the rest of the chapter is still upscaled.
  await setManga({ '127.0.0.1': true });
  const huge = await ctx.newPage();
  const hugeUrl = `${base}/manga/huge/chapter-3`;
  await huge.goto(hugeUrl);
  await huge.waitForFunction(() => document.getElementById('h2').naturalWidth === 1800, null, { timeout: 30000 }).catch(() => {});
  const hs = await statusOf(hugeUrl);
  const hugeNow = await huge.evaluate(() => ({ h1: document.getElementById('h1').naturalWidth, h2: document.getElementById('h2').naturalWidth }));
  check('page over the size cap is not decoded or upscaled', hugeNow.h1 === 3400 && hugeNow.h2 === 1800 && hs.failed === 1 && /too large/i.test(hs.lastError ?? ''),
    JSON.stringify({ ...hugeNow, done: hs.done, failed: hs.failed, err: hs.lastError }));
  await huge.close();
  // Downloaded bytes larger than the image on screen: refused by size, the rest still upscaled.
  const swap = await ctx.newPage();
  const swapUrl = `${base}/manga/swap/chapter-4`;
  await swap.goto(swapUrl);
  await swap.waitForFunction(() => document.getElementById('s2').naturalWidth === 1800, null, { timeout: 30000 }).catch(() => {});
  const ss = await statusOf(swapUrl);
  const swapNow = await swap.evaluate(() => ({ s1: document.getElementById('s1').naturalWidth, s2: document.getElementById('s2').naturalWidth }));
  check('downloaded bytes over the size cap are not upscaled', swapNow.s1 === 900 && swapNow.s2 === 1800 && swapHits >= 2 && /too large/i.test(ss.lastError ?? ''),
    JSON.stringify({ ...swapNow, swapHits, failed: ss.failed, err: ss.lastError }));
  await swap.close();

  // 8. Kept copies of blob: originals are freed once the site replaces or removes the image.
  const kc = await ctx.newPage();
  await kc.goto(`${base}/viewer/1000332`);
  await kc.waitForFunction(() => document.querySelectorAll('img.zao-image').length === 3 && [...document.querySelectorAll('img.zao-image')].every((i) => i.naturalWidth === 2160),
    null, { timeout: 30000 }).catch(() => {});
  await setManga({});
  await kc.waitForFunction(() => [...document.querySelectorAll('img.zao-image')].every((i) => i.naturalWidth === 1080), null, { timeout: 10000 }).catch(() => {});
  const alive = () => kc.evaluate((urls) => Promise.all(urls.map((u) => fetch(u).then(() => true, () => false))), kept);
  const kept = await kc.evaluate(() => [...document.querySelectorAll('img.zao-image')].map((i) => i.currentSrc));
  const aliveBefore = await alive();
  await kc.evaluate(() => {
    document.getElementById('m0').remove();
    document.getElementById('m1').src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  });
  await kc.waitForTimeout(500);
  const aliveAfter = await alive();
  check('kept originals are freed when the image is removed or replaced', kept.every((u) => u.startsWith('blob:')) && aliveBefore.every(Boolean) && !aliveAfter[0] && !aliveAfter[1] && aliveAfter[2],
    JSON.stringify({ aliveBefore, aliveAfter }));
  await kc.close();

  check('no uncaught errors in any popup', popupErrors.length === 0, popupErrors.join(' | '));
} finally {
  await ctx.close();
  images.close(); images2.close(); pages.close();
}
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);

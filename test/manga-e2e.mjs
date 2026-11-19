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
// A short video for the mode checks: mode "manga" must leave videos alone.
ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(work, 'v.mp4')]);

const serve = (handler) => new Promise((ok) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => ok(s)); });
let blindHits = 0; // requests that must never be made
let swapHits = 0;
let imageHits = 0; // every request to the image server
const images = await serve((req, res) => {
  imageHits++;
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
  // The video comes from the page's own origin: a cross-origin one without CORS cannot be upscaled.
  if (req.url === '/v.mp4') { res.writeHead(200, { 'Content-Type': 'video/mp4' }); fs.createReadStream(path.join(work, 'v.mp4')).pipe(res); return; }
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
  if (req.url.startsWith('/player')) {
    // A video player like strm.cx (Vidstack): "Next Episode" button and a seek-preview sprite sheet,
    // a 3200x4500 grid of 160x90 thumbnails drawn at full width inside a small clipping box. Hidden
    // until the seek bar is hovered (?shown=1: hovered).
    const shown = req.url.includes('shown=1');
    res.end(`<!doctype html><title>Dragon Ball Episode 3</title><body style="margin:0;background:#000">
      <video src="/v.mp4" muted style="width:100%;display:block"></video>
      <button aria-label="Previous Episode">‹</button><button aria-label="Next Episode">›</button>
      <div style="position:absolute;left:300px;top:500px;width:160px;height:90px;overflow:hidden;${shown ? '' : 'visibility:hidden'}">
        <img id="sprite" style="width:1796px;max-width:none;position:absolute;left:-200px;top:-90px">
      </div>
      <script>
        const c = document.createElement('canvas'); c.width = 3200; c.height = 4500;
        const g = c.getContext('2d');
        for (let y = 0; y < 4500; y += 90) for (let x = 0; x < 3200; x += 160) { g.fillStyle = 'hsl(' + ((x + y) % 360) + ',40%,40%)'; g.fillRect(x, y, 160, 90); }
        c.toBlob((b) => { document.getElementById('sprite').src = URL.createObjectURL(b); }, 'image/jpeg');
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
  if (req.url.startsWith('/watch')) {
    res.end(`<!doctype html><title>Some Show Episode 3</title><body style="margin:0;background:#000">
      <video src="/v.mp4" muted autoplay loop playsinline style="width:960px;height:540px"></video></body>`);
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
  headless: !process.env.A4K_SHOW, // headless by default; A4K_SHOW=1 opens a real window
  ignoreDefaultArgs: ['--hide-scrollbars'], // headless hides scrollbars by default; the popup's scrollbar lane is measured
  executablePath: exe,
  viewport: { width: 1000, height: 900 },
  // Headless (new headless mode loads extensions). A4K_SHOW=1 opens a real window for the real GPU.
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
    strip: document.querySelectorAll('#pmap-grid button.pcell').length,
    done: document.querySelectorAll('#pmap-grid .pcell.done').length,
    headTag: [...document.querySelectorAll('.bar .chip.manga')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.textContent).join('|'),
    map: getComputedStyle(document.getElementById('pmap')).display !== 'none',
    count: document.getElementById('pmap-count').textContent,
    numbers: [...document.querySelectorAll('#pmap-grid .pcell')].map((el) => el.textContent).join(','),
    labels: [...document.querySelectorAll('#pmap-grid .pcell')].map((el) => el.getAttribute('aria-label')).join('|'),
    group: document.getElementById('pmap-grid').getAttribute('role') === 'group' && !!document.getElementById('pmap-grid').getAttribute('aria-label'),
    legend: document.querySelectorAll('.pmap-legend, #pmap .pkey, [id^="pmap-n-"]').length,
    // The status line shows only while the chapter is not running; then the bar and the counts do.
    state: getComputedStyle(document.getElementById('manga-state')).display !== 'none' ? document.getElementById('manga-state').textContent : '',
    prog: getComputedStyle(document.getElementById('manga-prog')).display !== 'none',
    blocks: [...document.querySelectorAll('#mc-pages i')].map((el) => el.className).join(','),
    tiles: [...document.querySelectorAll('.mc-counts > div')].map((el) => `${el.querySelector('span').textContent.trim()}:${el.querySelector('b').textContent}`).join(','),
    failTip: document.querySelector('.mc-counts [data-k="fail"]').dataset.tip ?? '',
    cardTip: document.getElementById('manga-card').dataset.tip ?? '',
    hr: document.querySelectorAll('.hr').length,
    label: document.getElementById('nowLabel').textContent,
    hint: document.getElementById('hint').textContent,
    empty: !document.getElementById('empty').hidden,
    perfLabel: document.querySelector('#k-load').previousElementSibling.textContent,
    tip: /2×/.test(document.getElementById('verdict').dataset.tip ?? ''),
    height: document.body.scrollHeight /* content height: body itself is capped at 600 and scrolls */,
  }));
  const c0 = await card();
  check('popup shows the chapter card', c0.shown && c0.title === 'Chainsaw Man' && c0.tag === 'ch 172' && c0.strip === 2, JSON.stringify(c0));
  check('popup says it is off and how to start, on one line', /off · switch on/.test(c0.state) && !c0.prog && c0.cardTip === '' && c0.label === 'reading now' && c0.hint === 'manga' && !c0.empty,
    JSON.stringify({ state: c0.state, prog: c0.prog }));
  check('popup performance panel shows manga figures', c0.perfLabel === 'GPU / page' && c0.tip);
  check('header shows the manga tag on a reader page', c0.headTag === 'manga', c0.headTag);
  check('page map: one cell per page, numbered, with the total', c0.map && c0.strip === off0.total && c0.numbers === '1,2' && c0.count === '● 0 / 2' && c0.group,
    JSON.stringify({ map: c0.map, cells: c0.strip, numbers: c0.numbers, count: c0.count }));
  check('page map while off: every cell waiting, labelled', c0.done === 0 && c0.labels === 'go to page 1, off|go to page 2, off', c0.labels);
  check('page map: no legend row', c0.legend === 0, `${c0.legend} legend nodes`);
  check('no separator lines: no .hr in the popup', c0.hr === 0, `${c0.hr}`);
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
  check('popup shows progress: a bar and counts in place of the status line', c1.done === 2 && c1.prog && c1.state === '' && c1.hint === 'manga · ca', JSON.stringify({ done: c1.done, state: c1.state, prog: c1.prog, hint: c1.hint }));
  check('manga card: one bar block per page, coloured by its state', c1.blocks === 'done,done', c1.blocks);
  check('manga card: four counts, one word each', c1.tiles === 'done:2,active:0,failed:0,queued:0' && c1.failTip === '', `${c1.tiles} tip="${c1.failTip}"`);
  check('manga card: Alt+M is the card tooltip', c1.cardTip === 'Alt+M compares a page with its original' && c1.hr === 0, c1.cardTip);
  const s1 = await statusOf(pageUrl);
  check('page map cells turn done as pages finish', c1.done === s1.done && c1.strip === s1.total && c1.count === `● ${s1.done} / ${s1.total}`
    && c1.labels === 'go to page 1, done|go to page 2, done' && c1.legend === 0, JSON.stringify({ done: c1.done, count: c1.count, labels: c1.labels, legend: c1.legend }));
  check('header keeps the manga tag while upscaling', c1.headTag === 'manga · ca', c1.headTag);
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
  // A video player's seek-preview sprite sheet is not a manga page, hidden or shown (strm.cx false detection).
  for (const q of ['', '?shown=1']) {
    const pl = await ctx.newPage();
    await pl.goto(`${base}/player${q}`);
    await pl.waitForFunction(() => document.getElementById('sprite').naturalWidth === 3200, null, { timeout: 10000 });
    await pl.waitForTimeout(3500);
    const st = await statusOf(`${base}/player${q}`);
    check(`video player with a ${q ? 'shown' : 'hidden'} seek-preview sprite sheet and "Next Episode" is not detected as manga`, st?.kind === null, JSON.stringify({ kind: st?.kind, reasons: st?.reasons }));
    await pl.close();
  }
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
    perfLabels: [...document.querySelectorAll('#perf .kv span')].map((x) => x.textContent).join(','),
    verdict: getComputedStyle(document.getElementById('verdict')).display !== 'none',
    legend: document.getElementById('bars').dataset.tip, legendLine: document.querySelectorAll('#legend, #perf .meta').length,
    height: document.body.scrollHeight /* content height: body itself is capped at 600 and scrolls */,
  }));
  check('no manga: popup is the normal anime popup', !normal.card && normal.upscaleRow && normal.label === 'playing now' && normal.hint === 'off'
    && /No video found/.test(normal.empty ?? '') && normal.perfLabels.startsWith('GPU,Per frame') && normal.legend === 'no video', JSON.stringify(normal));
  check('performance panel: no legend line in the layout (it is the tooltip of the graph), no status without a video', normal.legendLine === 0 && !normal.verdict, JSON.stringify(normal));
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
    why: document.getElementById('manga-title').dataset.tip ?? '',
    name: document.getElementById('manga-name').textContent,
    height: document.body.scrollHeight /* content height: body itself is capped at 600 and scrolls */,
  }));
  check('popup: doujinshi title, real total, and why it was detected', c3.title === 'Matsuri no Yoru ni' && /^12 pages · /.test(c3.name) && /chapter navigation/.test(c3.why), JSON.stringify(c3));
  check('popup fits without a scrollbar on this page', c3.height <= POPUP_MAX, `${c3.height}px`);

  // Page map on a 12-page chapter: a uniform grid, and a cell jumps the reader to its page.
  const cellBoxes = () => popup3.evaluate(() => {
    const grid = document.getElementById('pmap-grid');
    const inner = grid.getBoundingClientRect();
    const cs = getComputedStyle(grid);
    return {
      left: inner.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft),
      right: inner.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight),
      cells: [...grid.querySelectorAll('.pcell')].map((el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return { w: el.offsetWidth, h: el.offsetHeight, x: r.left, y: r.top, r: r.right, border: st.borderTopWidth, font: `${st.fontSize} ${st.fontWeight}` };
      }),
    };
  });
  const same = (list) => new Set(list.map((v) => JSON.stringify(v))).size === 1;
  const sizes = (b) => b.cells.map((c) => [c.w, c.h, c.border, c.font]);
  const places = (b) => b.cells.map((c) => [c.x, c.y]);
  const calm = await cellBoxes();
  const r1 = (v) => Math.round(v * 10) / 10;
  const gaps = calm.cells.slice(1).map((c, i) => r1(c.x - calm.cells[i].r));
  check('page map: 12 cells for the 12-page chapter', calm.cells.length === 12, `${calm.cells.length} cells`);
  check('page map: every cell is the same square with the same border and type', same(sizes(calm)) && calm.cells[0].w === calm.cells[0].h, JSON.stringify(sizes(calm)[0]));
  check('page map: one row of 12 with equal gaps, edge to edge', same(calm.cells.map((c) => c.y)) && same(gaps)
    && calm.cells[0].x === calm.left && Math.abs(calm.cells[11].r - calm.right) < 0.5, JSON.stringify({ gaps, left: calm.left, right: calm.right, first: calm.cells[0].x, last: calm.cells[11].r }));
  // No tray behind the cells, and the map is as wide as the two tiles under it.
  const tray = await popup3.evaluate(() => {
    const grid = document.getElementById('pmap-grid');
    const cs = getComputedStyle(grid);
    const tiles = [...document.querySelectorAll('#pmap .kv.two > div')].map((el) => el.getBoundingClientRect());
    const cells = [...grid.children].map((el) => el.getBoundingClientRect());
    const r1 = (v) => Math.round(v * 10) / 10;
    return { bg: cs.backgroundColor, border: cs.borderTopWidth, padding: cs.paddingTop, left: r1(cells[0].left - tiles[0].left), right: r1(tiles[1].right - cells[11].right) };
  });
  check('page map: no tray (no background, border or padding) and the cells line up with the tiles below', tray.bg === 'rgba(0, 0, 0, 0)' && tray.border === '0px' && tray.padding === '0px'
    && tray.left === 0 && Math.abs(tray.right) < 0.5, JSON.stringify(tray));
  await popup3.hover('#pmap-grid .pcell:nth-child(5)');
  await popup3.waitForTimeout(300); // past the colour transition
  const hovered = await cellBoxes();
  check('page map: hover changes no size and moves nothing', JSON.stringify(sizes(hovered)) === JSON.stringify(sizes(calm))
    && JSON.stringify(places(hovered)) === JSON.stringify(places(calm)), JSON.stringify(sizes(hovered)[4]));
  await popup3.focus('#pmap-grid .pcell:nth-child(6)');
  const focused = await cellBoxes();
  check('page map: keyboard focus changes no size and moves nothing', JSON.stringify(sizes(focused)) === JSON.stringify(sizes(calm))
    && JSON.stringify(places(focused)) === JSON.stringify(places(calm)));
  // One tab stop for the whole map; the arrow keys move inside it.
  const stops = () => popup3.evaluate(() => {
    const cells = [...document.querySelectorAll('#pmap-grid .pcell')];
    return { tab: cells.filter((el) => el.tabIndex === 0).map((el) => el.textContent).join(','), focus: document.activeElement?.textContent };
  });
  const stop0 = await stops();
  await popup3.keyboard.press('ArrowRight');
  const stop1 = await stops();
  await popup3.keyboard.press('ArrowDown'); // no row below: stays
  await popup3.keyboard.press('ArrowLeft');
  await popup3.keyboard.press('ArrowLeft');
  const stop2 = await stops();
  check('page map: a single tab stop that follows the focus; arrow keys move between cells',
    stop0.tab === '6' && stop1.tab === '7' && stop1.focus === '7' && stop2.tab === '5' && stop2.focus === '5', JSON.stringify([stop0, stop1, stop2]));
  // Pages the reader has not put on the page yet look the same but are not controls.
  const s3 = await statusOf(rdUrl);
  const dead = await popup3.evaluate(() => [...document.querySelectorAll('#pmap-grid .pcell')].filter((el) => el.getAttribute('aria-disabled') === 'true').map((el) => el.textContent).join(','));
  const deadWant = Array.from({ length: s3.total - s3.marks.length - s3.loading }, (_, i) => s3.marks.length + s3.loading + i + 1).join(',');
  check('page map: cells past the pages on the reader page are marked as not reachable', dead === deadWant && s3.first === 0, `${dead} vs ${deadWant}`);
  // Instant scrolling (the reduced-motion path): the reader tab is in the background here, where
  // a smooth scroll would not advance.
  await rd.emulateMedia({ reducedMotion: 'reduce' });
  const topOf = (i) => rd.evaluate((n) => Math.round(document.querySelectorAll('img.pg')[n].getBoundingClientRect().top), i);
  const atTop = (i) => rd.waitForFunction((n) => Math.abs(document.querySelectorAll('img.pg')[n].getBoundingClientRect().top) < 4, i, { timeout: 5000 }).then(() => true, () => false);
  await popup3.click('#pmap-grid .pcell:nth-child(4)');
  check('page map: clicking cell 4 scrolls page 4 into view', await atTop(3), `top=${await topOf(3)}`);
  await popup3.focus('#pmap-grid .pcell:nth-child(2)');
  await popup3.keyboard.press('Enter');
  check('page map: Enter on cell 2 scrolls page 2 into view', await atTop(1), `top=${await topOf(1)}`);
  await popup3.focus('#pmap-grid .pcell:nth-child(7)');
  await popup3.keyboard.press('Space');
  check('page map: Space on cell 7 scrolls page 7 into view', await atTop(6), `top=${await topOf(6)}`);
  // A cell for a page the reader has not put on the page yet, and a made-up index: nothing moves.
  const yBefore = await rd.evaluate(() => scrollY);
  await popup3.click('#pmap-grid .pcell:nth-child(12)', { force: true }); // not a control, so no waiting for it to be one
  await sw.evaluate(async (id) => {
    for (const index of [-1, 1.5, 9999, '3', null]) await chrome.tabs.sendMessage(id, { type: 'a4k-manga-goto', index }, { frameId: 0 }).catch(() => {});
  }, rdTab);
  await rd.waitForTimeout(300);
  check('page map: an index that is not a page of the reader is ignored', await rd.evaluate(() => scrollY) === yBefore);
  if (shots) await popup3.screenshot({ path: path.join(shots, 'manga-popup-reader.png') });
  // A long chapter: the map scrolls after three rows and its cells stay the same whole-pixel squares.
  // The cells are added here and measured at once, before the popup's next repaint removes them.
  const long = await popup3.evaluate(() => {
    const grid = document.getElementById('pmap-grid');
    const short = grid.firstElementChild.offsetWidth;
    const edge = grid.getBoundingClientRect().left;
    grid.classList.add('long');
    for (let i = grid.children.length; i < 120; i += 1) grid.append(Object.assign(grid.firstElementChild.cloneNode(), { textContent: String(i + 1) }));
    const cells = [...grid.children].map((el) => {
      const r = el.getBoundingClientRect();
      return { w: el.offsetWidth, h: el.offsetHeight, x: r.left - edge, y: r.top, rw: r.width };
    });
    const rows = [...new Set([...grid.children].map((el) => el.offsetTop))].length;
    return {
      short, rows, scrolls: grid.scrollHeight > grid.clientHeight, sideways: grid.scrollWidth > grid.clientWidth,
      square: cells.every((c) => c.w === c.h && c.w === cells[0].w),
      whole: cells.every((c) => Number.isInteger(c.rw)), rowGap: cells[12].y - cells[0].y - cells[0].h,
      height: grid.clientHeight,
      cell: cells[0].w, lastRow: cells.slice(108).map((c) => c.x).join() === cells.slice(0, 12).map((c) => c.x).join(),
    };
  });
  check('page map, 120 pages: ten rows of 12 that scroll inside the map, never sideways', long.rows === 10 && long.scrolls && !long.sideways && long.lastRow, JSON.stringify(long));
  check('page map, 120 pages: every cell the same whole-pixel square as in a short chapter', long.square && long.whole && long.cell === long.short, JSON.stringify(long));
  check('page map, 120 pages: three rows show (3 cells and 2 gaps of 3px), the rest scrolls', long.rowGap === 3 && long.height === 3 * long.cell + 2 * 3, JSON.stringify({ rowGap: long.rowGap, height: long.height }));
  // A 30-page chapter (three rows, no scrolling): the gap between rows is the gap between columns.
  const thirty = await popup3.evaluate(() => {
    const grid = document.getElementById('pmap-grid');
    grid.classList.remove('long');
    while (grid.children.length > 30) grid.lastElementChild.remove();
    const b = [...grid.children].map((el) => el.getBoundingClientRect());
    const r1 = (v) => Math.round(v * 10) / 10;
    return { col: r1(b[1].left - b[0].right), row: r1(b[12].top - b[0].bottom), rows: new Set(b.map((r) => r.top)).size, scrolls: grid.scrollHeight > grid.clientHeight };
  });
  check('page map, 30 pages: three rows without scrolling, row gap equal to column gap', thirty.rows === 3 && !thirty.scrolls && thirty.col === thirty.row && thirty.col > 0, JSON.stringify(thirty));
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
    state: getComputedStyle(document.getElementById('manga-state')).display !== 'none' ? document.getElementById('manga-state').textContent : '',
    stateTip: document.getElementById('manga-state').dataset.tip ?? '',
    label: document.getElementById('nowLabel').textContent,
    empty: getComputedStyle(document.getElementById('empty')).display !== 'none',
    perf: document.querySelector('#k-load').previousElementSibling.textContent,
  }));
  check('old page script: popup asks for a reload (the reason in the tooltip) and still draws', c4.state === '● Reload' && /reload this page/.test(c4.stateTip) && c4.label === 'reading now' && !c4.empty && c4.perf === 'GPU / page', JSON.stringify(c4));
  await popup4.close();
  await rd.close();

  // Mode dropdown in the header: auto (default), anime (no manga), manga (no video upscaling).
  const getMode = () => sw.evaluate(async () => (await chrome.storage.sync.get('anime4k')).anime4k?.mode);
  // The dropdown is the popup's own: a button and a list. A mode is picked as a user does, with two clicks.
  const pickMode = async (p, m) => { await p.click('#mode'); await p.click(`#mode-list [data-mode="${m}"]`); };
  const head = () => popup.evaluate(() => {
    const sel = document.getElementById('mode');
    const chips = [...document.querySelectorAll('.bar > *')].map((el) => el.getBoundingClientRect());
    return {
      tag: sel?.tagName,
      options: [...document.querySelectorAll('#mode-list [role="option"]')].map((o) => o.dataset.mode).join(','),
      value: sel?.value,
      named: !!sel?.getAttribute('aria-label'),
      tip: sel?.dataset.tip ?? '',
      oneRow: chips.every((r) => r.top === chips[0].top && r.height === chips[0].height),
      fits: document.documentElement.scrollWidth <= document.documentElement.clientWidth && document.body.getBoundingClientRect().width === 380,
      card: getComputedStyle(document.getElementById('manga-card')).display !== 'none',
      map: getComputedStyle(document.getElementById('pmap')).display !== 'none',
      height: document.body.scrollHeight,
    };
  });
  await popup.bringToFront();
  const h0 = await head();
  check('mode dropdown: a labelled button with auto, anime and manga', h0.tag === 'BUTTON' && h0.options === 'auto,anime,manga' && h0.named && h0.tip.startsWith('Mode'), JSON.stringify(h0));
  check('mode dropdown: auto by default', h0.value === 'auto' && h0.card && h0.map, JSON.stringify(h0));
  check('mode dropdown: header stays one row of equal chips at the popup width', h0.oneRow && h0.fits, JSON.stringify(h0));
  if (shots) await popup.screenshot({ path: path.join(shots, 'mode-auto.png') });

  // Nothing in the popup is drawn by the browser or the system: no native select, no title= tooltips.
  const drop = () => popup.evaluate(() => {
    const btn = document.getElementById('mode');
    const list = document.getElementById('mode-list');
    const r = list.getBoundingClientRect();
    const body = document.body.getBoundingClientRect();
    const active = list.querySelector('.active');
    return {
      open: getComputedStyle(list).display !== 'none', expanded: btn.getAttribute('aria-expanded'), role: btn.getAttribute('role'), has: btn.getAttribute('aria-haspopup'),
      controls: btn.getAttribute('aria-controls') === list.id, listRole: list.getAttribute('role'),
      options: [...list.querySelectorAll('[role="option"]')].map((o) => `${o.dataset.mode}:${o.getAttribute('aria-selected')}`).join(','),
      active: active?.dataset.mode ?? '', activeId: btn.getAttribute('aria-activedescendant') ?? '',
      inside: r.left >= body.left && r.top >= body.top && r.right <= body.right && r.bottom <= body.bottom, width: Math.round(r.width),
      floats: getComputedStyle(list).position, row: active ? getComputedStyle(active).backgroundColor : '',
      height: document.body.scrollHeight, chips: [...document.querySelectorAll('.bar > *')].map((el) => Math.round(el.getBoundingClientRect().width)).join(','),
      focus: document.activeElement?.id ?? '', value: btn.value, text: btn.textContent,
      selects: document.querySelectorAll('select').length, titles: document.querySelectorAll('[title]').length,
    };
  });
  const d0 = await drop();
  check('custom look: no native select and no title= attribute in the popup', d0.selects === 0 && d0.titles === 0, JSON.stringify({ selects: d0.selects, titles: d0.titles }));
  check('mode dropdown: closed, a combobox button that owns a listbox', !d0.open && d0.role === 'combobox' && d0.has === 'listbox' && d0.controls && d0.listRole === 'listbox'
    && d0.expanded === 'false' && d0.text === 'auto', JSON.stringify(d0));
  await popup.click('#mode');
  const d1 = await drop();
  check('mode dropdown: a click opens the list with three options, the current one marked', d1.open && d1.expanded === 'true' && d1.options === 'auto:true,anime:false,manga:false'
    && d1.active === 'auto' && d1.activeId === 'mode-opt-auto' && d1.focus === 'mode', JSON.stringify(d1));
  check('mode dropdown: the open list floats inside the popup and changes no size', d1.floats === 'absolute' && d1.inside && d1.width <= 170 && d1.height === d0.height && d1.chips === d0.chips
    && d1.row !== 'rgba(0, 0, 0, 0)', JSON.stringify({ floats: d1.floats, inside: d1.inside, width: d1.width, height: `${d0.height} -> ${d1.height}`, row: d1.row }));
  await popup.hover('#mode-list [data-mode="manga"]');
  const dHover = await drop();
  if (shots) await popup.screenshot({ path: path.join(shots, 'dropdown.png'), clip: { x: 0, y: 0, width: 380, height: 540 } }); // the popup only
  await popup.keyboard.press('Escape');
  const dEsc = await drop();
  await popup.click('#mode');
  await popup.click('#presetName', { force: true }); // the page under the open list takes no pointer, so force the click at that spot
  const dOut = await drop();
  await popup.click('#mode');
  await popup.evaluate(() => document.getElementById('mode').blur());
  const dBlur = await drop();
  check('mode dropdown: hover moves the highlight; Esc, an outside click and blur close it without a change', dHover.active === 'manga' && !dEsc.open && dEsc.focus === 'mode'
    && dEsc.expanded === 'false' && !dOut.open && !dBlur.open && dBlur.value === 'auto' && await getMode() !== 'manga', JSON.stringify({ hover: dHover.active, esc: dEsc.open, out: dOut.open, blur: dBlur.open }));
  // A click on a control under the dimmed popup only closes the list; the next click works.
  const presetNow = () => popup.evaluate(() => document.querySelector('#presets [aria-checked="true"]')?.dataset.preset);
  const p0 = await presetNow();
  const otherPreset = await popup.evaluate((cur) => [...document.querySelectorAll('#presets [data-preset]')].find((b) => b.dataset.preset !== cur).dataset.preset, p0);
  await popup.click('#mode');
  // While open, nothing outside the list takes the pointer: no hand cursor on a preset or a header chip.
  const hoverOpen = await popup.evaluate((p) => ['#presets [data-preset="' + p + '"]', '#report'].map((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return getComputedStyle(hit).cursor;
  }), otherPreset);
  check('mode dropdown: while open, buttons behind it and header chips show no hand cursor', hoverOpen.every((c) => c !== 'pointer'), hoverOpen.join());
  await popup.click(`#presets [data-preset="${otherPreset}"]`, { force: true });
  const dBehind = await drop();
  const p1 = await presetNow();
  await popup.click(`#presets [data-preset="${otherPreset}"]`);
  await popup.waitForTimeout(200);
  const p2 = await presetNow();
  await popup.click(`#presets [data-preset="${p0}"]`); // put it back
  await popup.waitForTimeout(200);
  check('mode dropdown: a click on a button behind the open list only closes it; the next click works', !dBehind.open && p1 === p0 && p2 === otherPreset,
    JSON.stringify({ open: dBehind.open, before: p0, afterFirst: p1, afterSecond: p2 }));
  // Keyboard: arrows, Home, End and letters move the highlight; Enter picks it.
  await popup.focus('#mode');
  await popup.keyboard.press('End');
  const kEnd = await drop();
  await popup.keyboard.press('Home');
  await popup.keyboard.press('ArrowUp'); // already the first: stays
  const kHome = await drop();
  await popup.keyboard.press('m');
  const kM = await drop();
  await popup.keyboard.press('Escape');
  await popup.keyboard.press('a'); // closed, on "auto": the next name with an a
  const kA = await drop();
  await popup.keyboard.press('Escape');
  check('mode dropdown: End, Home, arrows and letters move the highlight and pick nothing', kEnd.open && kEnd.active === 'manga' && kHome.active === 'auto' && kM.active === 'manga'
    && kA.open && kA.active === 'anime' && (await drop()).value === 'auto', JSON.stringify({ end: kEnd.active, home: kHome.active, m: kM.active, a: kA.active }));
  await popup.keyboard.press('ArrowDown'); // opens on the current mode
  await popup.keyboard.press('ArrowDown');
  await popup.keyboard.press('Enter');
  const kPick = await drop();
  check('mode dropdown: ArrowDown and Enter pick anime; the list closes and the focus stays on the chip', !kPick.open && kPick.value === 'anime' && kPick.text === 'anime'
    && kPick.options === 'auto:false,anime:true,manga:false' && kPick.focus === 'mode', JSON.stringify(kPick));
  await page.waitForFunction((want) => ['p1', 'p2'].every((id) => document.getElementById(id).currentSrc === want[id].src), before, { timeout: 5000 }).catch(() => {});
  await popup.waitForTimeout(800);
  const animeNow = await state();
  const hAnime = await head();
  check('mode anime: stored', await getMode() === 'anime');
  check('mode anime: upscaled pages are restored', animeNow.p1.src === before.p1.src && animeNow.p2.src === before.p2.src && animeNow.p1.w === before.p1.w
    && !(await statusOf(pageUrl)).on, JSON.stringify({ p1: animeNow.p1.src.slice(0, 30) }));
  check('mode anime: manga card and page map are hidden', !hAnime.card && !hAnime.map && hAnime.oneRow, JSON.stringify(hAnime));
  check('mode anime: the site switch itself is kept', (await getManga())['127.0.0.1'] === true);
  if (shots) await popup.screenshot({ path: path.join(shots, 'mode-anime.png') });
  // The choice survives closing and reopening the popup.
  const popup5 = await ctx.newPage();
  await popup5.addInitScript(({ id, url }) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active ? [{ id, url }] : query(info));
  }, { id: tabId, url: pageUrl });
  await popup5.goto(`chrome-extension://${extId}/popup.html`);
  await popup5.waitForTimeout(800);
  const again = await popup5.evaluate(() => ({
    value: document.getElementById('mode').value,
    card: getComputedStyle(document.getElementById('manga-card')).display !== 'none',
  }));
  check('mode: the choice persists after reopening the popup', again.value === 'anime' && !again.card, JSON.stringify(again));
  await popup5.close();

  await popup.bringToFront();
  await pickMode(popup, 'auto');
  const mPick = await drop();
  check('mode dropdown: a click on an option picks it and closes the list', !mPick.open && mPick.value === 'auto' && mPick.text === 'auto' && mPick.focus === 'mode', JSON.stringify(mPick));
  await page.waitForFunction(() => ['p1', 'p2'].every((id) => document.getElementById(id).currentSrc.startsWith('blob:')), null, { timeout: 30000 }).catch(() => {});
  await popup.waitForTimeout(800);
  const hAuto = await head();
  check('mode auto again: pages upscaled without a reload, card and map back', blobs(await state()) && hAuto.card && hAuto.map && await getMode() === 'auto', JSON.stringify(hAuto));
  check('popup height is the same whenever the chapter is running', hAuto.height === c1.height, `${c1.height}px -> ${hAuto.height}px`);

  // Tooltips are the popup's own box: after a short hover, or at once on keyboard focus.
  const tipOf = () => popup.evaluate(() => {
    const tip = document.getElementById('tip');
    const r = tip.getBoundingClientRect();
    const body = document.body.getBoundingClientRect();
    const cs = getComputedStyle(tip);
    return {
      shown: cs.display !== 'none', text: tip.textContent, role: tip.getAttribute('role'), border: cs.borderTopWidth, font: cs.fontSize,
      inside: r.left >= body.left && r.top >= body.top && r.right <= body.right && r.bottom <= body.bottom,
      describes: document.querySelector('[aria-describedby="tip"]')?.id ?? '', focus: document.activeElement?.id ?? '', height: document.body.scrollHeight,
    };
  });
  await popup.hover('#report');
  const tSoon = await tipOf();
  await popup.waitForTimeout(700);
  const tHover = await tipOf();
  if (shots) await popup.screenshot({ path: path.join(shots, 'tooltip.png'), clip: { x: 0, y: 0, width: 380, height: 540 } }); // the popup only
  await popup.mouse.move(190, 300);
  const tAway = await tipOf();
  check('tooltip: shown after a short hover, inside the popup, gone when the pointer leaves', !tSoon.shown && tHover.shown && tHover.text === 'Report a problem' && tHover.role === 'tooltip'
    && tHover.border === '1px' && tHover.font === '10px' && tHover.inside && tHover.height === hAuto.height && !tAway.shown, JSON.stringify({ tSoon: tSoon.shown, tHover, tAway: tAway.shown }));
  await popup.focus('#report');
  await popup.keyboard.press('Shift+Tab');
  const tFocus = await tipOf();
  await popup.keyboard.press('Escape');
  const tEsc = await tipOf();
  check('tooltip: shown at once on keyboard focus and tied to its element; Esc hides it', tFocus.focus === 'mode' && tFocus.shown && tFocus.text.startsWith('Mode') && tFocus.describes === 'mode'
    && tFocus.inside && !tEsc.shown && tEsc.describes === '', JSON.stringify({ tFocus, tEsc: tEsc.shown }));

  // A popup with no manga card (it shows the upscale pills): a tooltip's size and place do not depend on where the one before it was.
  const popupT = await ctx.newPage();
  await popupT.goto(`chrome-extension://${extId}/popup.html`);
  await popupT.waitForTimeout(800);
  await popupT.hover('#report');
  await popupT.waitForTimeout(700);
  await popupT.hover('[data-upscale="8x"]');
  await popupT.waitForTimeout(700);
  const tNext = await popupT.evaluate(() => {
    const r = document.getElementById('tip').getBoundingClientRect();
    const pill = document.querySelector('[data-upscale="8x"]').getBoundingClientRect();
    return { width: Math.round(r.width), right: r.right, bodyRight: document.body.getBoundingClientRect().right, gap: Math.round((pill.top - r.bottom) * 10) / 10 };
  });
  await popupT.close();
  check('tooltip: full width and 4px from its element after another tooltip', tNext.width === 240 && tNext.right <= tNext.bodyRight - 4 && tNext.gap === 4, JSON.stringify(tNext));

  // A video page: upscaled in auto, left alone in mode manga, resumed in auto, all without a reload.
  const watchUrl = `${base}/watch/some-show-3`;
  await sw.evaluate(async (key) => { await chrome.storage.local.set({ 'anime4k-sources': { [key]: true } }); }, `${new URL(base).host}::${new URL(base).host}`);
  const watch = await ctx.newPage();
  await watch.goto(watchUrl);
  const videoOf = async () => (await sw.evaluate(async (u) => {
    const [tab] = await chrome.tabs.query({ url: u });
    return chrome.tabs.sendMessage(tab.id, { type: 'a4k-list' }, { frameId: 0 });
  }, watchUrl))?.[0];
  const canvases = () => watch.evaluate(() => document.querySelectorAll('canvas.a4k-canvas:not([hidden])').length);
  await watch.waitForSelector('canvas.a4k-canvas:not([hidden])', { state: 'attached', timeout: 30000 }).catch(() => {});
  const v0 = await videoOf();
  check('mode auto: the video is upscaled', v0?.status === 'Active' && await canvases() === 1, JSON.stringify({ status: v0?.status, message: v0?.message }));

  const watchTab = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, watchUrl);
  const popup6 = await ctx.newPage();
  await popup6.addInitScript(({ id, url }) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => (info.active ? [{ id, url }] : query(info));
  }, { id: watchTab, url: watchUrl });
  await popup6.goto(`chrome-extension://${extId}/popup.html`);
  await popup6.waitForTimeout(800);
  // The video card: three rows kept apart by the card's own gap, no separator line and no state line.
  const vOn = await popup6.evaluate(() => {
    const card = document.querySelector('#sources .source');
    const rows = [...card.children].filter((el) => getComputedStyle(el).display !== 'none');
    const boxes = rows.map((el) => el.getBoundingClientRect());
    const pills = [...document.querySelectorAll('.pills')].filter((el) => getComputedStyle(el).display !== 'none');
    const r1 = (v) => Math.round(v * 10) / 10;
    const box = (el) => el.getBoundingClientRect();
    const tiles = [...document.querySelectorAll('#presets .tile')].map(box);
    const effects = [...document.querySelectorAll('#effects .pill')];
    const upscale = [...document.querySelectorAll('#upscale .pill')].map(box);
    const heads = [...document.querySelectorAll('.sub-head')].filter((el) => getComputedStyle(el).display !== 'none');
    const panelHead = getComputedStyle(document.querySelector('.panel-head'));
    const verdict = document.getElementById('verdict');
    return {
      rows: rows.map((el) => el.className.split(' ')[0]).join(','), on: card.classList.contains('on'), hr: document.querySelectorAll('.hr').length,
      gaps: boxes.slice(1).map((b, i) => Math.round((b.top - boxes[i].bottom) * 10) / 10),
      stateLines: document.querySelectorAll('#sources .state').length, cardHeight: box(card).height,
      verdict: verdict.textContent, verdictColour: getComputedStyle(verdict).color, verdictTip: verdict.dataset.tip ?? '', barsTip: document.getElementById('bars').dataset.tip ?? '',
      tag: card.querySelector('.tag').textContent, name: card.querySelector('.epname').textContent, meta: card.querySelector('.meta').textContent,
      pillLines: pills.map((el) => getComputedStyle(el).borderTopWidth).join(','),
      // Effects: each exactly one preset tile wide, on the tiles' columns, text on the left.
      effects: effects.map((el, i) => `${r1(box(el).left - tiles[i].left)}/${r1(box(el).width - tiles[i].width)}/${getComputedStyle(el).textAlign}`).join(','),
      // Upscale: four equal boxes across the panel on a 6px gap; no label in the row.
      upscaleCount: upscale.length,
      upscaleWidths: [...new Set(upscale.map((b) => r1(b.width)))], upscaleGaps: [...new Set(upscale.slice(1).map((b, i) => r1(b.left - upscale[i].right)))],
      upscaleSpan: [r1(upscale[0].left - tiles[0].left), r1(tiles[2].right - upscale.at(-1).right)], upscaleRow: new Set(upscale.map((b) => b.top)).size,
      upscaleLabel: document.querySelectorAll('#upscale .pills-label, #upscale span').length,
      heads: heads.map((el) => el.textContent).join(','),
      headLook: heads.every((el) => { const cs = getComputedStyle(el); return cs.fontSize === panelHead.fontSize && cs.color === panelHead.color && cs.textTransform === 'uppercase' && cs.letterSpacing === panelHead.letterSpacing; }),
      headGaps: heads.map((el) => `${r1(box(el).top - box(el.previousElementSibling).bottom)}/${r1(box(el.nextElementSibling).top - box(el).bottom)}`).join(','),
      headGap: Math.round((card.getBoundingClientRect().top - document.querySelector('.panel-head').getBoundingClientRect().bottom) * 10) / 10,
      height: document.body.scrollHeight, scrolls: document.body.scrollHeight > document.body.clientHeight,
    };
  });
  check('video card: title, episode and info rows with equal gaps, no separator line and no state line', vOn.rows === 'line,episode,meta' && vOn.on && vOn.hr === 0
    && new Set(vOn.gaps).size === 1 && vOn.stateLines === 0, JSON.stringify(vOn));
  check('one status, in the performance heading: the open card\'s state in its colour, with the legend in its tooltip and the graph\'s', (vOn.verdict === '● Upscaling' ? vOn.verdictColour === 'rgb(159, 211, 168)' : vOn.verdict === '● Suspended' && vOn.verdictColour === 'rgb(141, 141, 141)')
    && vOn.barsTip !== '' && vOn.verdictTip.endsWith(vOn.barsTip), JSON.stringify({ verdict: vOn.verdict, colour: vOn.verdictColour, tip: vOn.verdictTip, bars: vOn.barsTip }));
  check('no "Episode N" filler: the quality stands beside the tag, the info line has the host and the stream host', vOn.tag === 'E3' && /^360p → \S+ \(\d×\)$/.test(vOn.name)
    && vOn.meta === `${new URL(base).host} · stream ${new URL(base).host}`, JSON.stringify({ tag: vOn.tag, name: vOn.name, meta: vOn.meta }));
  check('preset panel: no separator lines; effect buttons one tile wide on the tiles\' columns, text on the left', vOn.pillLines === '0px,0px' && vOn.effects === '0/0/left,0/0/left', JSON.stringify({ lines: vOn.pillLines, effects: vOn.effects }));
  check('preset panel: four equal upscale boxes (auto, 2×, 4×, 8×) across the full width on a 6px gap, no inline label', vOn.upscaleCount === 4 && vOn.upscaleWidths.length === 1 && vOn.upscaleGaps.length === 1 && vOn.upscaleGaps[0] === 6
    && vOn.upscaleSpan.join() === '0,0' && vOn.upscaleRow === 1 && vOn.upscaleLabel === 0, JSON.stringify({ widths: vOn.upscaleWidths, gaps: vOn.upscaleGaps, span: vOn.upscaleSpan, label: vOn.upscaleLabel }));
  check('preset panel: small headings "effects" and "upscale" in the panel heading\'s style, 6px above and 4px below', vOn.heads === 'effects,upscale' && vOn.headLook && vOn.headGaps === '6/4,6/4',
    JSON.stringify({ heads: vOn.heads, look: vOn.headLook, gaps: vOn.headGaps }));
  check('video page, mode auto: the card is 6px under the panel head and the popup fits without a scrollbar', vOn.headGap === 6 && vOn.height <= POPUP_MAX && !vOn.scrolls, `head gap ${vOn.headGap}px, ${vOn.height}px`);
  console.log(`INFO video page, mode auto, video on: popup content height ${vOn.height}px`);
  if (shots) await popup6.screenshot({ path: path.join(shots, 'video.png'), clip: { x: 0, y: 0, width: 380, height: Math.min(vOn.height, 600) } });
  await pickMode(popup6, 'manga');
  await popup6.waitForTimeout(800);
  const vCard = () => popup6.evaluate(() => ({
    sources: getComputedStyle(document.getElementById('sources')).display !== 'none',
    preview: getComputedStyle(document.getElementById('mp-preview')).display !== 'none',
    disabled: document.querySelector('#sources .source input')?.disabled,
    hint: document.getElementById('hint').textContent,
    value: document.getElementById('mode').value,
    native: document.querySelectorAll('select, [title]').length, tip: document.querySelector('#sources .source .meta')?.dataset.tip ?? '',
  }));
  const cManga = await vCard();
  check('custom look: the video popup has no native select or title= either', cManga.native === 0 && /^stream: /.test(cManga.tip), JSON.stringify({ native: cManga.native, tip: cManga.tip }));
  check('mode manga: the locked preview stands in for the paused video card', cManga.preview && !cManga.sources && cManga.disabled === true && cManga.hint === 'paused'
    && cManga.value === 'manga', JSON.stringify(cManga));
  await popup6.click('#mp-preview .mp-dim');
  await popup6.waitForTimeout(300);
  check('mode manga: clicking the locked preview does not flip the source', Object.values(await sw.evaluate(async () => (await chrome.storage.local.get('anime4k-sources'))['anime4k-sources'])).length === 1);
  if (shots) await popup6.screenshot({ path: path.join(shots, 'mode-manga-video.png') });
  await watch.bringToFront();
  await watch.waitForTimeout(500);
  const v1 = await videoOf();
  check('mode manga: the video is not upscaled (no canvas, no renderer)', v1?.status === 'Suspended' && /manga mode/i.test(v1.message) && v1.stats === null
    && await watch.evaluate(() => document.querySelectorAll('canvas.a4k-canvas').length) === 0
    && await watch.evaluate(() => !document.querySelector('video').hasAttribute('data-a4k-on')), JSON.stringify({ status: v1?.status, message: v1?.message }));
  check('mode manga: manga pages stay upscaled', blobs(await state()) && (await statusOf(pageUrl)).on);

  await pickMode(popup6, 'auto');
  await watch.waitForSelector('canvas.a4k-canvas:not([hidden])', { state: 'attached', timeout: 30000 }).catch(() => {});
  const v2 = await videoOf();
  check('mode auto again: the video is upscaled again without a reload', v2?.status === 'Active' && await canvases() === 1, JSON.stringify({ status: v2?.status, message: v2?.message }));
  check('mode: back to auto in storage', await getMode() === 'auto');
  await popup6.close();
  await watch.close();

  // Mode suggestion: mode "anime" on a reader page (or "manga" on a video page) shows, in "playing
  // now", the card the page would get (locked, dashed red), turns the mode chip red and puts a
  // one-letter badge on the tab's toolbar icon.
  const setMode = (m) => sw.evaluate(async (mode) => {
    const cur = (await chrome.storage.sync.get('anime4k')).anime4k ?? {};
    await chrome.storage.sync.set({ anime4k: { ...cur, mode } });
  }, m);
  const PROMPT_OFF = 'a4k-mode-prompt-off';
  const getOff = () => sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k] ?? {}, PROMPT_OFF);
  const setOff = (v) => sw.evaluate(async ({ k, v }) => { await chrome.storage.local.set({ [k]: v }); }, { k: PROMPT_OFF, v });
  const badgeOf = (id) => sw.evaluate(async (t) => ({ text: await chrome.action.getBadgeText({ tabId: t }), title: await chrome.action.getTitle({ tabId: t }) }), id);
  const waitBadge = async (id, want, ms = 9000) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if ((await badgeOf(id)).text === want) break;
      await page.waitForTimeout(200);
    }
    return badgeOf(id);
  };
  const openPopup = async (id, url) => {
    const p = await ctx.newPage();
    await p.addInitScript((tab) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info) => (info.active ? [tab] : query(info));
    }, { id, url });
    await p.goto(`chrome-extension://${extId}/popup.html`);
    await p.waitForTimeout(800);
    return p;
  };
  const prompt = (p) => p.evaluate(() => {
    const el = document.getElementById('mp-preview');
    const vis = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    const text = (id) => (vis(id) ? document.getElementById(id).textContent : '');
    const cs = getComputedStyle(el);
    const paused = el.querySelector('.mp-paused');
    return {
      shown: vis('mp-preview'), role: el.getAttribute('role'), label: el.getAttribute('aria-label'),
      title: text('mp-title'), tag: text('mp-tag'), name: text('mp-name'), go: text('mp-go'), auto: text('mp-auto'),
      paused: paused.textContent.trim(), pausedShown: getComputedStyle(paused).display !== 'none', pausedColour: getComputedStyle(paused).color, border: `${cs.borderTopWidth} ${cs.borderTopStyle}`,
      locked: el.querySelector('input').disabled && getComputedStyle(el.querySelector('.switch')).pointerEvents === 'none',
      buttons: [...el.querySelectorAll('button')].map((b) => `${b.id}:${b.type}`).join(','),
      // The buttons are on the left of the footer and "paused" is on its right, on one row.
      foot: (() => {
        const row = el.querySelector('.mp-row').getBoundingClientRect();
        const r = paused.getBoundingClientRect();
        const box = el.querySelector('.mp-foot').getBoundingClientRect();
        return row.left === box.left && Math.abs(r.right - box.right) < 0.5 && row.right < r.left && Math.abs((row.top + row.bottom) - (r.top + r.bottom)) <= 1;
      })(),
      done: vis('mp-done'), doneText: text('mp-done-text'), undoShown: vis('mp-done') && vis('mp-undo'),
      frame: document.getElementById('modeChip').classList.contains('mp-ind-frame'), frames: document.querySelectorAll('.mp-ind-frame').length,
      chipBorder: getComputedStyle(document.getElementById('modeChip')).borderTopColor,
      empty: vis('empty'), sources: vis('sources'), card: vis('manga-card'),
      // No dismissal and no per-site "off": no ✕, no "this site" wording anywhere in the popup.
      site: /this site/i.test(document.body.textContent) || !!document.querySelector('[data-tip*="this site" i], [aria-label*="ask" i]'),
      x: document.querySelectorAll('#mp-x, .mp-x, #mp-strip').length, hr: document.querySelectorAll('.hr').length,
      height: document.body.scrollHeight /* content height: body itself is capped at 600 and scrolls */, focus: document.activeElement?.id ?? '',
      scrolls: document.body.scrollHeight > document.body.clientHeight,
      // Distance from the panel head to the first card under it, and where the confirmation lies over the head.
      ...(() => {
        const r1 = (v) => Math.round(v * 10) / 10;
        const head = document.querySelector('.panel-head').getBoundingClientRect();
        const first = [el, ...document.querySelectorAll('#sources .source'), document.getElementById('manga-card')].find((c) => c.getClientRects().length)?.getBoundingClientRect();
        const done = document.getElementById('mp-done').getBoundingClientRect();
        const box = document.querySelector('.panel-head').parentElement;
        const panelTop = box.getBoundingClientRect().top + box.clientTop; // inside the panel's border
        return { headGap: first ? r1(first.top - head.bottom) : null, doneGaps: done.height && first ? [r1(done.top - panelTop), r1(first.top - done.bottom)] : null };
      })(),
      mode: document.getElementById('mode').value,
    };
  });
  const promptShown = (p, want) => p.waitForFunction((w) => (getComputedStyle(document.getElementById('mp-preview')).display !== 'none') === w, want, { timeout: 5000 }).catch(() => {});
  const upscaled = () => page.waitForFunction(() => ['p1', 'p2'].every((id) => document.getElementById(id).currentSrc.startsWith('blob:')), null, { timeout: 30000 }).catch(() => {});
  const restored = () => page.waitForFunction((want) => ['p1', 'p2'].every((id) => document.getElementById(id).currentSrc === want[id].src), before, { timeout: 5000 }).catch(() => {});

  const pAuto = await openPopup(tabId, pageUrl);
  const sAuto = await prompt(pAuto);
  check('mode suggestion: no preview and no red chip in mode auto', !sAuto.shown && !sAuto.done && !sAuto.frame && sAuto.frames === 0 && sAuto.mode === 'auto', JSON.stringify(sAuto));
  await page.bringToFront(); // a hidden tab is not measured
  await page.waitForTimeout(1500);
  check('mode suggestion: no badge in mode auto', (await badgeOf(tabId)).text === '');
  await pAuto.close();

  // Mode anime on a freshly loaded reader: detected, but nothing fetched, drawn or changed.
  await setMode('anime');
  await restored();
  await page.reload();
  await page.waitForFunction(() => document.images.length === 3 && [...document.images].every((i) => i.complete));
  await page.bringToFront();
  const hits0 = imageHits;
  const bM = await waitBadge(tabId, 'M');
  check('mode suggestion: badge M on the reader tab in mode anime', bM.text === 'M' && /manga detected/.test(bM.title), JSON.stringify(bM));
  const pA = await openPopup(tabId, pageUrl);
  const otherBadge = await badgeOf(await sw.evaluate(async () => (await chrome.tabs.query({ url: 'chrome-extension://*/popup.html' })).at(-1).id));
  check('mode suggestion: the badge is for that tab only', otherBadge.text === '' && otherBadge.title === 'Anime4Nerd', JSON.stringify(otherBadge));
  const sA = await prompt(pA);
  check('mode suggestion: in mode anime on a reader page, a preview of the manga card with real data', sA.shown && sA.role === 'group' && sA.label === 'Mode suggestion'
    && sA.title === 'Chainsaw Man' && sA.tag === 'ch 172' && /^2 pages\b/.test(sA.name) && !sA.card && !sA.done, JSON.stringify(sA));
  check('mode suggestion: locked, dashed, with "switch to manga" and "use auto" on the left and a red "paused" on the right', sA.locked && sA.border === '1px dashed'
    && sA.buttons === 'mp-go:button,mp-auto:button' && sA.go === 'switch to manga' && sA.auto === 'use auto' && sA.paused === '● paused' && sA.pausedColour === 'rgb(227, 154, 154)' && sA.foot,
    JSON.stringify({ locked: sA.locked, border: sA.border, buttons: sA.buttons, go: sA.go, auto: sA.auto, paused: sA.paused, colour: sA.pausedColour, foot: sA.foot }));
  check('mode suggestion: the preview stands in for the "No video found yet" text', !sA.empty, JSON.stringify({ empty: sA.empty }));
  check('mode suggestion: no dismiss button and no "this site" option', !sA.site && sA.x === 0, JSON.stringify({ site: sA.site, x: sA.x }));
  check('mode suggestion: no separator line in the popup', sA.hr === 0, `${sA.hr}`);
  check('mode suggestion: the mode chip, and only it, is framed red while the preview shows', sA.frame && sA.frames === 1 && /^rgba\(227, 154, 154/.test(sA.chipBorder), JSON.stringify({ frame: sA.frame, frames: sA.frames, border: sA.chipBorder }));
  check('mode suggestion: popup with the preview fits without a scrollbar, the preview 6px under the panel head', sA.height <= POPUP_MAX && sA.headGap === 6, `${sA.height}px, head gap ${sA.headGap}px`);
  console.log(`INFO reader page, mode anime, preview showing: popup content height ${sA.height}px`);
  // A long line is cut with an ellipsis: the preview keeps its height and the popup its width.
  const longLine = await pA.evaluate(() => {
    const el = document.getElementById('mp-preview');
    const name = document.getElementById('mp-name');
    const old = name.textContent;
    const h = el.getBoundingClientRect().height;
    name.textContent = 'That Time I Got Reincarnated as a Very Long Chapter Name · 24 pages · b&w · 1000×1399';
    const out = {
      sameHeight: el.getBoundingClientRect().height === h, cut: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth, tip: name.dataset.tip === old,
    };
    name.textContent = old;
    return out;
  });
  check('mode suggestion: a long line is cut, never wrapped', longLine.sameHeight && longLine.cut && longLine.ellipsis === 'ellipsis' && !longLine.sideways && longLine.tip, JSON.stringify(longLine));
  await pA.waitForTimeout(700);
  const quiet = await statusOf(pageUrl);
  const untouched = await page.evaluate(() => ({ canvases: document.querySelectorAll('canvas').length, blobs: [...document.images].filter((i) => i.currentSrc.startsWith('blob:')).length }));
  check('mode anime: the reader is only measured (no image fetches, no canvases, no page changes)', imageHits === hits0 && untouched.canvases === 0 && untouched.blobs === 0
    && quiet.kind === 'images' && !quiet.on && quiet.renders === 0, JSON.stringify({ fetched: imageHits - hits0, ...untouched, on: quiet.on, renders: quiet.renders }));
  if (shots) await pA.screenshot({ path: path.join(shots, 'prompt-reader.png'), clip: { x: 0, y: 0, width: 380, height: Math.min(sA.height, 600) } });

  // Keyboard: Tab reaches the preview's buttons with a visible focus; Esc hides it for this popup only.
  await pA.focus('#report');
  await pA.keyboard.press('Tab');
  const ring = await pA.evaluate(() => ({ id: document.activeElement.id, outline: getComputedStyle(document.activeElement).outlineStyle }));
  check('mode suggestion: keyboard focus is visible on the preview buttons', ring.id === 'mp-go' && ring.outline === 'solid', JSON.stringify(ring));
  await pA.keyboard.press('Escape');
  await pA.waitForTimeout(700); // past a refresh
  const sEsc = await prompt(pA);
  check('mode suggestion: Esc hides the preview and the red chip, and keeps the focus in the popup', !sEsc.shown && !sEsc.frame && sEsc.focus === 'mode' && sEsc.mode === 'anime', JSON.stringify(sEsc));
  check('mode suggestion: Esc stores nothing', Object.keys(await getOff()).length === 0 && (await badgeOf(tabId)).text === 'M');
  await pA.close();
  const pB = await openPopup(tabId, pageUrl);
  check('mode suggestion: after Esc the preview is back when the popup reopens', (await prompt(pB)).shown);

  // Switch: applied live, confirmed with an undo.
  await pB.click('#mp-go');
  await upscaled();
  await pB.waitForTimeout(700); // past a refresh
  const sDone = await prompt(pB);
  check('mode suggestion: switch to manga changes the mode and the pages upscale', await getMode() === 'manga' && blobs(await state()) && sDone.mode === 'manga');
  check('mode suggestion: a line confirms with an undo; the preview and the red chip are gone, the manga card is there', sDone.done && sDone.doneText === 'now in manga mode' && sDone.undoShown
    && !sDone.shown && !sDone.frame && sDone.card && sDone.focus === 'mp-undo', JSON.stringify(sDone));
  check('mode suggestion: the confirmation lies over the panel head and adds no height', sDone.height <= POPUP_MAX && !sDone.scrolls && sDone.headGap === 6
    && sDone.doneGaps?.[0] === sDone.doneGaps?.[1] && sDone.doneGaps?.[0] > 0, JSON.stringify({ height: sDone.height, headGap: sDone.headGap, doneGaps: sDone.doneGaps }));
  console.log(`INFO reader page, confirmation showing: popup content height ${sDone.height}px; gaps above / below the confirmation ${sDone.doneGaps}px`);
  check('mode suggestion: the badge is cleared once the mode fits', (await waitBadge(tabId, '')).text === '');
  await pB.click('#mp-undo');
  await restored();
  await promptShown(pB, true);
  const sUndo = await prompt(pB);
  check('mode suggestion: undo restores the previous mode and the originals', await getMode() === 'anime' && !blobs(await state()) && sUndo.shown && sUndo.go === 'switch to manga' && sUndo.frame
    && !sUndo.done, JSON.stringify(sUndo));
  await pB.click('#mp-go');
  await pB.waitForTimeout(3000);
  const sHeld = await prompt(pB);
  await pB.waitForTimeout(2000);
  const sGone = await prompt(pB);
  check('mode suggestion: the confirmation goes away after about 4 seconds', sHeld.done && sHeld.undoShown && !sGone.done && !sGone.shown && await getMode() === 'manga', JSON.stringify({ at3s: sHeld.done, at5s: sGone.done }));

  // A video on the reader page (a trailer, an ad): mode manga fits the page, so nothing offers to switch back.
  // An iframe with a video is offered, and forgotten when the page removes it (no navigation happens).
  await page.bringToFront();
  await page.evaluate(() => {
    const v = Object.assign(document.createElement('video'), { id: 'mixed', src: '/v.mp4', muted: true, loop: true });
    v.style.cssText = 'width:960px;height:540px;display:block';
    document.body.append(v);
    document.body.append(Object.assign(document.createElement('iframe'), { id: 'player', src: '/watch/embed', width: 980, height: 560 }));
  });
  // What the frames of the reader tab told the background: the frame says 'anime', the top page 'reader'.
  const told = () => sw.evaluate(async (t) => Object.entries((await chrome.storage.session.get('a4k-suggest'))['a4k-suggest'] ?? {})
    .filter(([k]) => k.startsWith(`${t}:`)).map(([, v]) => v).sort().join(','), tabId);
  const waitTold = async (want, ms) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (await told() === want) break;
      await page.waitForTimeout(200);
    }
    return told();
  };
  const toldFrame = await waitTold('anime,reader', 9000);
  await pB.waitForTimeout(700); // past a refresh of the popup
  const sFrame = await prompt(pB);
  const bFrame = await badgeOf(tabId);
  check('mode suggestion: a video in a frame of the reader page gets no badge and no preview (one rule for both)', toldFrame === 'anime,reader' && bFrame.text === '' && bFrame.title === 'Anime4Nerd'
    && !sFrame.shown && !sFrame.frame, JSON.stringify({ toldFrame, bFrame, preview: sFrame.shown, frame: sFrame.frame }));
  await page.evaluate(() => document.getElementById('player').remove());
  const toldGone = await waitTold('reader', 3000);
  check('mode suggestion: the frame with the video is forgotten when it is removed', toldGone === 'reader' && (await badgeOf(tabId)).text === '', JSON.stringify({ toldGone }));
  await page.waitForTimeout(6000); // past a suggestion check of the top frame
  const sMixed = await prompt(pB);
  const mixed = { videos: (await sw.evaluate((t) => chrome.tabs.sendMessage(t, { type: 'a4k-list' }, { frameId: 0 }), tabId))?.length, preview: sMixed.shown, frame: sMixed.frame, sources: sMixed.sources, badge: (await badgeOf(tabId)).text };
  check('mode suggestion: a video beside the reader does not offer anime mode', mixed.videos === 1 && !mixed.preview && !mixed.frame && mixed.sources && mixed.badge === '', JSON.stringify(mixed));
  await page.evaluate(() => document.getElementById('mixed').remove());

  // "use auto".
  await setMode('anime');
  await promptShown(pB, true);
  await pB.click('#mp-auto');
  await upscaled();
  const sAuto2 = await prompt(pB);
  check('mode suggestion: use auto switches to auto', await getMode() === 'auto' && blobs(await state()) && sAuto2.doneText === 'now in auto mode' && sAuto2.undoShown && !sAuto2.shown, JSON.stringify(sAuto2));
  await pB.click('#mp-undo');
  await promptShown(pB, true);
  check('mode suggestion: undo after use auto goes back to anime', await getMode() === 'anime');

  // The NEW badge (after an update) keeps priority; the tab badge comes back once it has been seen.
  await page.bringToFront();
  await waitBadge(tabId, 'M');
  await sw.evaluate(async () => { await chrome.storage.local.set({ 'anime4k-whats-new': '9.9.9' }); await chrome.action.setBadgeText({ text: 'NEW' }); });
  const bNew = await waitBadge(tabId, 'NEW');
  await sw.evaluate(async () => { await chrome.storage.local.remove('anime4k-whats-new'); await chrome.action.setBadgeText({ text: '' }); });
  const bBack = await waitBadge(tabId, 'M');
  check('mode suggestion: NEW badge keeps priority, and the tab badge returns after it is seen', bNew.text === 'NEW' && bNew.title === 'Anime4Nerd' && bBack.text === 'M', JSON.stringify({ bNew, bBack }));

  // Nothing is remembered per site: the badge does not depend on a stored list, and a mode
  // changed by hand brings the preview back as soon as it stops fitting the page again.
  await pB.bringToFront();
  await setOff({ '127.0.0.1': true }); // what an earlier build stored for a dismissed site
  await page.waitForTimeout(1200);
  check('mode suggestion: no stored list of sites hides the preview or the badge', (await prompt(pB)).shown && (await badgeOf(tabId)).text === 'M');
  await setOff({});
  await pickMode(pB, 'auto');
  await pB.waitForTimeout(800);
  const sHand = await prompt(pB);
  await pickMode(pB, 'anime');
  await pB.waitForTimeout(800);
  const sHand2 = await prompt(pB);
  check('mode suggestion: the preview and the red chip follow a mode changed by hand', !sHand.shown && !sHand.frame && !sHand.done && sHand2.shown && sHand2.frame && sHand2.frames === 1,
    JSON.stringify({ auto: [sHand.shown, sHand.frame], anime: [sHand2.shown, sHand2.frame] }));
  await pB.close();

  // The other direction: mode manga on a page with a video.
  await setMode('manga');
  const watch2 = await ctx.newPage();
  await watch2.goto(watchUrl);
  await watch2.bringToFront();
  const watchTab2 = await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, watchUrl);
  const bV = await waitBadge(watchTab2, 'V');
  check('mode suggestion: badge V on a video tab in mode manga', bV.text === 'V' && /video detected/.test(bV.title), JSON.stringify(bV));
  await watch2.goto(`${base}/blog/kyoto`);
  check('mode suggestion: the badge is cleared when the tab navigates', (await waitBadge(watchTab2, '', 3000)).text === '');
  await watch2.goto(watchUrl);
  await waitBadge(watchTab2, 'V');
  const pV = await openPopup(watchTab2, watchUrl);
  const sV = await prompt(pV);
  // The preview shows what the real (hidden) video card shows.
  const realCard = await pV.evaluate(() => {
    const c = document.querySelector('#sources .source');
    return { title: c?.querySelector('.title').textContent, tag: c?.querySelector('.tag').textContent, name: c?.querySelector('.epname').textContent };
  });
  check('mode suggestion: in mode manga on a video page, a preview of the video card stands in for the paused card', sV.shown && !sV.sources && !sV.empty && sV.title === realCard.title && sV.title !== ''
    && sV.tag === realCard.tag && sV.tag === 'E3' && sV.name === '360p' && sV.go === 'switch to anime' && sV.auto === 'use auto'
    && sV.frame && sV.frames === 1 && !sV.site && sV.hr === 0, JSON.stringify({ sV, realCard }));
  const headPaused = await pV.evaluate(() => { const v = document.getElementById('verdict'); return v.hidden || getComputedStyle(v).display === 'none' ? '' : v.textContent; });
  check('mode suggestion: "paused" is said once, in the performance heading; the preview does not repeat it', headPaused === '● Paused' && !sV.pausedShown, JSON.stringify({ headPaused, preview: sV.pausedShown }));
  check('mode suggestion: video popup with the preview fits without a scrollbar, the preview 6px under the panel head', sV.height <= POPUP_MAX && sV.headGap === 6, `${sV.height}px, head gap ${sV.headGap}px`);
  console.log(`INFO video page, mode manga, preview showing: popup content height ${sV.height}px`);
  if (shots) await pV.screenshot({ path: path.join(shots, 'prompt-video.png'), clip: { x: 0, y: 0, width: 380, height: Math.min(sV.height, 600) } });
  await pV.click('#mp-go');
  await watch2.bringToFront();
  await watch2.waitForSelector('canvas.a4k-canvas:not([hidden])', { state: 'attached', timeout: 30000 }).catch(() => {});
  await pV.waitForTimeout(700); // past a refresh
  const sV2 = await prompt(pV);
  check('mode suggestion: switch to anime changes the mode, the video is upscaled and its card is back', await getMode() === 'anime' && sV2.doneText === 'now in anime mode' && sV2.sources && !sV2.shown && !sV2.frame
    && await watch2.evaluate(() => document.querySelectorAll('canvas.a4k-canvas:not([hidden])').length) === 1, JSON.stringify(sV2));
  check('mode suggestion: video popup with the confirmation fits without a scrollbar', sV2.done && sV2.height <= POPUP_MAX && !sV2.scrolls && sV2.headGap === 6 && sV2.doneGaps?.[0] === sV2.doneGaps?.[1],
    JSON.stringify({ done: sV2.done, height: sV2.height, headGap: sV2.headGap, doneGaps: sV2.doneGaps }));
  console.log(`INFO video page, confirmation showing: popup content height ${sV2.height}px`);
  check('mode suggestion: the video tab badge is cleared after the switch', (await waitBadge(watchTab2, '')).text === '');
  await pV.close();
  await watch2.close();
  await setMode('auto');
  await page.bringToFront();
  await upscaled();

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
  // The failed page in the popup: a red block, a count, and the reason as the tooltip of "failed".
  const pH = await openPopup(await sw.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0].id, hugeUrl), hugeUrl);
  await pH.hover('.mc-counts [data-k="fail"]');
  await pH.waitForTimeout(700);
  const cH = await pH.evaluate(() => ({
    state: getComputedStyle(document.getElementById('manga-state')).display !== 'none',
    blocks: [...document.querySelectorAll('#mc-pages i')].map((el) => el.className).join(','),
    tiles: [...document.querySelectorAll('.mc-counts > div')].map((el) => `${el.querySelector('span').textContent.trim()}:${el.querySelector('b').textContent}`).join(','),
    failColour: getComputedStyle(document.querySelector('#mc-pages i.fail')).backgroundColor,
    failTip: document.querySelector('.mc-counts [data-k="fail"]').dataset.tip ?? '',
    tip: getComputedStyle(document.getElementById('tip')).display !== 'none' ? document.getElementById('tip').textContent : '', titles: document.querySelectorAll('[title]').length,
  }));
  check('manga card: a failed page is a red block and a count, with no status line', !cH.state && cH.blocks === 'fail,done' && cH.tiles === 'done:1,active:0,failed:1,queued:0'
    && cH.failColour === 'rgb(227, 154, 154)', JSON.stringify(cH));
  check('manga card: the failure reason is the tooltip of "failed" (the popup\'s own tooltip)', /^last error: .*too large/i.test(cH.failTip) && cH.tip === cH.failTip && cH.titles === 0, JSON.stringify({ failTip: cH.failTip, tip: cH.tip }));
  await pH.close();
  await huge.close();

  // Larger chapters: the reader tab's answer is replaced by a made-up chapter (pages done, in
  // progress, failed, waiting and not loaded yet), so the card and the map are drawn for it.
  const openChapter = async (total) => {
    const p = await ctx.newPage();
    await p.addInitScript(({ tab, total }) => {
      const query = chrome.tabs.query.bind(chrome.tabs);
      chrome.tabs.query = async (info) => (info.active ? [tab] : query(info));
      const send = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = async (...args) => {
        const reply = await send(...args);
        if (args[1]?.type !== 'a4k-manga-status' || !reply) return reply;
        // Three quarters of the chapter is on the page: half of those done, then two in progress; the 7th failed.
        const loaded = Math.floor(total * 0.75);
        const marks = Array.from({ length: loaded }, (_, i) => (i === 6 ? 'fail' : i < loaded / 2 ? 'done' : i < loaded / 2 + 2 ? 'now' : 'todo'));
        return { ...reply, on: true, total, marks, first: 0, loading: 2, done: marks.filter((m) => m === 'done').length, failed: 1, lastError: 'fetch failed', pageMs: 420 };
      };
    }, { tab: { id: tabId, url: pageUrl }, total });
    await p.goto(`chrome-extension://${extId}/popup.html`);
    await p.waitForTimeout(800);
    return p;
  };
  const chapter = (p) => p.evaluate(() => {
    const r1 = (v) => Math.round(v * 10) / 10;
    const vis = (el) => getComputedStyle(el).display !== 'none';
    const card = document.getElementById('manga-card').getBoundingClientRect();
    const bar = document.getElementById('mc-pages');
    const blocks = [...bar.children].filter(vis);
    const bb = blocks.map((el) => el.getBoundingClientRect());
    const tiles = [...document.querySelectorAll('.mc-counts > div')];
    const tb = tiles.map((el) => el.getBoundingClientRect());
    const panels = [...document.querySelectorAll('.panel')].filter(vis).map((el) => el.getBoundingClientRect());
    const body = document.body.getBoundingClientRect();
    const grid = document.getElementById('pmap-grid');
    return {
      n: bar.children.length, shares: bar.classList.contains('shares'), classes: [...bar.children].map((el) => el.className).join(','),
      label: bar.getAttribute('aria-label'), barRole: bar.getAttribute('role'),
      oneRow: new Set(bb.map((b) => b.top)).size === 1, barHeight: r1(bar.getBoundingClientRect().height),
      barRows: [...new Set(bb.map((b) => b.top))].map((top) => bb.filter((b) => b.top === top).length).join('+'), blockHeights: [...new Set(bb.map((b) => r1(b.height)))],
      rowGaps: (() => { const tops = [...new Set(bb.map((b) => b.top))].sort((x, y) => x - y); return [...new Set(tops.slice(1).map((t, i) => r1(t - tops[i] - bb[0].height)))]; })(),
      nowLook: (() => { const el = bar.querySelector('i.now'); if (!el) return ''; const cs = getComputedStyle(el); return `${cs.backgroundColor} ${cs.boxShadow}`; })(),
      keys: tiles.map((el) => { const cs = getComputedStyle(el.querySelector('.pkey')); return `${cs.backgroundColor} ${cs.borderTopWidth}`; }).join(' | '),
      numberOnTop: tiles.every((el) => el.querySelector('b').getBoundingClientRect().bottom <= el.querySelector('span').getBoundingClientRect().top),
      tilePad: tiles.map((el) => { const t = el.getBoundingClientRect(); return `${r1(el.querySelector('b').getBoundingClientRect().top - t.top)}/${r1(t.bottom - el.querySelector('span').getBoundingClientRect().bottom)}`; }),
      blockWidths: [...new Set(bb.map((b) => r1(b.width)))], blockGaps: [...new Set(bb.slice(1).map((b, i) => (b.top === bb[i].top ? r1(b.left - bb[i].right) : null)).filter((v) => v !== null))], minBlock: r1(Math.min(...bb.map((b) => b.width))),
      barInset: [r1(bb[0].left - card.left), r1(card.right - bb.at(-1).right)],
      tiles: tiles.map((el) => `${el.querySelector('span').textContent.trim()}:${el.querySelector('b').textContent}`).join(','),
      words: tiles.every((el) => /^[a-z]+$/.test(el.querySelector('span').textContent.trim())), squares: tiles.every((el) => { const k = el.querySelector('.pkey'); return k && k.offsetWidth === 6 && k.offsetHeight === 6; }),
      tileWidths: [...new Set(tb.map((b) => r1(b.width)))], tileHeights: [...new Set(tb.map((b) => r1(b.height)))], tileGaps: [...new Set(tb.slice(1).map((b, i) => r1(b.left - tb[i].right)))],
      tileInset: [r1(tb[0].left - card.left), r1(card.right - tb.at(-1).right)], tilesOneRow: new Set(tb.map((b) => b.top)).size === 1,
      // Word and number are both on the centre line of their box (half a pixel of rounding allowed).
      centred: tiles.every((el) => {
        const mid = (r) => (r.left + r.right) / 2;
        const box = el.getBoundingClientRect();
        const word = document.createRange(); word.selectNodeContents(el.querySelector('span'));
        return Math.abs(mid(el.querySelector('b').getBoundingClientRect()) - mid(box)) <= 0.5 && Math.abs(mid(el.querySelector('span').getBoundingClientRect()) - mid(box)) <= 0.5
          && Math.abs(mid(word.getBoundingClientRect()) - mid(box)) <= 1;
      }),
      sideGaps: [...new Set(panels.map((r) => `${r1(r.left - body.left)}/${r1(body.right - r.right)}`))], bodyWidth: body.width,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      mapRows: new Set([...grid.children].map((el) => el.offsetTop)).size, mapLong: grid.classList.contains('long'), mapScrolls: grid.scrollHeight > grid.clientHeight,
      legend: document.querySelectorAll('.pmap-legend, #pmap .pkey').length, hr: document.querySelectorAll('.hr').length,
      headGap: r1(card.top - document.querySelector('.panel-head').getBoundingClientRect().bottom),
      height: document.body.scrollHeight,
    };
  });
  const p24 = await openChapter(24);
  const g24 = await chapter(p24);
  check('24-page chapter: one bar block per page, in page order, coloured by its state', g24.n === 24 && !g24.shares && g24.barRole === 'img' && g24.label === '8 of 24 pages upscaled'
    && g24.classes === [...Array(6).fill('done'), 'fail', ...Array(2).fill('done'), 'now', 'now', ...Array(13).fill('wait')].join(','), JSON.stringify({ n: g24.n, classes: g24.classes, label: g24.label }));
  check('24-page chapter: four counts, done / active / failed / queued, with the right numbers', g24.tiles === 'done:8,active:2,failed:1,queued:13' && g24.words && g24.squares, g24.tiles);
  check('24-page chapter: bar blocks are 6×6px squares with 2px gaps, on one row from the left', g24.oneRow && g24.blockWidths.join() === '6' && g24.blockHeights.join() === '6' && g24.blockGaps.join() === '2' && g24.barHeight === 6
    && g24.barInset[0] === g24.tileInset[0] && g24.barInset[1] > g24.barInset[0], JSON.stringify({ widths: g24.blockWidths, heights: g24.blockHeights, gaps: g24.blockGaps, height: g24.barHeight, inset: g24.barInset }));
  check('manga card: active squares are filled white, with no outline', g24.nowLook === 'rgb(255, 255, 255) none', g24.nowLook);
  check('manga card: count tiles have the number on top and the word under it, with equal space above and below', g24.numberOnTop && new Set(g24.tilePad).size === 1
    && g24.tilePad[0].split('/')[0] === g24.tilePad[0].split('/')[1], JSON.stringify(g24.tilePad));
  check('manga card: every key square is a filled colour (done green, active white, failed red, queued grey)',
    g24.keys === 'rgb(159, 211, 168) 0px | rgb(255, 255, 255) 0px | rgb(227, 154, 154) 0px | rgb(88, 88, 88) 0px', g24.keys);
  check('24-page chapter: count boxes are equal, with equal gaps, on one row, word and number centred', g24.tilesOneRow && g24.tileWidths.length === 1 && g24.tileHeights.length === 1
    && g24.tileGaps.length === 1 && g24.tileGaps[0] === 6 && g24.centred, JSON.stringify({ widths: g24.tileWidths, heights: g24.tileHeights, gaps: g24.tileGaps, centred: g24.centred }));
  check('24-page chapter: the counts have the same inset on the left and on the right of the card, and the bar starts where they do', g24.tileInset[0] === g24.tileInset[1]
    && g24.barInset[0] === g24.tileInset[0], JSON.stringify({ bar: g24.barInset, tiles: g24.tileInset }));
  check('popup side gaps are 10px on the left and 10px on the right', g24.sideGaps.length === 1 && g24.sideGaps[0] === '10/10' && g24.bodyWidth === 380 && !g24.sideways, JSON.stringify({ gaps: g24.sideGaps, width: g24.bodyWidth }));
  check('24-page chapter upscaling: popup fits without a scrollbar, no legend, no separator line', g24.height <= POPUP_MAX && g24.mapRows === 2 && g24.legend === 0 && g24.hr === 0, `${g24.height}px, ${g24.mapRows} map rows`);
  check('manga card: 6px under the panel head, as the video card and the preview', g24.headGap === 6, `${g24.headGap}px`);
  console.log(`INFO reader page, mode auto, 24-page chapter upscaling: popup content height ${g24.height}px; bar blocks ${g24.blockWidths}px, gaps ${g24.blockGaps}px, inset ${g24.barInset}; count boxes ${g24.tileWidths}×${g24.tileHeights}px, gaps ${g24.tileGaps}px, inset ${g24.tileInset}; side gaps ${g24.sideGaps}`);
  if (shots) await p24.screenshot({ path: path.join(shots, 'manga-running.png'), clip: { x: 0, y: 0, width: 380, height: Math.min(g24.height, 600) } });
  await p24.close();
  const p80 = await openChapter(80);
  const g80 = await chapter(p80);
  check('80-page chapter: still one 6×6px square per page, 39 to a row, wrapping to more rows on the same 2px gap', g80.n === 80 && !g80.shares && g80.barRows === '39+39+2' && g80.blockWidths.join() === '6'
    && g80.blockHeights.join() === '6' && g80.blockGaps.join() === '2' && g80.rowGaps.join() === '2' && !g80.sideways && g80.height <= POPUP_MAX,
    JSON.stringify({ n: g80.n, rows: g80.barRows, widths: g80.blockWidths, gaps: g80.blockGaps, rowGaps: g80.rowGaps, height: g80.height }));
  await p80.close();
  const p120 = await openChapter(120);
  const g120 = await chapter(p120);
  check('120-page chapter: the bar is one segment per state, as wide as its share, on one row', g120.shares && g120.n === 4 && g120.classes === 'done,now,fail,wait' && g120.oneRow && g120.barHeight === 6
    && g120.minBlock >= 2 && g120.blockGaps.length === 1 && g120.blockGaps[0] === 2 && g120.barInset[0] === g120.barInset[1] && g120.tiles === 'done:44,active:2,failed:1,queued:73',
    JSON.stringify({ n: g120.n, classes: g120.classes, widths: g120.blockWidths, gaps: g120.blockGaps, min: g120.minBlock, inset: g120.barInset, tiles: g120.tiles }));
  check('120-page chapter (three-row page map that scrolls): popup fits without a scrollbar', g120.mapLong && g120.mapScrolls && g120.height <= POPUP_MAX && !g120.sideways && g120.sideGaps[0] === '10/10' && g120.sideGaps.length === 1,
    `${g120.height}px, side gaps ${g120.sideGaps}`);
  console.log(`INFO reader page, mode auto, 120-page chapter (three-row page map): popup content height ${g120.height}px; segments ${g120.blockWidths}px`);
  // The confirmation on the tallest popup: anime mode, then "switch to manga" from the preview.
  await pickMode(p120, 'anime');
  await promptShown(p120, true);
  await p120.click('#mp-go');
  await p120.waitForTimeout(700); // past a refresh
  const d120 = await prompt(p120);
  const m120 = await chapter(p120);
  check('120-page chapter with the confirmation: popup fits without a scrollbar', d120.done && d120.card && m120.mapLong && d120.height <= POPUP_MAX && !d120.scrolls && d120.height === g120.height,
    JSON.stringify({ done: d120.done, card: d120.card, long: m120.mapLong, height: d120.height, before: g120.height }));
  console.log(`INFO reader page, 120-page chapter, confirmation showing: popup content height ${d120.height}px`);
  await p120.close();
  await setMode('auto');
  const p300 = await openChapter(300);
  const g300 = await chapter(p300);
  check('300-page chapter: one failed page in 300 is still a visible segment', g300.shares && g300.oneRow && g300.minBlock >= 2 && g300.tiles === 'done:112,active:2,failed:1,queued:185' && g300.height <= POPUP_MAX,
    JSON.stringify({ min: g300.minBlock, widths: g300.blockWidths, tiles: g300.tiles, height: g300.height }));
  await p300.close();
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

  // --- Video cards drawn from made-up page replies ------------------------------------------------
  // Every frame's answer (videos, page title data, reader status) is replaced inside the popup, so
  // each layout can be drawn exactly: `stub` can be changed while the popup is open.
  const STATS = { gpuMs: 4, samples: Array(48).fill(4), cpuMs: 1, fps: 24, passes: 9, textureBytes: 1e8, outputWidth: 3840, outputHeight: 2160, timerSupported: true, sourceFps: 24 };
  const VIDEO = { id: 'site.example#1', key: 'site.example::cdn.example', frameHost: 'site.example', mediaHost: 'cdn.example', width: 1920, height: 1080, playing: true, sourceFps: 24,
    enabled: true, status: 'Active', message: '', media: null, stats: STATS };
  const META = { title: 'Some Show', season: 1, episode: 12, episodeName: null, subtitle: null, source: 'test' };
  const LONG_TITLE = 'That Time I Got Reincarnated as a Slime: The Movie, Scarlet Bond, Director\'s Cut with Commentary';
  const UNBROKEN = 'Some_Show_S01E05_1080p_x265_10bit_AAC_5.1_MultiSub_BluRay_Remux_HEVC_HDR10_DolbyVision_GroupName_ABCDEF12_final_v2_fixed.mkv';
  const openStub = async (stub, viewport) => {
    const p = await ctx.newPage();
    if (viewport) await p.setViewportSize(viewport);
    await p.addInitScript((first) => {
      window.stub = first;
      chrome.tabs.query = async () => [{ id: 1, url: 'https://site.example/watch' }];
      chrome.webNavigation.getAllFrames = async () => Object.keys(window.stub.frames).map((f) => ({ frameId: Number(f) }));
      chrome.tabs.sendMessage = async (_tab, msg, opt) => {
        const f = opt?.frameId ?? 0;
        if (msg.type === 'a4k-list') return window.stub.frames[f] ?? null;
        if (msg.type === 'a4k-page-meta') return f === 0 ? window.stub.meta ?? null : null;
        if (msg.type === 'a4k-manga-status') return f === 0 ? window.stub.manga ?? null : null;
        return null;
      };
    }, stub);
    await p.goto(`chrome-extension://${extId}/popup.html`);
    await p.waitForTimeout(800);
    return p;
  };
  const restub = async (p, stub) => { await p.evaluate((next) => { window.stub = next; }, stub); await p.waitForTimeout(800); };
  const look = (p) => p.evaluate(() => {
    const r1 = (v) => Math.round(v * 10) / 10;
    const vis = (el) => !!el && el.getClientRects().length > 0;
    const text = (el) => (vis(el) ? el.textContent : '');
    const verdict = document.getElementById('verdict');
    const body = document.body;
    const bRect = body.getBoundingClientRect();
    const panels = [...document.querySelectorAll('.panel')].filter(vis).map((el) => el.getBoundingClientRect());
    return {
      cards: [...document.querySelectorAll('#sources .source')].map((card) => {
        const q = (sel) => card.querySelector(sel);
        const box = card.getBoundingClientRect();
        const title = q('.title');
        const sw = q('.switch input').getBoundingClientRect();
        return {
          id: card.dataset.id, compact: card.classList.contains('compact'), h: r1(box.height), title: title.textContent, titleH: r1(title.getBoundingClientRect().height),
          titleCut: title.scrollWidth > title.clientWidth || title.scrollHeight > title.clientHeight + 1, titleTip: title.dataset.tip ?? '', ellipsis: getComputedStyle(title).textOverflow,
          tag: text(q('.tag')), name: text(q('.epname')), nameTip: q('.epname').dataset.tip ?? '', meta: [...q('.meta').children].map(text).join(''), metaTip: q('.meta').dataset.tip ?? '',
          why: text(q('.why')), whyColour: getComputedStyle(q('.why')).color, state: card.dataset.state, dot: getComputedStyle(title, '::before').color, tip: card.dataset.tip ?? '',
          rows: [...card.children].filter(vis).map((el) => el.className.split(' ')[0]).join(','), stateLine: card.querySelectorAll('.state').length,
          switchInside: sw.left >= box.left && sw.right <= box.right - 1 && sw.width === 36, on: q('.switch input').checked,
          oneLine: [q('.epname'), q('.host'), q('.why')].filter(vis).every((el) => el.getBoundingClientRect().height < 20),
          hostCut: q('.host').scrollWidth > q('.host').clientWidth, resWhole: q('.res').scrollWidth <= q('.res').clientWidth && q('.res').getBoundingClientRect().right <= box.right - 12,
        };
      }),
      perf: vis(document.getElementById('perf')), pmap: vis(document.getElementById('pmap')), manga: vis(document.getElementById('manga-card')),
      verdict: text(verdict), verdictColour: getComputedStyle(verdict).color, verdictTip: verdict.dataset.tip ?? '', tiles: document.getElementById('k-load').textContent,
      count: document.getElementById('count').textContent,
      height: body.scrollHeight, scrolls: body.scrollHeight > body.clientHeight, scrollsClass: document.documentElement.classList.contains('scrolls'),
      bodyWidth: bRect.width, barWidth: body.offsetWidth - body.clientWidth, maxHeight: body.style.maxHeight,
      // left gap / gap between the panels and the scrollbar's lane (or the popup's edge when there is none)
      sideGaps: [...new Set(panels.map((r) => `${r1(r.left - bRect.left)}/${r1(bRect.left + body.clientLeft + body.clientWidth - r.right)}`))],
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth || body.scrollWidth > body.clientWidth,
    };
  });
  const FULL_CARD = 89.5; // title row 22 + episode row 19 + info line 16.5 + two gaps of 5 + padding and border 22
  const heights = {};

  // One video, a season and an episode but no episode name: the quality stands beside the tag.
  const pv = await openStub({ frames: { 0: [VIDEO] }, meta: META });
  const one = await look(pv);
  check('one video: a full card with no state line, title on one line', one.cards.length === 1 && !one.cards[0].compact && one.cards[0].rows === 'line,episode,meta' && one.cards[0].stateLine === 0
    && one.cards[0].h === FULL_CARD && !one.cards[0].titleCut && one.cards[0].titleTip === '', JSON.stringify(one.cards[0]));
  check('no "Episode N" filler: tag, then the quality; info line "host · stream <stream host>"', one.cards[0].tag === 'S1 E12' && one.cards[0].name === '1080p → 3840×2160 (2×)'
    && one.cards[0].meta === 'site.example · stream cdn.example' && !/Episode/.test(JSON.stringify(one.cards[0])), JSON.stringify(one.cards[0]));
  check('one status in the performance heading: "● Upscaling" in green, the legend in its tooltip', one.perf && one.verdict === '● Upscaling' && one.verdictColour === 'rgb(159, 211, 168)'
    && one.verdictTip === 'last 2 s · dashed = limit · red = late', JSON.stringify({ verdict: one.verdict, colour: one.verdictColour, tip: one.verdictTip }));
  check('one video: the popup fits without a scrollbar, 380px wide, side gaps 10px and 10px', !one.scrolls && !one.scrollsClass && one.bodyWidth === 380 && one.barWidth === 0 && one.sideGaps.join() === '10/10' && !one.sideways,
    JSON.stringify({ height: one.height, width: one.bodyWidth, gaps: one.sideGaps }));
  heights['one video'] = one.height;
  if (shots) await pv.screenshot({ path: path.join(shots, 'one-video.png'), clip: { x: 0, y: 0, width: 380, height: Math.min(one.height, 600) } });

  // The heading follows the state; behind the frame limit it says so instead of "Upscaling".
  const headings = [];
  for (const [label, v] of [
    ['off', { enabled: false, status: 'Off', stats: null }], ['paused', { playing: false }], ['starting', { status: 'Loading', stats: null }], ['waiting', { status: 'Waiting', stats: null }],
    ['suspended', { status: 'Suspended', message: 'Paused: hidden tab.', stats: null }], ['near limit', { stats: { ...STATS, gpuMs: 38 } }], ['dropping', { stats: { ...STATS, gpuMs: 60 } }],
  ]) {
    await restub(pv, { frames: { 0: [{ ...VIDEO, ...v }] }, meta: META });
    const m = await look(pv);
    headings.push(`${label}: ${m.verdict} ${m.verdictColour} ${m.cards[0].h}`);
  }
  check('performance heading: the state of the open card in that state\'s colour; "Near limit" and "Dropping frames" when the video is behind', headings.join(' | ') === [
    'off: ● Off rgba(227, 154, 154, 0.9) 89.5', 'paused: ● Paused rgb(141, 141, 141) 89.5', 'starting: ● Starting… rgb(227, 197, 138) 89.5', 'waiting: ● Waiting rgb(141, 141, 141) 89.5',
    'suspended: ● Suspended rgb(141, 141, 141) 89.5', 'near limit: ● Near limit rgb(227, 197, 138) 89.5', 'dropping: ● Dropping frames rgb(227, 154, 154) 89.5',
  ].join(' | '), headings.join(' | '));
  // Paused: the header chip says so instead of the last GPU time; the graph keeps the last run the page sent.
  await restub(pv, { frames: { 0: [{ ...VIDEO, playing: false }] }, meta: META });
  const pausedLook = await pv.evaluate(() => ({ chip: document.getElementById('gpuchip').textContent, bars: [...document.querySelectorAll('#bars i')].filter((b) => !b.classList.contains('empty')).length }));
  check('paused: the header chip reads "paused", and the graph keeps the last 2 s of bars', pausedLook.chip === 'paused' && pausedLook.bars > 0, JSON.stringify(pausedLook));
  await restub(pv, { frames: { 0: [{ ...VIDEO, enabled: false, status: 'Off', stats: null }] }, meta: META });
  const offTip = (await look(pv)).verdictTip;
  check('performance heading: its tooltip is the state\'s long reason and the legend', offTip === 'Tap to turn on · turn the video on to start measuring', offTip);

  // A real episode name is shown as before, and the info line keeps the quality.
  await restub(pv, { frames: { 0: [VIDEO] }, meta: { ...META, episodeName: 'The Long Awaited Reunion' } });
  const named = (await look(pv)).cards[0];
  check('a real episode name is still shown beside the tag; the info line has the quality', named.tag === 'S1 E12' && named.name === 'The Long Awaited Reunion'
    && named.meta === 'site.example · 1080p → 3840×2160 (2×)' && named.h === FULL_CARD, JSON.stringify(named));

  // No season or episode at all: a tag no matter what.
  await restub(pv, { frames: { 0: [VIDEO] }, meta: { ...META, title: 'Short Show', season: null, episode: null } });
  const bareShort = await look(pv);
  check('no episode, short title: a "1080p" quality tag with the output, then "host · stream host"', bareShort.cards[0].tag === '1080p' && bareShort.cards[0].name === '→ 3840×2160 (2×)'
    && bareShort.cards[0].meta === 'site.example · stream cdn.example' && bareShort.cards[0].h === FULL_CARD && bareShort.cards[0].rows === 'line,episode,meta', JSON.stringify(bareShort.cards[0]));
  if (shots) await pv.screenshot({ path: path.join(shots, 'no-episode-short.png'), clip: { x: 0, y: 0, width: 380, height: Math.min(bareShort.height, 600) } });
  await restub(pv, { frames: { 0: [VIDEO] }, meta: { ...META, title: LONG_TITLE, season: null, episode: null } });
  const bareLong = await look(pv);
  check('no episode, long title: the title takes two lines and the tag row ("1080p", "→ output · host") stands in for the info line', bareLong.cards[0].tag === '1080p'
    && bareLong.cards[0].name === '→ 3840×2160 (2×) · site.example' && bareLong.cards[0].rows === 'line,episode' && bareLong.cards[0].titleH === 43.5 && bareLong.cards[0].h === FULL_CARD
    && bareLong.cards[0].nameTip === 'stream: cdn.example', JSON.stringify(bareLong.cards[0]));
  check('a title cut on its two lines has the full title in the popup\'s own tooltip', bareLong.cards[0].titleCut && bareLong.cards[0].titleTip === LONG_TITLE, JSON.stringify({ cut: bareLong.cards[0].titleCut, tip: bareLong.cards[0].titleTip }));
  if (shots) await pv.screenshot({ path: path.join(shots, 'no-episode-long.png'), clip: { x: 0, y: 0, width: 380, height: Math.min(bareLong.height, 600) } });

  // Long texts: one line and an ellipsis, the full text in the tooltip, and the switch never moves.
  await restub(pv, { frames: { 0: [VIDEO] }, meta: { ...META, title: LONG_TITLE, episodeName: 'The Long Awaited Reunion At The Border Fortress Where Everything Finally Changes' } });
  const longBoth = (await look(pv)).cards[0];
  check('long title and long episode name: one line each with an ellipsis, the full text in the tooltip', longBoth.titleH < 20 && longBoth.titleCut && longBoth.ellipsis === 'ellipsis'
    && longBoth.titleTip === LONG_TITLE && longBoth.oneLine && longBoth.nameTip === 'The Long Awaited Reunion At The Border Fortress Where Everything Finally Changes' && longBoth.h === FULL_CARD, JSON.stringify(longBoth));
  const unbroken = [];
  for (const meta of [{ ...META, title: UNBROKEN }, { ...META, title: UNBROKEN, season: null, episode: null }]) {
    await restub(pv, { frames: { 0: [VIDEO] }, meta });
    const m = await look(pv);
    unbroken.push({ ...m.cards[0], sideways: m.sideways, width: m.bodyWidth });
  }
  check(`an unbroken ${UNBROKEN.length}-char title: the switch stays inside the card, nothing scrolls sideways, the card keeps its height (with and without an episode)`,
    unbroken.every((c) => c.switchInside && !c.sideways && c.width === 380 && c.h === FULL_CARD && c.titleTip === UNBROKEN), JSON.stringify(unbroken.map((c) => ({ in: c.switchInside, h: c.h, sideways: c.sideways, titleH: c.titleH }))));
  const LONG_HOST = `${'stream-edge-node-0042-eu-central'}.${'x'.repeat(63)}.cdn.example`;
  await restub(pv, { frames: { 0: [{ ...VIDEO, mediaHost: LONG_HOST }] }, meta: { ...META, episodeName: 'Pilot' } });
  await pv.hover('#sources .source .meta');
  await pv.waitForTimeout(700);
  const tipBox = await pv.evaluate(() => { const t = document.getElementById('tip'); return { shown: getComputedStyle(t).display !== 'none', text: t.textContent, width: t.offsetWidth, spill: t.scrollWidth > t.clientWidth, lines: Math.round(t.clientHeight / 15) }; });
  check('tooltip: a long host name wraps inside the box', tipBox.shown && tipBox.text === `stream: ${LONG_HOST}` && tipBox.width <= 240 && !tipBox.spill && tipBox.lines > 1, JSON.stringify(tipBox));
  await pv.mouse.move(190, 5);

  // Not possible: the heading says so, the info line says why in a few words, the tooltip has the full message.
  const CORS = 'This video source does not allow browser upscaling (cross-origin without CORS). Normal playback is available.';
  const impossible = [];
  for (const message of [CORS, 'Texture limit of this GPU is 4096.', 'WebGL2 is not available.', 'Anime4K initialization timed out.']) {
    await restub(pv, { frames: { 0: [{ ...VIDEO, status: 'Unavailable', message, stats: null }] }, meta: META });
    const m = await look(pv);
    impossible.push({ why: m.cards[0].why, tip: m.cards[0].metaTip === message, verdict: m.verdict, colour: m.verdictColour, whyColour: m.cards[0].whyColour, h: m.cards[0].h, tag: m.cards[0].tag, name: m.cards[0].name, meta: m.cards[0].meta, tips: m.verdictTip.startsWith(message), height: m.height });
  }
  check('not possible: "● Not possible" in the heading, a few plain words in the bad colour on the info line, the full message in the tooltip',
    impossible.map((x) => x.why).join(' | ') === 'this site blocks access to its video | too large for this GPU | the GPU is not available | anime4k initialization timed out'
    && impossible.every((x) => x.tip && x.tips && x.verdict === '● Not possible' && x.colour === 'rgb(227, 154, 154)' && x.whyColour === 'rgb(227, 154, 154)' && x.h === FULL_CARD && x.tag === 'S1 E12' && x.name === '' && x.meta === x.why),
    JSON.stringify(impossible));
  await restub(pv, { frames: { 0: [{ ...VIDEO, status: 'Unavailable', message: CORS, stats: null }] }, meta: META });
  if (shots) await pv.screenshot({ path: path.join(shots, 'not-possible.png'), clip: { x: 0, y: 0, width: 380, height: Math.min(impossible[0].height, 600) } });

  // Capped: short on the card, "GPU limit" in the tooltip.
  await sw.evaluate(async () => { const cur = (await chrome.storage.sync.get('anime4k')).anime4k ?? {}; await chrome.storage.sync.set({ anime4k: { ...cur, upscale: '8x' } }); });
  await restub(pv, { frames: { 0: [VIDEO] }, meta: { ...META, episodeName: 'Pilot' } });
  const capA = (await look(pv)).cards[0];
  await restub(pv, { frames: { 0: [VIDEO] }, meta: META });
  const capB = (await look(pv)).cards[0];
  await restub(pv, { frames: { 0: [{ ...VIDEO, loadCapped: true }] }, meta: META });
  const capLoad = (await look(pv)).cards[0];
  check('capped by load: "· 8× capped" on the card, "GPU load" in the tooltip', capLoad.name === '1080p → 3840×2160 (2×) · 8× capped' && capLoad.nameTip === '8× capped: GPU load', JSON.stringify({ name: capLoad.name, tip: capLoad.nameTip }));
  await sw.evaluate(async () => { const cur = (await chrome.storage.sync.get('anime4k')).anime4k ?? {}; await chrome.storage.sync.set({ anime4k: { ...cur, upscale: 'auto' } }); });
  check('capped: "· 8× capped" on the card, "GPU limit" in the tooltip only; on a full info line the host gives way (its full text in the tooltip), never the quality', capA.meta === 'site.example · 1080p → 3840×2160 (2×) · 8× capped' && capA.metaTip === 'site.example · stream: cdn.example · 8× capped: GPU limit' && capA.resWhole
    && capB.name === '1080p → 3840×2160 (2×) · 8× capped' && capB.nameTip === '8× capped: GPU limit' && !/GPU limit/.test(capA.meta + capB.name + capB.meta), JSON.stringify({ capA, capB }));
  await pv.close();

  // Several videos: one card is open, the others are compact rows.
  const vid = (n, over = {}) => ({ ...VIDEO, id: `site.example#${n}`, key: `site.example::cdn${n}.example`, mediaHost: `cdn${n}.example`, media: { title: `Video ${n}`, artist: null, album: null }, ...over });
  const IDLE = { enabled: false, status: 'Off', playing: false, stats: null };
  const NO_META = { title: null, season: null, episode: null, episodeName: null, subtitle: null, source: 'test' };
  const openOf = (m) => m.cards.filter((c) => !c.compact).map((c) => c.title).join(',');
  const tiers = [];
  for (const [label, videos, want] of [
    ['upscaling beats playing', [vid(1, { ...IDLE, playing: true }), vid(2, { playing: false, width: 640, height: 360 })], 'Video 2'],
    ['several upscaling: the one playing', [vid(1, { playing: false }), vid(2), vid(3, { playing: false })], 'Video 2'],
    ['none upscaling: the one playing', [vid(1, IDLE), vid(2, { ...IDLE, playing: true, width: 640, height: 360 }), vid(3, IDLE)], 'Video 2'],
    ['none playing: the largest', [vid(1, { ...IDLE, width: 640, height: 360 }), vid(2, IDLE), vid(3, { ...IDLE, width: 1280, height: 720 })], 'Video 2'],
    ['all alike: the first in the list', [vid(1, IDLE), vid(2, IDLE), vid(3, IDLE)], 'Video 1'],
  ]) {
    const p = await openStub({ frames: { 0: videos }, meta: NO_META });
    const m = await look(p);
    tiers.push(`${label}: ${openOf(m) === want ? 'ok' : `opened "${openOf(m)}", want "${want}"`}`);
    heights[`${videos.length} videos`] ??= m.height;
    if (label.startsWith('all alike')) {
      // The choice is made when the popup opens: a video that starts upscaling later does not take the open card.
      await restub(p, { frames: { 0: [vid(1, IDLE), vid(2, IDLE), vid(3)] }, meta: NO_META });
      await p.waitForTimeout(700);
      const later = await look(p);
      check('open card: it does not jump while the popup is open', openOf(later) === 'Video 1' && later.cards[2].compact && later.cards[2].state === 'ok' && later.verdict === '● Off', JSON.stringify({ open: openOf(later), verdict: later.verdict }));
    }
    await p.close();
  }
  check('open card: upscaling, then playing, then the largest, then the first', tiers.every((t) => t.endsWith(': ok')), tiers.join(' | '));

  const pm = await openStub({ frames: { 0: [vid(1), vid(2, IDLE)] }, meta: NO_META });
  const two = await look(pm);
  heights['2 videos'] = two.height;
  check('two videos: the open card is full, the other one compact row (dot in the state colour, title, switch), details in its tooltip', two.cards.length === 2 && two.count === '2 videos'
    && !two.cards[0].compact && two.cards[0].h === FULL_CARD && two.cards[1].compact && two.cards[1].rows === 'line' && two.cards[1].h === 34 && two.cards[1].dot === 'rgba(227, 154, 154, 0.9)'
    && two.cards[1].switchInside && two.cards[1].tip === 'Video 2 · site.example · 1080p → 2160p (2×) · Off: Tap to turn on' && two.cards[0].tip === '' && two.cards[1].titleTip === '', JSON.stringify(two.cards));
  // 626px, as designed: with the headings in the preset panel a second card no longer fits in 600px.
  check('two videos: the popup scrolls by 26px, with its bar outside the 10px right gap', two.height === one.height + 44 && two.scrolls && two.bodyWidth === 387 && two.sideGaps.join() === '10/10' && !two.sideways, `${two.height}px`);
  if (shots) await pm.screenshot({ path: path.join(shots, 'two-videos.png'), clip: { x: 0, y: 0, width: 380, height: Math.min(two.height, 600) } });
  const sourcesNow = () => sw.evaluate(async () => (await chrome.storage.local.get('anime4k-sources'))['anime4k-sources'] ?? {});
  const stored0 = await sourcesNow();
  await pm.click('#sources .source:nth-child(2) .title');
  await pm.waitForTimeout(800);
  const swapped = await look(pm);
  check('compact card: a click on its title opens it and folds the open one, and switches nothing', swapped.cards[0].compact && !swapped.cards[1].compact && swapped.cards[1].h === FULL_CARD
    && swapped.cards[0].dot === 'rgb(159, 211, 168)' && JSON.stringify(await sourcesNow()) === JSON.stringify(stored0), JSON.stringify(swapped.cards.map((c) => ({ compact: c.compact, h: c.h, dot: c.dot }))));
  check('performance panel follows the open card', two.verdict === '● Upscaling' && two.tiles !== '—' && swapped.verdict === '● Off' && swapped.tiles === '—', JSON.stringify({ before: [two.verdict, two.tiles], after: [swapped.verdict, swapped.tiles] }));
  await pm.click('#sources .source:nth-child(1) .switch');
  await pm.waitForTimeout(800);
  const flipped = await look(pm);
  const stored1 = await sourcesNow();
  check('compact card: its switch toggles that video directly, without opening it', flipped.cards[0].compact && !flipped.cards[1].compact && !flipped.cards[0].on
    && 'site.example::cdn1.example' in stored1 === false && !('site.example::cdn2.example' in stored1), JSON.stringify({ compact: flipped.cards.map((c) => c.compact), on: flipped.cards.map((c) => c.on), stored: Object.keys(stored1) }));
  await pm.click('#sources .source:nth-child(1) .switch');
  await pm.waitForTimeout(400);
  check('compact card: the switch again turns it back on', (await sourcesNow())['site.example::cdn1.example'] === true && (await look(pm)).cards[0].compact, JSON.stringify(Object.keys(await sourcesNow())));
  await sw.evaluate(async (v) => { await chrome.storage.local.set({ 'anime4k-sources': v }); }, stored0);
  await pm.close();

  // Videos in several frames of one host: each has a card of its own.
  const framed = (n) => ({ ...VIDEO, id: 'player.example#1', key: `player.example::cdn${n}.example`, frameHost: 'player.example', mediaHost: `cdn${n}.example`, ...IDLE });
  const pf = await openStub({ frames: { 0: [vid(1)], 4: [framed(4)], 7: [framed(7)] }, meta: NO_META });
  const inFrames = await look(pf);
  check('video ids are unique across frames: two frames of one host get two cards', inFrames.cards.length === 3 && new Set(inFrames.cards.map((c) => c.id)).size === 3 && inFrames.count === '3 videos',
    JSON.stringify(inFrames.cards.map((c) => c.id)));
  await pf.close();

  // Many videos: the popup scrolls. Its bar sits outside the right gap and the popup is 7px wider.
  const pmany = await openStub({ frames: { 0: [1, 2, 3, 4, 5, 6].map((n) => vid(n, n > 1 ? IDLE : {})) }, meta: NO_META });
  const many = await look(pmany);
  check('popup that scrolls: 387px wide, left gap 10px, 10px between the panels and the 7px bar lane, nothing sideways', many.scrolls && many.scrollsClass && many.bodyWidth === 387 && many.barWidth === 7
    && many.sideGaps.join() === '10/10' && !many.sideways, JSON.stringify({ height: many.height, width: many.bodyWidth, bar: many.barWidth, gaps: many.sideGaps }));
  heights['6 videos'] = many.height;
  // The mode list hangs under the chip: opened by keyboard in a scrolled popup, the popup goes to the top first.
  await pmany.evaluate(() => { document.body.scrollTop = 150; });
  await pmany.evaluate(() => document.getElementById('mode').focus({ preventScroll: true }));
  const scrolledBy = await pmany.evaluate(() => document.body.scrollTop);
  await pmany.keyboard.press('ArrowDown');
  const listTop = await pmany.evaluate(() => {
    const list = document.getElementById('mode-list').getBoundingClientRect();
    return { open: document.getElementById('mode').getAttribute('aria-expanded'), scrollTop: document.body.scrollTop, inside: list.top >= 0 && list.height > 0 };
  });
  await pmany.keyboard.press('Escape');
  check('mode list opened by keyboard in a scrolled popup: the popup scrolls to the top first', scrolledBy > 0 && listTop.open === 'true' && listTop.scrollTop === 0 && listTop.inside, JSON.stringify({ scrolledBy, ...listTop }));
  await restub(pmany, { frames: { 0: [vid(1)] }, meta: NO_META });
  const fewer = await look(pmany);
  check('popup that stops scrolling: back to 380px with 10px on both sides', !fewer.scrolls && !fewer.scrollsClass && fewer.bodyWidth === 380 && fewer.barWidth === 0 && fewer.sideGaps.join() === '10/10', JSON.stringify({ width: fewer.bodyWidth, gaps: fewer.sideGaps }));
  await pmany.close();

  // Browser zoom above 100%: the popup window stays lower than the content. Body takes the window's
  // height, so the popup scrolls instead of being cut off.
  const pz = await openStub({ frames: { 0: [VIDEO] }, meta: META }, { width: 387, height: 440 });
  await pz.waitForTimeout(1200); // the window is given time to grow before its height is taken as final
  const zoomed = await look(pz);
  const reach = await pz.evaluate(() => {
    document.body.scrollTop = document.body.scrollHeight;
    const last = [...document.querySelectorAll('.panel')].at(-1).getBoundingClientRect();
    return { lastBottom: Math.round(last.bottom), view: innerHeight };
  });
  check('window lower than the content (browser zoom): body takes the window height and scrolls, the last panel can be reached', zoomed.maxHeight === '440px' && zoomed.scrolls && zoomed.scrollsClass
    && zoomed.height > 440 && reach.lastBottom <= reach.view - 10, JSON.stringify({ maxHeight: zoomed.maxHeight, scrolls: zoomed.scrolls, content: zoomed.height, ...reach }));
  await pz.setViewportSize({ width: 387, height: 900 });
  await pz.waitForTimeout(800);
  const unzoomed = await look(pz);
  check('window tall enough again: the limit is dropped and nothing scrolls', unzoomed.maxHeight === '' && !unzoomed.scrolls && !unzoomed.scrollsClass && unzoomed.bodyWidth === 380, JSON.stringify({ maxHeight: unzoomed.maxHeight, scrolls: unzoomed.scrolls }));
  await pz.close();

  // A manga reader on the page: no performance panel even while a video is upscaling, and the video card is compact.
  const real = await statusOf(pageUrl);
  const marks = Array.from({ length: 30 }, (_, i) => (i < 18 ? 'done' : i < 20 ? 'now' : 'todo'));
  const READER = { ...real, on: true, kind: 'images', meta: { series: 'Chainsaw Man', volume: null, chapter: '172', chapterTitle: null }, marks, first: 0, loading: 0, total: 30, current: 0, done: 18, failed: 0,
    lastError: null, grey: false, size: { w: 900, h: 1300 }, perPageMs: 120, pageMs: 420, imageHost: 'img.example', host: 'site.example' };
  await setManga({ 'site.example': true });
  // A 12-page chapter (one row in the page map) fits beside a video; the 30-page one is measured after it.
  const pr = await openStub({ frames: { 0: [VIDEO] }, meta: META, manga: { ...READER, marks: marks.slice(12), total: 12, done: 6 } });
  const beside12 = await look(pr);
  await restub(pr, { frames: { 0: [VIDEO] }, meta: META, manga: READER });
  const beside = await look(pr);
  check('video beside a reader: no performance panel while the video is upscaling, the page map shows, the video card is compact with a green dot', beside.manga && beside.pmap && !beside.perf
    && beside.cards.length === 1 && beside.cards[0].compact && beside.cards[0].h === 34 && beside.cards[0].dot === 'rgb(159, 211, 168)' && /Upscaling$/.test(beside.cards[0].tip), JSON.stringify({ perf: beside.perf, pmap: beside.pmap, card: beside.cards[0] }));
  check('video beside a reader: with a 12-page chapter the popup fits without a scrollbar', !beside12.scrolls && beside12.bodyWidth === 380 && beside12.sideGaps.join() === '10/10' && beside12.cards[0].compact,
    `${beside12.height}px; with 30 pages (three map rows) ${beside.height}px`);
  heights['video + reader (12 pages)'] = beside12.height;
  heights['video + reader (30 pages)'] = beside.height;
  await pr.click('#sources .source .title');
  await pr.waitForTimeout(700);
  check('video beside a reader: its card stays compact when clicked', (await look(pr)).cards[0].compact);
  if (shots) await pr.screenshot({ path: path.join(shots, 'video-plus-reader.png'), clip: { x: 0, y: 0, width: 380, height: Math.min(beside.height, 600) } });
  await restub(pr, { frames: { 0: [] }, meta: META, manga: READER });
  const reading = await look(pr);
  const upscaleHead = await pr.evaluate(() => [...document.querySelectorAll('.sub-head')].filter((el) => el.getClientRects().length).map((el) => el.textContent).join(','));
  check('reader page: no heading over the hidden upscale row', upscaleHead === 'effects' && !reading.perf, upscaleHead);
  heights['reader, 30 pages running'] = reading.height;
  await pr.close();
  await setManga({});

  // After an update: a chip in the header in place of the clock, for this one popup opening. No banner.
  const pn0 = await openStub({ frames: { 0: [VIDEO] }, meta: META });
  const plainHeader = await pn0.evaluate(() => ({ clock: !!document.getElementById('clock')?.isConnected, chip: getComputedStyle(document.getElementById('whatsnew')).display !== 'none', height: document.body.scrollHeight }));
  await pn0.close();
  await sw.evaluate(async () => { await chrome.storage.local.set({ 'anime4k-whats-new': '1.2.6' }); });
  const pn = await openStub({ frames: { 0: [VIDEO] }, meta: META });
  const chip = await pn.evaluate(() => {
    const el = document.getElementById('whatsnew');
    const row = [...document.querySelectorAll('.bar > *')].map((c) => c.getBoundingClientRect());
    return {
      inHeader: el.parentElement.classList.contains('bar'), text: el.textContent, tip: el.dataset.tip ?? '', href: el.href, target: el.target, cls: el.className,
      afterGpu: el.previousElementSibling?.id, beforeBug: el.nextElementSibling?.id, clock: !!document.getElementById('clock'),
      oneRow: row.every((r) => r.top === row[0].top && r.height === row[0].height), banner: document.querySelectorAll('.update-note, .update-link').length, height: document.body.scrollHeight,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  const pending = await sw.evaluate(async () => (await chrome.storage.local.get('anime4k-whats-new'))['anime4k-whats-new'] ?? null);
  check('what\'s new: a header chip "● new v1.2.6" in place of the clock, with a tooltip and the release notes link', chip.inHeader && chip.text === '● new v1.2.6' && chip.tip === 'Updated to v1.2.6 · see what\'s new'
    && /#changes$/.test(chip.href) && chip.target === '_blank' && chip.afterGpu === 'gpuchip' && chip.beforeBug === 'report' && !chip.clock, JSON.stringify(chip));
  check('what\'s new: no banner, the header stays one row and the popup keeps its height', chip.banner === 0 && chip.oneRow && !chip.sideways && chip.height === plainHeader.height && plainHeader.clock && !plainHeader.chip,
    JSON.stringify({ banner: chip.banner, oneRow: chip.oneRow, height: `${plainHeader.height} -> ${chip.height}` }));
  check('what\'s new: shown for one popup opening (the flag is cleared)', pending === null, String(pending));
  await pn.close();

  // The rating card keeps its full form; the popup may scroll while it shows.
  const rateBefore = await sw.evaluate(async () => (await chrome.storage.local.get('anime4k-rate'))['anime4k-rate'] ?? null);
  await sw.evaluate(async () => { await chrome.storage.local.set({ 'anime4k-rate': { seconds: 16560, episodes: 12, shown: 1, clicked: false, rated: false, returning: false } }); });
  const prate = await openStub({ frames: { 0: [VIDEO] }, meta: META });
  const rated = await look(prate);
  const rateCard = await prate.evaluate(() => { const el = document.getElementById('rate'); return { shown: el.getClientRects().length > 0, strip: el.classList.contains('rate-strip'), rows: el.querySelectorAll('.rate-top, .rate-big, .rate-row').length, h: el.getBoundingClientRect().height }; });
  check('rating card: unchanged, the full card', rateCard.shown && !rateCard.strip && rateCard.rows === 3 && rateCard.h > 80, JSON.stringify(rateCard));
  heights['one video + rating card'] = rated.height;
  await prate.close();
  await sw.evaluate(async (v) => { if (v) await chrome.storage.local.set({ 'anime4k-rate': v }); else await chrome.storage.local.remove('anime4k-rate'); }, rateBefore);

  const pnone = await openStub({ frames: { 0: [] }, meta: META });
  heights['no video'] = (await look(pnone)).height;
  await pnone.close();
  console.log(`INFO popup content heights: ${Object.entries(heights).map(([k, v]) => `${k} ${v}px`).join('; ')}`);

  check('no uncaught errors in any popup', popupErrors.length === 0, popupErrors.join(' | '));
} finally {
  await ctx.close();
  images.close(); images2.close(); pages.close();
}
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);

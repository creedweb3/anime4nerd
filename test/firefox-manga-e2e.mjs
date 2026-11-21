// Manga mode in Firefox: the reader fixtures of test/manga-e2e.mjs, run against the Firefox build.
// Checks detection, upscaling, the popup's manga card, page map and mode list, and the guarded
// background image fetch (private addresses, a public name that resolves to a private address,
// redirects).
//
// Needs ffmpeg on PATH, Playwright (global or local) with its Firefox
// (`npx playwright install firefox`), and a fresh `npm run build:firefox`.
//
//   node test/firefox-manga-e2e.mjs
//
// Headless. Playwright cannot drive the add-on's background page or see its moz-extension://
// tabs, so a test-only copy of the add-on gets these additions:
// - the content script relays window messages from the page to the background, which answers a
//   few test commands;
// - the real popup is shown in an iframe on a test page. A framed extension page in Firefox gets
//   only the content-script APIs, so the popup's tabs, webNavigation, scripting and action calls
//   are forwarded to the background, and its active tab is the reader tab named in its address.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RDP_PORT = 6125;

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const { firefox } = loadPlaywright();

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-ffmanga-'));
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=900x1300', '-frames:v', '1', '-q:v', '4', path.join(work, 'colour.jpg')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=900x1300', '-frames:v', '1', '-vf', 'format=gray', '-q:v', '4', path.join(work, 'grey.jpg')]);
ff(['-f', 'lavfi', '-i', 'testsrc2=size=64x64', '-frames:v', '1', path.join(work, 'icon.png')]);

const serve = (handler, host = '127.0.0.1') => new Promise((ok) => { const s = http.createServer(handler).listen(0, host, () => ok(s)); });
let blindHits = 0; // requests that must never be made
const images = await serve((req, res) => {
  if (req.url.startsWith('/nothing')) { res.writeHead(204).end(); return; }
  if (req.url.includes('blind=1')) blindHits++;
  const to = (url) => res.writeHead(302, { Location: url }).end();
  if (req.url.startsWith('/to-local')) return to(`http://127.0.0.2:${images2.address().port}/colour.jpg?blind=1`);
  if (req.url.startsWith('/to-trick')) return to(`http://trick.mangatest.example:${images2.address().port}/colour.jpg`);
  if (req.url.startsWith('/to-ok')) return to(`http://same.mangatest.example:${images.address().port}/colour.jpg#frag`);
  if (req.url.startsWith('/to-relative')) return to('/colour.jpg');
  if (req.url.startsWith('/loop')) return to('/loop');
  const file = path.join(work, path.basename(req.url.split('?')[0]));
  if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.png') ? 'image/png' : 'image/jpeg' }); // no CORS headers on purpose
  fs.createReadStream(file).pipe(res);
});
const imgBase = `http://127.0.0.1:${images.address().port}`;
// The same files on a second loopback address, for the DNS trick check.
const images2 = await serve((req, res) => images.emit('request', req, res), '127.0.0.2');
const pages = await serve((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.url.startsWith('/blog')) {
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

// Test-only copy of the add-on.
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-ffmanga-dist-'));
fs.cpSync(path.join(root, 'dist-firefox'), dist, { recursive: true });
fs.appendFileSync(path.join(dist, 'content.js'), `
window.addEventListener('message', (e) => {
  if (e.source !== window || !e.data?.a4kTest) return;
  const { id, op, args } = e.data.a4kTest;
  browser.runtime.sendMessage({ type: 'a4k-test', op, args }).then((result) => window.postMessage({ a4kTestReply: { id, result } }, '*'),
    (err) => window.postMessage({ a4kTestReply: { id, result: { testError: String(err) } } }, '*'));
});
`);
fs.appendFileSync(path.join(dist, 'background.js'), `
// Not tabs.query({ url }): Firefox match patterns take no port.
const tabOf = async (url) => (await browser.tabs.query({})).find((t) => t.url === url);
const testOps = {
  setManga: (v) => browser.storage.local.set({ 'a4k-manga': v }),
  getManga: async () => (await browser.storage.local.get('a4k-manga'))['a4k-manga'] ?? {},
  settings: async (patch) => {
    const cur = (await browser.storage.sync.get('anime4k')).anime4k ?? {};
    await browser.storage.sync.set({ anime4k: { ...cur, ...patch } });
    return (await browser.storage.sync.get('anime4k')).anime4k;
  },
  status: async (url) => browser.tabs.sendMessage((await tabOf(url)).id, { type: 'a4k-manga-status' }, { frameId: 0 }),
  // The page itself asks the background for an image, as manga.ts does.
  ask: async ({ page, url }) => {
    const [r] = await browser.scripting.executeScript({ target: { tabId: (await tabOf(page)).id }, func: (u) => browser.runtime.sendMessage({ type: 'a4k-fetch-image', url: u }), args: [url] });
    return r.result;
  },
  badge: async (url) => {
    const tabId = (await tabOf(url)).id;
    return { text: await browser.action.getBadgeText({ tabId }), title: await browser.action.getTitle({ tabId }) };
  },
  popupUrl: async (url) => browser.runtime.getURL('popup.html?tab=' + (await tabOf(url)).id),
};
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'a4k-test') return Promise.resolve(testOps[msg.op](msg.args));
  if (msg?.type === 'a4k-test-api') return browser[msg.ns][msg.fn](...msg.args);
  return undefined;
});
`);
const manifestPath = path.join(dist, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.web_accessible_resources.push({ resources: ['popup.html', 'popup.js', 'popup.css'], matches: ['<all_urls>'] });
fs.writeFileSync(manifestPath, JSON.stringify(manifest));
const popupJs = path.join(dist, 'popup.js');
fs.writeFileSync(popupJs, `{
  const forward = (ns, fn) => (...args) => browser.runtime.sendMessage({ type: 'a4k-test-api', ns, fn, args });
  const apis = { tabs: ['query', 'get', 'sendMessage'], webNavigation: ['getAllFrames'], scripting: ['executeScript', 'insertCSS'],
    action: ['setBadgeText', 'setBadgeBackgroundColor', 'setBadgeTextColor', 'setTitle'] };
  for (const [ns, fns] of Object.entries(apis)) browser[ns] = Object.fromEntries(fns.map((fn) => [fn, forward(ns, fn)]));
  const want = Number(new URLSearchParams(location.search).get('tab'));
  const query = browser.tabs.query;
  browser.tabs.query = async (info) => (info.active ? [await browser.tabs.get(want)] : query(info));
}
${fs.readFileSync(popupJs, 'utf8')}`);

/** Firefox remote debugging protocol: "<byte length>:<json>" packets. */
function connectRdp() {
  const sock = net.connect(RDP_PORT, '127.0.0.1');
  let buf = Buffer.alloc(0);
  const waiters = [];
  sock.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      const i = buf.indexOf(':');
      if (i < 0) return;
      const n = Number(buf.subarray(0, i).toString());
      if (buf.length < i + 1 + n) return;
      const msg = JSON.parse(buf.subarray(i + 1, i + 1 + n).toString('utf8'));
      buf = buf.subarray(i + 1 + n);
      if (/ListChanged$/.test(msg.type ?? '')) continue; // unsolicited notifications
      const w = waiters.findIndex((x) => x.from === msg.from);
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg);
    }
  });
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    waiters.push({ from: 'root', resolve: () => resolve({
      send: (to, packet) => new Promise((r) => {
        waiters.push({ from: to, resolve: r });
        const s = JSON.stringify({ to, ...packet });
        sock.write(`${Buffer.byteLength(s)}:${s}`);
      }),
      close: () => sock.destroy(),
    }) });
  });
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-ffmanga-profile-'));
const ctx = await firefox.launchPersistentContext(profile, {
  headless: true,
  viewport: { width: 1000, height: 900 },
  args: ['-start-debugger-server', String(RDP_PORT)],
  firefoxUserPrefs: {
    'devtools.debugger.remote-enabled': true,
    'devtools.debugger.prompt-connection': false,
    'xpinstall.signatures.required': false,
    'extensions.background.idle.timeout': 600000,
    // Public-looking names that resolve to this machine, like a hostile DNS record would: these two
    // to 127.0.0.1, every other name (trick.mangatest.example) to 127.0.0.2.
    'network.dns.localDomains': 'reader.mangatest.example,same.mangatest.example',
    'network.dns.forceResolve': '127.0.0.2',
    'network.dns.disableIPv6': true,
  },
});
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };
try {
  let rdp;
  for (let i = 0; i < 30 && !rdp; i += 1) rdp = await connectRdp().catch(() => new Promise((r) => setTimeout(() => r(undefined), 300)));
  const { addonsActor } = await rdp.send('root', { type: 'getRoot' });
  const installed = await rdp.send(addonsActor, { type: 'installTemporaryAddon', addonPath: dist });
  rdp.close();
  if (!installed.addon) throw new Error(`install failed: ${JSON.stringify(installed)}`);

  const page = await ctx.newPage();
  await page.goto(pageUrl);
  await page.waitForFunction(() => document.images.length === 3 && [...document.images].every((i) => i.complete));
  await page.waitForTimeout(1000); // the content script starts at document_idle
  let rpcId = 0;
  /** Runs a test command in the background, through the content script of `via`. */
  const bg = (op, args, via = page) => via.evaluate(({ id, op, args }) => new Promise((ok) => {
    addEventListener('message', function on(e) {
      if (e.data?.a4kTestReply?.id !== id) return;
      removeEventListener('message', on);
      ok(e.data.a4kTestReply.result);
    });
    postMessage({ a4kTest: { id, op, args } }, '*');
  }), { id: ++rpcId, op, args });
  await bg('settings', { preset: 'CA', mode: 'auto' });

  const state = () => page.evaluate(() => Object.fromEntries([...document.images].map((i) => [i.id, {
    src: i.currentSrc, nw: i.naturalWidth, w: Math.round(i.getBoundingClientRect().width),
  }])));
  const before = await state();
  const blobs = (s) => ['p1', 'p2'].every((id) => s[id].src.startsWith('blob:'));

  // Detected while off, with the series and chapter; nothing touched.
  const off0 = await bg('status', pageUrl);
  check('reader page detected while off', off0?.kind === 'images' && off0.marks.length === 2 && !off0.on, JSON.stringify({ kind: off0?.kind, n: off0?.marks?.length }));
  check('series and chapter from the title', off0?.meta?.series === 'Chainsaw Man' && off0.meta.chapter === '172', JSON.stringify(off0?.meta));
  check('off by default', !blobs(await state()));

  // The real popup, pointed at the reader tab, in an iframe on a page of its own.
  const host = await ctx.newPage();
  const popupErrors = [];
  host.on('pageerror', (e) => popupErrors.push(e.message));
  await host.goto(`${base}/blog/popup-host`);
  const popupUrl = await bg('popupUrl', pageUrl);
  await host.evaluate((u) => {
    document.body.replaceChildren();
    const f = document.createElement('iframe');
    f.src = u;
    f.style.cssText = 'width:440px;height:640px;border:0';
    document.body.append(f);
  }, popupUrl);
  await host.waitForTimeout(2000);
  const popup = host.frames().find((f) => f.url().startsWith('moz-extension://'));
  if (!popup) throw new Error('popup frame not found');
  const card = () => popup.evaluate(() => ({
    shown: getComputedStyle(document.getElementById('manga-card')).display !== 'none',
    title: document.getElementById('manga-title').textContent,
    tag: document.getElementById('manga-tag').textContent,
    cells: document.querySelectorAll('#pmap-grid button.pcell').length,
    done: document.querySelectorAll('#pmap-grid .pcell.done').length,
    map: getComputedStyle(document.getElementById('pmap')).display !== 'none',
    count: document.getElementById('pmap-count').textContent,
    labels: [...document.querySelectorAll('#pmap-grid .pcell')].map((el) => el.getAttribute('aria-label')).join('|'),
    headTag: [...document.querySelectorAll('.bar .chip.manga')].filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.textContent).join('|'),
    modeChip: !!document.querySelector('#modeChip #mode[role="combobox"]'),
    label: document.getElementById('nowLabel').textContent,
  }));
  const c0 = await card();
  check('popup shows the chapter card', c0.shown && c0.title === 'Chainsaw Man' && c0.tag === 'ch 172' && c0.cells === 2, JSON.stringify(c0));
  check('header shows the manga tag and the mode control', c0.headTag === 'manga' && c0.modeChip && c0.label === 'reading now', JSON.stringify({ headTag: c0.headTag, modeChip: c0.modeChip, label: c0.label }));
  check('page map: one cell per page, all off', c0.map && c0.count === '● 0 / 2' && c0.labels === 'go to page 1, off|go to page 2, off', JSON.stringify({ map: c0.map, count: c0.count, labels: c0.labels }));

  // The mode list opens and sets the mode.
  await popup.click('#mode');
  await popup.waitForTimeout(200);
  const opts = await popup.evaluate(() => ({ open: !document.getElementById('mode-list').hidden, modes: [...document.querySelectorAll('#mode-list .mode-opt')].map((o) => o.dataset.mode).join(',') }));
  check('mode list opens with every mode', opts.open && opts.modes === 'auto,anime,manga', JSON.stringify(opts));
  await popup.click('#mode-opt-manga');
  await popup.waitForTimeout(300);
  const picked = await bg('settings', {});
  check('picking a mode stores it', picked.mode === 'manga', picked.mode);
  check('mode chip shows the picked mode', (await popup.textContent('#mode')).trim() === 'manga', await popup.textContent('#mode'));
  await bg('settings', { mode: 'auto' });
  await popup.waitForTimeout(600);

  // Switch on by clicking the card: pages are fetched by the background (no CORS) and upscaled.
  await popup.click('#manga-card');
  await popup.waitForTimeout(300);
  check('clicking the card switches the site on', (await bg('getManga'))['127.0.0.1'] === true);
  await page.waitForFunction(() => ['p1', 'p2'].every((id) => document.getElementById(id).currentSrc.startsWith('blob:')
    && document.getElementById(id).naturalWidth > 1000), null, { timeout: 60000 }).catch(() => {});
  const on = await state();
  const s1 = await bg('status', pageUrl);
  check('both pages swapped for upscaled ones', blobs(on), JSON.stringify({ p1: on.p1.src.slice(0, 20), err: s1?.lastError }));
  check('upscaled pages are 2x', on.p1.nw === before.p1.nw * 2 && on.p2.nw === before.p2.nw * 2, `${before.p1.nw} -> ${on.p1.nw}`);
  check('layout unchanged', on.p1.w === before.p1.w && on.p2.w === before.p2.w, `${before.p2.w} -> ${on.p2.w}`);
  check('small icon left alone', on.icon.src === before.icon.src);
  check('each page rendered once, none failed', s1?.renders === 2 && s1.done === 2 && s1.failed === 0, JSON.stringify({ renders: s1?.renders, done: s1?.done, failed: s1?.failed, err: s1?.lastError }));
  const tint = await page.evaluate(() => Object.fromEntries(['p1', 'p2'].map((id) => {
    const cv = document.createElement('canvas'); cv.width = 200; cv.height = 200;
    const g = cv.getContext('2d'); g.drawImage(document.getElementById(id), 0, 0, 200, 200);
    try {
      const d = g.getImageData(0, 0, 200, 200).data; let max = 0;
      for (let i = 0; i < d.length; i += 4) max = Math.max(max, Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]));
      return [id, max];
    } catch (e) { return [id, `unreadable: ${e.message}`]; }
  })));
  check('black-and-white page stays grey, colour page keeps colour', tint.p2 <= 2 && tint.p1 > 50, JSON.stringify(tint));
  await popup.waitForTimeout(1200);
  const c1 = await card();
  check('page map cells turn done', c1.done === 2 && c1.count === '● 2 / 2' && c1.labels === 'go to page 1, done|go to page 2, done', JSON.stringify({ done: c1.done, count: c1.count, labels: c1.labels }));
  // Alt+M: originals, and back.
  await page.bringToFront();
  await page.keyboard.press('Alt+KeyM');
  await page.waitForTimeout(500);
  const orig = await state();
  await page.keyboard.press('Alt+KeyM');
  await page.waitForTimeout(500);
  check('Alt+M shows the originals and back', orig.p1.src === before.p1.src && blobs(await state()));
  // Switch off by clicking the card again.
  await popup.click('#manga-card');
  await page.waitForTimeout(1000);
  const off = await state();
  check('switching off restores the originals', off.p1.src === before.p1.src && off.p2.src === before.p2.src);
  check('no errors in the popup', popupErrors.length === 0, popupErrors.join(' | '));
  await host.close();

  // Toolbar badge: in mode anime a reader tab gets "M" (manga detected); back in auto it is cleared.
  const waitBadge = async (want) => {
    let b;
    for (let i = 0; i < 40; i++) { b = await bg('badge', pageUrl); if (b.text === want) break; await page.waitForTimeout(250); }
    return b;
  };
  await page.bringToFront(); // a hidden tab is measured again only once it is shown
  check('badge: none in mode auto', (await bg('badge', pageUrl)).text === '');
  await bg('settings', { mode: 'anime' });
  const bM = await waitBadge('M');
  check('badge: M on the reader tab in mode anime', bM.text === 'M' && /manga detected/.test(bM.title), JSON.stringify(bM));
  await bg('settings', { mode: 'auto' });
  const bOff = await waitBadge('');
  check('badge: cleared once the mode fits', bOff.text === '' && bOff.title === 'Anime4Nerd', JSON.stringify(bOff));

  // Safety stop: an ordinary page on a switched-on site is never touched.
  await bg('setManga', { '127.0.0.1': true });
  const blog = await ctx.newPage();
  await blog.goto(`${base}/blog/kyoto`);
  await blog.waitForFunction(() => [...document.images].every((i) => i.complete));
  await blog.waitForTimeout(3500);
  const blogSrcs = await blog.evaluate(() => [...document.images].map((i) => i.currentSrc));
  check('ordinary page on a switched-on site is left alone', blogSrcs.every((s) => !s.startsWith('blob:')));
  await blog.close();
  await bg('setManga', {});

  // The guarded fetch. The asking page is on a public-looking name, so local addresses are refused.
  const dns = await ctx.newPage();
  const dnsUrl = `http://reader.mangatest.example:${pages.address().port}/blog`;
  await dns.goto(dnsUrl);
  await dns.waitForTimeout(1000);
  const ask = (url) => bg('ask', { page: dnsUrl, url }, dns);
  const show = (r) => JSON.stringify(r).slice(0, 90);
  const direct = await ask(`http://127.0.0.2:${images2.address().port}/colour.jpg?blind=1`);
  check('private address is refused without requesting it', !direct?.dataUrl && /local addresses are not fetched/i.test(direct?.error ?? '') && blindHits === 0, `${show(direct)} hits=${blindHits}`);
  const meta = await ask('http://169.254.169.254/latest/meta-data/');
  check('cloud metadata address is refused', !meta?.dataUrl && /local addresses/i.test(meta?.error ?? ''), show(meta));
  const tricked = await ask(`http://trick.mangatest.example:${images2.address().port}/colour.jpg`);
  check('DNS trick: public name resolving to a private address is refused', !tricked?.dataUrl && /resolves to a local address/i.test(tricked?.error ?? ''), show(tricked));
  const samePlace = await ask(`http://same.mangatest.example:${images.address().port}/colour.jpg`);
  check('image from the same address as the page still loads (proxy case)', !!samePlace?.dataUrl?.startsWith('data:image/jpeg'), show(samePlace));
  // A navigation that answers 204 leaves the document in place: it must not change what the frame may read.
  await dns.evaluate((u) => { location.href = u; }, `http://127.0.0.2:${images2.address().port}/nothing`);
  await dns.waitForTimeout(700);
  const spoofed = await ask(`http://trick.mangatest.example:${images2.address().port}/colour.jpg`);
  check('a 204 navigation to a private address does not unlock it', dns.url() === dnsUrl && !spoofed?.dataUrl && /local address/i.test(spoofed?.error ?? ''), show(spoofed));
  const viaSame = `http://same.mangatest.example:${images.address().port}`;
  const toLocal = await ask(`${viaSame}/to-local`);
  check('redirect to a local address is refused without requesting it', !toLocal?.dataUrl && /redirected to a local/i.test(toLocal?.error ?? '') && blindHits === 0, `${show(toLocal)} hits=${blindHits}`);
  const toTrick = await ask(`${viaSame}/to-trick`);
  check('redirect to a name resolving to a private address is refused', !toTrick?.dataUrl && /local address/i.test(toTrick?.error ?? ''), show(toTrick));
  const toOk = await ask(`${viaSame}/to-ok`);
  check('an allowed redirect is followed', !!toOk?.dataUrl?.startsWith('data:image/jpeg'), show(toOk));
  const toRelative = await ask(`${viaSame}/to-relative`);
  check('a relative redirect is followed', !!toRelative?.dataUrl?.startsWith('data:image/jpeg'), show(toRelative));
  const loop = await ask(`${viaSame}/loop`);
  check('a redirect loop stops', /too many redirects/i.test(loop?.error ?? ''), show(loop));
  await dns.close();
} finally {
  await ctx.close();
  for (const s of [images, images2, pages]) s.close();
  for (const d of [work, dist, profile]) fs.rmSync(d, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

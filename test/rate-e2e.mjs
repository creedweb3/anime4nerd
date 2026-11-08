// End-to-end check of the rating card in a real Chromium browser with the built extension:
// upscaled playback is counted, and the popup card shows, hides and stores answers correctly.
//
// Needs ffmpeg on PATH, Playwright (global or local), Edge or Chrome, and a fresh `npm run build`.
//
//   node test/rate-e2e.mjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" [screenshot dir]

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
if (!exe) { console.error('usage: node test/rate-e2e.mjs <path to Edge/Chrome> [screenshot dir]'); process.exit(2); }

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const { chromium } = loadPlaywright();

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-rate-'));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=20',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(work, 'v.mp4')]);
fs.writeFileSync(path.join(work, 'index.html'), '<video src="v.mp4" muted autoplay loop playsinline style="width:640px;height:360px"></video>');
const server = http.createServer((req, res) => {
  const file = path.join(work, req.url === '/' ? 'index.html' : path.basename(req.url));
  if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.mp4') ? 'video/mp4' : 'text/html' });
  fs.createReadStream(file).pipe(res);
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const host = `127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-rate-prof-')), {
  headless: false,
  executablePath: exe,
  viewport: { width: 380, height: 640 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--autoplay-policy=no-user-gesture-required'],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;
  const getRate = () => sw.evaluate(async () => (await chrome.storage.local.get('anime4k-rate'))['anime4k-rate'] ?? null);
  const setRate = (v) => sw.evaluate(async (val) => { await chrome.storage.local.set({ 'anime4k-rate': val }); }, v);

  // 1. Counting: upscale a looping video for ~12 s, then leave the page (pagehide reports).
  await sw.evaluate(async (key) => { await chrome.storage.local.set({ 'anime4k-sources': { [key]: true } }); }, `${host}::${host}`);
  const page = await ctx.newPage();
  await page.goto(`http://${host}/`);
  await page.waitForSelector('canvas.a4k-canvas:not([hidden])', { timeout: 30000 });
  await page.waitForTimeout(12000);
  await page.goto('about:blank');
  await page.waitForTimeout(1500);
  const counted = await getRate();
  check('upscaled playback is counted', counted && counted.seconds > 8 && counted.seconds < 20, `seconds=${counted?.seconds?.toFixed(1)}`);
  check('a short video is not an episode', counted && counted.episodes === 0);

  // 2. Popup states.
  const base = { seconds: 0, episodes: 0, shown: 0, clicked: false, rated: false, returning: false };
  const popup = await ctx.newPage();
  const open = async (state) => {
    await setRate(state);
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.waitForTimeout(400);
    return popup.evaluate(() => {
      const el = document.querySelector('#rate');
      return {
        visible: !el.hidden, cls: el.className, badge: document.querySelector('#rate-badge').textContent,
        big: document.querySelector('#rate-big').textContent, done: !document.querySelector('#rate-done').hidden,
        href: document.querySelector('#rate-go').href,
      };
    });
  };

  let c = await open({ ...base, episodes: 2, seconds: 3000 });
  check('no card before the first milestone', !c.visible);

  c = await open({ ...base, episodes: 12, seconds: 16560, shown: 1 });
  check('level 2 card shows', c.visible && c.cls.includes('lv2') && c.big === '12 episodes · 4.6 h', `${c.cls} "${c.big}" ${c.badge}`);
  check('level 2 badge from its pool', ['chunin', 'training arc', 'regular'].includes(c.badge));
  check('no "already rated" before a click', !c.done);
  check('rate link goes to the store reviews', c.href.startsWith('https://chromewebstore.google.com/detail/') && c.href.endsWith('/reviews'));
  if (shots) await popup.screenshot({ path: path.join(shots, 'popup-lv2.png') });
  await popup.click('#rate-x');
  await popup.waitForTimeout(300);
  let s = await getRate();
  check('✕ hides the card until the next level', s.shown === 2 && !s.clicked && !(await popup.isVisible('#rate')));

  c = await open({ ...s, episodes: 48, seconds: 19 * 3600 });
  check('level 3 card shows after the next milestone', c.visible && c.cls.includes('lv3'));
  const [store] = await Promise.all([ctx.waitForEvent('page'), popup.click('#rate-go')]);
  await popup.waitForTimeout(300);
  s = await getRate();
  check('"rate it" opens the store and is remembered', store.url().includes('chromewebstore') || store.url() === 'about:blank', store.url());
  check('"rate it" stored as clicked', s.clicked && s.shown === 3);
  await store.close();

  c = await open({ ...s, episodes: 230, seconds: 88 * 3600 });
  check('level 4 card offers "already rated"', c.visible && c.cls.includes('lv4') && c.done);
  if (shots) await popup.screenshot({ path: path.join(shots, 'popup-lv4.png') });
  await popup.click('#rate-done');
  await popup.waitForTimeout(300);
  s = await getRate();
  c = await open({ ...s, episodes: 100000 });
  check('"already rated" stops the card for good', s.rated && !c.visible);

  c = await open({ ...base, episodes: 3, seconds: 4000 });
  if (shots) await popup.screenshot({ path: path.join(shots, 'popup-lv1.png') });
  check('level 1 card shows', c.visible && c.cls.includes('lv1') && ['genin', 'rookie'].includes(c.badge));
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

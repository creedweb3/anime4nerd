// Site access in the real popup (test/popup-live.html: src/popup.html, src/popup.css and the built
// popup.js with a fake chrome.*). With access=1 the browser withholds the player frame's host:
// the popup must say so and offer "allow" instead of "No video found yet", and after the grant the
// video must show. Without it the row must never appear.
//
// Needs Playwright (global or local) and fresh builds (`npm run build`, and `npm run build:firefox`
// for Firefox). Runs headless.
//
//   node test/popup-access-e2e.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
//   node test/popup-access-e2e.mjs firefox

import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [target, shotDir] = process.argv.slice(2);
if (!target) { console.error('usage: node test/popup-access-e2e.mjs <path to Brave/Chrome/Edge | firefox> [screenshot dir]'); process.exit(2); }
const firefox = target === 'firefox';

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const pw = loadPlaywright();

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(0, '127.0.0.1');
await new Promise((ok) => server.once('listening', ok));
const base = `http://127.0.0.1:${server.address().port}/test/popup-live.html`;

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

const browser = firefox
  ? await pw.firefox.launch({ headless: true })
  : await pw.chromium.launch({ headless: true, executablePath: target, args: ['--window-position=-32000,-32000'] });
const page = await browser.newPage({ viewport: { width: 382, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const build = firefox ? '&build=firefox' : '';
const state = () => page.evaluate(() => {
  const shown = (s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.getClientRects().length > 0; };
  return { access: shown('#access'), empty: shown('#empty'), cards: document.querySelectorAll('#sources > *').length, requested: !!window.__accessRequested };
});
const shot = async (name) => { if (shotDir) await page.screenshot({ path: path.join(shotDir, `${name}-${firefox ? 'firefox' : 'chromium'}.png`) }); };

// --- player frame without access: the row and its button, not "No video found yet" ----------------
await page.goto(`${base}?access=1${build}`);
await page.waitForFunction(() => { const e = document.querySelector('#access'); return e && !e.hidden; }, null, { timeout: 10000 });
let s = await state();
check('no access: the access row shows', s.access, JSON.stringify(s));
check('no access: "No video found yet" is hidden', !s.empty, JSON.stringify(s));
check('no access: no video card', s.cards === 0, JSON.stringify(s));
const row = await page.evaluate(() => {
  const r = document.querySelector('#access').getBoundingClientRect();
  const b = document.querySelector('#access-go').getBoundingClientRect();
  return { text: document.querySelector('#access span').textContent, label: document.querySelector('#access-go').textContent, inside: b.right <= r.right + 0.5 && b.left >= r.left, oneLine: b.height < 30 };
});
check('the button says "allow" and sits inside the row', row.label === 'allow' && row.inside && row.oneLine, JSON.stringify(row));
await shot('access-missing');

// --- allow: the browser is asked, then the video shows and the row goes ------------------------------
await page.click('#access-go');
await page.waitForFunction(() => document.querySelectorAll('#sources > *').length > 0, null, { timeout: 10000 });
s = await state();
check('allow: the browser was asked for access', s.requested, JSON.stringify(s));
check('allow: the video card shows', s.cards === 1, JSON.stringify(s));
check('allow: the access row is gone', !s.access, JSON.stringify(s));
await shot('access-granted');

// --- a frame webNavigation leaves out (blob: in Chromium): found through executeScript ---------------
await page.goto(`${base}?unlisted=1${build}`);
await page.waitForFunction(() => document.querySelectorAll('#sources > *').length > 0, null, { timeout: 10000 }).catch(() => {});
s = await state();
check('unlisted frame: its video card shows', s.cards === 1, JSON.stringify(s));

// --- full access (the normal case): the row never shows ----------------------------------------------
await page.goto(`${base}?${build.slice(1)}`);
await page.waitForFunction(() => document.querySelectorAll('#sources > *').length > 0, null, { timeout: 10000 });
await page.waitForTimeout(900); // past a few refreshes
s = await state();
check('full access: no access row', !s.access, JSON.stringify(s));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.close();
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed (${firefox ? 'Firefox' : 'Chromium'})`);
process.exit(passed === results.length ? 0 : 1);

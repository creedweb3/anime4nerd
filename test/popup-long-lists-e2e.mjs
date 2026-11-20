// Long lists in the real popup (test/popup-live.html: src/popup.html, src/popup.css and the built
// popup.js with a fake chrome.*): the profile list at its limit with the longest names, and the
// page map of a long manga chapter shown one set of 120 pages at a time.
//
// Needs Playwright (global or local) and fresh builds (`npm run build`, and `npm run build:firefox`
// for Firefox). Runs headless.
//
//   node test/popup-long-lists-e2e.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
//   node test/popup-long-lists-e2e.mjs firefox
//
// Firefox runs dist-firefox/popup.js, which has no manga side, so only the profile checks run there.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [target] = process.argv.slice(2);
if (!target) { console.error('usage: node test/popup-long-lists-e2e.mjs <path to Brave/Chrome/Edge | firefox>'); process.exit(2); }
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
// The popup's own size: 380 wide, at most 600 tall (the 2px are the frame's border in a real popup).
const page = await browser.newPage({ viewport: { width: 382, height: 600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const build = firefox ? '&build=firefox' : '';
const open = async (query, hash = '') => {
  await page.goto(`${base}?${query}${build}${hash}`);
  await page.waitForFunction(() => !!document.querySelector('#pf .pf-open'), null, { timeout: 10000 });
  await page.waitForTimeout(900); // past the first refresh
};
/** Elements other than the popup's body that can scroll: there must be none. */
const innerScrollers = () => page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => {
  const o = getComputedStyle(e).overflowY;
  return (o === 'auto' || o === 'scroll') && e.getClientRects().length;
}).map((e) => e.id || e.className));
/** Changes the first color value, so the line under the profile head offers its actions. */
const changeValue = async () => {
  await page.click('.cs-val');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('5');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
};

// --- profiles: the limit (16 with neutral), each name as long as allowed (14 wide letters) ---------
await open('profiles=15&names=long', '#tab=color');
const head = await page.evaluate(() => {
  const b = document.querySelector('#pf .pf-open');
  const panel = b.closest('.panel-head').getBoundingClientRect();
  return { text: b.textContent, cut: [...b.querySelectorAll('*')].some((e) => e.scrollWidth > e.clientWidth), inside: b.getBoundingClientRect().right <= panel.right + 0.5 };
});
check('profile head: the longest name shows whole, inside the heading', !head.cut && head.inside && head.text.includes('WMWMWMWMWMW004'), JSON.stringify(head));
await page.click('#pf .pf-open');
await page.waitForTimeout(300);
const list = await page.evaluate(() => {
  const l = document.querySelector('.pf-list');
  const r = l.getBoundingClientRect();
  const names = [...l.querySelectorAll('.mode-opt b')];
  return {
    rows: l.querySelectorAll('.mode-opt[data-id]').length, bottom: r.bottom, view: document.body.clientHeight,
    bodyScrolls: document.body.scrollHeight > document.body.clientHeight,
    cut: names.filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent),
    outside: [...l.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.left < r.left - 0.5 || b.right > r.right + 0.5); }).length,
    inPopup: r.left >= 0 && r.right <= document.body.clientWidth,
  };
});
check('profile list at the limit: all 16 profiles and custom, the whole list on screen, the popup does not scroll', list.rows === 17 && list.bottom <= list.view && !list.bodyScrolls, JSON.stringify(list));
check('profile list: no 14-letter name is cut, nothing leaves the list or the popup', list.cut.length === 0 && list.outside === 0 && list.inPopup, JSON.stringify({ cut: list.cut, outside: list.outside }));
check('profile list open: no scroll box inside the popup', (await innerScrollers()).length === 0, (await innerScrollers()).join());
await page.keyboard.press('Escape');
await changeValue();
const full = await page.evaluate(() => ({ text: document.querySelector('.pf-actions')?.textContent, tip: document.querySelector('.pf-full')?.dataset.tip, saveNew: !!document.querySelector('[data-act="new"]') }));
check('at the limit: "16 max" stands where "save new" was, and says why', !!full.text?.includes('16 max') && !full.saveNew && full.tip === 'delete a profile to save a new one', JSON.stringify(full));
const fullBox = await page.evaluate(() => { const f = document.querySelector('.pf-full').getBoundingClientRect(), a = document.querySelector('.pf-act').getBoundingClientRect(); return { h: f.height, ah: a.height, top: f.top, atop: a.top }; });
check('"16 max" is as tall as the action buttons and on their line', fullBox.h === fullBox.ah && fullBox.top === fullBox.atop, JSON.stringify(fullBox));
await open('profiles=14&names=long', '#tab=color');
await changeValue();
const under = await page.evaluate(() => ({ saveNew: !!document.querySelector('[data-act="new"]'), full: !!document.querySelector('.pf-full') }));
check('below the limit: "save new" is offered', under.saveNew && !under.full, JSON.stringify(under));

// --- page map (the Chrome build: Firefox has no manga side) --------------------------------------
if (!firefox) {
  const map = () => page.evaluate(() => {
    const shown = [...document.querySelectorAll('#pmap-grid .pcell')].filter((el) => !el.hidden);
    const headEl = document.querySelector('#pmap .panel-head');
    return {
      sets: !document.getElementById('pmap-sets').hidden, range: document.getElementById('pmap-range').textContent,
      n: shown.length, first: shown[0]?.textContent, last: shown.at(-1)?.textContent, rows: new Set(shown.map((c) => c.offsetTop)).size,
      prev: document.getElementById('pmap-prev').disabled, next: document.getElementById('pmap-next').disabled,
      headH: headEl.getBoundingClientRect().height, headRight: Math.max(...[...headEl.children].map((e) => e.getBoundingClientRect().right)), panelRight: headEl.getBoundingClientRect().right,
    };
  });
  const openPages = async (n) => {
    await page.goto(`${base}?pages=${n}`);
    await page.waitForFunction((n) => document.querySelectorAll('#pmap-grid .pcell').length === n, n, { timeout: 10000 });
    await page.waitForTimeout(300);
  };
  await openPages(24);
  const m24 = await map();
  await openPages(120);
  const m120 = await map();
  check('page map up to 120 pages: no arrows, every page shown', !m24.sets && m24.n === 24 && !m120.sets && m120.n === 120 && m120.rows === 10, JSON.stringify({ m24: [m24.sets, m24.n], m120: [m120.sets, m120.n, m120.rows] }));
  await openPages(121);
  const m121 = await map();
  check('121 pages: arrows show, 1–120 first, the heading keeps its height', m121.sets && m121.range === '1–120' && m121.n === 120 && m121.headH === m120.headH && m121.headRight <= m121.panelRight + 0.5,
    JSON.stringify({ range: m121.range, headH: [m121.headH, m120.headH] }));
  await openPages(300);
  await page.click('#pmap-next');
  await page.click('#pmap-next');
  const last = await map();
  check('300 pages: the last set is 241–300 and its arrow switches off', last.range === '241–300' && last.n === 60 && last.next && !last.prev && last.first === '241' && last.last === '300', JSON.stringify(last));
  check('page map with arrows: no scroll box inside the popup', (await innerScrollers()).length === 0, (await innerScrollers()).join());
}

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close();
server.close();
const passed = results.filter(Boolean).length;
console.log(`${passed}/${results.length} passed (${firefox ? 'Firefox' : 'Chromium'})`);
process.exit(passed === results.length ? 0 : 1);

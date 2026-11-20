// End-to-end check of the fullscreen menu's color tab with the built extension in a real
// Chromium browser: a playing video goes fullscreen, the menu opens, and real mouse clicks and
// key presses on the color tab change the stored color state. The menu's shadow root is closed,
// so elements are found through the DevTools protocol (which sees into it) and clicked with the
// real mouse.
//
// Needs ffmpeg on PATH, Playwright (global or local), Brave/Edge/Chrome, and a fresh `npm run build`.
//
//   node test/fullscreen-color-e2e.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const [exe] = process.argv.slice(2);
if (!exe) { console.error('usage: node test/fullscreen-color-e2e.mjs <path to Brave/Edge/Chrome>'); process.exit(2); }

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const { chromium } = loadPlaywright();

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-fscolor-'));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=24:duration=120',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(work, 'v.mp4')]);
// A player: the video in a box that goes fullscreen from a button, as real players do.
fs.writeFileSync(path.join(work, 'index.html'), `<!doctype html><body style="margin:0;background:#000">
<div id="player" style="width:960px;height:540px;background:#000"><video src="v.mp4" muted autoplay loop playsinline style="width:100%;height:100%"></video></div>
<button id="fs" onclick="document.getElementById('player').requestFullscreen()">fullscreen</button></body>`);
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

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-fscolor-prof-')), {
  headless: !process.env.A4K_SHOW, // headless by default; A4K_SHOW=1 opens a real window
  executablePath: exe,
  viewport: { width: 1280, height: 720 },
  args: [...(process.env.A4K_SHOW ? [] : ['--window-position=-32000,-32000']), `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--autoplay-policy=no-user-gesture-required'],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const setSource = (on) => sw.evaluate(async ([key, v]) => { await chrome.storage.local.set({ 'anime4k-sources': { [key]: v } }); }, [`${host}::${host}`, on]);
  const color = () => sw.evaluate(async () => (await chrome.storage.local.get('anime4k-color'))['anime4k-color'] ?? null);
  const setColor = (patch) => sw.evaluate(async (p) => {
    const cur = (await chrome.storage.local.get('anime4k-color'))['anime4k-color'] ?? {};
    await chrome.storage.local.set({ 'anime4k-color': { ...cur, ...p } });
  }, patch);
  await setSource(true);

  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://${host}/`);
  await page.waitForSelector('canvas.a4k-canvas:not([hidden])', { timeout: 30000 });
  await page.click('#fs');
  await page.waitForFunction(() => !!document.fullscreenElement);
  await page.mouse.move(600, 400);

  // --- the menu, through the DevTools protocol (it sees into closed shadow roots) -------------
  const cdp = await ctx.newCDPSession(page);
  const tree = async () => (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })).root;
  const attrs = (n) => {
    const a = n.attributes ?? [];
    const o = {};
    for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1];
    return o;
  };
  const walk = function* (n) {
    yield n;
    for (const c of [...(n.children ?? []), ...(n.shadowRoots ?? []), ...(n.contentDocument ? [n.contentDocument] : [])]) yield* walk(c);
  };
  const textOf = (n) => [...walk(n)].filter((x) => x.nodeType === 3).map((x) => x.nodeValue).join('');
  /** Nodes whose class list has every class in `cls`, and (optionally) whose text includes `text`. */
  const find = async (cls, text) => {
    const out = [];
    for (const n of walk(await tree())) {
      const a = attrs(n);
      const classes = (a.class ?? '').split(/\s+/);
      if (cls.every((c) => classes.includes(c)) && (text === undefined || textOf(n).includes(text))) out.push({ node: n, a });
    }
    return out;
  };
  const box = async (n) => {
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: n.backendNodeId });
    const q = model.border; // x1 y1 x2 y2 x3 y3 x4 y4
    return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2, w: model.width, h: model.height };
  };
  const wait = (ms) => page.waitForTimeout(ms);
  const click = async (cls, text) => {
    const [hit] = await find(cls, text);
    if (!hit) throw new Error(`not found: .${cls.join('.')} ${text ?? ''}`);
    const b = await box(hit.node);
    await page.mouse.click(b.x, b.y);
    await wait(400);
  };
  const caption = async () => textOf((await find(['ccap']))[0].node).replace(/\s+/g, ' ');

  await click(['toggle']);
  const panel = (await find(['panel']))[0];
  check('the menu opens in fullscreen', !!panel && panel.a.hidden === undefined);

  await click(['ftab'], 'color');
  check('the color tab opens', (await find(['ftab'], 'color'))[0]?.a['aria-selected'] === 'true');
  const graph = (await find(['graph']))[0];
  check('the status box keeps its graph on the color tab', !!graph && (await box(graph.node)).h > 0);
  check('caption says where colors go', /colors on\s*upscaled only/.test(await caption()), await caption());

  await click(['pr'], 'moody');
  let c = await color();
  const moody = c.profiles.find((p) => p.name === 'moody');
  check('clicking a profile picks it and applies its values', c.profile === moody.id && JSON.stringify(c.values) === JSON.stringify(moody.v), c.profile);
  const sel = (await find(['pr'])).find((x) => x.a['aria-checked'] === 'true');
  check('the picked profile is marked', !!sel && textOf(sel.node).includes('moody'));

  await page.keyboard.press('3');
  await wait(400);
  c = await color();
  check('key 3 picks the third profile', c.profile === c.profiles[2].id, c.profile);

  await click(['chip'], 'always');
  c = await color();
  check('the always chip turns "always" on', c.always === true);
  check('caption follows: every video', (await caption()).includes('every video'), await caption());
  await click(['chip'], 'always');

  await click(['chip'], 'colors');
  c = await color();
  check('the colors chip turns colors off', c.on === false);
  check('colors off: the profiles are out of reach', (await find(['pcols']))[0].a.inert !== undefined);
  await page.keyboard.press('2');
  await wait(400);
  check('colors off: number keys do nothing', (await color()).profile === c.profile);
  await click(['chip'], 'colors');
  check('the colors chip turns colors back on', (await color()).on === true);

  await setSource(false);
  await wait(1200);
  check('upscale off, always off: caption says "not upscaled"', (await caption()).includes('not upscaled'), await caption());
  const dots = await find(['tdot']);
  check('both tab dots turn red', dots.length === 2 && dots.every((d) => d.a.class.includes('off')), dots.map((d) => d.a.class).join(' / '));
  await setSource(true);
  await wait(1200);

  // The most saved profiles (the limit, 16 with neutral), each with the longest name allowed (14 wide
  // letters): the menu stays within 480 px, nothing inside it scrolls on its own, and no name is cut.
  c = await color();
  const extra = Array.from({ length: 16 - c.profiles.length }, (_, i) => ({ id: `e2e-${i}`, name: `WMWMWMWMWMW${String(i).padStart(3, '0')}`, v: { ...c.profiles[1].v } }));
  await setColor({ profiles: [...c.profiles, ...extra] });
  await wait(1000);
  const wb = await box((await find(['wrap']))[0].node);
  check('profile limit: the menu stays within 480 px', wb.h <= 480, `${wb.h}px`);
  // Run a function on a node inside the closed shadow root, through the DevTools protocol.
  const onNode = async (n, fn) => {
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: n.backendNodeId });
    return (await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: fn, returnByValue: true })).result.value;
  };
  const tboxOverflow = await onNode((await find(['tbox']))[0].node, 'function () { return getComputedStyle(this).overflowY; }');
  const panelOverflow = await onNode((await find(['panel']))[0].node, 'function () { return getComputedStyle(this).overflowY; }');
  check('profile limit: only the whole panel may scroll; the tab box never scrolls on its own', tboxOverflow === 'visible' && panelOverflow === 'auto', JSON.stringify({ tboxOverflow, panelOverflow }));
  const rows = await find(['pr']);
  const cut = [];
  for (const r of rows) {
    // The name (b) is what can be cut; the row's own scroll width counts its column divider line.
    const t = await onNode(r.node, `function () { const p = this.getRootNode().querySelector('.panel').getBoundingClientRect(), b = this.getBoundingClientRect();
      const name = this.querySelector('b');
      return name.scrollWidth > name.clientWidth || b.left < p.left - 0.5 || b.right > p.right + 0.5 ? this.textContent : ''; }`);
    if (t) cut.push(t);
  }
  check('profile limit: all 16 profiles listed, the 14-letter names whole and inside the menu', rows.length >= 16 && cut.length === 0, `${rows.length} rows; cut: ${cut.join(' | ')}`);

  await click(['pr'], 'sunlit');
  c = await color();
  check('profile limit: a click on a profile still counts', c.profiles.find((p) => p.id === c.profile)?.name === 'sunlit', c.profile);

  check('the page stayed fullscreen', await page.evaluate(() => !!document.fullscreenElement));
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

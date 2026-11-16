// Check of the fullscreen menu button's placement in a real Chromium browser: the button keeps
// to the top-right corner, and moves down the edge when a control of the player already sits
// there. Mounts the real FullscreenMenu (bundled here from src/) on a plain test page, so no
// extension, video or real fullscreen is needed.
//
// Needs Playwright (global or local) and Brave/Edge/Chrome.
//
//   node test/fullscreen-menu-e2e.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"

import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [exe] = process.argv.slice(2);
if (!exe) { console.error('usage: node test/fullscreen-menu-e2e.mjs <path to Brave/Edge/Chrome>'); process.exit(2); }

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const { chromium } = loadPlaywright();

// The menu, mounted on <body> as the content script does for a fullscreen frame.
const entry = `
import { FullscreenMenu } from ${JSON.stringify(path.join(root, 'src/fullscreen-menu.ts'))};
import { normalize } from ${JSON.stringify(path.join(root, 'src/settings.ts'))};
const settings = normalize({});
const menu = new FullscreenMenu(() => null, () => settings);
menu.mount(document.body);
document.addEventListener('mousemove', () => menu.wake(), { passive: true });
`;
const bundle = (await build({
  stdin: { contents: entry, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', write: false,
  loader: { '.glsl': 'text' }, define: { __FIREFOX__: 'false' }, logLevel: 'warning',
})).outputFiles[0].text;

// A player whose own controls (two stacked 44 px squares, 8 px apart) sit in the top-right corner.
const controls = '<div style="position:fixed;top:8px;right:8px;display:grid;gap:8px;z-index:5"><button style="width:44px;height:44px">A</button><div id="b" style="width:44px;height:44px;cursor:pointer;background:#444">B</div></div>';
// A click-to-play surface over the whole picture is not a control to keep clear of.
const surface = '<div style="position:fixed;inset:0;cursor:pointer"></div>';
const pages = { plain: '', player: controls, surface };
const html = (extra) => `<!doctype html><body style="margin:0;background:#000;height:100vh">${extra}<script src="/menu.js"></script></body>`;

const server = http.createServer((req, res) => {
  const name = path.basename(req.url, '.html');
  if (req.url === '/menu.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(bundle); return; }
  if (!(name in pages)) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' }).end(html(pages[name]));
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const host = `127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-fsm-prof-')), {
  headless: false,
  executablePath: exe,
  viewport: { width: 1280, height: 720 },
  // A real window, parked off-screen so it does not pop up; A4K_SHOW=1 shows it.
  args: process.env.A4K_SHOW ? [] : ['--window-position=-32000,-32000'],
});
try {
  // The menu's host: the fixed, top-layer element added to <body>.
  const buttonBox = (p) => p.evaluate(() => {
    const el = [...document.body.children].find((e) => e.tagName === 'DIV' && e.style.zIndex === '2147483647');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), right: Math.round(innerWidth - r.right) };
  });
  // Mouse moves wake the menu; it re-checks its spot at most every 400 ms.
  const wiggle = async (p) => { for (let i = 0; i < 6; i++) { await p.mouse.move(300 + i * 20, 300); await p.waitForTimeout(250); } };
  const open = async (name) => {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.log('pageerror', e.message));
    await p.goto(`http://${host}/${name}.html`);
    await wiggle(p);
    return p;
  };

  const plain = await open('plain');
  const a = await buttonBox(plain);
  check('no player controls: button stays in the top-right corner', a?.top === 16 && a?.right === 16, JSON.stringify(a));
  await plain.close();

  const surfacePage = await open('surface');
  const s = await buttonBox(surfacePage);
  check('a click-to-play surface over the picture does not move the button', s?.top === 16, JSON.stringify(s));
  await surfacePage.close();

  // The player's controls cover y = 8..104, so the first free spot down the edge is 112.
  const player = await open('player');
  const b = await buttonBox(player);
  check('player controls in the corner: button moves below them', b?.top === 112 && b?.right === 16, JSON.stringify(b));

  // The player's controls go away: the button stays put instead of jumping back.
  await player.evaluate(() => document.querySelector('#b').parentElement.remove());
  await wiggle(player);
  const c = await buttonBox(player);
  check('button does not jump back when the controls disappear', c?.top === 112, JSON.stringify(c));
  await player.close();
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

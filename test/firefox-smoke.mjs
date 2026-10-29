// Firefox smoke test: same-origin (VP9, H.264), CORS, no-CORS, cross-origin iframe and the
// fullscreen redirect must behave as in Chrome.
//
// Needs ffmpeg on PATH, Playwright (global or local) with its Firefox
// (`npx playwright install firefox`), and a fresh `npm run build:firefox`.
//
//   node test/firefox-smoke.mjs
//
// Runs headless: a headed Playwright Firefox window may not paint, which stalls every
// requestVideoFrameCallback loop. Playwright cannot open moz-extension:// pages, so the add-on
// is installed over Firefox's remote debugging protocol, and a test-only copy of background.js
// turns the test sources on and writes each tab's a4k-list answers onto the page.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RDP_PORT = 6123;
const MIN_FPS = 15; // the fixtures are 24 fps; a stalled render loop reports ~0

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const { firefox } = loadPlaywright();

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-ff-'));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=6',
  '-c:v', 'libvpx-vp9', '-b:v', '1M', '-deadline', 'realtime', '-an', path.join(work, 'v.webm')]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=854x480:rate=24:duration=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', path.join(work, 'v.mp4')]);

const video = (src, extra = '') => `<video src="${src}" ${extra} muted loop autoplay playsinline style="display:block;width:960px;height:540px"></video>`;
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><body style="margin:0">${body}</body>`); };
let pagePort;
let mediaPort;
// Pages on 127.0.0.1; the "other origin" (media, iframe) on localhost.
const PAGES = {
  same: () => video('v.webm'),
  h264: () => video('v.mp4'),
  cors: () => video(`http://localhost:${mediaPort}/cors/v.webm`, 'crossorigin="anonymous"'),
  nocors: () => video(`http://localhost:${mediaPort}/plain/v.webm`),
  iframe: () => `<iframe src="http://localhost:${mediaPort}/frame" width="1000" height="600" allowfullscreen></iframe>`,
  fs: () => `<div id="box" style="width:960px;height:540px">${video('v.webm')}</div><button id="go">fs</button><script>go.onclick = () => document.querySelector('video').requestFullscreen()</script>`,
};
function listen(handler) {
  const s = http.createServer(handler).listen(0, '127.0.0.1');
  return new Promise((r) => s.once('listening', () => r(s)));
}
const pageServer = await listen((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname);
  if (/\.(webm|mp4)$/.test(name)) {
    res.writeHead(200, { 'content-type': name.endsWith('.webm') ? 'video/webm' : 'video/mp4' });
    fs.createReadStream(path.join(work, name)).pipe(res);
  } else if (PAGES[name]) html(res, PAGES[name]());
  else { res.writeHead(404); res.end(); }
});
const mediaServer = await listen((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/frame') { html(res, video('/plain/v.webm')); return; }
  const headers = { 'content-type': 'video/webm' };
  if (p.startsWith('/cors/')) headers['access-control-allow-origin'] = '*';
  res.writeHead(200, headers);
  fs.createReadStream(path.join(work, 'v.webm')).pipe(res);
});
pagePort = pageServer.address().port;
mediaPort = mediaServer.address().port;

// Test-only copy of the add-on.
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-ff-dist-'));
fs.cpSync(path.join(root, 'dist-firefox'), dist, { recursive: true });
const page = `127.0.0.1:${pagePort}`;
const other = `localhost:${mediaPort}`;
const sources = Object.fromEntries([`${page}::same-origin`, `${page}::${page}`, `${page}::${other}`, `${other}::same-origin`, `${other}::${other}`].map((k) => [k, true]));
fs.appendFileSync(path.join(dist, 'background.js'), `
browser.storage.local.set({ 'anime4k-sources': ${JSON.stringify(sources)} });
setInterval(async () => {
  for (const tab of await browser.tabs.query({ url: 'http://127.0.0.1/*' })) {
    const out = [];
    for (const f of await browser.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => [])) {
      const r = await browser.tabs.sendMessage(tab.id, { type: 'a4k-list' }, { frameId: f.frameId }).catch(() => null);
      if (r) out.push(...r);
    }
    await browser.scripting.executeScript({ target: { tabId: tab.id }, func: (j) => { document.documentElement.dataset.a4kList = j; }, args: [JSON.stringify(out)] }).catch(() => {});
  }
}, 1000);
`);

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
    // The server greets every connection with a packet from "root"; requests go after it.
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-ff-profile-'));
const ctx = await firefox.launchPersistentContext(profile, {
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: ['-start-debugger-server', String(RDP_PORT)],
  firefoxUserPrefs: {
    'devtools.debugger.remote-enabled': true,
    'devtools.debugger.prompt-connection': false,
    'xpinstall.signatures.required': false,
    'media.autoplay.default': 0,
    'full-screen-api.allow-trusted-requests-only': false,
    'full-screen-api.transition-duration.enter': '0 0',
    'extensions.background.idle.timeout': 600000, // keep the harness interval alive
  },
});
let failures = 0;
try {
  let rdp;
  for (let i = 0; i < 30 && !rdp; i += 1) {
    rdp = await connectRdp().catch(() => new Promise((r) => setTimeout(() => r(undefined), 300)));
  }
  const { addonsActor } = await rdp.send('root', { type: 'getRoot' });
  const installed = await rdp.send(addonsActor, { type: 'installTemporaryAddon', addonPath: dist });
  rdp.close();
  if (!installed.addon) throw new Error(`install failed: ${JSON.stringify(installed)}`);

  const check = (name, ok, detail) => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
  };
  const list = (p) => p.evaluate(() => JSON.parse(document.documentElement.dataset.a4kList ?? '[]'));
  const fast = (i) => i?.status === 'Active' && (i.stats?.fps ?? 0) >= MIN_FPS;
  const canvasSize = (p) => p.evaluate(() => {
    const c = document.querySelector('canvas.a4k-canvas');
    return c && !c.hidden ? [c.width, c.height] : null;
  });

  // name, expected 2x canvas (null: the canvas lives inside the iframe)
  for (const [name, want] of [['same', [2560, 1440]], ['h264', [1708, 960]], ['cors', [2560, 1440]], ['iframe', null]]) {
    const p = await ctx.newPage();
    await p.goto(`http://${page}/${name}`);
    await p.waitForTimeout(12000); // first start compiles shaders
    const info = (await list(p))[0];
    const canvas = await canvasSize(p);
    const ok = fast(info) && (want === null || (canvas?.[0] === want[0] && canvas?.[1] === want[1]));
    check(name, ok, `status=${info?.status} fps=${info?.stats?.fps} canvas=${canvas} ${info?.message ?? ''}`);
    await p.close();
  }

  {
    const p = await ctx.newPage();
    await p.goto(`http://${page}/nocors`);
    await p.waitForTimeout(8000);
    const info = (await list(p))[0];
    check('nocors', info?.status === 'Unavailable' && /CORS/.test(info.message), `status=${info?.status} ${info?.message ?? ''}`);
    await p.close();
  }

  {
    // The page fullscreens the bare <video>; fullscreen-redirect.js must fullscreen its container.
    const p = await ctx.newPage();
    await p.goto(`http://${page}/fs`);
    await p.waitForTimeout(10000);
    await p.click('#go');
    await p.waitForTimeout(3000);
    const el = await p.evaluate(() => document.fullscreenElement?.id ?? document.fullscreenElement?.tagName ?? null);
    const info = (await list(p))[0];
    check('fullscreen-redirect', el === 'box' && fast(info), `fullscreenElement=${el} status=${info?.status} fps=${info?.stats?.fps}`);
    await p.close();
  }
} finally {
  await ctx.close();
  pageServer.close();
  mediaServer.close();
  for (const d of [work, dist, profile]) fs.rmSync(d, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);

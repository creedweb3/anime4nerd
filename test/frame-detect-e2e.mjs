// Video detection in frames and shadow trees that players use to hide from scrapers: a video in a
// blob: iframe (content scripts need match_origin_as_fallback), a video in a closed shadow root,
// and, for information only, a video in a sandboxed cross-origin iframe.
//
// Needs ffmpeg on PATH, Playwright (global or local) with its Firefox for the Firefox run, and
// fresh builds (`npm run build`, `npm run build:firefox`). Runs off-screen.
//
//   node test/frame-detect-e2e.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
//   node test/frame-detect-e2e.mjs firefox
//
// A test-only copy of the background script asks every frame of each test tab for its videos and
// writes the count onto the page (as test/firefox-smoke.mjs does).

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target) { console.error('usage: node test/frame-detect-e2e.mjs <path to Brave/Chrome/Edge | firefox>'); process.exit(2); }
const isFirefox = target === 'firefox';
const RDP_PORT = 6124;

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const pw = loadPlaywright();

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-detect-'));
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4',
  '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-an', path.join(work, 'v.webm')]);

const STYLE = 'display:block;width:640px;height:360px';
const tag = (src) => `<video src="${src}" muted loop autoplay playsinline style="${STYLE}"></video>`;
let pagePort;
let otherPort;
const PAGES = {
  // Control: a plain video on the page.
  plain: () => tag('/v.webm'),
  // The player frame's document is a blob: URL made by the page.
  blob: () => `<script>
    const doc = '<!doctype html><body style="margin:0">${tag(`http://127.0.0.1:${pagePort}/v.webm`).replace(/"/g, '\\"')}</body>';
    const f = document.createElement('iframe');
    f.width = 700; f.height = 420;
    f.src = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
    document.body.append(f);
  </script>`,
  // The video sits in a closed shadow root: element.shadowRoot reads null.
  closed: () => `<div id="host"></div><script>
    const root = document.getElementById('host').attachShadow({ mode: 'closed' });
    root.innerHTML = '${tag('/v.webm')}';
  </script>`,
  // Cross-origin player frame sandboxed without allow-same-origin (pop-up ad blocking).
  sandbox: () => `<iframe sandbox="allow-scripts" src="http://localhost:${otherPort}/frame" width="700" height="420"></iframe>`,
};
const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><body style="margin:0">${body}</body>`); };
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, '127.0.0.1'); s.once('listening', () => r(s)); });
const serveVideo = (res) => { res.writeHead(200, { 'content-type': 'video/webm', 'access-control-allow-origin': '*' }); fs.createReadStream(path.join(work, 'v.webm')).pipe(res); };
const pageServer = await listen((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname);
  if (name === 'v.webm') serveVideo(res);
  else if (PAGES[name]) html(res, PAGES[name]());
  else res.writeHead(404).end();
});
const otherServer = await listen((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  if (p === '/frame') html(res, tag('/v.webm'));
  else if (p === '/v.webm') serveVideo(res);
  else res.writeHead(404).end();
});
pagePort = pageServer.address().port;
otherPort = otherServer.address().port;

// Test-only copy of the add-on: report, per test tab, how many videos all its frames list.
const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-detect-dist-'));
fs.cpSync(path.join(root, isFirefox ? 'dist-firefox' : 'dist'), dist, { recursive: true });
fs.appendFileSync(path.join(dist, 'background.js'), `
setInterval(async () => {
  for (const tab of await chrome.tabs.query({ url: 'http://127.0.0.1/*' })) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => []) ?? [];
    // As the popup does: frames webNavigation leaves out (blob: frames in Chromium) come from an
    // all-frames executeScript, which answers with every frame's id.
    const hit = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: () => location.href }).catch(() => []);
    for (const r of hit ?? []) if (!frames.some((f) => f.frameId === r.frameId)) frames.push({ frameId: r.frameId, url: String(r.result ?? '') });
    let videos = 0;
    for (const f of frames) {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'a4k-list' }, { frameId: f.frameId }).catch(() => null);
      if (Array.isArray(r)) videos += r.length;
    }
    const report = JSON.stringify({ videos, frames: frames.map((f) => f.url.slice(0, 40)) });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (j) => { document.documentElement.dataset.a4kDetect = j; }, args: [report] }).catch(() => {});
  }
}, 1000);
`);

/** Firefox remote debugging protocol, to install the temporary add-on (as in firefox-smoke.mjs). */
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
      if (/ListChanged$/.test(msg.type ?? '')) continue;
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

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-detect-profile-'));
const ctx = isFirefox
  ? await pw.firefox.launchPersistentContext(profile, {
    headless: true,
    args: ['-start-debugger-server', String(RDP_PORT)],
    firefoxUserPrefs: {
      'devtools.debugger.remote-enabled': true, 'devtools.debugger.prompt-connection': false,
      'xpinstall.signatures.required': false, 'media.autoplay.default': 0, 'extensions.background.idle.timeout': 600000,
    },
  })
  : await pw.chromium.launchPersistentContext(profile, {
    headless: false, // unpacked extensions need a headed Chromium; the window is placed off-screen
    executablePath: target,
    args: ['--window-position=-32000,-32000', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch', '--autoplay-policy=no-user-gesture-required'],
  });

let failures = 0;
try {
  if (isFirefox) {
    let rdp;
    for (let i = 0; i < 30 && !rdp; i += 1) rdp = await connectRdp().catch(() => new Promise((r) => setTimeout(() => r(undefined), 300)));
    const { addonsActor } = await rdp.send('root', { type: 'getRoot' });
    const installed = await rdp.send(addonsActor, { type: 'installTemporaryAddon', addonPath: dist });
    rdp.close();
    if (!installed.addon) throw new Error(`install failed: ${JSON.stringify(installed)}`);
  } else if (!ctx.serviceWorkers().length) {
    await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  }

  const detect = async (name) => {
    const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:${pagePort}/${name}`);
    let r = null;
    for (let i = 0; i < 16; i++) { // up to 8 s: the page's scan and the reporter run every 1-2 s
      await p.waitForTimeout(500);
      r = await p.evaluate(() => JSON.parse(document.documentElement.dataset.a4kDetect ?? 'null'));
      if (r?.videos > 0) break;
    }
    // Whether the extension's page-world script reached each child frame (it sets __a4kFsPatched).
    if (r) r.injected = await Promise.all(p.frames().slice(1).map((f) => f.evaluate(() => !!window.__a4kFsPatched).catch(() => 'n/a')));
    await p.close();
    return r;
  };
  for (const [name, counted] of [['plain', true], ['blob', true], ['closed', true], ['sandbox', false]]) {
    const r = await detect(name);
    const ok = (r?.videos ?? 0) > 0;
    if (counted && !ok) failures += 1;
    console.log(`${counted ? (ok ? 'PASS' : 'FAIL') : 'INFO'} ${name}: ${ok ? 'video found' : 'no video'} ${JSON.stringify(r)}`);
  }
} finally {
  await ctx.close();
  pageServer.close();
  otherServer.close();
  for (const d of [work, dist, profile]) fs.rmSync(d, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed (${isFirefox ? 'Firefox' : 'Chromium'})` : `all passed (${isFirefox ? 'Firefox' : 'Chromium'})`);
process.exit(failures ? 1 : 0);

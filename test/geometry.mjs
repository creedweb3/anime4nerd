// Regression check for video geometry: anamorphic, cropped, rotated and odd-sized
// sources must upscale without WebGL errors.
//
// Needs ffmpeg on PATH, Playwright (global or local), a Chromium browser with
// proprietary codecs (Edge or Chrome), and a fresh `npm run build`.
//
//   node test/geometry.mjs "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const exe = process.argv[2];
if (!exe) { console.error('usage: node test/geometry.mjs <path to Edge/Chrome>'); process.exit(2); }

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const { chromium } = loadPlaywright();

// expect = size of the uploaded frame: stored pixels, in display orientation.
const CASES = [
  { name: 'square-1080p', vf: 'scale=1920:1080,setsar=1', expect: [1920, 1080] },
  { name: 'anamorphic-dvd', vf: 'scale=704:480,setsar=10/11', expect: [704, 480] },
  { name: 'anamorphic-wide', vf: 'scale=720:480,setsar=32/27', expect: [720, 480] },
  { name: 'odd-854x480', vf: 'scale=854:480,setsar=1', expect: [854, 480] },
  { name: 'rotated-90', vf: 'scale=640:360,setsar=1', pre: ['-display_rotation', '90'], expect: [360, 640] },
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-geom-'));
for (const c of CASES) {
  const tmp = path.join(work, `${c.name}.tmp.mp4`);
  execFileSync('ffmpeg', [
    '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=6',
    '-vf', c.vf, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', tmp,
  ]);
  // Rotation is container metadata, so apply it in a remux step.
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...(c.pre ?? []), '-i', tmp, '-c', 'copy', '-movflags', '+faststart', path.join(work, `${c.name}.mp4`)]);
}

// Layout cases: where the overlay canvas lands relative to the video. All use the
// anamorphic fixture (displayed 4:3) in a 960x540 box, so `contain` paints 720x540 at x+120.
const video = (style = '') => `<video src="anamorphic-dvd.mp4" muted loop autoplay playsinline style="display:block;width:960px;height:540px;${style}"></video>`;
const LAYOUT = [
  {
    name: 'layout-border-scroll', // parent with border, padding and a scroll offset
    body: `<div id="p" style="position:relative;border:7px solid #c00;padding:5px;width:1000px;height:600px;overflow:auto"><div style="height:40px"></div>${video()}<div style="height:800px"></div></div><script>p.scrollTop = 30</script>`,
    expect: (v) => ({ x: v.x + 120, y: v.y, w: 720, h: 540 }),
  },
  {
    name: 'layout-position', // object-position: left top
    body: video('object-position:left top'),
    expect: (v) => ({ x: v.x, y: v.y, w: 720, h: 540 }),
  },
  {
    name: 'layout-cover', // paints 960x720, clipped back to the 960x540 box
    body: video('object-fit:cover'),
    expect: (v) => ({ x: v.x, y: v.y - 90, w: 960, h: 720 }),
    clip: 'inset(90px 0px)',
  },
  {
    name: 'layout-reparent', // player moves the <video> into another container after start
    body: `<div id="a">${video()}</div><div id="b" style="margin-left:50px"></div>`,
    after: (page) => page.evaluate(() => document.getElementById('b').append(document.querySelector('video'))),
    expect: (v) => ({ x: v.x + 120, y: v.y, w: 720, h: 540 }),
  },
  {
    name: 'layout-cap', // three eligible videos: only MAX_ACTIVE_RENDERERS (2) may run
    body: [1, 2, 3].map(() => video('width:480px;height:270px')).join(''),
    statuses: { Active: 2, Waiting: 1 },
  },
];

const server = http.createServer((req, res) => {
  const name = path.basename(new URL(req.url, 'http://x').pathname);
  const layout = LAYOUT.find((l) => l.name === name);
  if (name.endsWith('.mp4')) {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    fs.createReadStream(path.join(work, name)).pipe(res);
  } else if (layout) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><body style="margin:0">${layout.body}</body>`);
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><video src="${name}.mp4" muted loop autoplay playsinline style="width:960px;height:540px"></video>`);
  }
}).listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const port = server.address().port;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-geom-profile-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  executablePath: exe,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--autoplay-policy=no-user-gesture-required'],
});
let failures = 0;
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  await sw.evaluate((key) => chrome.storage.local.set({ 'anime4k-sources': { [key]: true } }), `127.0.0.1:${port}::127.0.0.1:${port}`);

  for (const c of CASES) {
    const page = await ctx.newPage();
    const glErrors = [];
    page.on('console', (m) => { if (/GL_INVALID|WebGL: /.test(m.text())) glErrors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${port}/${c.name}`);
    await page.waitForTimeout(15000); // first start compiles shaders
    const r = await page.evaluate(() => {
      const v = document.querySelector('video');
      const cv = document.querySelector('canvas.a4k-canvas');
      const f = new VideoFrame(v);
      const stored = [f.visibleRect.width, f.visibleRect.height];
      f.close();
      return { natural: [v.videoWidth, v.videoHeight], stored, canvas: cv && !cv.hidden ? [cv.width, cv.height] : null };
    });
    const list = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab.id, { type: 'a4k-list' }, { frameId: 0 });
    });
    const info = list?.[0];
    const want = c.expect;
    const ok = glErrors.length === 0 && info?.status === 'Active' && r.canvas
      && r.canvas[0] === want[0] * 2 && r.canvas[1] === want[1] * 2;
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}: natural=${r.natural} stored=${r.stored} canvas=${r.canvas} status=${info?.status} ${info?.message ?? ''} glErrors=${glErrors.length}`);
    await page.close();
  }

  for (const l of LAYOUT) {
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${port}/${l.name}`);
    await page.waitForTimeout(12000);
    if (l.after) { await l.after(page); await page.waitForTimeout(3000); }
    const list = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab.id, { type: 'a4k-list' }, { frameId: 0 });
    });
    let ok;
    let detail;
    if (l.statuses) {
      const counts = {};
      for (const i of list ?? []) counts[i.status] = (counts[i.status] ?? 0) + 1;
      ok = Object.entries(l.statuses).every(([s, n]) => counts[s] === n);
      detail = `statuses=${JSON.stringify(counts)}`;
    } else {
      const r = await page.evaluate(() => {
        const v = document.querySelector('video');
        const c = document.querySelector('canvas.a4k-canvas');
        const vr = v.getBoundingClientRect();
        const cr = c?.getBoundingClientRect();
        return {
          video: { x: vr.x, y: vr.y },
          canvas: cr && { x: cr.x, y: cr.y, w: cr.width, h: cr.height },
          clip: c?.style.clipPath ?? '',
          nextToVideo: c?.previousElementSibling === v,
        };
      });
      const want = l.expect(r.video);
      const near = (a, b) => Math.abs(a - b) <= 1;
      ok = list?.[0]?.status === 'Active' && r.canvas && r.nextToVideo
        && near(r.canvas.x, want.x) && near(r.canvas.y, want.y) && near(r.canvas.w, want.w) && near(r.canvas.h, want.h)
        && r.clip === (l.clip ?? '');
      detail = `status=${list?.[0]?.status} canvas=${JSON.stringify(r.canvas)} want=${JSON.stringify(want)} clip="${r.clip}" nextToVideo=${r.nextToVideo}`;
    }
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${l.name}: ${detail}`);
    await page.close();
  }
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
}
process.exit(failures ? 1 : 0);

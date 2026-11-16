// End-to-end check of rendering in a real Chromium browser with the built extension: each
// Anime4K mode builds, reaches Active on a playing video and reuses unchanged parts of the
// frame; drawing pauses while the video is scrolled out of view.
//
// Needs ffmpeg on PATH, Playwright (global or local), Brave/Edge/Chrome, and a fresh `npm run build`.
//
//   node test/render-e2e.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"

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
if (!exe) { console.error('usage: node test/render-e2e.mjs <path to Brave/Edge/Chrome>'); process.exit(2); }

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const { chromium } = loadPlaywright();

// A4K_UPSCALE=4x runs every mode at 4x instead of 2x.
const UPSCALE = process.env.A4K_UPSCALE ?? '2x';

const MODES = ['A', 'B', 'C', 'AA', 'BB', 'CA'];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-render-'));
// 960x540 source so 2x lands at 1080p, like a typical 540p/720p stream upscaled.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=24:duration=30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(work, 'v.mp4')]);
fs.writeFileSync(path.join(work, 'index.html'), '<video src="v.mp4" muted autoplay loop playsinline style="width:1920px;height:1080px"></video>');
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

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-render-prof-')), {
  headless: false,
  executablePath: exe,
  viewport: { width: 1280, height: 720 },
  // A real window (real GPU), parked off-screen so it does not pop up; A4K_SHOW=1 shows it.
  args: [...(process.env.A4K_SHOW ? [] : ['--window-position=-32000,-32000']), `--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--autoplay-policy=no-user-gesture-required'],
});
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  await sw.evaluate(async (key) => { await chrome.storage.local.set({ 'anime4k-sources': { [key]: true } }); }, `${host}::${host}`);
  const page = await ctx.newPage();
  await page.goto(`http://${host}/`);
  await page.waitForSelector('canvas.a4k-canvas:not([hidden])', { timeout: 30000 });

  // The content script's view of its videos, asked from the service worker.
  const list = () => sw.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    return tab ? chrome.tabs.sendMessage(tab.id, { type: 'a4k-list' }, { frameId: 0 }) : null;
  }, `http://${host}/*`);

  for (const mode of MODES) {
    await sw.evaluate(async ([preset, up]) => {
      const cur = (await chrome.storage.sync.get('anime4k')).anime4k ?? {};
      await chrome.storage.sync.set({ anime4k: { ...cur, preset, upscale: up } });
    }, [mode, UPSCALE]);
    let v = null;
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(250);
      const l = await list();
      v = Array.isArray(l) ? l[0] : null;
      if (v?.status === 'Active' && v.stats?.gpuMs != null) break;
      if (v?.status === 'Unavailable') break;
    }
    await page.waitForTimeout(1500); // let timings settle
    v = (await list())?.[0] ?? v;
    const st = v?.stats;
    const ms = st?.samples?.length ? st.samples.reduce((a, b) => a + b, 0) / st.samples.length : st?.gpuMs;
    // reach > 0: frame reuse measured this chain and is on.
    check(`mode ${mode} renders`, v?.status === 'Active' && st?.outputWidth === 960 * parseInt(UPSCALE, 10) && st?.reach > 0,
      v?.status === 'Active' ? `${st.outputWidth}x${st.outputHeight}, ${st.passes} passes, reach ${st.reach}, GPU ${ms?.toFixed(2)} ms, CPU ${st.cpuMs.toFixed(2)} ms, ${(st.textureBytes / 1048576).toFixed(0)} MB` : `${v?.status}: ${v?.message}`);
  }

  // Scrolled out of view: drawing stops, and resumes when the video is back.
  const status = async () => (await list())?.[0]?.status;
  await page.evaluate(() => { document.body.style.paddingTop = '3000px'; });
  await page.waitForTimeout(800);
  const away = await status();
  await page.evaluate(() => { document.body.style.paddingTop = ''; });
  await page.waitForTimeout(800);
  const back = await status();
  check('out of view pauses drawing, back in view resumes', away === 'Suspended' && back === 'Active', `${away} -> ${back}`);
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

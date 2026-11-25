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
import { fileURLToPath, pathToFileURL } from 'node:url';

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
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=960x540:rate=24:duration=120', // longer than the whole run: this server cannot serve the loop's reread
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(work, 'v.mp4')]);
// Full-frame noise: every pixel changes each frame, so nothing is reused and 8x costs its full
// price (the load-cap check needs a video the GPU cannot keep up with at 8x).
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'nullsrc=size=960x540:rate=60:duration=40,geq=random(1)*255:128:128',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '35', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(work, 'noise.mp4')]);
fs.writeFileSync(path.join(work, 'noise.html'), '<video src="noise.mp4" muted autoplay playsinline style="width:1920px;height:1080px"></video>');
fs.writeFileSync(path.join(work, 'index.html'), '<video src="v.mp4" muted autoplay loop playsinline style="width:1920px;height:1080px"></video>');
// 1080p source: at 8x (15360x8640) it fits the texture limit but not Chromium's canvas buffer.
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24:duration=60',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', path.join(work, 'hd.mp4')]);
fs.writeFileSync(path.join(work, 'hd.html'), '<body style="margin:0"><video src="hd.mp4" muted autoplay loop playsinline style="width:960px;height:540px;display:block"></video></body>');
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
  headless: !process.env.A4K_SHOW, // headless by default; A4K_SHOW=1 opens a real window
  executablePath: exe,
  viewport: { width: 1280, height: 720 },
  // Headless (new headless mode loads extensions). A4K_SHOW=1 opens a real window for the real GPU.
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

  // GPU-load cap: 8x (7680x4320 output) of full-frame 60 fps noise with the heaviest preset (B+B)
  // misses the 16.7 ms frame limit even on a fast GPU, so once its start-up grace (8 s) and a lasting drop are over it steps down,
  // and again if needed, never below 2x; the card says "GPU load".
  await sw.evaluate(async () => {
    const cur = (await chrome.storage.sync.get('anime4k')).anime4k ?? {};
    await chrome.storage.sync.set({ anime4k: { ...cur, preset: 'BB', upscale: '8x' } });
  });
  await page.goto(`http://${host}/noise.html`);
  await page.waitForSelector('canvas.a4k-canvas:not([hidden])', { timeout: 30000 });
  const widths = new Set();
  const trail = []; // status changes, for the failure detail
  let capped = null;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(500);
    const v = (await list())?.[0];
    if (v?.stats) widths.add(v.stats.outputWidth);
    const media = v?.status === 'Active' ? '' : await page.evaluate(() => { const e = document.querySelector('video'); return ` [readyState ${e.readyState}, error ${e.error?.code ?? '-'} ${e.error?.message ?? ''}, t ${e.currentTime.toFixed(1)}]`; });
    const avg = v?.stats?.samples?.length ? ` ${(v.stats.samples.reduce((a, b) => a + b, 0) / v.stats.samples.length).toFixed(0)}ms/${v.stats.sourceFps ? (1000 / v.stats.sourceFps).toFixed(0) : '?'}ms` : '';
    const step = `${v?.status}${v?.stats ? `@${v.stats.outputWidth}${avg}` : ''}${v?.status === 'Active' ? '' : `: ${v?.message}${media}`}`;
    if (trail.at(-1) !== step) trail.push(step);
    capped = v;
    if (v?.loadCapped && v.stats && v.stats.outputWidth < 960 * 8) break;
  }
  check('8x on a GPU that cannot keep up steps down and says it was the GPU load', !!capped?.loadCapped && capped.stats.outputWidth < 960 * 8 && capped.stats.outputWidth >= 960 * 2,
    `widths seen ${[...widths].join(' -> ')}, loadCapped ${capped?.loadCapped}, trail: ${trail.join(' | ')}`);
  // The cap is checked after it (load-cap.ts capHelped): a real overload stays capped once the
  // lower scale's warm-up and the check are over.
  await page.waitForTimeout(8000);
  const held = (await list())?.[0];
  check('a cap that fixed real drops holds after its check', !!held?.loadCapped && held.stats?.outputWidth < 960 * 8, `loadCapped ${held?.loadCapped}, ${held?.stats?.outputWidth}`);
  // Clicking the chosen upscale again (settings.ts liftLoadCap) runs it again, cap or not.
  await sw.evaluate(async () => { await chrome.storage.local.set({ 'anime4k-lift-cap': Date.now() }); });
  await page.waitForTimeout(2500);
  const relifted = (await list())?.[0];
  check('clicking the capped scale again runs it again', relifted?.loadCapped === false && relifted.stats?.outputWidth === 960 * 8, `loadCapped ${relifted?.loadCapped}, ${relifted?.stats?.outputWidth}`);
  await sw.evaluate(async () => {
    const cur = (await chrome.storage.sync.get('anime4k')).anime4k ?? {};
    await chrome.storage.sync.set({ anime4k: { ...cur, upscale: '2x' } });
  });
  await page.waitForTimeout(1500);
  const lifted = (await list())?.[0];
  check('a settings change lifts the load cap', lifted?.loadCapped === false, `loadCapped ${lifted?.loadCapped}, ${lifted?.stats?.outputWidth}`);

  // Prediction accuracy: the cost model (chain.ts chainCost) predicts 4x from the GPU time
  // measured at 2x; compare with the real 4x time on the same full-change video, per preset.
  const costFile = path.join(work, 'chain-cost.mjs');
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), path.join(root, 'src', 'chain.ts'),
    '--bundle', '--platform=node', '--format=esm', '--loader:.glsl=text', `--outfile=${costFile}`, '--log-level=error']);
  const { chainCost } = await import(pathToFileURL(costFile).href);
  const medianOf = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const timeAt = async (preset, upscale) => {
    await sw.evaluate(async ([p, u]) => {
      const cur = (await chrome.storage.sync.get('anime4k')).anime4k ?? {};
      await chrome.storage.sync.set({ anime4k: { ...cur, preset: p, upscale: u } });
    }, [preset, upscale]);
    await page.waitForTimeout(4500); // rebuild, settle, then 2 s of samples
    const v = (await list())?.[0];
    return { ms: v?.stats?.samples?.length ? medianOf(v.stats.samples) : null, width: v?.stats?.outputWidth };
  };
  const errors = [];
  // A, C and B+B were used to fit the model's fixed cost (chain.ts); A+A and C+A were not.
  for (const preset of ['A', 'C', 'BB', 'AA', 'CA']) {
    const s = { mode: 'auto', preset, darkenLines: false, thinLines: false, upscale: '4x' };
    const at2 = await timeAt(preset, '2x');
    const at4 = await timeAt(preset, '4x');
    if (!at2.ms || !at4.ms || at4.width !== 960 * 4) { errors.push({ preset, skipped: true }); continue; }
    const model = at2.ms * chainCost(s, 960, 540, 4) / chainCost(s, 960, 540, 2);
    const flat = at2.ms * 4;
    errors.push({ preset, at2: +at2.ms.toFixed(1), at4: +at4.ms.toFixed(1), model: +model.toFixed(1), flat: +flat.toFixed(1),
      modelErr: Math.abs(model - at4.ms) / at4.ms, flatErr: Math.abs(flat - at4.ms) / at4.ms });
  }
  const measuredRows = errors.filter((e) => !e.skipped);
  // A lightly loaded GPU clocks down, so the 2x time is inflated and predictions run high (the
  // safe side: a step up that is too slow is undone by its drops). What must hold: the model is
  // never optimistic by more than 10%, and always beats a flat 4x per doubling.
  const under = (e) => (e.at4 - e.model) / e.at4; // > 0: predicted less than measured
  check('cost model predicts 4x from 2x never more than 10% low, and closer than a flat 4x, for presets it was and was not fitted on', measuredRows.length >= 4
    && measuredRows.every((e) => under(e) <= 0.1 && e.modelErr < e.flatErr),
    errors.map((e) => e.skipped ? `${e.preset}: skipped` : `${e.preset}: 2x ${e.at2} ms, 4x ${e.at4} ms, model ${e.model} (${(e.modelErr * 100).toFixed(0)}%), flat ${e.flat} (${(e.flatErr * 100).toFixed(0)}%)`).join(' | '));

  // 8x of a 1080p video: Chromium caps the canvas's drawing buffer by area and halves it without
  // an error. The canvas must still show the whole frame, scaled down, not a zoomed-in corner:
  // a screenshot of it must match one of the paused video under it (both shrunk to 240x135).
  await sw.evaluate(async () => {
    const cur = (await chrome.storage.sync.get('anime4k')).anime4k ?? {};
    await chrome.storage.sync.set({ anime4k: { ...cur, preset: 'A', upscale: '8x' } });
  });
  await page.goto(`http://${host}/hd.html`);
  await page.waitForSelector('canvas.a4k-canvas:not([hidden])', { timeout: 30000 });
  let hd = null;
  for (let i = 0; i < 40 && hd?.status !== 'Active'; i++) { await page.waitForTimeout(250); hd = (await list())?.[0]; }
  await page.evaluate(() => document.querySelector('video').pause());
  await page.waitForTimeout(800);
  const clip = { x: 0, y: 0, width: 960, height: 540 };
  const shown = (await page.screenshot({ clip })).toString('base64');
  await page.evaluate(() => { document.querySelector('canvas.a4k-canvas').style.visibility = 'hidden'; });
  await page.waitForTimeout(300);
  const plain = (await page.screenshot({ clip })).toString('base64');
  const diff = await page.evaluate(async ([a, b]) => {
    const pixels = (png) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = 240; c.height = 135;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0, 240, 135);
        resolve(g.getImageData(0, 0, 240, 135).data);
      };
      img.src = `data:image/png;base64,${png}`;
    });
    const [x, y] = [await pixels(a), await pixels(b)];
    let sum = 0;
    for (let i = 0; i < x.length; i += 4) sum += Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
    return sum / (x.length / 4) / 3; // mean difference per channel, 0-255
  }, [shown, plain]);
  // Upscaling changes the picture a little (about 0.5 here); a zoomed-in corner differs by ~100.
  check('8x of a 1080p video shows the whole frame, not a zoomed-in corner', hd?.status === 'Active' && hd.stats?.outputWidth === 1920 * 8 && diff < 5,
    `${hd?.status}, output ${hd?.stats?.outputWidth}x${hd?.stats?.outputHeight}, mean difference from the video ${diff.toFixed(2)}`);

  await sw.evaluate(async () => {
    const cur = (await chrome.storage.sync.get('anime4k')).anime4k ?? {};
    await chrome.storage.sync.set({ anime4k: { ...cur, preset: 'A', upscale: '2x' } });
  });

  await page.goto(`http://${host}/`);
  await page.waitForSelector('canvas.a4k-canvas:not([hidden])', { timeout: 30000 });

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

// Local harness: draws an animated anime-ish line test pattern into a canvas,
// captures it as a MediaStream into a <video>, and runs the renderer on it.
import { createAnime4kRenderer, setFrameReuse } from '../src/gpu';
import type { Preset, Settings } from '../src/settings';
import { measure, score, type Measurement, type Picture } from './quality';

const v = document.getElementById('v') as HTMLVideoElement;
let out = document.getElementById('c') as HTMLCanvasElement;
const err = document.getElementById('err') as HTMLPreElement;
const info = document.getElementById('info') as HTMLSpanElement;

// Synthetic low-res source: thin dark lines, flat fills, soft gradients, slight noise.
const params = new URLSearchParams(location.search);
const hash = new URLSearchParams(location.hash.slice(1));
const SW = Number(params.get('w') ?? hash.get('w')) || 320;
const SH = Number(params.get('h') ?? hash.get('h')) || 180;
const src = document.createElement('canvas');
src.width = SW; src.height = SH;
const g = src.getContext('2d', { willReadFrequently: true })!;
g.scale(SW / 320, SH / 180);
let t = 0;
let freeze = false;
function paint() {
  if (freeze) { requestAnimationFrame(paint); return; }
  t += 1;
  g.fillStyle = '#dfe8f3'; g.fillRect(0, 0, 320, 180);
  const grad = g.createLinearGradient(0, 0, 0, 180); grad.addColorStop(0, '#9ec5ff'); grad.addColorStop(1, '#fff');
  g.fillStyle = grad; g.fillRect(0, 0, 320, 90);
  g.fillStyle = '#f2c9a0'; g.beginPath(); g.ellipse(160 + Math.sin(t / 30) * 20, 110, 40, 50, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#2a1e1a'; g.lineWidth = 1.2; g.stroke();
  g.beginPath(); g.moveTo(140, 100); g.quadraticCurveTo(150, 92, 160, 100); g.stroke();
  g.beginPath(); g.moveTo(165, 100); g.quadraticCurveTo(175, 92, 185, 100); g.stroke();
  g.fillStyle = '#5b3a2e'; g.beginPath(); g.ellipse(160 + Math.sin(t / 30) * 20, 75, 48, 30, 0, Math.PI, 0); g.fill();
  for (let i = 0; i < 6; i++) { g.strokeStyle = '#333'; g.lineWidth = 0.8 + (i % 3) * 0.4; g.beginPath(); g.moveTo(10 + i * 50, 170); g.lineTo(40 + i * 50, 130 + (i % 2) * 20); g.stroke(); }
  g.setTransform(1, 0, 0, 1, 0, 0); const id = g.getImageData(0, 0, SW, SH); const d = id.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 10; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(id, 0, 0);
  // simulate a soft low-bitrate source
  g.filter = 'blur(0.7px)'; g.drawImage(src, 0, 0); g.filter = 'none';
  g.scale(SW / 320, SH / 180);
  requestAnimationFrame(paint);
}
paint();
v.srcObject = src.captureStream(30);
v.play().catch(() => {});

let renderer: Awaited<ReturnType<typeof createAnime4kRenderer>> | null = null;
let raf = 0;

async function run() {
  err.textContent = '';
  cancelAnimationFrame(raf);
  renderer?.destroy();
  renderer = null;
  const settings: Settings = {
    preset: (document.getElementById('preset') as HTMLSelectElement).value as Settings['preset'],
    darkenLines: (document.getElementById('darken') as HTMLInputElement).checked,
    thinLines: (document.getElementById('thin') as HTMLInputElement).checked,
    upscale: 'auto',
  };
  if (v.readyState < 2) await new Promise((r) => { v.onloadeddata = r; });
  // A fresh canvas each run so the WebGL context is clean.
  const fresh = out.cloneNode() as HTMLCanvasElement; out.replaceWith(fresh); out = fresh;
  fresh.style.width = '640px'; fresh.style.height = '360px'; fresh.style.aspectRatio = `${SW}/${SH}`;
  const t0 = performance.now();
  try {
    renderer = await createAnime4kRenderer(v, fresh, settings, (m) => { err.textContent = m; }, Number(params.get('scale')) || 2);
    info.textContent = `init ${(performance.now() - t0).toFixed(0)} ms`;
    let frames = 0; let acc = 0;
    const loop = () => {
      const a = performance.now();
      renderer!.render();
      acc += performance.now() - a; frames += 1;
      if (frames % 30 === 0) { const st = renderer!.stats(); info.textContent = `init ${(performance.now() - t0).toFixed(0)} ms · cpu ${(acc / frames).toFixed(2)} ms · GPU ${st.gpuMs === null ? 'n/a' : st.gpuMs.toFixed(2) + ' ms'} · ${st.passes} passes · ${(st.textureBytes / 1048576).toFixed(0)} MB`; (window as any).a4kStats = st; }
      raf = requestAnimationFrame(loop);
    };
    loop();
  } catch (e) {
    err.textContent = e instanceof Error ? e.message : String(e);
  }
}
document.getElementById('run')!.addEventListener('click', run);
(window as any).a4kRun = run;

// Benchmark: median GPU ms over `frames` frames of one preset (the pattern keeps moving).
(window as any).a4kBench = async (preset: Preset, frames = 180): Promise<{ gpu: number | null; cpu: number }> => {
  freeze = false;
  const c = document.createElement('canvas');
  document.body.append(c);
  const r = await createAnime4kRenderer(v, c, {
    preset, darkenLines: false, thinLines: false, upscale: '2x',
  }, () => {}, 2);
  const gpu: number[] = []; let cpu = 0;
  for (let i = 0; i < frames; i++) {
    await new Promise((res) => { requestAnimationFrame(res); });
    r.render();
    const st = r.stats();
    cpu += st.cpuMs;
    if (i > 30 && st.gpuMs !== null) gpu.push(st.gpuMs); // skip warm-up
  }
  r.destroy(); c.remove();
  gpu.sort((a, b) => a - b);
  return { gpu: gpu.length ? gpu[gpu.length >> 1] : null, cpu: cpu / frames };
};

// Preset comparison: freezes the pattern and renders one frame of a preset into a copy canvas.
(window as any).a4kSnap = async (preset: Preset): Promise<HTMLCanvasElement> => {
  freeze = true;
  const c = document.createElement('canvas');
  const r = await createAnime4kRenderer(v, c, {
    preset, darkenLines: false, thinLines: false, upscale: 'auto',
  }, () => {}, 2);
  r.render();
  const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
  copy.getContext('2d')!.drawImage(c, 0, 0);
  r.destroy();
  return copy;
};


// --- A vs A+A comparison sheet -------------------------------------------------
async function renderOnce(preset: Settings['preset']): Promise<HTMLCanvasElement> {
  const c = document.createElement('canvas');
  const r = await createAnime4kRenderer(v, c, { preset, darkenLines: false, thinLines: false, upscale: 'auto' }, () => {});
  r.render();
  const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
  copy.getContext('2d')!.drawImage(c, 0, 0);
  r.destroy();
  return copy;
}
async function compare() {
  freeze = true;
  await new Promise((r) => { setTimeout(r, 200); });
  const a = await renderOnce('A');
  const aa = await renderOnce('AA');
  const W = a.width; const H = a.height;
  // crop region around the face/lines for detail
  const cx = 230; const cy = 160; const cw = 220; const ch = 160; const Z = 3; // zoom factor
  const sheet = document.createElement('canvas');
  sheet.width = cw * Z * 4 + 50; sheet.height = ch * Z + 40;
  const s = sheet.getContext('2d')!;
  s.fillStyle = '#111'; s.fillRect(0, 0, sheet.width, sheet.height);
  s.imageSmoothingEnabled = false;
  const label = (x: number, text: string) => { s.fillStyle = '#eee'; s.font = '16px system-ui'; s.fillText(text, x, 24); };
  // 1: source scaled 2x bilinear (what the browser shows without Anime4K)
  const src2 = document.createElement('canvas'); src2.width = W; src2.height = H;
  const g2 = src2.getContext('2d')!; g2.imageSmoothingEnabled = true; g2.drawImage(v, 0, 0, W, H);
  label(10, 'Source ×2 (browser bilinear)'); s.drawImage(src2, cx, cy, cw, ch, 10, 34, cw * Z, ch * Z);
  label(20 + cw * Z, 'Mode A'); s.drawImage(a, cx, cy, cw, ch, 20 + cw * Z, 34, cw * Z, ch * Z);
  label(30 + cw * Z * 2, 'A+A'); s.drawImage(aa, cx, cy, cw, ch, 30 + cw * Z * 2, 34, cw * Z, ch * Z);
  // 4: |A - AA| amplified 6x
  const da = a.getContext('2d')!.getImageData(cx, cy, cw, ch); const db = aa.getContext('2d')!.getImageData(cx, cy, cw, ch);
  const dd = new ImageData(cw, ch);
  let sum = 0;
  for (let i = 0; i < da.data.length; i += 4) {
    const d = (Math.abs(da.data[i] - db.data[i]) + Math.abs(da.data[i + 1] - db.data[i + 1]) + Math.abs(da.data[i + 2] - db.data[i + 2])) / 3;
    sum += d;
    const vv = Math.min(255, d * 6);
    dd.data[i] = vv; dd.data[i + 1] = vv; dd.data[i + 2] = vv; dd.data[i + 3] = 255;
  }
  const dc = document.createElement('canvas'); dc.width = cw; dc.height = ch; dc.getContext('2d')!.putImageData(dd, 0, 0);
  label(40 + cw * Z * 3, `|A − A+A| ×6  (mean ${(sum / (cw * ch)).toFixed(2)}/255)`);
  s.drawImage(dc, 0, 0, cw, ch, 40 + cw * Z * 3, 34, cw * Z, ch * Z);
  (window as any).a4kCompareUrl = sheet.toDataURL('image/png');
  freeze = false;
  return (window as any).a4kCompareUrl as string;
}
(window as any).a4kCompare = compare;

// Frame reuse on/off, and a check that it changes nothing: two renderers, one with
// reuse and one without, draw the same frames while small parts of the picture change.
(window as any).a4kReuse = setFrameReuse;
(window as any).a4kReuseCheck = async (preset: Preset, frames = 12): Promise<{ max: number; reach: number | null }> => {
  freeze = true;
  await new Promise((r) => { setTimeout(r, 400); });
  const settings: Settings = { preset, darkenLines: false, thinLines: false, upscale: '2x' };
  const make = async (on: boolean) => {
    setFrameReuse(on);
    const c = document.createElement('canvas');
    return { c, r: await createAnime4kRenderer(v, c, settings, () => {}, 2) };
  };
  const a = await make(true);
  const b = await make(false);
  setFrameReuse(true);
  const read = (c: HTMLCanvasElement) => {
    const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
    const cg = copy.getContext('2d', { willReadFrequently: true })!;
    cg.drawImage(c, 0, 0);
    return cg.getImageData(0, 0, c.width, c.height).data;
  };
  let max = 0;
  for (let f = 0; f < frames; f++) {
    // Every third frame is a repeat; the others change one or two small patches.
    if (f % 3 !== 2) {
      g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
      for (let k = 0; k <= f % 2; k++) {
        g.fillStyle = `rgb(${Math.random() * 255 | 0},${Math.random() * 255 | 0},${Math.random() * 255 | 0})`;
        g.fillRect(Math.random() * (SW - 40) | 0, Math.random() * (SH - 40) | 0, 3 + Math.random() * 36 | 0, 3 + Math.random() * 36 | 0);
      }
      g.restore();
    }
    await new Promise((r) => { setTimeout(r, 150); });
    a.r.render(); b.r.render();
    const pa = read(a.c); const pb = read(b.c);
    for (let i = 0; i < pa.length; i++) { const d = Math.abs(pa[i] - pb[i]); if (d > max) max = d; }
  }
  const reach = a.r.stats().reach;
  a.r.destroy(); b.r.destroy();
  return { max, reach };
};

// Frame reuse on a real encoded clip: one renderer with reuse and one without draw every
// decoded frame back to back (same GPU state), so their timings compare fairly; every
// `checkEvery`-th frame their pixels are compared too.
(window as any).a4kReuseVideo = async (url: string, preset: Preset, frames = 240, checkEvery = 8): Promise<{ on: number; off: number; max: number; reach: number | null; frames: number; checked: number; raced: number }> => {
  const vid = document.createElement('video');
  vid.muted = true; vid.loop = true; vid.playsInline = true; vid.src = url;
  vid.style.cssText = 'position:fixed;left:0;top:0;width:320px;opacity:0.01';
  document.body.append(vid);
  await vid.play();
  await new Promise((r) => { setTimeout(r, 500); });
  const settings: Settings = { preset, darkenLines: false, thinLines: false, upscale: '2x' };
  const make = async (on: boolean) => {
    setFrameReuse(on);
    const c = document.createElement('canvas');
    return { c, r: await createAnime4kRenderer(vid, c, settings, () => {}, 2) };
  };
  const a = await make(true);
  const b = await make(false);
  const c = await make(false); // brackets the pair: if b and c differ, the video advanced mid-task
  setFrameReuse(true);
  const read = (c: HTMLCanvasElement) => {
    const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
    const cg = copy.getContext('2d', { willReadFrequently: true })!;
    cg.drawImage(c, 0, 0);
    return cg.getImageData(0, 0, c.width, c.height).data;
  };
  let max = 0; let on = 0; let off = 0; let n = 0; let checked = 0; let raced = 0;
  for (let f = 0; f < frames; f++) {
    await new Promise((r) => { vid.requestVideoFrameCallback(r); });
    const check = f % checkEvery === 0;
    b.r.render(); a.r.render();
    if (check) {
      c.r.render();
      const pa = read(a.c); const pb = read(b.c); const pc = read(c.c);
      let same = true;
      for (let i = 0; i < pb.length; i++) if (pb[i] !== pc[i]) { same = false; break; }
      if (!same) { raced += 1; continue; }
      checked += 1;
      let cnt = 0; let x0 = 1e9; let y0 = 1e9; let x1 = -1; let y1 = -1;
      for (let i = 0; i < pa.length; i++) { const d = Math.abs(pa[i] - pb[i]); if (d > max) max = d; if (d) { cnt += 1; const q = i >> 2; const x = q % a.c.width; const y = (q / a.c.width) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } }
      if (cnt) ((window as any).a4kBad ??= []).push({ f, cnt, box: [x0, y0, x1, y1] });
    }
    const sa = a.r.stats().gpuMs; const sb = b.r.stats().gpuMs;
    if (f >= 30 && sa !== null && sb !== null) { on += sa; off += sb; n += 1; }
  }
  const reach = a.r.stats().reach;
  a.r.destroy(); b.r.destroy(); c.r.destroy(); vid.remove();
  return { on: on / n, off: off / n, max, reach, frames: n, checked, raced };
};

// Quality test: upscale stream-like 540p inputs with one Anime4K mode and measure each result
// against its sharp 1080p original (see test/quality.ts). 'bilinear' is the browser's own
// scaling, the baseline every preset is scored against.
async function loadBitmap(url: string): Promise<ImageBitmap> {
  return createImageBitmap(await (await fetch(url)).blob());
}
function pixels(src: CanvasImageSource, w: number, h: number): Picture {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const cg = c.getContext('2d', { willReadFrequently: true })!;
  cg.drawImage(src, 0, 0, w, h);
  return { data: cg.getImageData(0, 0, w, h).data, width: w, height: h };
}
(window as any).a4kScore = score;
(window as any).a4kQualityPreset = async (preset: Preset | 'bilinear', frames: string[]): Promise<(Measurement | null)[]> => {
  setFrameReuse(false);
  const out: (Measurement | null)[] = [];
  let made: { c: HTMLCanvasElement; r: Awaited<ReturnType<typeof createAnime4kRenderer>> } | null = null;
  for (const name of frames) {
    const truth = await loadBitmap(`/truth/${name}.png`);
    const input = await loadBitmap(`/input/${name}.png`);
    const t = pixels(truth, truth.width, truth.height);
    let result: Picture;
    if (preset === 'bilinear') {
      result = pixels(input, t.width, t.height);
    } else {
      if (!made) {
        const c = document.createElement('canvas');
        const settings: Settings = { preset, darkenLines: false, thinLines: false, upscale: '2x' };
        made = { c, r: await createAnime4kRenderer(input, c, settings, () => {}, 2) };
      }
      made.r.render(input);
      result = pixels(made.c, made.c.width, made.c.height);
    }
    out.push(result.width === t.width && result.height === t.height ? measure(t, result) : null);
    truth.close(); input.close();
  }
  made?.r.destroy();
  setFrameReuse(true);
  return out;
};

// Manga pages at 2x and at 4x, as they would look on screen: both results are scaled to each
// display width the way the browser scales an <img>, then compared. `crop` keeps the 4x render
// inside the memory budget. Returns, per width, how much 4x differs from 2x and 2x from the
// untouched page, plus PNG crops at the first and last width for looking at.
(window as any).a4kMangaScale = async (url: string, preset: Preset, widths: number[], crop = 800): Promise<unknown> => {
  setFrameReuse(false);
  const page = await loadBitmap(url);
  const side = Math.min(crop, page.width, page.height);
  const input = await createImageBitmap(page, Math.floor((page.width - side) / 2), Math.floor((page.height - side) / 3), side, side);
  const render = async (scale: 2 | 4) => {
    const c = document.createElement('canvas');
    const settings: Settings = { preset, darkenLines: false, thinLines: false, upscale: scale === 2 ? '2x' : '4x' };
    const r = await createAnime4kRenderer(input, c, settings, () => {}, scale);
    r.render(input);
    const copy = document.createElement('canvas'); copy.width = c.width; copy.height = c.height;
    copy.getContext('2d')!.drawImage(c, 0, 0);
    r.destroy();
    return copy;
  };
  const two = await render(2);
  const four = await render(4);
  const shown = (src: CanvasImageSource, w: number) => {
    const c = document.createElement('canvas'); c.width = w; c.height = w;
    const cg = c.getContext('2d', { willReadFrequently: true })!;
    cg.imageSmoothingQuality = 'high';
    cg.drawImage(src, 0, 0, w, w);
    return c;
  };
  const differ = (a: HTMLCanvasElement, b: HTMLCanvasElement) => {
    const p = a.getContext('2d')!.getImageData(0, 0, a.width, a.height).data;
    const q = b.getContext('2d')!.getImageData(0, 0, b.width, b.height).data;
    let sum = 0; let big = 0;
    for (let i = 0; i < p.length; i += 4) { const d = (Math.abs(p[i] - q[i]) + Math.abs(p[i + 1] - q[i + 1]) + Math.abs(p[i + 2] - q[i + 2])) / 3; sum += d; if (d > 8) big += 1; }
    return { mean: +(sum / (p.length / 4)).toFixed(2), changed: +(100 * big / (p.length / 4)).toFixed(2) };
  };
  const rows = [];
  const crops: Record<string, string> = {};
  for (const w of widths) {
    const a = shown(input, w); const b = shown(two, w); const c = shown(four, w);
    rows.push({ shownAt: +(w / side).toFixed(2), offVs2x: differ(a, b), twoVs4x: differ(b, c) });
    if (w === widths[0] || w === widths[widths.length - 1]) {
      const cut = (src: HTMLCanvasElement) => { const k = document.createElement('canvas'); k.width = 420; k.height = 300; k.getContext('2d')!.drawImage(src, Math.floor(src.width * 0.3), Math.floor(src.height * 0.3), 420, 300, 0, 0, 420, 300); return k.toDataURL('image/png'); };
      crops[`w${w}-off`] = cut(a); crops[`w${w}-2x`] = cut(b); crops[`w${w}-4x`] = cut(c);
    }
  }
  setFrameReuse(true);
  return { input: `${side}x${side}`, out2: `${two.width}x${two.height}`, out4: `${four.width}x${four.height}`, rows, crops };
};

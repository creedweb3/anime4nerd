// Local harness: draws an animated anime-ish line test pattern into a canvas,
// captures it as a MediaStream into a <video>, and runs the renderer on it.
import { createAnime4kRenderer } from '../src/gpu';
import type { Settings } from '../src/settings';

const v = document.getElementById('v') as HTMLVideoElement;
let out = document.getElementById('c') as HTMLCanvasElement;
const err = document.getElementById('err') as HTMLPreElement;
const info = document.getElementById('info') as HTMLSpanElement;

// Synthetic low-res source: thin dark lines, flat fills, soft gradients, slight noise.
const params = new URLSearchParams(location.search);
const SW = Number(params.get('w')) || 320;
const SH = Number(params.get('h')) || 180;
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

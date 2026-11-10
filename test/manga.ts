// Manga prototype: runs still pages through the real Anime4K renderer (src/gpu.ts) with every
// preset at 2x and shows the same crop from each, next to the browser's own upscale.
// Route 1 of the manga plan: reuse the video shaders on images and see how they cope with
// screentones, colour pages and low-quality scans before building anything into the extension.
import { createAnime4kRenderer } from '../src/gpu';
import type { Preset } from '../src/settings';

const PRESETS: { value: Preset; label: string }[] = [
  { value: 'A', label: 'Mode A' }, { value: 'B', label: 'Mode B' }, { value: 'C', label: 'Mode C' },
  { value: 'AA', label: 'A + A' }, { value: 'BB', label: 'B + B' }, { value: 'CA', label: 'C + A' },
];
const SCALE = 2;
const CROP_OUT = { 1: 360, 2: 230 } as const; // crop size in output pixels per zoom level
const STREAM_SETTLE_MS = 400; // time for the canvas stream to deliver its first frame
const TIMED_RUNS = 3; // renders averaged for the per-page time

interface Result { label: string; canvas: HTMLCanvasElement; ms: number | null; note?: string }
interface Page { name: string; source: HTMLCanvasElement; results: Result[]; cx: number; cy: number }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (msg: string, err = false) => { const s = $('status'); s.textContent = msg; s.classList.toggle('err', err); };
let zoom: 1 | 2 = 1;
let current: Page | null = null;
const pages: Page[] = [];

// ---- test pages ----------------------------------------------------------------------------

/** A black-and-white manga-style page: ink lines of several widths, hatching, round-dot
 *  screentones at three densities, a tone gradient, a speech bubble and SFX lettering. */
function drawMangaPage(w = 900, h = 1300): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#000'; g.fillStyle = '#000'; g.lineCap = 'round'; g.lineJoin = 'round';
  const panels = [[30, 30, w - 60, 520], [30, 570, (w - 75) / 2, 700], [45 + (w - 75) / 2, 570, (w - 75) / 2, 700]];

  const dots = (x: number, y: number, pw: number, ph: number, pitch: number, radius: (px: number) => number) => {
    g.save(); g.beginPath(); g.rect(x, y, pw, ph); g.clip();
    g.translate(x + pw / 2, y + ph / 2); g.rotate(Math.PI / 4);
    const reach = Math.hypot(pw, ph) / 2;
    for (let i = -reach; i < reach; i += pitch) for (let j = -reach; j < reach; j += pitch) {
      // position along the panel's width, before rotation, drives gradient tones
      const px = (i * Math.cos(Math.PI / 4) - j * Math.sin(Math.PI / 4) + pw / 2) / pw;
      const r = radius(px);
      if (r > 0.15) { g.beginPath(); g.arc(i, j, r, 0, Math.PI * 2); g.fill(); }
    }
    g.restore();
  };

  // panel 1: sky in a light tone, ground in a gradient tone, a figure in ink
  const [x1, y1, w1, h1] = panels[0];
  dots(x1, y1, w1, h1 * 0.55, 6, () => 1.1); // light 10% tone
  dots(x1, y1 + h1 * 0.55, w1, h1 * 0.45, 5, (p) => 0.4 + p * 2.2); // gradient tone
  g.fillStyle = '#fff';
  g.beginPath(); g.ellipse(x1 + w1 * 0.62, y1 + h1 * 0.42, 120, 150, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#000'; g.lineWidth = 4;
  g.beginPath(); g.ellipse(x1 + w1 * 0.62, y1 + h1 * 0.42, 120, 150, 0, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 2.2; // hair strands
  for (let k = 0; k < 14; k++) {
    const sx = x1 + w1 * 0.62 - 110 + k * 16;
    g.beginPath(); g.moveTo(sx, y1 + h1 * 0.42 - 140);
    g.bezierCurveTo(sx - 30, y1 + 60, sx + 40, y1 + 40, sx + 10 + k, y1 + 20); g.stroke();
  }
  g.lineWidth = 1.2; // eyes and mouth, fine lines
  for (const ex of [-45, 45]) {
    g.beginPath(); g.ellipse(x1 + w1 * 0.62 + ex, y1 + h1 * 0.42, 18, 26, 0, 0, Math.PI * 2); g.stroke();
    g.beginPath(); g.arc(x1 + w1 * 0.62 + ex + 4, y1 + h1 * 0.42 + 4, 9, 0, Math.PI * 2); g.fill();
  }
  g.beginPath(); g.moveTo(x1 + w1 * 0.62 - 22, y1 + h1 * 0.42 + 70); g.quadraticCurveTo(x1 + w1 * 0.62, y1 + h1 * 0.42 + 82, x1 + w1 * 0.62 + 22, y1 + h1 * 0.42 + 70); g.stroke();
  // speech bubble with small dialogue text
  g.fillStyle = '#fff'; g.lineWidth = 2.5;
  g.beginPath(); g.ellipse(x1 + 190, y1 + 130, 150, 85, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = '#000'; g.font = '600 17px "Segoe UI", Arial, sans-serif'; g.textAlign = 'center';
  ['WAIT... YOU CAN', 'SEE THE DOTS', 'TOO?'].forEach((t, i) => g.fillText(t, x1 + 190, y1 + 108 + i * 22));

  // panel 2: dense dark tone with white speed lines and SFX
  const [x2, y2, w2, h2] = panels[1];
  dots(x2, y2, w2, h2, 4, () => 1.55); // dark 50%+ tone
  g.strokeStyle = '#fff'; g.lineWidth = 1.5;
  for (let k = 0; k < 40; k++) {
    const a = (k / 40) * Math.PI * 2; const cx = x2 + w2 / 2; const cy = y2 + h2 / 2;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * 60, cy + Math.sin(a) * 60); g.lineTo(cx + Math.cos(a) * 500, cy + Math.sin(a) * 500); g.stroke();
  }
  g.font = '900 96px Impact, "Arial Black", sans-serif'; g.lineWidth = 8; g.strokeStyle = '#000'; g.fillStyle = '#fff';
  g.strokeText('DON!', x2 + w2 / 2, y2 + h2 / 2 + 30); g.fillText('DON!', x2 + w2 / 2, y2 + h2 / 2 + 30);

  // panel 3: hatching and cross-hatching at decreasing spacing, plus a coarse tone
  const [x3, y3, w3, h3] = panels[2];
  g.save(); g.beginPath(); g.rect(x3, y3, w3, h3); g.clip(); g.strokeStyle = '#000';
  [[7, 1], [5, 1], [4, 0.8], [3, 0.7]].forEach(([gap, lw], band) => {
    const by = y3 + band * (h3 / 5); g.lineWidth = lw;
    for (let x = x3 - h3; x < x3 + w3; x += gap) { g.beginPath(); g.moveTo(x, by); g.lineTo(x + h3 / 5, by + h3 / 5); g.stroke(); }
    if (band >= 2) for (let x = x3; x < x3 + w3 + h3; x += gap) { g.beginPath(); g.moveTo(x, by); g.lineTo(x - h3 / 5, by + h3 / 5); g.stroke(); }
  });
  g.restore();
  dots(x3, y3 + h3 * 0.8, w3, h3 * 0.2, 9, () => 2.4); // coarse tone

  g.strokeStyle = '#000'; g.lineWidth = 5; // panel borders last
  for (const [x, y, pw, ph] of panels) g.strokeRect(x, y, pw, ph);
  return c;
}

/** The same page as a typical low-quality aggregator scan: shrunk, then saved as a rough JPEG. */
async function badScan(page: HTMLCanvasElement, factor = 0.62, quality = 0.45): Promise<HTMLCanvasElement> {
  const small = document.createElement('canvas');
  small.width = Math.round(page.width * factor); small.height = Math.round(page.height * factor);
  const g = small.getContext('2d')!; g.imageSmoothingQuality = 'medium'; g.drawImage(page, 0, 0, small.width, small.height);
  const blob = await new Promise<Blob>((ok) => small.toBlob((b) => ok(b!), 'image/jpeg', quality));
  return toCanvas(await createImageBitmap(blob));
}

function toCanvas(src: CanvasImageSource & { width: number; height: number }): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  c.getContext('2d')!.drawImage(src, 0, 0); return c;
}

// ---- rendering -----------------------------------------------------------------------------

/** Wraps a canvas in a playing video, which is what the renderer takes. */
async function asVideo(src: HTMLCanvasElement): Promise<{ video: HTMLVideoElement; stop: () => void }> {
  const g = src.getContext('2d')!;
  const keep = setInterval(() => g.drawImage(src, 0, 0), 30); // keep the stream producing frames
  const video = document.createElement('video'); video.muted = true; video.playsInline = true;
  video.srcObject = src.captureStream(30); await video.play();
  await new Promise((r) => setTimeout(r, STREAM_SETTLE_MS));
  return { video, stop: () => { clearInterval(keep); video.srcObject = null; } };
}

async function upscale(video: HTMLVideoElement, preset: Preset): Promise<Result> {
  const label = PRESETS.find((p) => p.value === preset)!.label;
  const out = document.createElement('canvas');
  const errors: string[] = [];
  const r = await createAnime4kRenderer(video, out, { preset, darkenLines: false, thinLines: false, upscale: '2x' }, (m) => errors.push(m), SCALE);
  try {
    const copy = document.createElement('canvas'); copy.width = out.width; copy.height = out.height;
    const cg = copy.getContext('2d', { willReadFrequently: false })!;
    const frame = () => { r.render(); cg.drawImage(out, 0, 0); cg.getImageData(0, 0, 1, 1); }; // the readback waits for the GPU
    frame(); // warm-up: the first frame also uploads textures and links programs
    const t0 = performance.now();
    for (let i = 0; i < TIMED_RUNS; i++) frame();
    return { label, canvas: copy, ms: (performance.now() - t0) / TIMED_RUNS, note: errors[0] };
  } finally { r.destroy(); }
}

function browserUpscale(src: HTMLCanvasElement, smooth: boolean): Result {
  const c = document.createElement('canvas'); c.width = src.width * SCALE; c.height = src.height * SCALE;
  const g = c.getContext('2d')!; g.imageSmoothingEnabled = smooth; g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return { label: smooth ? 'Browser 2×' : 'Source pixels', canvas: c, ms: null };
}

async function processPage(name: string, source: HTMLCanvasElement): Promise<Page> {
  const page: Page = { name, source, results: [browserUpscale(source, false), browserUpscale(source, true)], cx: source.width * 0.6, cy: source.height * 0.25 };
  const { video, stop } = await asVideo(source);
  try {
    for (const p of PRESETS) {
      status(`${name}: rendering ${p.label}…`);
      try { page.results.push(await upscale(video, p.value)); }
      catch (e) { page.results.push({ label: p.label, canvas: document.createElement('canvas'), ms: null, note: e instanceof Error ? e.message : String(e) }); }
    }
  } finally { stop(); }
  return page;
}

// ---- view ----------------------------------------------------------------------------------

function show(page: Page) {
  current = page;
  document.querySelectorAll<HTMLButtonElement>('#sources button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === page.name)));
  const thumb = $('thumb'); thumb.replaceChildren(page.source, Object.assign(document.createElement('div'), { className: 'box' }));
  const timed = page.results.filter((r) => r.ms !== null).map((r) => r.ms!);
  $('meta').textContent = `${page.source.width}×${page.source.height} → ${page.source.width * SCALE}×${page.source.height * SCALE}` +
    (timed.length ? ` · ${Math.min(...timed).toFixed(0)}–${Math.max(...timed).toFixed(0)} ms per page` : '');
  drawCrops();
}

function drawCrops() {
  if (!current) return;
  const page = current; const size = CROP_OUT[zoom]; const half = size / 2 / SCALE;
  page.cx = Math.min(Math.max(page.cx, half), page.source.width - half);
  page.cy = Math.min(Math.max(page.cy, half), page.source.height - half);
  const sx = Math.round((page.cx - half) * SCALE); const sy = Math.round((page.cy - half) * SCALE);

  const box = $('thumb').querySelector<HTMLElement>('.box')!;
  const k = 100 / page.source.width; const kh = 100 / page.source.height;
  Object.assign(box.style, { left: `${(page.cx - half) * k}%`, top: `${(page.cy - half) * kh}%`, width: `${2 * half * k}%`, height: `${2 * half * kh}%` });

  $('grid').replaceChildren(...page.results.map((r) => {
    const fig = document.createElement('figure');
    const cap = document.createElement('figcaption');
    cap.innerHTML = `<b></b><span></span>`;
    cap.querySelector('b')!.textContent = r.label;
    cap.querySelector('span')!.textContent = r.note ?? (r.ms !== null ? `${r.ms.toFixed(0)} ms` : '');
    const c = document.createElement('canvas'); c.width = size; c.height = size;
    if (r.canvas.width) c.getContext('2d')!.drawImage(r.canvas, sx, sy, size, size, 0, 0, size, size);
    fig.append(cap, c); return fig;
  }));
}

$('thumb').addEventListener('click', (e) => {
  if (!current) return;
  const rect = $('thumb').getBoundingClientRect();
  current.cx = ((e.clientX - rect.left) / rect.width) * current.source.width;
  current.cy = ((e.clientY - rect.top) / rect.height) * current.source.height;
  drawCrops();
});

document.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
  zoom = Number(b.dataset.zoom) as 1 | 2;
  document.querySelectorAll('[data-zoom]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  document.body.classList.toggle('zoomed', zoom === 2);
  drawCrops();
}));

async function add(name: string, source: HTMLCanvasElement) {
  const page = await processPage(name, source);
  pages.push(page);
  const b = document.createElement('button'); b.textContent = name; b.addEventListener('click', () => show(page));
  $('sources').append(b);
  status('');
  show(page);
}

$<HTMLInputElement>('files').addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  for (const f of Array.from(input.files ?? [])) {
    try { await add(f.name, toCanvas(await createImageBitmap(f))); }
    catch (err) { status(`${f.name}: ${err instanceof Error ? err.message : err}`, true); }
  }
  input.value = '';
});

async function main() {
  try {
    const bw = drawMangaPage();
    await add('B&W screentones', bw);
    await add('Bad scan (62%, JPEG)', await badScan(bw));
    const img = new Image(); img.src = './still-source.png'; await img.decode();
    await add('Colour (anime frame)', toCanvas(img));
    show(pages[0]);
  } catch (e) { status(e instanceof Error ? e.message : String(e), true); }
}
(window as unknown as { mangaReady: Promise<void> }).mangaReady = main();

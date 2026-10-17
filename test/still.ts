// Renders one still image through the real Anime4K pipeline and posts the results to a local receiver.
import { createAnime4kRenderer } from '../src/gpu';
import type { Settings } from '../src/settings';

async function run(preset: Settings['preset'], endpoint: string, darkenLines = false, tag = preset) {
  const img = new Image(); img.src = './still-source.png'; await img.decode();
  const src = document.createElement('canvas'); src.width = img.width; src.height = img.height;
  const g = src.getContext('2d')!; g.drawImage(img, 0, 0);
  const keep = setInterval(() => g.drawImage(img, 0, 0), 30); // keep the stream producing frames
  const v = document.createElement('video'); v.muted = true; v.playsInline = true;
  v.srcObject = src.captureStream(30); await v.play();
  await new Promise((r) => setTimeout(r, 400));
  const out = document.createElement('canvas');
  const r = await createAnime4kRenderer(v, out, { preset, darkenLines, thinLines: false }, () => {});
  r.render(); r.render();
  const after = document.createElement('canvas'); after.width = out.width; after.height = out.height;
  after.getContext('2d')!.drawImage(out, 0, 0);
  r.destroy();
  const before = document.createElement('canvas'); before.width = img.width * 2; before.height = img.height * 2;
  const bg = before.getContext('2d')!; bg.imageSmoothingEnabled = true; bg.imageSmoothingQuality = 'low'; bg.drawImage(img, 0, 0, before.width, before.height);
  clearInterval(keep);
  await fetch(`${endpoint}?name=morevna-before.png`, { method: 'POST', body: before.toDataURL('image/png') });
  await fetch(`${endpoint}?name=morevna-after-${tag}.png`, { method: 'POST', body: after.toDataURL('image/png') });
  return { w: after.width, h: after.height };
}
(window as any).runStill = run;

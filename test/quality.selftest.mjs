// Self-test of the picture-quality metrics (test/quality.ts) on a synthetic picture. No browser.
//
//   node test/quality.selftest.mjs

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({ entryPoints: [path.join(here, 'quality.ts')], bundle: true, format: 'esm', write: false, logLevel: 'silent' });
const q = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].contents).toString('base64'));

const SIZE = 256;

/** Grey RGBA picture from a function of (x, y) returning 0..255. */
function picture(width, height, value) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0, p = 0; y < height; y++) {
    for (let x = 0; x < width; x++, p += 4) {
      data[p] = data[p + 1] = data[p + 2] = value(x, y);
      data[p + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Deterministic noise, so every run measures the same picture. */
function random(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

// Mid-grey background (so sharpening has room to overshoot both ways) with:
// top left: sharp one-pixel vertical lines; top right: a noisy texture patch;
// bottom: two flat blocks.
function synthetic() {
  const rand = random(1);
  return picture(SIZE, SIZE, (x, y) => {
    if (x < 128 && y < 128) return x % 8 === 4 ? 40 : 128;
    if (x >= 144 && x < 240 && y >= 16 && y < 112) return 128 + Math.round((rand() - 0.5) * 24);
    if (y >= 160 && y < 224 && x >= 32 && x < 112) return 200;
    if (y >= 160 && y < 224 && x >= 144 && x < 224) return 60;
    return 128;
  });
}

function boxBlur(img) {
  const { data, width: w, height: h } = img;
  const at = (x, y) => data[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4];
  return picture(w, h, (x, y) => {
    let s = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += at(x + dx, y + dy);
    return s / 9;
  });
}

function unsharp(img, amount) {
  const blurred = boxBlur(img);
  return picture(img.width, img.height, (x, y) => {
    const i = (y * img.width + x) * 4;
    return img.data[i] + amount * (img.data[i] - blurred.data[i]);
  });
}

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const near = (a, b) => Math.abs(a - b) < 1e-9;
const show = (m) => Object.entries(m).map(([k, v]) => `${k} ${typeof v === 'number' ? +v.toFixed(4) : v}`).join(', ');

const truth = synthetic();
const blurred = boxBlur(truth);
const sharpened = unsharp(truth, 1.5);

const same = q.measure(truth, synthetic());
check('identical: psnr is Infinity', same.psnr === Infinity, show(same));
check('identical: ssim is 1', near(same.ssim, 1));
check('identical: edge is 1', near(same.edge, 1));
check('identical: detail is 1', near(same.detail, 1));
check('identical: overshoot is 0', same.overshoot === 0);

const soft = q.measure(truth, blurred);
check('box blur: edge < 0.9', soft.edge < 0.9, show(soft));
check('box blur: detail < 0.9', soft.detail < 0.9);
check('box blur: ssim < 1 and psnr finite', soft.ssim < 1 && Number.isFinite(soft.psnr));

const sharp = q.measure(truth, sharpened);
check('unsharp mask: edge > 1', sharp.edge > 1, show(sharp));
check('unsharp mask: overshoot > 0', sharp.overshoot > 0);

check(
  'single metrics agree with measure()',
  q.psnrY(truth, blurred) === soft.psnr &&
    q.ssimY(truth, blurred) === soft.ssim &&
    q.edgeSharpness(truth, blurred) === soft.edge &&
    q.detailRetention(truth, blurred) === soft.detail &&
    q.overshoot(truth, sharpened) === sharp.overshoot,
);

const inRange = (s) => Object.values(s).every((v) => Number.isInteger(v) && v >= 0 && v <= 100);
const best = q.score(same, soft);
const equal = q.score(soft, soft);
const over = q.score(sharp, soft);
check('score: identical vs baseline is in 0..100', inRange(best), show(best));
check('score: baseline vs itself is in 0..100, faithful 50', inRange(equal) && equal.faithful === 50, show(equal));
check('score: unsharp mask is in 0..100, clean < 100', inRange(over) && over.clean < 100, show(over));
check('score: identical beats the blurred baseline overall', best.overall > equal.overall);
const weights = Object.values(q.OVERALL_WEIGHTS).reduce((a, b) => a + b, 0);
check('score: weights add up to 1', near(weights, 1));

// Pictures with no edges and no texture must give finite numbers, never NaN.
const finite = (m) => Object.entries(m).every(([k, v]) => (k === 'psnr' ? !Number.isNaN(v) : Number.isFinite(v)));
const grey = picture(64, 64, () => 128);
const lighter = picture(64, 64, () => 140);
const flatSame = q.measure(grey, picture(64, 64, () => 128));
const flatOff = q.measure(grey, lighter);
check('flat picture: edge and detail fall back to 1', finite(flatSame) && flatSame.edge === 1 && flatSame.detail === 1, show(flatSame));
check('flat picture, lighter copy: overshoot is the 12 level offset', finite(flatOff) && near(flatOff.overshoot, 12), show(flatOff));
check('flat picture: scores are in 0..100', inRange(q.score(flatSame, flatOff)) && inRange(q.score(flatOff, flatSame)));
const tiny = q.measure(picture(5, 3, (x, y) => (x * 37 + y * 91) % 256), picture(5, 3, (x, y) => (x * 41 + y * 89) % 256));
check('picture smaller than one SSIM window gives finite numbers', finite(tiny), show(tiny));

const throws = (run) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};
check('pictures of different sizes throw', throws(() => q.measure(grey, picture(64, 32, () => 128))));
check('picture data shorter than its size throws', throws(() => q.measure(grey, { data: new Uint8ClampedArray(100), width: 64, height: 64 })));
check('empty picture throws', throws(() => q.measure({ data: new Uint8ClampedArray(0), width: 0, height: 0 }, { data: new Uint8ClampedArray(0), width: 0, height: 0 })));

// 1080p must stay well under 2 seconds.
const rand = random(2);
const big = picture(1920, 1080, (x, y) => (x % 64 < 2 || y % 48 < 2 ? 30 : 128 + (rand() - 0.5) * 40));
const bigOut = picture(1920, 1080, (x, y) => big.data[(y * 1920 + x) * 4] + ((x + y) % 3) - 1);
q.measure(big, bigOut); // warm up the JIT
const start = performance.now();
q.measure(big, bigOut);
const ms = performance.now() - start;
check('1920x1080 measured in under 2 s', ms < 2000, `${ms.toFixed(0)} ms`);

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);

// Picture-quality metrics for comparing presets against plain bilinear: score an upscaled
// picture against the original it was shrunk from ("truth"). Pure maths on RGBA buffers, so
// it runs the same in a page and in Node. Everything works on BT.709 luma.

export interface Picture {
  data: Uint8ClampedArray | Uint8Array; // RGBA, 4 bytes per pixel
  width: number;
  height: number;
}

export interface Measurement {
  psnr: number; // dB, Infinity when identical
  ssim: number; // 0..1
  edge: number; // edge sharpness against truth: 1 = as sharp, <1 softer, >1 over-sharpened
  detail: number; // texture kept against truth: 1 = kept, <1 smoothed away, >1 invented
  overshoot: number; // mean luma levels outside the local range of truth (halos, ringing)
}

/** The 0-100 scores worked out from a Measurement (see axes below). */
export interface Axes {
  overall: number;
  faithful: number;
  detail: number;
  lines: number;
  clean: number;
}

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;
const SSIM_WINDOW = 8;
const SSIM_STRIDE = 4;

/** Edge pixels are the top 5% of truth's gradient magnitudes. */
const EDGE_FRACTION = 0.05;
/** Largest possible Sobel magnitude on 0..255 luma: both axes at 4 * 255. */
const SOBEL_MAX = 4 * 255 * Math.SQRT2;
const SOBEL_BINS = 4096;

/** Texture is where the local 5x5 standard deviation lies in this range, away from edges. */
const TEXTURE_STD_MIN = 2;
const TEXTURE_STD_MAX = 12;
/** With fewer texture pixels than this the picture has no texture worth measuring. */
const TEXTURE_MIN_PIXELS = 500;

/** How much each axis counts towards the overall score. */
export const OVERALL_WEIGHTS = { faithful: 0.35, lines: 0.25, detail: 0.25, clean: 0.15 } as const;

/** BT.709 luma, 0..255. */
export function luma(img: Picture): Float32Array {
  const n = img.width * img.height;
  const d = img.data;
  const y = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) y[i] = 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2];
  return y;
}

// An empty picture or a buffer shorter than its size would turn the metrics into NaN without
// any error, and a NaN score would end up in the ranking.
function sameSize(a: Picture, b: Picture): void {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`pictures differ in size: ${a.width}x${a.height} and ${b.width}x${b.height}`);
  }
  if (!Number.isInteger(a.width) || !Number.isInteger(a.height) || a.width < 1 || a.height < 1) {
    throw new Error(`bad picture size: ${a.width}x${a.height}`);
  }
  const bytes = a.width * a.height * 4;
  if (a.data.length < bytes || b.data.length < bytes) {
    throw new Error(`picture data is shorter than ${a.width}x${a.height} RGBA (${bytes} bytes)`);
  }
}

function psnrOf(t: Float32Array, o: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < t.length; i++) {
    const d = t[i] - o[i];
    sum += d * d;
  }
  return sum === 0 ? Infinity : 10 * Math.log10((255 * 255 * t.length) / sum);
}

function ssimOf(t: Float32Array, o: Float32Array, w: number, h: number): number {
  const bw = Math.min(SSIM_WINDOW, w);
  const bh = Math.min(SSIM_WINDOW, h);
  const n = bw * bh;
  let total = 0;
  let windows = 0;
  for (let y0 = 0; y0 + bh <= h; y0 += SSIM_STRIDE) {
    for (let x0 = 0; x0 + bw <= w; x0 += SSIM_STRIDE) {
      let st = 0, so = 0, stt = 0, soo = 0, sto = 0;
      for (let y = y0; y < y0 + bh; y++) {
        const end = y * w + x0 + bw;
        for (let i = y * w + x0; i < end; i++) {
          const a = t[i], b = o[i];
          st += a; so += b; stt += a * a; soo += b * b; sto += a * b;
        }
      }
      const mt = st / n, mo = so / n;
      const vt = stt / n - mt * mt, vo = soo / n - mo * mo, cov = sto / n - mt * mo;
      total += ((2 * mt * mo + C1) * (2 * cov + C2)) / ((mt * mt + mo * mo + C1) * (vt + vo + C2));
      windows++;
    }
  }
  return total / windows;
}

/** Sobel gradient magnitude; the one-pixel border stays 0. */
function sobel(y: Float32Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let r = 1; r < h - 1; r++) {
    for (let i = r * w + 1, end = r * w + w - 1; i < end; i++) {
      const tl = y[i - w - 1], tc = y[i - w], tr = y[i - w + 1];
      const ml = y[i - 1], mr = y[i + 1];
      const bl = y[i + w - 1], bc = y[i + w], br = y[i + w + 1];
      const gx = tr + 2 * mr + br - tl - 2 * ml - bl;
      const gy = bl + 2 * bc + br - tl - 2 * tc - tr;
      g[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return g;
}

/** Absolute 4-neighbour Laplacian; the one-pixel border stays 0. */
function laplacian(y: Float32Array, w: number, h: number): Float32Array {
  const l = new Float32Array(w * h);
  for (let r = 1; r < h - 1; r++) {
    for (let i = r * w + 1, end = r * w + w - 1; i < end; i++) {
      l[i] = Math.abs(4 * y[i] - y[i - 1] - y[i + 1] - y[i - w] - y[i + w]);
    }
  }
  return l;
}

/**
 * Folds every 5x5 neighbourhood with `combine` (sum, min or max) in two separable passes.
 * At the picture border the nearest pixel is repeated.
 */
function window5<T extends Float32Array | Uint8Array>(src: T, w: number, h: number, combine: (a: number, b: number) => number): T {
  const make = () => new (src.constructor as new (n: number) => T)(w * h);
  const tmp = make();
  for (let r = 0; r < h; r++) {
    const row = r * w;
    for (let x = 0; x < w; x++) {
      const a = row + Math.max(0, x - 2), b = row + Math.max(0, x - 1);
      const c = row + Math.min(w - 1, x + 1), d = row + Math.min(w - 1, x + 2);
      tmp[row + x] = combine(combine(combine(src[a], src[b]), combine(src[row + x], src[c])), src[d]);
    }
  }
  const out = make();
  for (let r = 0; r < h; r++) {
    const a = Math.max(0, r - 2) * w, b = Math.max(0, r - 1) * w;
    const c = Math.min(h - 1, r + 1) * w, d = Math.min(h - 1, r + 2) * w;
    const row = r * w;
    for (let x = 0; x < w; x++) {
      out[row + x] = combine(combine(combine(tmp[a + x], tmp[b + x]), combine(tmp[row + x], tmp[c + x])), tmp[d + x]);
    }
  }
  return out;
}

const add = (a: number, b: number) => a + b;
const min = (a: number, b: number) => (a < b ? a : b);
const max = (a: number, b: number) => (a > b ? a : b);

/** 1 where truth's gradient is in its top 5% (and not zero), else 0. */
function edgeMask(grad: Float32Array): Uint8Array {
  const hist = new Uint32Array(SOBEL_BINS);
  const scale = (SOBEL_BINS - 1) / SOBEL_MAX;
  for (let i = 0; i < grad.length; i++) hist[(grad[i] * scale) | 0]++;
  const target = Math.ceil(grad.length * EDGE_FRACTION);
  let bin = SOBEL_BINS - 1;
  for (let seen = hist[bin]; seen < target && bin > 0; ) seen += hist[--bin];
  const threshold = bin / scale;
  const mask = new Uint8Array(grad.length);
  for (let i = 0; i < grad.length; i++) mask[i] = grad[i] > 0 && grad[i] >= threshold ? 1 : 0;
  return mask;
}

/** 1 where truth has fine texture: moderate local contrast, at least 3 px from any edge pixel. */
function textureMask(y: Float32Array, edges: Uint8Array, w: number, h: number): Uint8Array {
  const sq = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) sq[i] = y[i] * y[i];
  const sum = window5(y, w, h, add);
  const sumSq = window5(sq, w, h, add);
  const nearEdge = window5(edges, w, h, max);
  const lo = TEXTURE_STD_MIN * TEXTURE_STD_MIN, hi = TEXTURE_STD_MAX * TEXTURE_STD_MAX;
  const mask = new Uint8Array(y.length);
  for (let i = 0; i < y.length; i++) {
    const mean = sum[i] / 25;
    const variance = sumSq[i] / 25 - mean * mean;
    mask[i] = variance >= lo && variance <= hi && !nearEdge[i] ? 1 : 0;
  }
  return mask;
}

/** Sum of `values` where `mask` is set. */
function maskedSum(values: Float32Array, mask: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) if (mask[i]) s += values[i];
  return s;
}

function edgeOf(tGrad: Float32Array, o: Float32Array, edges: Uint8Array, w: number, h: number): number {
  const truthSum = maskedSum(tGrad, edges);
  return truthSum === 0 ? 1 : maskedSum(sobel(o, w, h), edges) / truthSum;
}

function detailOf(t: Float32Array, o: Float32Array, edges: Uint8Array, w: number, h: number): number {
  const texture = textureMask(t, edges, w, h);
  let count = 0;
  for (let i = 0; i < texture.length; i++) count += texture[i];
  if (count < TEXTURE_MIN_PIXELS) return 1;
  const truthSum = maskedSum(laplacian(t, w, h), texture);
  return truthSum === 0 ? 1 : maskedSum(laplacian(o, w, h), texture) / truthSum;
}

function overshootOf(t: Float32Array, o: Float32Array, w: number, h: number): number {
  const lo = window5(t, w, h, min);
  const hi = window5(t, w, h, max);
  let sum = 0;
  for (let i = 0; i < o.length; i++) {
    const v = o[i];
    if (v < lo[i]) sum += lo[i] - v;
    else if (v > hi[i]) sum += v - hi[i];
  }
  return sum / o.length;
}

/** Peak signal-to-noise ratio on luma, in dB; Infinity when identical. */
export function psnrY(truth: Picture, out: Picture): number {
  sameSize(truth, out);
  return psnrOf(luma(truth), luma(out));
}

/** Mean SSIM on luma over 8x8 windows, stride 4. */
export function ssimY(truth: Picture, out: Picture): number {
  sameSize(truth, out);
  return ssimOf(luma(truth), luma(out), truth.width, truth.height);
}

/** Mean gradient of `out` over that of `truth`, on truth's edge pixels (top 5% of its gradient). */
export function edgeSharpness(truth: Picture, out: Picture): number {
  sameSize(truth, out);
  const { width: w, height: h } = truth;
  const grad = sobel(luma(truth), w, h);
  return edgeOf(grad, luma(out), edgeMask(grad), w, h);
}

/** Mean absolute Laplacian of `out` over that of `truth`, on truth's texture pixels; 1 if it has too few. */
export function detailRetention(truth: Picture, out: Picture): number {
  sameSize(truth, out);
  const { width: w, height: h } = truth;
  const t = luma(truth);
  return detailOf(t, luma(out), edgeMask(sobel(t, w, h)), w, h);
}

/** Mean distance, in luma levels, of `out` outside the [min, max] of truth's 5x5 neighbourhood. */
export function overshoot(truth: Picture, out: Picture): number {
  sameSize(truth, out);
  return overshootOf(luma(truth), luma(out), truth.width, truth.height);
}

/** Every metric at once; luma and the edge mask are computed once and shared. */
export function measure(truth: Picture, out: Picture): Measurement {
  sameSize(truth, out);
  const { width: w, height: h } = truth;
  const t = luma(truth);
  const o = luma(out);
  const grad = sobel(t, w, h);
  const edges = edgeMask(grad);
  return {
    psnr: psnrOf(t, o),
    ssim: ssimOf(t, o, w, h),
    edge: edgeOf(grad, o, edges, w, h),
    detail: detailOf(t, o, edges, w, h),
    overshoot: overshootOf(t, o, w, h),
  };
}

const clamp100 = (v: number) => Math.min(100, Math.max(0, v));

/**
 * Turns a measurement into the 0-100 axes. `baseline` is the measurement of a plain bilinear
 * upscale of the same input, so "faithful" says how much closer to the original the engine
 * gets than doing nothing clever.
 *
 * - faithful: 50 + 15 * (psnr - baseline psnr), in dB, each capped at 60 dB. Same as bilinear = 50;
 *   +3.3 dB = 100. (SSIM barely tells engines apart on anime: all land within 0.01 of bilinear.)
 * - lines: 100 * min(edge, 1), minus 100 for every 1.0 of edge beyond 1.15. Softer than the
 *   original loses points in proportion; up to 15% over-sharpening is free, more is penalised.
 * - detail: 100 * (1 - min(1, |log2(detail)|)). Texture kept exactly = 100; half the
 *   texture (smoothed away) or double (invented) = 0.
 * - clean: 100 * (1 - min(1, overshoot / 4)). No halos = 100; a mean of 4 luma levels of
 *   overshoot or more = 0.
 * - overall: the OVERALL_WEIGHTS mix of the four, taken before rounding.
 *
 * Each axis is clamped to 0..100 and rounded to an integer.
 */
export function score(m: Measurement, baseline: Measurement): Axes {
  const faithful = clamp100(50 + 15 * (Math.min(m.psnr, 60) - Math.min(baseline.psnr, 60)));
  const lines = clamp100(100 * Math.min(m.edge, 1) - 100 * Math.max(0, m.edge - 1.15));
  const detail = clamp100(100 * (1 - Math.min(1, Math.abs(Math.log2(Math.max(m.detail, 1e-3))))));
  const clean = clamp100(100 * (1 - Math.min(1, m.overshoot / 4)));
  const overall =
    OVERALL_WEIGHTS.faithful * faithful + OVERALL_WEIGHTS.lines * lines + OVERALL_WEIGHTS.detail * detail + OVERALL_WEIGHTS.clean * clean;
  return {
    overall: Math.round(clamp100(overall)),
    faithful: Math.round(faithful),
    detail: Math.round(detail),
    lines: Math.round(lines),
    clean: Math.round(clean),
  };
}

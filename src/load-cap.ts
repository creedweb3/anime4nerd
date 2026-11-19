// GPU-load cap for scales above 2x: step down when frames are dropped because the GPU cannot keep
// up, and predict the cost before stepping up. Pure rules; content.ts measures and rebuilds.

/** Below this share of the video's frames drawn, frames are being dropped. */
const DRAWN_MIN = 0.92;
/** ...and the GPU is the reason when its median frame time is at least this share of the limit. */
const GPU_SHARE = 0.75;
/**
 * Step up while the predicted GPU time fits the frame limit. Predictions from a lightly loaded
 * GPU run high (it clocks down, so its frame times are inflated), so the full limit is allowed;
 * a step that turns out too slow is caught by its dropped frames and undone.
 */
const STEP_UP_SHARE = 1;
/** Step down to a scale predicted to use at most this share: measured at full load, so accurate, with headroom. */
const FIT_SHARE = 0.8;
/** Never below the one scale every renderer can run. */
const MIN_SCALE = 2;
/** GPU timings needed before they count. */
const MIN_SAMPLES = 5;
/** A renderer must run this long before it can count as too slow (shader warm-up spikes). */
export const OVERLOAD_AFTER_MS = 2000;

/** Relative GPU cost of the chain at a scale (chain.ts chainCost); only ratios are used. */
export type CostOf = (scale: number) => number;
/** Fallback before the renderer is loaded: the output pixels. */
export const pixelCost: CostOf = (s) => s * s;

/** Median GPU time measured at each scale this video ran at, with the current chain. */
export type Measured = Map<number, number>;

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * GPU time at `scale`: measured if this video ran there; from two or more measured scales, a
 * fixed part plus a part that grows with the chain's cost, fitted to this video on this GPU;
 * from one, scaled by the cost ratio. null with nothing measured.
 */
export function predictAt(scale: number, measured: Measured, cost: CostOf): number | null {
  const seen = measured.get(scale);
  if (seen !== undefined) return seen;
  const pts = [...measured].map(([s, ms]) => ({ c: cost(s), ms }));
  if (!pts.length) return null;
  if (pts.length >= 2) {
    // Least squares for ms = fixed + slope * cost.
    const n = pts.length;
    const mc = pts.reduce((a, p) => a + p.c, 0) / n;
    const mm = pts.reduce((a, p) => a + p.ms, 0) / n;
    const vc = pts.reduce((a, p) => a + (p.c - mc) ** 2, 0);
    const slope = vc ? pts.reduce((a, p) => a + (p.c - mc) * (p.ms - mm), 0) / vc : 0;
    if (slope > 0) return Math.max(0, mm - slope * mc) + slope * cost(scale);
  }
  const nearest = pts.reduce((a, p) => (Math.abs(p.c - cost(scale)) < Math.abs(a.c - cost(scale)) ? p : a));
  return (nearest.ms * cost(scale)) / nearest.c;
}

/**
 * The scale to run: the wanted one, no higher than the load cap, and above the running scale
 * only while the predicted GPU time fits the frame limit (the running scale itself is judged by
 * its drops, not by a prediction). Never below 2x.
 */
export function allowedScale(want: number, running: number, measured: Measured, budgetMs: number | null, cap: number | null, cost: CostOf): number {
  let s = cap === null ? want : Math.min(want, cap);
  if (budgetMs) {
    for (;;) {
      if (s <= running) break;
      const p = predictAt(s, measured, cost);
      if (p === null || p <= budgetMs * STEP_UP_SHARE) break;
      s /= 2;
    }
  }
  return Math.max(MIN_SCALE, s);
}

/**
 * Where an overloaded renderer at `scale` goes: straight to the highest lower scale predicted to
 * fit (one rebuild, not one per halving), else 2x. Without a measurement or frame limit: half.
 */
export function stepDownTo(scale: number, measured: Measured, budgetMs: number | null, cost: CostOf): number {
  if (!budgetMs || !measured.size) return Math.max(MIN_SCALE, scale / 2);
  for (let s = scale / 2; s > MIN_SCALE; s /= 2) {
    const p = predictAt(s, measured, cost);
    if (p !== null && p <= budgetMs * FIT_SHARE) return s;
  }
  return MIN_SCALE;
}

/**
 * True when frames are being dropped (`drawn`: share of the video's frames drawn over the last
 * 2 s) and the GPU is the reason (median GPU time near the frame limit). A slow page with an idle
 * GPU is not: a lower scale would not help. Without any GPU timing the drops alone decide.
 */
export function overloaded(i: { drawn: number | null; gpuMs: number[]; budgetMs: number | null }): boolean {
  if (i.drawn === null || !i.budgetMs || i.drawn >= DRAWN_MIN) return false;
  if (i.gpuMs.length < MIN_SAMPLES) return true;
  return median(i.gpuMs) >= i.budgetMs * GPU_SHARE;
}

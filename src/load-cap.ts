// GPU-load cap for scales above 2x: step down only when the GPU really cannot keep up (a
// consistent drop in frames drawn, or many frames lost), and predict the cost before stepping up.
// A confirmed cap holds for the video (no going back and forth). Pure rules; content.ts
// measures and rebuilds.

/** Below this share of the video's frames drawn, frames are being dropped. */
const DRAWN_MIN = 0.92;
/** Below this share, so many frames are lost that the scale steps down after SEVERE_MS... */
export const SEVERE_DRAWN = 0.75;
/** ...one full window: a single bad check (a cold GPU, a page still loading) is not enough. */
export const SEVERE_MS = 2000;
/** The first renderer for a video waits this long before it can count as too slow: the GPU clocks up from idle and the page settles. */
export const START_GRACE_MS = 8000;
/** After playback resumes from a pause, the same for a shorter while. */
export const RESUME_GRACE_MS = 3000;
/** A drop above SEVERE_DRAWN must last this long without a break before the scale steps down. */
export const SUSTAIN_MS = 6000;
/** The GPU is the reason when its median frame time is at least this share of the limit... */
const GPU_SHARE = 0.8;
/** ...or when its slowest frames (this percentile) take longer than the limit: spikes drop frames. */
const SLOW_PERCENTILE = 0.9;
/** Weight of a new check in a scale's GPU time (the rest is its history). */
const SMOOTH = 0.3;
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

/** The value below which `p` (0-1) of the samples lie. */
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

/**
 * True when frames are being dropped (`drawn`: share of the video's frames drawn over the last
 * 2 s) and the GPU is the reason: its median time near the frame limit, or its slowest frames
 * past it. A slow page with an idle GPU is not: a lower scale would not help. Without any GPU
 * timing the drops alone decide.
 */
export function overloaded(i: { drawn: number | null; gpuMs: number[]; budgetMs: number | null }): boolean {
  if (i.drawn === null || !i.budgetMs || i.drawn >= DRAWN_MIN) return false;
  if (i.gpuMs.length < MIN_SAMPLES) return true;
  return median(i.gpuMs) >= i.budgetMs * GPU_SHARE || percentile(i.gpuMs, SLOW_PERCENTILE) > i.budgetMs;
}

/**
 * Whether to step down now. `since`: when the current unbroken overload began (null: none);
 * `drawn`: this check's share of frames drawn while overloaded, or null when not overloaded;
 * `timed`: GPU timings back the overload (without them the drops may have other causes).
 * Too many frames lost steps down after SEVERE_MS (with timings); a smaller drop must last
 * SUSTAIN_MS, so a passing hiccup (entering fullscreen, a menu, a busy moment of the browser)
 * changes nothing. `slow` stretches both waits (after a false alarm on this video).
 */
export function overloadFor(
  since: number | null, now: number, drawn: number | null, timed = true, slow = 1,
): { since: number | null; fire: boolean } {
  if (drawn === null) return { since: null, fire: false };
  const start = since ?? now;
  const lasted = now - start;
  return { since: start, fire: (timed && drawn < SEVERE_DRAWN && lasted >= SEVERE_MS * slow) || lasted >= SUSTAIN_MS * slow };
}

/** A step down must be predicted to cut the GPU time by at least this share... */
const MIN_SAVING = 0.15;
/** ...and after it, the share of frames drawn must rise by at least this much (or reach DRAWN_MIN). */
const MIN_RECOVERY = 0.05;
/** How long the lower scale is watched after a cap before it counts as confirmed. */
export const VERIFY_MS = 4000;

/**
 * Whether stepping down from `scale` to `lower` would clearly lighten the GPU: when the time
 * hardly depends on the scale (fixed work dominates), a lower scale would not stop the drops.
 * With nothing measured there is no evidence against it.
 */
export function lowerHelps(scale: number, lower: number, measured: Measured, cost: CostOf): boolean {
  const now = predictAt(scale, measured, cost);
  const after = predictAt(lower, measured, cost);
  if (now === null || after === null || now <= 0) return true;
  return after <= now * (1 - MIN_SAVING);
}

/**
 * Whether a cap did its job: the share of frames drawn at the lower scale (`after`) clearly beats
 * the share before it (`before`). If not, the GPU was not the reason and the cap is undone.
 */
export function capHelped(before: number, after: number): boolean {
  return after >= DRAWN_MIN || after >= before + MIN_RECOVERY;
}

/** A scale's GPU time after a new check: steady against one noisy window, still following real change. */
export function smoothMs(prev: number | undefined, sample: number): number {
  return prev === undefined ? sample : prev + SMOOTH * (sample - prev);
}

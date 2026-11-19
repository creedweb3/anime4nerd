// GPU-load cap for scales above 2x: step down when the GPU cannot keep up, and predict the cost
// before stepping up. Pure rules; content.ts measures and rebuilds.

import { frameVerdict } from './settings';

/** Each doubling adds an x2 pass over four times the pixels: about four times the GPU time. */
const COST_PER_DOUBLING = 4;
/** Step up only while the predicted GPU time is under this share of the frame limit. */
const STEP_UP_SHARE = 0.8;
/** Never below the one scale every renderer can run. */
const MIN_SCALE = 2;
/** A renderer must run this long before it can count as too slow (shader warm-up spikes). */
export const OVERLOAD_AFTER_MS = 2000;

/** GPU time at a scale, from the last 2 s of playback. */
export interface Measured { scale: number; ms: number }

/** Predicted GPU time at `to`, from `ms` measured at `from`. */
export function predictMs(ms: number, from: number, to: number): number {
  return ms * COST_PER_DOUBLING ** Math.log2(to / from);
}

/**
 * The scale to run: the wanted one, no higher than the load cap, and above the measured scale
 * only while the predicted GPU time stays under 80% of the frame limit. Never below 2x.
 */
export function allowedScale(want: number, measured: Measured | null, budgetMs: number | null, cap: number | null): number {
  let s = cap === null ? want : Math.min(want, cap);
  if (measured && budgetMs) {
    while (s > measured.scale && predictMs(measured.ms, measured.scale, s) > budgetMs * STEP_UP_SHARE) s /= 2;
  }
  return Math.max(MIN_SCALE, s);
}

/** True when the last 2 s ran over the frame limit (GPU time; without timing, frames drawn). */
export function overloaded(s: { samples: number[]; timerSupported: boolean; fps: number }, sourceFps: number | null): boolean {
  if (!sourceFps) return false;
  if (!s.timerSupported) return frameVerdict(s.fps, sourceFps) === 'bad';
  if (!s.samples.length) return false;
  return average(s.samples) > 1000 / sourceFps;
}

export function average(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Unit tests for the GPU-load cap (src/load-cap.ts) and the chain cost model (src/chain.ts). Runs in Node:
//   npx esbuild test/load-cap-test.ts --bundle --platform=node --format=esm --loader:.glsl=text --outfile=test/load-cap-test.js && node test/load-cap-test.js
import assert from 'node:assert/strict';
import { Measured, allowedScale, median, overloaded, pixelCost, predictAt, stepDownTo } from '../src/load-cap';
import { chainCost, passWeight } from '../src/chain';
import type { Settings } from '../src/settings';

const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

// 24 fps: a 41.7 ms frame limit; 80% of it is 33.3 ms.
const BUDGET = 1000 / 24;
const FIT = BUDGET * 0.8;
const A: Settings = { mode: 'auto', preset: 'A', darkenLines: false, thinLines: false, upscale: '8x' };
const cost = (s: number) => chainCost(A, 960, 540, s);
const m = (...pairs: [number, number][]): Measured => new Map(pairs);

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('pass weight: a conv layer costs more than a plain copy, and #define lines do not count', () => {
  const conv = 'vec4 hook() { vec4 r = mat4(1.0) * go_0(0.0, 0.0); r += mat4(1.0) * go_0(1.0, 0.0); return r; }';
  assert.ok(passWeight(conv) > passWeight('vec4 hook() { return HOOKED_tex(HOOKED_pos); }'));
  assert.equal(passWeight(`#define go_0(x, y) (MAIN_texOff(vec2(x, y)))\n${conv}`), passWeight(conv));
});

test('chain cost: grows with scale, by less than the pixels (restore passes and the frame upload stay at the source size)', () => {
  const r4 = cost(4) / cost(2);
  const r8 = cost(8) / cost(4);
  assert.ok(r4 > 1.05 && r4 < 4, `2x->4x ${r4.toFixed(2)}`);
  assert.ok(r8 > 1.05 && r8 < 4, `4x->8x ${r8.toFixed(2)}`);
});

test('prediction: a measured scale is used as measured', () => {
  assert.equal(predictAt(4, m([2, 5], [4, 9]), cost), 9);
  assert.equal(predictAt(4, m(), cost), null);
});

test('prediction from one scale: the cost ratio', () => {
  assert.equal(predictAt(8, m([2, 5]), pixelCost), 80);
});

test('prediction from two scales: fixed part plus a part growing with cost, fitted to this video', () => {
  // Made-up GPU: 3 ms fixed + 1 ms per cost unit; the fit recovers it exactly.
  const lin = (s: number) => [1, 2, 4, 8][Math.log2(s)];
  const ms = (s: number) => 3 + lin(s);
  assert.ok(Math.abs(predictAt(8, m([2, ms(2)], [4, ms(4)]), lin)! - ms(8)) < 1e-9);
});

test('step up: the highest scale predicted to fit the frame limit, judged only above the running scale', () => {
  // Pixel cost from 2x at 5 ms: 4x 20 ms fits, 8x 80 ms does not.
  assert.equal(allowedScale(8, 2, m([2, 5]), BUDGET, null, pixelCost), 4);
  // 2x at 2 ms: 8x 32 ms fits.
  assert.equal(allowedScale(8, 2, m([2, 2]), BUDGET, null, pixelCost), 8);
  // 2x at 10 ms: 4x 40 ms is under the 41.7 ms limit, so it is tried (its drops would undo it).
  assert.equal(allowedScale(4, 2, m([2, 10]), BUDGET, null, pixelCost), 4);
  assert.equal(allowedScale(4, 2, m([2, 11]), BUDGET, null, pixelCost), 2);
  // The running scale is never judged by prediction: 4x at 36 ms (over 80%) but not dropping stays.
  assert.equal(allowedScale(4, 4, m([4, 36]), BUDGET, null, pixelCost), 4);
  // Nothing measured, or no frame limit: the wanted scale.
  assert.equal(allowedScale(8, 2, m(), BUDGET, null, pixelCost), 8);
  assert.equal(allowedScale(8, 2, m([2, 30]), null, null, pixelCost), 8);
});

test('a load cap holds the scale down, never below 2x', () => {
  assert.equal(allowedScale(8, 2, m(), BUDGET, 4, cost), 4);
  assert.equal(allowedScale(8, 2, m(), BUDGET, 1, cost), 2);
});

test('step down: straight to the highest lower scale predicted to fit, else 2x', () => {
  // 8x at 100 ms, pixel cost: 4x 25 ms fits (under 33.3).
  assert.equal(stepDownTo(8, m([8, 100]), BUDGET, pixelCost), 4);
  // 8x at 200 ms: 4x 50 ms does not fit: 2x.
  assert.equal(stepDownTo(8, m([8, 200]), BUDGET, pixelCost), 2);
  // 4x was measured before at 30 ms: it fits, use it.
  assert.equal(stepDownTo(8, m([4, 30], [8, 200]), BUDGET, pixelCost), 4);
  // Nothing measured, or no frame limit: halve.
  assert.equal(stepDownTo(8, m(), BUDGET, pixelCost), 4);
  assert.equal(stepDownTo(4, m([4, 50]), null, pixelCost), 2);
  assert.ok(FIT > 33 && FIT < 34);
});

test('overloaded: frames dropped AND the GPU is the reason', () => {
  assert.equal(overloaded({ drawn: 0.7, gpuMs: [40, 42, 44, 45, 41], budgetMs: BUDGET }), true);
  // Dropping, but the GPU has plenty of room: the page is slow, a lower scale would not help.
  assert.equal(overloaded({ drawn: 0.7, gpuMs: [5, 6, 5, 6, 5], budgetMs: BUDGET }), false);
  // GPU busy but every frame drawn: keeping up.
  assert.equal(overloaded({ drawn: 0.99, gpuMs: [40, 41, 40, 39, 40], budgetMs: BUDGET }), false);
  // No GPU timing at all: the drops alone decide.
  assert.equal(overloaded({ drawn: 0.7, gpuMs: [], budgetMs: BUDGET }), true);
  // Nothing known yet.
  assert.equal(overloaded({ drawn: null, gpuMs: [50, 50, 50, 50, 50], budgetMs: BUDGET }), false);
  assert.equal(overloaded({ drawn: 0.5, gpuMs: [50, 50, 50, 50, 50], budgetMs: null }), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);

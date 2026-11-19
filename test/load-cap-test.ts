// Unit tests for the GPU-load cap (src/load-cap.ts). Runs in Node:
//   npx esbuild test/load-cap-test.ts --bundle --platform=node --format=esm --outfile=test/load-cap-test.js && node test/load-cap-test.js
import assert from 'node:assert/strict';
import { allowedScale, overloaded, predictMs } from '../src/load-cap';

const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

// 24 fps: a 41.7 ms frame limit.
const BUDGET = 1000 / 24;

test('predicted cost: about 4x per doubling', () => {
  assert.equal(predictMs(5, 2, 4), 20);
  assert.equal(predictMs(5, 2, 8), 80);
  assert.equal(predictMs(5, 4, 4), 5);
});

test('no measurement and no cap: the wanted scale', () => {
  assert.equal(allowedScale(8, null, BUDGET, null), 8);
  assert.equal(allowedScale(2, null, null, null), 2);
});

test('a load cap holds the scale down, never below 2x', () => {
  assert.equal(allowedScale(8, null, BUDGET, 4), 4);
  assert.equal(allowedScale(4, null, BUDGET, 2), 2);
  assert.equal(allowedScale(8, null, BUDGET, 1), 2);
});

test('stepping up: only while the prediction stays under 80% of the frame limit', () => {
  // 5 ms at 2x: 4x is 20 ms (48%), 8x is 80 ms (192%): stop at 4x.
  assert.equal(allowedScale(8, { scale: 2, ms: 5 }, BUDGET, null), 4);
  // 2 ms at 2x: 8x is 32 ms (77%): allowed.
  assert.equal(allowedScale(8, { scale: 2, ms: 2 }, BUDGET, null), 8);
  // 10 ms at 2x: 4x is 40 ms (96%): stay at 2x.
  assert.equal(allowedScale(4, { scale: 2, ms: 10 }, BUDGET, null), 2);
});

test('no step-up prediction without a frame limit, or at or below the measured scale', () => {
  assert.equal(allowedScale(8, { scale: 2, ms: 30 }, null, null), 8);
  assert.equal(allowedScale(4, { scale: 4, ms: 60 }, BUDGET, null), 4);
  assert.equal(allowedScale(2, { scale: 4, ms: 60 }, BUDGET, null), 2);
});

test('overloaded: average GPU time over the frame limit', () => {
  assert.equal(overloaded({ samples: [50, 45, 48], timerSupported: true, fps: 20 }, 24), true);
  assert.equal(overloaded({ samples: [30, 35, 38], timerSupported: true, fps: 24 }, 24), false);
  assert.equal(overloaded({ samples: [], timerSupported: true, fps: 24 }, 24), false);
  assert.equal(overloaded({ samples: [50], timerSupported: true, fps: 24 }, null), false);
});

test('overloaded without GPU timing (Firefox): under 90% of the video frame rate drawn', () => {
  assert.equal(overloaded({ samples: [], timerSupported: false, fps: 20 }, 24), true);
  assert.equal(overloaded({ samples: [], timerSupported: false, fps: 23.5 }, 24), false);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${(e as Error).message}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);

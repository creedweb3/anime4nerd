// Unit tests for the rating prompt's pure logic (src/rate-prompt.ts). Runs in Node:
//   npx esbuild test/rate-test.ts --bundle --platform=node --format=esm --outfile=test/rate-test.js && node test/rate-test.js
import assert from 'node:assert/strict';
import {
  EMPTY_RATE, LEVEL_EPISODES, RateState, addWatch, applyAction, cardFor, levelFor, normalizeRate, pendingLevel,
} from '../src/rate-prompt';

const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);
const state = (patch: Partial<RateState>): RateState => ({ ...EMPTY_RATE, ...patch });
const first = () => 0; // deterministic "random": always the first entry of a pool

test('levelFor counts the milestones reached', () => {
  assert.equal(levelFor(0), 0);
  assert.equal(levelFor(LEVEL_EPISODES[0] - 1), 0);
  assert.equal(levelFor(LEVEL_EPISODES[0]), 1);
  assert.equal(levelFor(LEVEL_EPISODES[1]), 2);
  assert.equal(levelFor(LEVEL_EPISODES[3] + 1000), 4);
});

test('no card before the first milestone', () => {
  assert.equal(pendingLevel(state({ episodes: 2 })), null);
});

test('card shows once a milestone is reached and not yet answered', () => {
  assert.equal(pendingLevel(state({ episodes: 3 })), 1);
});

test('dismissing hides the card until the next milestone', () => {
  const s = applyAction(state({ episodes: 5 }), 'dismiss');
  assert.equal(pendingLevel(s), null);
  assert.equal(pendingLevel({ ...s, episodes: 12 }), 2);
});

test('clicking rate hides the card until the next milestone and remembers the click', () => {
  const s = applyAction(state({ episodes: 12 }), 'clicked');
  assert.equal(s.clicked, true);
  assert.equal(pendingLevel(s), null);
  assert.equal(pendingLevel({ ...s, episodes: 48 }), 3);
});

test('"already rated" stops the card for good', () => {
  const s = applyAction(state({ episodes: 48, clicked: true }), 'rated');
  assert.equal(pendingLevel({ ...s, episodes: 100000 }), null);
});

test('jumping several milestones at once shows only the highest, once', () => {
  const s = state({ episodes: 250 });
  assert.equal(pendingLevel(s), 4);
  assert.equal(pendingLevel(applyAction(s, 'dismiss')), null);
});

test('answering a card only covers the level that was shown', () => {
  // Card for level 1 was on screen; meanwhile the count reached level 2.
  const s = applyAction(state({ episodes: 12 }), 'dismiss', 1);
  assert.equal(s.shown, 1);
  assert.equal(pendingLevel(s), 2);
});

test('an answer cannot claim a level not reached yet', () => {
  assert.equal(applyAction(state({ episodes: 3 }), 'dismiss', 4).shown, 1);
  assert.equal(applyAction(state({ episodes: 3 }), 'dismiss', NaN).shown, 0);
});

test('addWatch adds time and episodes without mutating the input', () => {
  const s = state({ seconds: 10, episodes: 1 });
  const next = addWatch(s, 50, 1);
  assert.deepEqual([next.seconds, next.episodes], [60, 2]);
  assert.deepEqual([s.seconds, s.episodes], [10, 1]);
});

test('addWatch ignores bad or oversized input', () => {
  const s = state({ seconds: 10, episodes: 1 });
  assert.deepEqual(addWatch(s, NaN, -3), s);
  assert.deepEqual(addWatch(s, -5, Infinity), s);
  const big = addWatch(s, 1e9, 1e9);
  assert.ok(big.seconds <= 10 + 600 && big.episodes <= 1 + 5, 'per-message caps apply');
});

test('normalizeRate repairs junk storage', () => {
  assert.deepEqual(normalizeRate(undefined), EMPTY_RATE);
  assert.deepEqual(normalizeRate({ seconds: 'x', episodes: -1, shown: 9, clicked: 1 }), EMPTY_RATE);
  assert.deepEqual(normalizeRate({ seconds: 30, episodes: 4, shown: 1, clicked: true, rated: false, returning: true }),
    { seconds: 30, episodes: 4, shown: 1, clicked: true, rated: false, returning: true });
});

test('card text: level 1 for a new user', () => {
  const c = cardFor(state({ episodes: 3, seconds: 3960 }), 1, first);
  assert.equal(c.badge, 'genin');
  assert.equal(c.big, '3 episodes · 1.1 h');
  assert.equal(c.lines[0], 'first impressions?');
  assert.equal(c.alreadyRated, false);
});

test('returning users never get "first impressions?"', () => {
  for (let i = 0; i < 10; i++) {
    const c = cardFor(state({ episodes: 3, seconds: 3960, returning: true }), 1, () => i / 10);
    assert.notEqual(c.lines[0], 'first impressions?');
  }
});

test('card text fills seasons and days from the counts', () => {
  const l3 = cardFor(state({ episodes: 48, seconds: 19 * 3600 }), 3, first);
  assert.equal(l3.big, '48 episodes · 19 h');
  assert.equal(l3.lines[0], 'that is about 4 full seasons.');
  const l4 = cardFor(state({ episodes: 230, seconds: 88 * 3600 }), 4, first);
  assert.equal(l4.lines[0], 'that is 3.7 days of sharper anime.');
});

test('"days" line is skipped when the total is under a day', () => {
  const c = cardFor(state({ episodes: 200, seconds: 20 * 3600 }), 4, first);
  assert.ok(!c.lines[0].includes('days'), c.lines[0]);
});

test('"already rated" button appears only after a click on rate', () => {
  assert.equal(cardFor(state({ episodes: 12, clicked: true }), 2, first).alreadyRated, true);
});

test('every pool entry fits on one popup line', () => {
  for (let lvl = 1; lvl <= 4; lvl++) {
    for (let i = 0; i < 20; i++) {
      const c = cardFor(state({ episodes: 230, seconds: 88 * 3600 }), lvl, () => i / 20);
      for (const l of c.lines) assert.ok(l.length <= 38, `too long: ${l}`);
      assert.ok(c.badge.length <= 16, `badge too long: ${c.badge}`);
    }
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${e instanceof Error ? e.message : e}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

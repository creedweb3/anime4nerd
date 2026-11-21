// Unit tests for src/color.ts (node --test). Run: npm run test:color
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILT_IN_PROFILES, COLOR_KEYS, COLOR_RANGE, MAX_PROFILES, NEUTRAL_COLOR, appliedColor, cleanName, formatColor,
  isNeutral, normalizeColor, normalizeValues, snapColor, toPosition, toValue, type ColorKey,
} from '../src/color';

test('snapColor rounds to the step, clamps to the range, and turns non-numbers into neutral', () => {
  assert.equal(snapColor('brightness', 0.975), 0.98);
  assert.equal(snapColor('hue', 12.4), 12);
  assert.equal(snapColor('grain', 0.014), 0.01);
  assert.equal(snapColor('saturation', 9), 3);
  assert.equal(snapColor('gamma', 0), 0.01);
  assert.equal(snapColor('contrast', 'x'), 1);
  assert.equal(snapColor('deband', Number.NaN), 0);
});

test('normalizeValues fills every control, missing ones neutral', () => {
  const v = normalizeValues({ hue: 20 });
  assert.deepEqual(Object.keys(v), [...COLOR_KEYS]);
  assert.equal(v.hue, 20);
  assert.equal(v.brightness, 1);
  assert.deepEqual(normalizeValues(null), NEUTRAL_COLOR);
});

test('slider position and value convert both ways; neutral is position 0', () => {
  for (const k of COLOR_KEYS) {
    assert.equal(toPosition(k, NEUTRAL_COLOR[k]), 0, `${k} neutral`);
    const [lo, hi] = COLOR_RANGE[k];
    for (const v of [lo, hi, (lo + hi) / 2]) {
      assert.ok(Math.abs(toValue(k, toPosition(k, v)) - v) < 1e-9, `${k} ${v}`);
    }
  }
});

test('formatColor writes values as the color tab shows them', () => {
  const cases: [ColorKey, number, string][] = [
    ['brightness', 1.25, '125%'], ['hue', -8, '−8°'], ['hue', 20, '+20°'], ['hue', 0, '0°'],
    ['gamma', 0.92, '0.92'], ['temperature', 14, '+14'], ['tint', -9, '−9'],
    ['deband', 0, 'off'], ['deband', 35, '35'], ['grain', 0, 'off'], ['grain', 0.04, '0.04'],
  ];
  for (const [k, v, s] of cases) assert.equal(formatColor(k, v), s, `${k} ${v}`);
});

test('first run gives the included profiles, neutral first, colors on and nothing applied', () => {
  const s = normalizeColor(undefined);
  assert.deepEqual(s.profiles.map((p) => p.name), BUILT_IN_PROFILES.map((p) => p.name));
  assert.equal(s.profiles[0].id, 'neutral');
  assert.equal(s.on, true);
  assert.equal(s.always, false);
  assert.equal(s.profile, 'neutral');
  assert.equal(appliedColor(s), null);
});

test('every included profile changes at least half the controls and is already on the steps', () => {
  for (const p of BUILT_IN_PROFILES.slice(1)) {
    const changed = COLOR_KEYS.filter((k) => p.v[k] !== NEUTRAL_COLOR[k]).length;
    assert.ok(changed >= 5, `${p.name} changes ${changed}`);
    assert.deepEqual(normalizeValues(p.v), p.v, `${p.name} snaps to itself`);
  }
});

test('malformed stored state falls back safely', () => {
  const s = normalizeColor({
    on: 'yes', always: 1, profile: 'gone',
    values: { hue: 'red', brightness: 5 },
    profiles: [
      { id: 'a', name: '  mine\n', v: { saturation: 1.5 } },
      { id: 'a', name: 'duplicate', v: {} },
      { id: '', name: 'no id' },
      { id: 'b', name: '' },
      'junk',
      { id: 'neutral', name: 'fake neutral', v: { hue: 90 } },
    ],
  });
  assert.equal(s.on, true); // anything but false is on
  assert.equal(s.always, false); // only true is true
  assert.equal(s.profile, 'neutral'); // unknown id
  assert.equal(s.values.hue, 0);
  assert.equal(s.values.brightness, 2);
  assert.deepEqual(s.profiles.map((p) => [p.id, p.name]), [['neutral', 'neutral'], ['a', 'mine']]);
  assert.ok(isNeutral(s.profiles[0].v), 'neutral cannot be overwritten');
});

test('at most 16 profiles are kept, neutral included: the popup list fits without scrolling', () => {
  assert.equal(MAX_PROFILES, 16);
  const extra = Array.from({ length: 30 }, (_, i) => ({ id: `x${i}`, name: `look ${i}`, v: {} }));
  const s = normalizeColor({ profiles: [...normalizeColor(undefined).profiles, ...extra] });
  assert.equal(s.profiles.length, MAX_PROFILES);
  assert.equal(s.profiles[0].id, 'neutral');
});

test('stored profiles are kept as saved, so a deleted included one stays deleted', () => {
  const saved = normalizeColor(undefined).profiles.filter((p) => p.name !== 'vintage');
  const s = normalizeColor({ profiles: saved, profile: 'p-moody' });
  assert.ok(!s.profiles.some((p) => p.name === 'vintage'));
  assert.equal(s.profile, 'p-moody');
});

test('profile names are one trimmed line of at most 14 characters', () => {
  assert.equal(cleanName('  a\tb  '), 'a b');
  assert.equal(cleanName('x'.repeat(30)).length, 14);
  assert.equal(cleanName(42), '');
  // bidi overrides and zero-width characters could make a name read as something else
  assert.equal(cleanName('ab‮cd​e⁦f﻿'), 'abcdef');
});

test('colors apply only when on and not neutral', () => {
  const base = normalizeColor(undefined);
  const graded = { ...base, values: normalizeValues({ saturation: 1.2 }) };
  assert.ok(appliedColor(graded));
  assert.equal(appliedColor({ ...graded, on: false }), null);
});

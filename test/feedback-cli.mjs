// Unit tests for scripts/feedback.mjs. Run: node --test test/feedback-cli.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalSafe, isAnswerKey, newestFirst, formatAnswer } from '../scripts/feedback.mjs';

const KEY = 'report:2026-11-12T10:05Z-0123456789abcdef';

test('terminalSafe removes escape sequences and control characters but keeps newlines', () => {
  assert.equal(terminalSafe('a\x1b[31mred\x1b[0m\nb\x07\x9b'), 'a[31mred[0m\nb');
});

test('terminalSafe removes bidi overrides and zero-width characters', () => {
  assert.equal(terminalSafe('ab\u202Ecd\u200Bef\u2066'), 'abcdef');
});

test('isAnswerKey accepts only the key shape the function writes', () => {
  assert.equal(isAnswerKey(KEY), true);
  assert.equal(isAnswerKey('uninstall:2026-11-12T10:05Z-0123456789abcdef'), true);
  assert.equal(isAnswerKey('rl:2026-11-12:report'), false);
  assert.equal(isAnswerKey('shot:2026-11-12T10:05Z-0123456789abcdef:1'), false);
  assert.equal(isAnswerKey('report:2026-11-12T10:05Z-0123456789abcdef & calc'), false);
});

test('newestFirst sorts uninstall and report keys together by time, newest first', () => {
  const keys = [
    'uninstall:2026-11-10T09:00Z-aaaaaaaaaaaaaaaa',
    'report:2026-11-12T10:05Z-bbbbbbbbbbbbbbbb',
    'report:2026-11-11T23:59Z-cccccccccccccccc',
  ];
  assert.deepEqual(newestFirst(keys), [keys[1], keys[2], keys[0]]);
});

test('formatAnswer shows time, kind, type, version, browser, reasons, screenshots and note', () => {
  const value = JSON.stringify({
    kind: 'report', type: 'idea', reasons: ['feature', 'menu'], note: 'Add a\nhotkey', v: '1.2.5', b: 'firefox',
    at: '2026-11-12T10:05Z', shots: 2,
  });
  const out = formatAnswer(KEY, value);
  assert.match(out, /^2026-11-12 10:05 UTC {2}report \/ idea {2}v1\.2\.5 firefox$/m);
  assert.match(out, /^ {2}reasons: feature, menu$/m);
  assert.match(out, /^ {2}screenshots: shot:2026-11-12T10:05Z-0123456789abcdef:1, shot:2026-11-12T10:05Z-0123456789abcdef:2$/m);
  assert.match(out, /^ {4}Add a\n {4}hotkey$/m);
});

test('formatAnswer cleans the note before printing it', () => {
  const out = formatAnswer(KEY, JSON.stringify({ kind: 'report', note: 'hi\x1b]0;owned\x07' }));
  assert.equal(out.includes('\x1b'), false);
  assert.equal(out.includes('\x07'), false);
});

test('formatAnswer reports a value that is not JSON instead of throwing', () => {
  assert.match(formatAnswer(KEY, 'not json'), /unreadable/);
});

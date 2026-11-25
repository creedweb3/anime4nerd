// Unit tests for src/site-access.ts (node --test). Run: npm run test:access
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessLabel, accessOrigins, missingAccess } from '../src/site-access';

test('accessLabel names the first missing host and counts the rest', () => {
  assert.equal(accessLabel(['https://tau-video.xyz/*']), 'tau-video.xyz');
  assert.equal(accessLabel(['https://tau-video.xyz/*', 'https://ads.example/*']), 'tau-video.xyz and 1 more');
  assert.equal(accessLabel(['https://a.test/*', 'http://b.test/*', 'https://c.test/*']), 'a.test and 2 more');
  assert.equal(accessLabel([]), '');
});

test('accessOrigins turns page and frame URLs into one host pattern each', () => {
  assert.deepEqual(
    accessOrigins([
      'https://animecix.tv/titles/11824/overlord',
      'https://tau-video.xyz/embed/abc?vid=1',
      'https://tau-video.xyz/embed/other',
      'http://example.com:8080/x',
    ]),
    ['https://animecix.tv/*', 'https://tau-video.xyz/*', 'http://example.com/*'],
  );
});

test('accessOrigins skips pages no extension can be given access to', () => {
  assert.deepEqual(
    accessOrigins([undefined, '', 'about:blank', 'about:srcdoc', 'chrome://extensions/', 'moz-extension://id/popup.html', 'data:text/html,x', 'not a url']),
    [],
  );
});

test('missingAccess keeps only the origins the browser has not granted', async () => {
  const granted = new Set(['https://animecix.tv/*']);
  const missing = await missingAccess(['https://animecix.tv/*', 'https://tau-video.xyz/*'], async (o) => granted.has(o));
  assert.deepEqual(missing, ['https://tau-video.xyz/*']);
});

test('missingAccess treats a failed check as granted, so a broken API never shows the button', async () => {
  const missing = await missingAccess(['https://a.test/*'], async () => { throw new Error('no permissions API'); });
  assert.deepEqual(missing, []);
});

test('missingAccess also treats a check that throws at once (API missing) as granted', async () => {
  const missing = await missingAccess(['https://a.test/*'], () => { throw new TypeError('permissions is undefined'); });
  assert.deepEqual(missing, []);
});

// Unit tests for src/doc-ips.ts: which address a document is filed under, in either event order,
// and that nothing a page can leave behind (a 204, a redirect, an earlier navigation) is filed
// under a later document. Runs in Node:
//   npx esbuild test/doc-ips-test.ts --bundle --platform=node --format=esm --outfile=test/doc-ips-test.js && node test/doc-ips-test.js
import assert from 'node:assert/strict';
import { DocIps } from '../src/doc-ips';

const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);
const NAV = '7:0';
const URL_A = 'http://reader.example/chapter';
const PUBLIC = '203.0.113.9';
const LOCAL = '127.0.0.1';

test('response first, then commit (Chrome order): the commit files the address', () => {
  const d = new DocIps();
  d.beforeNavigate(NAV);
  assert.equal(d.response(NAV, URL_A, 200, PUBLIC), null);
  assert.equal(d.commit(NAV, URL_A, '7:doc1'), PUBLIC);
});

test('commit first, then response (Firefox order): the response files the address', () => {
  const d = new DocIps();
  d.beforeNavigate(NAV);
  assert.equal(d.commit(NAV, URL_A, '7:doc1'), undefined);
  assert.deepEqual(d.response(NAV, URL_A, 200, PUBLIC), { doc: '7:doc1', ip: PUBLIC });
});

test('the fragment does not matter', () => {
  const d = new DocIps();
  d.response(NAV, `${URL_A}#p3`, 200, PUBLIC);
  assert.equal(d.commit(NAV, URL_A, '7:doc1'), PUBLIC);
});

test('DNS rebinding: a 204 to the same URL is never filed under the next document', () => {
  const d = new DocIps();
  // First navigation: the name resolves to a local address, which answers 204 (no document).
  d.beforeNavigate(NAV);
  assert.equal(d.response(NAV, URL_A, 204, LOCAL), null);
  // Second navigation to the same URL, now public; Firefox commits before its response arrives.
  d.beforeNavigate(NAV);
  assert.equal(d.commit(NAV, URL_A, '7:doc2'), undefined, 'the local address must not be filed at commit');
  assert.deepEqual(d.response(NAV, URL_A, 200, PUBLIC), { doc: '7:doc2', ip: PUBLIC });
});

test('DNS rebinding: a 204 seen after the next navigation started is still dropped', () => {
  const d = new DocIps();
  d.beforeNavigate(NAV);
  d.beforeNavigate(NAV); // the second navigation started before the first one's response was seen
  assert.equal(d.response(NAV, URL_A, 204, LOCAL), null);
  assert.equal(d.commit(NAV, URL_A, '7:doc2'), undefined);
  assert.deepEqual(d.response(NAV, URL_A, 200, PUBLIC), { doc: '7:doc2', ip: PUBLIC });
});

test('a stale response from an earlier navigation is dropped when a new one starts', () => {
  const d = new DocIps();
  d.beforeNavigate(NAV);
  d.response(NAV, URL_A, 200, LOCAL); // e.g. a download: a response, no commit
  d.beforeNavigate(NAV);
  assert.equal(d.commit(NAV, URL_A, '7:doc2'), undefined);
});

test('a commit waiting for its response is dropped when a new navigation starts', () => {
  const d = new DocIps();
  d.beforeNavigate(NAV);
  d.commit(NAV, URL_A, '7:doc1'); // a cached or restored page: no response ever comes
  d.beforeNavigate(NAV);
  assert.equal(d.response(NAV, URL_A, 200, LOCAL), null, 'the old document must not get this address');
});

test('redirect and reset responses never file an address', () => {
  for (const status of [204, 205, 301, 302, 303, 307, 308]) {
    const d = new DocIps();
    d.commit(NAV, URL_A, '7:doc1');
    assert.equal(d.response(NAV, URL_A, status, LOCAL), null, `status ${status} after the commit`);
    const e = new DocIps();
    e.response(NAV, URL_A, status, LOCAL);
    assert.equal(e.commit(NAV, URL_A, '7:doc1'), undefined, `status ${status} before the commit`);
  }
});

test('a response for another URL is not filed under the waiting commit', () => {
  const d = new DocIps();
  d.commit(NAV, URL_A, '7:doc1');
  assert.equal(d.response(NAV, 'http://reader.example/other', 200, LOCAL), null);
});

test('frames are kept apart', () => {
  const d = new DocIps();
  d.response('7:5', URL_A, 200, LOCAL);
  assert.equal(d.commit(NAV, URL_A, '7:doc1'), undefined);
});

test('a response with no address files nothing', () => {
  const d = new DocIps();
  d.commit(NAV, URL_A, '7:doc1');
  assert.equal(d.response(NAV, URL_A, 200, undefined), null);
  const e = new DocIps();
  e.response(NAV, URL_A, 200, undefined);
  assert.equal(e.commit(NAV, URL_A, '7:doc1'), undefined);
});

test('a non-http commit waits for nothing', () => {
  const d = new DocIps();
  d.commit(NAV, 'about:blank', '7:doc1');
  assert.equal(d.response(NAV, 'about:blank', 200, LOCAL), null);
});

test('a closed tab is forgotten', () => {
  const d = new DocIps();
  d.response(NAV, URL_A, 200, LOCAL);
  d.commit('7:3', URL_A, '7:doc3');
  d.forgetTab(7);
  assert.equal(d.commit(NAV, URL_A, '7:doc1'), undefined);
  assert.equal(d.response('7:3', URL_A, 200, LOCAL), null);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${e instanceof Error ? e.message : e}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

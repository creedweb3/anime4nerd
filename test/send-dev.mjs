// Abuse checks against a running `wrangler pages dev` (Turnstile test secret with
// ALLOW_TEST_TURNSTILE=1, local KV); see docs/FEEDBACK_SETUP.md.
// Usage: node test/send-dev.mjs [http://localhost:8788]
// Sends real requests, so it uses up the local per-visitor daily cap; run it against local state only.
import assert from 'node:assert/strict';

const BASE = process.argv[2] ?? 'http://localhost:8788';
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const ok = { kind: 'uninstall', reasons: ['other'], note: 'dev abuse test', v: '1.2.4', token: TOKEN };
const report = { kind: 'report', reasons: ['look'], note: 'dev abuse test', v: '1.2.4', b: 'chrome', token: TOKEN };
const b64 = (s) => Buffer.from(s, 'latin1').toString('base64');

async function post(body, { origin = BASE, type = 'application/json' } = {}) {
  const res = await fetch(`${BASE}/api/send`, {
    method: 'POST',
    headers: { origin, 'content-type': type },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text(), headers: res.headers };
}

const checks = [
  ['unknown field', { ...ok, admin: true }, 400],
  ['reason not on the list', { ...ok, reasons: ['drop table'] }, 400],
  ['bad version', { ...ok, v: '1.2.4"><img src=x>' }, 400],
  ['note too long', { ...ok, note: 'x'.repeat(501) }, 400],
  ['kind as array', { ...ok, kind: ['uninstall'] }, 400],
  ['not JSON', '{"kind":', 400],
  ['2 MB body', { ...ok, note: 'x'.repeat(2_000_000) }, 413],
  ['PNG upload', { ...report, shots: [b64('\x89PNG\r\n\x1a\n' + '0'.repeat(100))] }, 400],
  ['SVG upload', { ...report, shots: [b64('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')] }, 400],
  ['HTML behind JPEG markers', { ...report, shots: [b64('\xff\xd8\xff<html><script>alert(1)</script></html>\xff\xd9')] }, 400],
  ['not base64', { ...report, shots: ['%%%%'] }, 400],
  ['four screenshots', { ...report, shots: ['a', 'a', 'a', 'a'] }, 400],
];
for (const [name, body, want] of checks) {
  const r = await post(body);
  assert.equal(r.status, want, `${name}: ${r.status} ${r.text}`);
  console.log(`ok  ${name} -> ${r.status} ${r.text}`);
}

let r = await post(ok, { origin: 'https://evil.example' });
assert.equal(r.status, 403);
console.log(`ok  foreign origin -> ${r.status}`);
r = await post(ok, { type: 'text/plain' });
assert.equal(r.status, 415);
console.log(`ok  text/plain -> ${r.status}`);
assert.equal(r.headers.get('cache-control'), 'no-store');
assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');

// Script and HTML in the text are accepted and stored as plain text (never rendered).
r = await post({ ...ok, note: '<script>alert(1)</script><img src=x onerror=alert(1)> {{7*7}} ${7*7} \'; DROP TABLE x;--' });
assert.equal(r.status, 200, r.text);
console.log('ok  script/HTML text -> 200, stored as text');

// Valid answers until the per-visitor cap answers 429 (at most 5 per day).
let sent = 1;
for (;;) {
  r = await post(ok);
  if (r.status !== 200) break;
  sent++;
  assert.ok(sent <= 5, 'cap never hit');
}
assert.equal(r.status, 429, r.text);
console.log(`ok  rate limit -> 429 after ${sent} valid answers from this script (${r.text})`);

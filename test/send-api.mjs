// Unit tests for functions/api/send.js. Run: node --test test/send-api.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, ipBucket, isJpeg } from '../functions/api/send.js';

const ORIGIN = 'https://anime4nerd.pages.dev';
// The function logs one line per refused request; keep test output readable.
const logged = [];
console.info = (line) => logged.push(line);

function memoryKV() {
  const store = new Map();
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key).value : null; },
    async put(key, value, opts = {}) { store.set(key, { value, opts }); },
  };
}

const passFor = (action) => async () => Response.json({ success: true, hostname: 'anime4nerd.pages.dev', action });
const passTurnstile = passFor('report');
const failTurnstile = async () => Response.json({ success: false });

const env = (kv = memoryKV()) => ({ FEEDBACK: kv, TURNSTILE_SECRET: 's', IP_SALT: 'salt' });
// Structurally valid JPEG: SOI, SOF0 segment, SOS segment, scan data, EOI.
const jpegBytes = (size = 100, sofMarker = 0xc0) => {
  const b = new Uint8Array(size);
  b.set([0xff, 0xd8]);
  b.set([0xff, sofMarker, 0x00, 0x0b], 2); // 11-byte segment
  b.set([0xff, 0xda, 0x00, 0x08], 15); // 8-byte segment, then scan data
  b.set([0xff, 0xd9], size - 2);
  return b;
};
const jpeg = (size, sofMarker) => Buffer.from(jpegBytes(size, sofMarker)).toString('base64');

// A canvas-style JPEG header: SOI, APP0 "JFIF", APP2 "ICC_PROFILE" (Chromium), then the frame.
const canvasJpeg = (extraSegment = []) => {
  const seg = (marker, text) => [0xff, marker, (text.length + 2) >> 8, (text.length + 2) & 0xff, ...Buffer.from(text, 'latin1')];
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0'),
    ...seg(0xe2, 'ICC_PROFILE\0\x01\x01'),
    ...extraSegment,
    ...seg(0xdb, '\0'.repeat(65)),
    ...seg(0xc0, '\x08\0\x10\0\x10\x01\x01\x11\0'),
    ...seg(0xc4, '\0'.repeat(20)),
    ...seg(0xda, '\x01\x01\0\0\x3f\0'),
    0x12, 0x34, 0x56,
    0xff, 0xd9,
  ]);
};

function post(body, { origin = ORIGIN, type = 'application/json', ip = '203.0.113.7', raw } = {}) {
  const headers = { origin, 'content-type': type };
  if (ip) headers['cf-connecting-ip'] = ip;
  return new Request(`${ORIGIN}/api/send`, {
    method: 'POST',
    headers,
    body: raw ?? JSON.stringify(body),
  });
}

const report = (extra = {}) => ({ kind: 'report', reasons: ['slow'], note: 'stutters on site x', v: '1.2.4', b: 'chrome', token: 't', ...extra });
const uninstall = (extra = {}) => ({ kind: 'uninstall', reasons: ['trying'], note: '', v: '1.2.4', token: 't', ...extra });

async function send(body, opts, e = env(), verify = passTurnstile) {
  const res = await handle(post(body, opts), e, verify);
  return { status: res.status, body: await res.json(), env: e };
}

test('stores a valid report with screenshots, never the IP', async () => {
  const { status, body, env: e } = await send(report({ shots: [jpeg(), jpeg()] }));
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  const keys = [...e.FEEDBACK.store.keys()];
  const rec = JSON.parse(e.FEEDBACK.store.get(keys.find((k) => k.startsWith('report:'))).value);
  assert.deepEqual({ ...rec, at: 0 }, { kind: 'report', reasons: ['slow'], note: 'stutters on site x', v: '1.2.4', b: 'chrome', type: 'bug', shots: 2, at: 0 });
  assert.equal(keys.filter((k) => k.startsWith('shot:')).length, 2);
  for (const [k, { value }] of e.FEEDBACK.store) {
    assert.ok(!k.includes('203.0.113.7') && !String(value).includes('203.0.113.7'), 'raw IP stored');
  }
});

test('stores an idea from the report form, with its own reasons', async () => {
  const { status, env: e } = await send(report({ type: 'idea', reasons: ['feature', 'browser'], note: 'add a sharpness slider' }));
  assert.equal(status, 200);
  const rec = JSON.parse([...e.FEEDBACK.store].find(([k]) => k.startsWith('report:'))[1].value);
  assert.equal(rec.type, 'idea');
  assert.deepEqual(rec.reasons, ['feature', 'browser']);
});

test('stores a valid uninstall answer', async () => {
  const { status, env: e } = await send(uninstall(), {}, env(), passFor('uninstall'));
  assert.equal(status, 200);
  assert.ok([...e.FEEDBACK.store.keys()].some((k) => k.startsWith('uninstall:')));
});

test('strips control, bidi and invisible characters from the note', async () => {
  const { env: e } = await send(report({ note: 'a\u0000b\u202Ec\r\nd\u0007\u200Be\u2028f\uFEFFg\uD800h\u00ADi\u180Ej\uFFF9k\u{E0041}l' }));
  const rec = [...e.FEEDBACK.store].find(([k]) => k.startsWith('report:'))[1].value;
  assert.equal(JSON.parse(rec).note, 'abc\ndefg\uFFFDhijkl');
});

test('accepts canvas JPEG headers and refuses metadata or comment segments', () => {
  assert.ok(isJpeg(canvasJpeg()), 'Chromium-style JFIF + ICC header refused');
  const seg = (marker, text) => [0xff, marker, (text.length + 2) >> 8, (text.length + 2) & 0xff, ...Buffer.from(text, 'latin1')];
  assert.ok(!isJpeg(canvasJpeg(seg(0xe1, 'Exif\0\0GPS'))), 'EXIF accepted');
  assert.ok(!isJpeg(canvasJpeg(seg(0xe1, 'http://ns.adobe.com/xap/1.0/\0<x/>'))), 'XMP accepted');
  assert.ok(!isJpeg(canvasJpeg(seg(0xfe, '<script>alert(1)</script>'))), 'comment accepted');
  assert.ok(!isJpeg(canvasJpeg(seg(0xed, 'Photoshop 3.0\0'))), 'APP13 accepted');
  const fakeApp0 = canvasJpeg();
  fakeApp0[6] = 0x58; // "JFIF" -> "XFIF"
  assert.ok(!isJpeg(fakeApp0), 'non-JFIF APP0 accepted');
  const truncated = canvasJpeg().slice(0, 30);
  assert.ok(!isJpeg(new Uint8Array([...truncated, 0xff, 0xd9])), 'truncated header accepted');
  // Allowed segments may not carry extra payload or repeat beyond what an encoder writes.
  assert.ok(!isJpeg(canvasJpeg(seg(0xe2, 'ICC_PROFILE\0' + 'x'.repeat(5000)))), 'oversized or second ICC accepted');
  assert.ok(!isJpeg(canvasJpeg(seg(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0'))), 'second APP0 accepted');
  const thumb = canvasJpeg();
  thumb[2 + 4 + 12] = 4; // thumbnail width 4 in APP0
  assert.ok(!isJpeg(thumb), 'APP0 thumbnail accepted');
  const dqt = seg(0xdb, '\0'.repeat(65));
  assert.ok(!isJpeg(canvasJpeg([...dqt, ...dqt, ...dqt, ...dqt])), 'five DQT segments accepted');
  assert.ok(!isJpeg(canvasJpeg(seg(0xdb, '\0'.repeat(600)))), 'oversized DQT accepted');
});

test('stores times cut to the minute and gives screenshots an expiry', async () => {
  const { env: e } = await send(report({ shots: [jpeg()] }));
  const [recKey, rec] = [...e.FEEDBACK.store].find(([k]) => k.startsWith('report:'));
  assert.match(JSON.parse(rec.value).at, /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
  assert.match(recKey, /^report:\d{4}-\d\d-\d\dT\d\d:\d\dZ-[0-9a-f]{16}$/);
  assert.equal(rec.opts.expirationTtl, undefined, 'text answers are kept');
  const shot = [...e.FEEDBACK.store].find(([k]) => k.startsWith('shot:'))[1];
  assert.ok(shot.opts.expirationTtl > 0);
  assert.equal(shot.opts.metadata.contentType, 'image/jpeg');
});

test('past the daily screenshot ceiling the text is kept and the drop recorded', async () => {
  const e = env();
  await e.FEEDBACK.put(`rl:${new Date().toISOString().slice(0, 10)}:shots`, '29');
  const r = await send(report({ shots: [jpeg(), jpeg()] }), {}, e);
  assert.equal(r.status, 200);
  const rec = JSON.parse([...e.FEEDBACK.store].find(([k]) => k.startsWith('report:'))[1].value);
  assert.equal(rec.shots, 1);
  assert.equal(rec.shotsDropped, 1);
});

test('groups IPv6 visitors by /64', () => {
  assert.equal(ipBucket('203.0.113.7'), '203.0.113.7');
  assert.equal(ipBucket('2001:db8:aa:bb:1:2:3:4'), '2001:db8:aa:bb::/64');
  assert.equal(ipBucket('2001:0db8:00aa:00bb::9'), '2001:db8:aa:bb::/64');
  assert.equal(ipBucket('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipBucket('::1'), '0:0:0:0::/64');
  assert.equal(ipBucket('::ffff:198.51.100.4'), '198.51.100.4');
});

test('one IPv6 /64 shares a single daily cap', async () => {
  const e = env();
  for (let i = 1; i <= 5; i++) assert.equal((await send(report(), { ip: `2001:db8:1:2::${i}` }, e)).status, 200);
  assert.equal((await send(report(), { ip: '2001:db8:1:2:ffff::9' }, e)).status, 429);
});

test('rejects bad fields without writing anything', async () => {
  const cases = [
    [report({ extra: 1 }), 'unknown_field'],
    [uninstall({ shots: [] }), 'unknown_field'],
    [uninstall({ b: 'chrome' }), 'unknown_field'],
    [report({ kind: 'admin' }), 'bad_kind'],
    [report({ kind: '__proto__' }), 'bad_kind'],
    [report({ kind: ['report'] }), 'bad_kind'],
    [report({ shots: [jpeg(100, 0xe1)] }), 'bad_shot'],
    [report({ shots: [Buffer.from('\xff\xd8\xff<html><script>alert(1)</script>\xff\xd9', 'latin1').toString('base64')] }), 'bad_shot'],
    [report({ shots: [Buffer.from('\x89PNG\r\n\x1a\n0000', 'latin1').toString('base64')] }), 'bad_shot'],
    [report({ reasons: ['trying'] }), 'bad_reasons'],
    [report({ type: 'idea', reasons: ['slow'] }), 'bad_reasons'],
    [report({ type: 'bug', reasons: ['feature'] }), 'bad_reasons'],
    [report({ type: 'wish' }), 'bad_type'],
    [report({ type: ['idea'] }), 'bad_type'],
    [report({ type: 'idea', reasons: ['feature'], note: '' }), 'note_required'],
    [uninstall({ type: 'idea' }), 'unknown_field'],
    [report({ reasons: ['slow', 'slow'] }), 'bad_reasons'],
    [report({ reasons: 'slow' }), 'bad_reasons'],
    [report({ note: '' }), 'note_required'],
    [report({ note: 'x'.repeat(1001) }), 'bad_note'],
    [uninstall({ note: 'x'.repeat(501) }), 'bad_note'],
    [uninstall({ reasons: [], note: '  ' }), 'empty'],
    [report({ note: { $gt: '' } }), 'bad_note'],
    [report({ v: '1.2' }), 'bad_version'],
    [report({ v: '1.2.4<script>' }), 'bad_version'],
    [report({ b: 'edge' }), 'bad_browser'],
    [report({ token: '' }), 'bad_token'],
    [report({ shots: [jpeg(), jpeg(), jpeg(), jpeg()] }), 'bad_shot'],
    [report({ shots: [Buffer.from('<svg onload=alert(1)>').toString('base64')] }), 'bad_shot'],
    [report({ shots: [jpeg(270_000)] }), 'bad_shot'],
    [report({ shots: ['not base64!'] }), 'bad_shot'],
    [[], 'bad_body'],
  ];
  for (const [body, error] of cases) {
    const r = await send(body);
    assert.equal(r.status, 400, error);
    assert.equal(r.body.error, error);
    assert.equal(r.env.FEEDBACK.store.size, 0, `${error} wrote to KV`);
  }
});

test('rejects wrong origin, type, broken JSON and oversize bodies', async () => {
  assert.equal((await send(report(), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send(report(), { type: 'text/plain' })).status, 415);
  assert.equal((await send(null, { raw: '{"kind":' })).body.error, 'bad_json');
  // A literal "__proto__" key in JSON becomes an own key, which the field allow-list refuses.
  const proto = await send(null, { raw: '{"kind":"report","note":"a","token":"t","__proto__":{"admin":1}}' });
  assert.equal(proto.body.error, 'unknown_field');
  assert.equal(proto.env.FEEDBACK.store.size, 0);
  const big = await send(null, { raw: JSON.stringify(report({ note: 'x'.repeat(1_500_000) })) });
  assert.equal(big.status, 413);
  // Streamed with no Content-Length: the reader cap must stop it.
  const chunk = new Uint8Array(100_000).fill(0x20);
  let sent = 0;
  const stream = new ReadableStream({ pull(c) { sent++ < 20 ? c.enqueue(chunk) : c.close(); } });
  const req = new Request(`${ORIGIN}/api/send`, { method: 'POST', duplex: 'half', body: stream, headers: { origin: ORIGIN, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' } });
  assert.equal(req.headers.get('content-length'), null);
  assert.equal((await handle(req, env(), passTurnstile)).status, 413);
  assert.ok(sent < 20, 'read the whole stream');
});

test('fails closed without Turnstile success or configuration', async () => {
  // A bad token is refused before any KV read or write.
  const reads = [];
  const kv = memoryKV();
  const spy = { ...kv, get: (k) => { reads.push(k); return kv.get(k); } };
  const r = await send(report(), {}, env(spy), failTurnstile);
  assert.equal(r.status, 403);
  assert.equal(kv.store.size, 0);
  assert.deepEqual(reads, []);
  assert.equal((await send(report(), {}, env(), passFor('uninstall'))).status, 403, 'wrong action accepted');
  assert.equal((await send(report(), {}, env(), async () => { throw new Error('down'); })).status, 503);
  const res = await handle(post(report()), { FEEDBACK: memoryKV() }, passTurnstile);
  assert.equal(res.status, 503);
  // Cloudflare's test keys pass only with the local-development flag.
  const testKey = async () => Response.json({ success: true, hostname: 'example.com' });
  assert.equal((await send(report(), {}, env(), testKey)).status, 403, 'test key accepted in production');
  assert.equal((await send(report(), {}, { ...env(), ALLOW_TEST_TURNSTILE: '1' }, testKey)).status, 200);
  // A hanging siteverify is cut off by the timeout signal.
  // ...and is never sent the visitor's IP.
  const sent = await new Promise((resolve) => {
    send(report(), {}, env(), async (_u, init) => { resolve(init); return Response.json({ success: false }); });
  });
  assert.ok(sent.signal instanceof AbortSignal, 'siteverify has no timeout');
  assert.equal(sent.body.get('remoteip'), null);
  assert.ok(![...sent.body.values()].some((v) => String(v).includes('203.0.113.7')));
});

// Workers' Free plan allows 10 ms CPU per request. Workers has a native Uint8Array.fromBase64;
// Node 24 does not, so stand in Buffer's native decoder for the estimate.
test('a maximum-size report stays well inside the CPU budget (warm, native base64)', async () => {
  const had = Object.hasOwn(Uint8Array, 'fromBase64');
  if (!had) Uint8Array.fromBase64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
  try {
    const big = jpeg(260_000);
    const times = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      const r = await send(report({ shots: [big, big, big] }), { ip: `198.51.100.${i}` });
      times.push(performance.now() - t0);
      assert.equal(r.status, 200);
    }
    const median = times.sort((a, b) => a - b)[7];
    console.log(`    3 x 260 KB report: median ${median.toFixed(1)} ms (Node wall time, includes the KV mock)`);
    assert.ok(median < 8, `median ${median.toFixed(1)} ms`);
  } finally {
    if (!had) delete Uint8Array.fromBase64;
  }
});

test('caps answers per visitor per day', async () => {
  const e = env();
  for (let i = 0; i < 5; i++) assert.equal((await send(report(), {}, e)).status, 200);
  const sixth = await send(report(), {}, e);
  assert.equal(sixth.status, 429);
  assert.equal(sixth.body.error, 'rate_limited');
  assert.equal((await send(report(), { ip: '198.51.100.1' }, e)).status, 200, 'other visitor blocked');
});

test('caps each form separately per day', async () => {
  const e = env();
  await e.FEEDBACK.put(`rl:${new Date().toISOString().slice(0, 10)}:report`, '60');
  const r = await send(report(), {}, e);
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'daily_limit');
  // A flood of reports leaves the uninstall form working.
  assert.equal((await send(uninstall(), {}, e, passFor('uninstall'))).status, 200);
});

test('caps screenshots per visitor per day, keeping the text', async () => {
  const e = env();
  assert.equal((await send(report({ shots: [jpeg(), jpeg()] }), {}, e)).status, 200);
  assert.equal((await send(report({ shots: [jpeg(), jpeg()] }), {}, e)).status, 200);
  const recs = [...e.FEEDBACK.store].filter(([k]) => k.startsWith('report:')).map(([, v]) => JSON.parse(v.value));
  assert.deepEqual(recs.map((r) => [r.shots, r.shotsDropped ?? 0]).sort(), [[1, 1], [2, 0]]);
  assert.equal([...e.FEEDBACK.store.keys()].filter((k) => k.startsWith('shot:')).length, 3);
});

test('refuses a request without the Cloudflare client IP header', async () => {
  const r = await send(report(), { ip: '' });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'no_ip');
  assert.equal((await send(report(), { ip: '' }, { ...env(), ALLOW_TEST_TURNSTILE: '1' })).status, 200);
});

test('screenshots are decoded only after Turnstile', async () => {
  const notJpeg = Buffer.from('a'.repeat(300)).toString('base64');
  assert.equal((await send(report({ shots: [notJpeg] }), {}, env(), failTurnstile)).status, 403);
  assert.equal((await send(report({ shots: [notJpeg] }))).body.error, 'bad_shot');
});

test('a KV failure answers 503 unavailable, and logs only the code', async () => {
  const broken = { ...memoryKV(), put: async () => { throw new Error('KV put() limit exceeded for the day.'); } };
  logged.length = 0;
  const r = await send(report({ note: 'secret note 203.0.113.7' }), {}, env(broken));
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'unavailable');
  assert.equal(logged.length, 1);
  assert.deepEqual(JSON.parse(logged[0]), { event: 'feedback_rejected', status: 503, code: 'unavailable' });
  assert.ok(!logged[0].includes('secret') && !logged[0].includes('203.0.113.7'));
  // A KV read failure is the same 503; an unrelated bug stays a 500 with only its type logged.
  const unreadable = { ...memoryKV(), get: async () => { throw new Error('KV get() limit exceeded'); } };
  assert.equal((await send(report(), {}, env(unreadable))).body.error, 'unavailable');
  logged.length = 0;
  const buggy = { ...memoryKV(), get: async () => '1', put: async () => {} };
  const bug = await send(report(), {}, { ...env(buggy), IP_SALT: { toString() { throw new TypeError('boom'); } } });
  assert.equal(bug.status, 500);
  assert.equal(bug.body.error, 'error');
  assert.deepEqual(JSON.parse(logged.at(-1)), { event: 'feedback_rejected', status: 500, code: 'error:TypeError' });
});

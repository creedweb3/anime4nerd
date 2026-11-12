// POST /api/send: stores one anonymous answer from the site's /uninstalled or /report form.
//
// Bindings (Cloudflare Pages > Settings > Bindings / Variables and Secrets; see docs/FEEDBACK_SETUP.md):
//   FEEDBACK              Workers KV namespace: answers, screenshots, rate counters
//   TURNSTILE_SECRET      secret: Turnstile widget secret key
//   IP_SALT               secret: random string mixed into the per-visitor counter hash
//   ALLOW_TEST_TURNSTILE  local development only: "1" accepts Cloudflare's Turnstile test keys
//                         and requests without a CF-Connecting-IP header
//
// Everything is plain data in KV: no SQL, no queries, nothing executed or rendered as HTML here.
// The Free plan cannot bill: past its quotas, requests and writes simply fail, and this function
// then answers 503 "unavailable" instead of storing anything.
//
// Order of work, cheapest first: headers, a capped body read, shape checks on every field,
// Turnstile, the daily counters, and only then decoding and checking the screenshots.

const MAX_BODY = 1_050_000; // 3 screenshots of 260 KB as base64, plus the text fields
const MAX_SHOT = 260_000; // bytes per decoded JPEG (the page re-encodes to at most 250 KB)
const MAX_SHOT_B64 = Math.ceil(MAX_SHOT / 3) * 4;
const MAX_SHOTS = 3;
const MAX_TOKEN = 2048;
const PER_VISITOR_PER_DAY = 5;
const SHOTS_PER_VISITOR_PER_DAY = 3;
// Daily ceilings for everyone together, kept per form so a flood of one kind can't use up the
// other's. They keep KV inside the Free plan: at most 120 answers x 3 writes plus 30 screenshots
// x 3 writes = 450 of the 1,000 daily writes, and 30 x 260 KB x 60 days = 468 MB of 1 GB.
const PER_KIND_PER_DAY = { uninstall: 60, report: 60 };
const SHOTS_PER_DAY = 30;
const SHOT_TTL = 60 * 24 * 60 * 60; // screenshots expire after 60 days; text answers are kept
const COUNTER_TTL = 2 * 24 * 60 * 60; // counters expire after two days
const VERIFY_TIMEOUT_MS = 5000;

const KINDS = {
  uninstall: {
    reasons: ['controls', 'slow', 'site', 'look', 'trying', 'other'],
    noteMax: 500,
    fields: ['kind', 'reasons', 'note', 'v', 'token'],
  },
  report: {
    reasons: ['controls', 'slow', 'site', 'look', 'menu', 'other'],
    noteMax: 1000,
    fields: ['kind', 'reasons', 'note', 'v', 'b', 'token', 'shots'],
  },
};

const VERSION = /^\d+\.\d+\.\d+$/;
const BROWSERS = ['chrome', 'firefox'];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// Invisible or text-disguising code points, removed from notes: C0/C1 controls except tab and
// newline, soft hyphen, Mongolian vowel separator, zero-width characters, bidi controls,
// line/paragraph separators, word joiners, the byte-order mark, interlinear annotation
// characters and Unicode tag characters. Built from numbers so the source stays plain ASCII.
const INVISIBLE_RANGES = [
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x180e, 0x180e], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
];
const cp = (n) => `\\u{${n.toString(16)}}`;
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => `${cp(a)}-${cp(b)}`).join('')}]`, 'gu');
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
// JPEG start-of-frame markers (baseline, progressive, lossless, arithmetic variants).
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const reply = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

class Rejected extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
  }
}
const reject = (status, code) => {
  throw new Rejected(status, code);
};

// Reads at most `limit` bytes, whatever Content-Length claims.
async function readCapped(request, limit) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      reject(413, 'too_large');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

function cleanText(value, max) {
  if (value === undefined) return '';
  if (typeof value !== 'string') reject(400, 'bad_note');
  const text = value.toWellFormed().replace(/\r\n?/g, '\n').replace(INVISIBLE, '').trim();
  if (text.length > max) reject(400, 'bad_note');
  return text;
}

function base64Bytes(value) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(value);
  const bin = atob(value);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const ascii = (b, at, text) => [...text].every((ch, k) => b[at + k] === ch.charCodeAt(0));

// True for a JPEG as a browser canvas writes it: SOI; then only a JFIF APP0 segment, an
// ICC_PROFILE APP2 segment (Chromium adds one), quantisation/Huffman/restart tables and one
// start-of-frame; then the start-of-scan, and EOI at the end. Each segment kind may appear only
// as often and as large as a canvas encoder writes it (APP0 exactly 16 bytes with no thumbnail,
// one ICC segment of at most 4 KB), and any other APPn or COM segment (EXIF, XMP, comments,
// vendor data) is refused, so no metadata can ride along in the headers. The entropy-coded scan
// itself is not decoded here.
const SEGMENT_LIMITS = new Map([
  [0xe0, { times: 1, maxLen: 16 }], // APP0 JFIF
  [0xe2, { times: 1, maxLen: 4096 }], // APP2 ICC_PROFILE
  [0xdb, { times: 4, maxLen: 2 + 4 * 129 }], // DQT: up to four 16-bit tables
  [0xc4, { times: 8, maxLen: 2 + 4 * (17 + 256) }], // DHT: up to four tables
  [0xdd, { times: 1, maxLen: 4 }], // DRI
]);
const SOF_LIMIT = { times: 1, maxLen: 8 + 3 * 4 }; // up to four colour components

export function isJpeg(b) {
  const n = b.length;
  if (n < 8 || b[0] !== 0xff || b[1] !== 0xd8 || b[n - 2] !== 0xff || b[n - 1] !== 0xd9) return false;
  const seen = new Map();
  let sof = false;
  let i = 2;
  while (i + 4 <= n) {
    if (b[i] !== 0xff) return false;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xda) return sof; // start of scan: entropy-coded data follows
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > n) return false;
    const limit = SOF.has(marker) ? SOF_LIMIT : SEGMENT_LIMITS.get(marker);
    const kind = SOF.has(marker) ? 'sof' : marker;
    const times = (seen.get(kind) ?? 0) + 1;
    if (!limit || times > limit.times || len > limit.maxLen) return false;
    seen.set(kind, times);
    const body = i + 4;
    if (SOF.has(marker)) sof = true;
    // APP0: "JFIF\0", version, units, densities, and a 0 x 0 thumbnail.
    if (marker === 0xe0 && (len !== 16 || !ascii(b, body, 'JFIF\0') || b[body + 12] !== 0 || b[body + 13] !== 0)) return false;
    if (marker === 0xe2 && !ascii(b, body, 'ICC_PROFILE\0')) return false;
    i += 2 + len;
  }
  return false;
}

// Shape-checks one screenshot without decoding it (that waits until after Turnstile).
function checkShotShape(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_SHOT_B64 || value.length % 4 !== 0) {
    reject(400, 'bad_shot');
  }
  // Only the first and last characters are checked here; the decoder checks the rest later.
  if (!BASE64.test(value.slice(0, 64)) || !BASE64.test(value.slice(-64))) reject(400, 'bad_shot');
}

function decodeShot(value) {
  let bytes;
  try {
    bytes = base64Bytes(value);
  } catch {
    reject(400, 'bad_shot');
  }
  if (bytes.length > MAX_SHOT || !isJpeg(bytes)) reject(400, 'bad_shot');
  return bytes;
}

// Checks every field's shape and returns a clean record, the screenshots still as base64, and the
// Turnstile token. Throws Rejected on anything unexpected.
export function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject(400, 'bad_body');
  if (typeof input.kind !== 'string' || !Object.hasOwn(KINDS, input.kind)) reject(400, 'bad_kind');
  const spec = KINDS[input.kind];
  for (const key of Object.keys(input)) if (!spec.fields.includes(key)) reject(400, 'unknown_field');

  const reasons = input.reasons ?? [];
  if (!Array.isArray(reasons) || reasons.length > spec.reasons.length) reject(400, 'bad_reasons');
  for (const r of reasons) if (typeof r !== 'string' || !spec.reasons.includes(r)) reject(400, 'bad_reasons');
  if (new Set(reasons).size !== reasons.length) reject(400, 'bad_reasons');

  const note = cleanText(input.note, spec.noteMax);
  if (input.kind === 'report' && !note) reject(400, 'note_required');
  if (input.kind === 'uninstall' && !note && !reasons.length) reject(400, 'empty');

  const v = input.v ?? '';
  if (typeof v !== 'string' || v.length > 20 || (v && !VERSION.test(v))) reject(400, 'bad_version');
  const b = input.b ?? '';
  if (typeof b !== 'string' || (b && !BROWSERS.includes(b))) reject(400, 'bad_browser');

  if (typeof input.token !== 'string' || !input.token || input.token.length > MAX_TOKEN) reject(400, 'bad_token');

  const shots = input.shots ?? [];
  if (!Array.isArray(shots) || shots.length > MAX_SHOTS) reject(400, 'bad_shot');
  shots.forEach(checkShotShape);

  const record = { kind: input.kind, reasons, note, v, ...(input.kind === 'report' ? { b } : {}) };
  return { record, shots, token: input.token };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// One rate-limit bucket per IPv4 address, and per /64 for IPv6 (one home or phone network
// usually owns a whole /64, so single addresses inside it would be free to rotate).
// IPv4-mapped IPv6 (::ffff:1.2.3.4) counts as its IPv4 address.
export function ipBucket(ip) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// The visitor's IP is not sent along (remoteip is optional), so it goes nowhere from here.
async function verifyTurnstile(env, token, action, host, fetchFn) {
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  let out;
  try {
    const res = await fetchFn(SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
    out = await res.json();
  } catch {
    reject(503, 'verify_unavailable');
  }
  if (!out || out.success !== true) reject(403, 'not_verified');
  // Cloudflare's test keys answer hostname "example.com" and no action. Only local development
  // may accept them; in production a test secret is a misconfiguration and must fail.
  const testKey = env.ALLOW_TEST_TURNSTILE === '1' && out.hostname === 'example.com';
  if (!testKey && (out.hostname !== host || out.action !== action)) reject(403, 'not_verified');
}

// KV reads and stored writes that fail (most likely a Free-plan daily quota) answer 503
// "unavailable"; any other unexpected error stays a plain 500.
async function kvCall(fn) {
  try {
    return await fn();
  } catch {
    reject(503, 'unavailable');
  }
}
const count = async (kv, key) => Number((await kvCall(() => kv.get(key))) ?? 0);

// Counters are approximate (KV is eventually consistent and allows one write per second per
// key), so a failed write must not fail an answer that is already stored.
async function setCount(kv, key, value) {
  try {
    await kv.put(key, String(value), { expirationTtl: COUNTER_TTL });
  } catch {
    // Best effort: the next answer writes the counter again.
  }
}

// One log line per refused or failed request: the code only, never the body, IP or headers.
function logOutcome(status, code) {
  console.info(JSON.stringify({ event: 'feedback_rejected', status, code }));
}

export async function handle(request, env, fetchFn = fetch) {
  try {
    if (!env.FEEDBACK || !env.TURNSTILE_SECRET || !env.IP_SALT) reject(503, 'not_configured');
    const url = new URL(request.url);
    if (request.headers.get('origin') !== url.origin) reject(403, 'bad_origin');
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) reject(415, 'bad_type');
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) reject(413, 'too_large');
    // Cloudflare always sets this header; without it every visitor would share one bucket.
    const ip = request.headers.get('cf-connecting-ip') ?? '';
    if (!ip && env.ALLOW_TEST_TURNSTILE !== '1') reject(400, 'no_ip');

    let input;
    try {
      input = JSON.parse(await readCapped(request, MAX_BODY));
    } catch (e) {
      if (e instanceof Rejected) throw e;
      reject(400, 'bad_json');
    }
    const { record, shots: shotText, token } = validate(input);

    // Turnstile before any KV access, so requests without a valid token cost no KV reads.
    await verifyTurnstile(env, token, record.kind, url.hostname, fetchFn);

    // Per-visitor counters: SHA-256 of a secret salt, the UTC day and the IP bucket. The day in
    // the hash rotates it daily, so counters can't be linked across days. The IP is never stored.
    const minute = `${new Date().toISOString().slice(0, 16)}Z`; // stored times are cut to the minute
    const day = minute.slice(0, 10);
    const visitor = await sha256Hex(`${env.IP_SALT}|${day}|${ipBucket(ip)}`);
    const visitorKey = `rl:${day}:${visitor}`;
    const visitorShotKey = `rl:${day}:${visitor}:shots`;
    const kindKey = `rl:${day}:${record.kind}`;
    const shotKey = `rl:${day}:shots`;
    const kv = env.FEEDBACK;

    const visitorCount = await count(kv, visitorKey);
    if (visitorCount >= PER_VISITOR_PER_DAY) reject(429, 'rate_limited');
    const kindCount = await count(kv, kindKey);
    if (kindCount >= PER_KIND_PER_DAY[record.kind]) reject(429, 'daily_limit');

    // Decoded only now: a bad screenshot costs CPU only for a visitor Turnstile let through.
    const shots = shotText.map(decodeShot);

    // The visitor's slot is taken before anything is stored, so a failed write still counts.
    await setCount(kv, visitorKey, visitorCount + 1);

    // Past either screenshot ceiling the text is still kept; the record says how many were dropped.
    let room = 0;
    let shotCount = 0;
    let visitorShots = 0;
    if (shots.length) {
      shotCount = await count(kv, shotKey);
      visitorShots = await count(kv, visitorShotKey);
      room = Math.max(0, Math.min(SHOTS_PER_DAY - shotCount, SHOTS_PER_VISITOR_PER_DAY - visitorShots));
    }
    const kept = shots.slice(0, room);
    const id = `${minute}-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
    for (const [i, bytes] of kept.entries()) {
      await kvCall(() => kv.put(`shot:${id}:${i + 1}`, bytes, { expirationTtl: SHOT_TTL, metadata: { contentType: 'image/jpeg' } }));
    }
    const dropped = shots.length - kept.length;
    await kvCall(() => kv.put(`${record.kind}:${id}`, JSON.stringify({ ...record, at: minute, shots: kept.length, ...(dropped ? { shotsDropped: dropped } : {}) })));

    await setCount(kv, kindKey, kindCount + 1);
    if (kept.length) {
      await setCount(kv, shotKey, shotCount + kept.length);
      await setCount(kv, visitorShotKey, visitorShots + kept.length);
    }
    return reply(200, { ok: true });
  } catch (e) {
    if (e instanceof Rejected) {
      logOutcome(e.status, e.message);
      return reply(e.status, { ok: false, error: e.message });
    }
    // Not a KV failure (those are Rejected 503 above): a bug. Log the error type only.
    logOutcome(500, `error:${e?.name ?? 'Error'}`);
    return reply(500, { ok: false, error: 'error' });
  }
}

export const onRequestPost = ({ request, env }) => handle(request, env);

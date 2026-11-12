// POST /api/send: stores one anonymous answer from the site's /uninstalled or /report form.
//
// Bindings (Cloudflare Pages > Settings > Bindings / Variables and Secrets; see docs/FEEDBACK_SETUP.md):
//   FEEDBACK              Workers KV namespace: answers, screenshots, rate counters
//   TURNSTILE_SECRET      secret: Turnstile widget secret key
//   IP_SALT               secret: random string mixed into the per-visitor counter hash
//   ALLOW_TEST_TURNSTILE  local development only: "1" accepts Cloudflare's Turnstile test keys
//
// Everything is plain data in KV: no SQL, no queries, nothing executed or rendered as HTML here.
// The Free plan cannot bill: past its quotas, requests and writes simply fail.

const MAX_BODY = 1_050_000; // 3 screenshots of 260 KB as base64, plus the text fields
const MAX_SHOT = 260_000; // bytes per decoded JPEG (the page re-encodes to at most 250 KB)
const MAX_SHOTS = 3;
const MAX_TOKEN = 2048;
const PER_VISITOR_PER_DAY = 5;
// Daily ceilings for everyone together. They keep KV inside the Free plan: at most about
// 100 x 3 + 30 x 2 = 360 of the 1,000 daily writes, and 30 x 260 KB x 60 days = 468 MB of 1 GB.
const ALL_PER_DAY = 100;
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
// C0/C1 controls except tab and newline, bidi controls, zero-width characters, line/paragraph
// separators and the byte-order mark: all invisible or able to disguise text.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
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

// True for a structurally plausible JPEG: SOI, marker segments including a start-of-frame
// before the start-of-scan, and EOI at the end.
function isJpeg(b) {
  const n = b.length;
  if (n < 8 || b[0] !== 0xff || b[1] !== 0xd8 || b[n - 2] !== 0xff || b[n - 1] !== 0xd9) return false;
  let sof = false;
  let i = 2;
  while (i + 4 <= n) {
    if (b[i] !== 0xff) return false;
    const marker = b[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xda) return sof; // start of scan: entropy-coded data follows
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return false;
    if (SOF.has(marker)) sof = true;
    i += 2 + ((b[i + 2] << 8) | b[i + 3]);
  }
  return false;
}

function decodeShot(value) {
  // No separate base64 regex: both decoders below throw on anything that is not base64, and a
  // regex pass over ~1 MB costs CPU time the Free plan's 10 ms budget can't spare.
  if (typeof value !== 'string' || !value || value.length > Math.ceil(MAX_SHOT / 3) * 4) reject(400, 'bad_shot');
  let bytes;
  try {
    bytes = base64Bytes(value);
  } catch {
    reject(400, 'bad_shot');
  }
  if (bytes.length > MAX_SHOT || !isJpeg(bytes)) reject(400, 'bad_shot');
  return bytes;
}

// Returns a clean record plus decoded screenshots, or throws Rejected.
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

  const raw = input.shots ?? [];
  if (!Array.isArray(raw) || raw.length > MAX_SHOTS) reject(400, 'bad_shot');
  const shots = raw.map(decodeShot);

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

const count = async (kv, key) => Number((await kv.get(key)) ?? 0);

// Counters are approximate (KV is eventually consistent and allows one write per second per
// key), so a failed write must not fail an answer that is already stored.
async function setCount(kv, key, value) {
  try {
    await kv.put(key, String(value), { expirationTtl: COUNTER_TTL });
  } catch {
    // Best effort: the next answer writes the counter again.
  }
}

export async function handle(request, env, fetchFn = fetch) {
  try {
    if (!env.FEEDBACK || !env.TURNSTILE_SECRET || !env.IP_SALT) reject(503, 'not_configured');
    const url = new URL(request.url);
    if (request.headers.get('origin') !== url.origin) reject(403, 'bad_origin');
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) reject(415, 'bad_type');
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) reject(413, 'too_large');

    let input;
    try {
      input = JSON.parse(await readCapped(request, MAX_BODY));
    } catch (e) {
      if (e instanceof Rejected) throw e;
      reject(400, 'bad_json');
    }
    const { record, shots, token } = validate(input);

    // Per-visitor counter: SHA-256 of a secret salt, the UTC day and the IP bucket. The day in the
    // hash rotates it daily, so counters can't be linked across days. The IP itself is never stored.
    const ip = request.headers.get('cf-connecting-ip') ?? '';
    const minute = `${new Date().toISOString().slice(0, 16)}Z`; // stored times are cut to the minute
    const day = minute.slice(0, 10);
    const visitorKey = `rl:${day}:${await sha256Hex(`${env.IP_SALT}|${day}|${ipBucket(ip)}`)}`;
    const dayKey = `rl:${day}:all`;
    const shotKey = `rl:${day}:shots`;
    const kv = env.FEEDBACK;

    // Turnstile first: requests without a valid token never touch KV, so junk cannot use up
    // the Free plan's daily KV reads.
    await verifyTurnstile(env, token, record.kind, url.hostname, fetchFn);

    const visitorCount = await count(kv, visitorKey);
    if (visitorCount >= PER_VISITOR_PER_DAY) reject(429, 'rate_limited');
    const dayCount = await count(kv, dayKey);
    if (dayCount >= ALL_PER_DAY) reject(429, 'daily_limit');
    // The visitor's slot is taken before anything is stored, so a failed write still counts.
    await setCount(kv, visitorKey, visitorCount + 1);

    // Past the daily screenshot ceiling the text is still kept; the record says how many were dropped.
    const shotCount = shots.length ? await count(kv, shotKey) : 0;
    const kept = shots.slice(0, Math.max(0, SHOTS_PER_DAY - shotCount));
    const id = `${minute}-${crypto.randomUUID().slice(0, 8)}`;
    for (const [i, bytes] of kept.entries()) {
      await kv.put(`shot:${id}:${i + 1}`, bytes, { expirationTtl: SHOT_TTL, metadata: { contentType: 'image/jpeg' } });
    }
    const dropped = shots.length - kept.length;
    await kv.put(`${record.kind}:${id}`, JSON.stringify({ ...record, at: minute, shots: kept.length, ...(dropped ? { shotsDropped: dropped } : {}) }));

    await setCount(kv, dayKey, dayCount + 1);
    if (kept.length) await setCount(kv, shotKey, shotCount + kept.length);
    return reply(200, { ok: true });
  } catch (e) {
    if (e instanceof Rejected) return reply(e.status, { ok: false, error: e.message });
    return reply(500, { ok: false, error: 'error' });
  }
}

export const onRequestPost = ({ request, env }) => handle(request, env);

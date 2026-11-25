// /admin: the feedback dashboard, served by a Cloudflare Pages Function (functions/admin/[[path]].js).
//
// Nothing about the dashboard is public. Without a valid session every path answers a plain 404,
// except GET /admin, which shows only the sign-in form. The dashboard page, its script and every
// answer come from this function, and only after sign-in, so dev tools on the sign-in page show
// nothing of them.
//
// Bindings (Cloudflare Pages > Settings > Variables and Secrets; see docs/FEEDBACK_SETUP.md):
//   ADMIN_PASSWORD_HASH  secret: "pbkdf2-sha256$…" from `node scripts/admin-password.mjs`.
//                        Without it every admin path is 404. Changing it ends every session.
//   FEEDBACK, TURNSTILE_SECRET, TURNSTILE_SITEKEY, IP_SALT: shared with /api/send.
//
// Sign-in: Turnstile first (so bots cost no KV), then a lock check, then PBKDF2. Five wrong
// passwords from one visitor lock that visitor for 15 minutes; thirty from anyone in one UTC day
// lock every sign-in until the day ends. Each failure writes two KV keys, so failures can use at
// most 60 of the Free plan's 1,000 daily writes. The counters are a soft guard: KV is eventually
// consistent, so parallel or far-apart attempts can slip a few extra tries past them; Turnstile and
// a long password are what really stop guessing. The session is a signed cookie (HMAC-SHA256 keyed
// from the password hash), HttpOnly, Secure, SameSite=Strict, for 12 hours.
//
// Answers are untrusted text typed by strangers. They leave here only as JSON or JPEG with
// nosniff, and the page puts them on screen as text, never as HTML.

import {
  PER_KIND_PER_DAY, Rejected, SHOTS_PER_DAY, SHOT_TTL, checkShotShape, decodeShot, ipBucket, readCapped, sha256Hex, verifyTurnstile,
} from '../functions/api/send.js';
import { b64url, isPasswordHash, sameBytes, verifyPassword } from './password.js';
import { MAX_ADMIN_TEXT, MAX_MSGS, STATUSES, markMetadata, markOf, merged, sideFrom, sideValue, threadSummary, withMessage } from '../server/tickets.js';

export const SESSION_COOKIE = '__Host-a4n_admin';
const SESSION_SECONDS = 12 * 60 * 60;
const FAILS_PER_VISITOR = 5;
const LOCK_SECONDS = 15 * 60;
const FAILS_PER_DAY = 30;
const MAX_BODY = 4096;
const MAX_REPLY_BODY = 1_050_000; // a reply with three screenshots, as on /api/reply
const MAX_REPLY_SHOTS = 3;
const MAX_PASSWORD = 256;
const MAX_TOKEN = 2048;
const MAX_ANSWERS = 5000; // per kind; far above the 60-a-day cap for the 180 days the charts show
const MAX_OLD_READS = 300; // answers stored before metadata existed are read one by one
const ANSWER_KEY = /^(report|uninstall):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)-[0-9a-f]{16}$/;
const SHOT_KEY = /^shot:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z-[0-9a-f]{16}:[1-3]$/;
// Screenshots the reporter attached when writing back: message number, then 1-3 (server/tickets.js).
const RSHOT_KEY = /^rshot:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z-[0-9a-f]{16}:\d{1,2}:[1-3]$/;
// Screenshots we attached to our own replies, same shape ("ashot:").
const ASHOT_KEY = /^ashot:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z-[0-9a-f]{16}:\d{1,2}:[1-3]$/;
const TAGS = ['bug', 'idea', 'uninstall'];
const BROWSERS = ['', 'chrome', 'firefox'];
// Admin marks, one KV key per answer: "mark:<answer key>". Status, star, archive and the time the
// status last changed live in the key's metadata, so the list needs no reads; the private note is
// the value, read only when one answer is opened. Older answers may still have a "done:<key>" mark.
// The ticket conversation is "msgu:" (reporter) and "msga:" (us) plus "seen:" (server/tickets.js);
// their metadata feeds the list.
const MAX_MEMO = 2000;
const TURNSTILE = 'https://challenges.cloudflare.com';

const BASE_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
const COMMON_CSP = "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Fonts: the site's own JetBrains Mono from Google Fonts, as on every other page of the site.
const FONTS = 'font-src https://fonts.gstatic.com';
const LOGIN_CSP = (n) => `default-src 'none'; script-src 'nonce-${n}' ${TURNSTILE}; style-src 'nonce-${n}' https://fonts.googleapis.com; ${FONTS}; frame-src ${TURNSTILE}; img-src 'self'; ${COMMON_CSP}`;
// blob: shows thumbnails of screenshots picked for a reply before they are sent.
const APP_CSP = (n) => `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}' https://fonts.googleapis.com; ${FONTS}; img-src 'self' blob:; ${COMMON_CSP}`;

const headers = (extra = {}) => ({ ...BASE_HEADERS, ...extra });
const notFound = () => new Response('Not found', { status: 404, headers: headers({ 'content-type': 'text/plain; charset=utf-8' }) });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: headers({ 'content-type': 'application/json; charset=utf-8' }) });
const done = (extra) => new Response(null, { status: 204, headers: headers(extra) });
const reject = (status, code) => {
  throw new Rejected(status, code);
};

// A fresh nonce per response: the page's one <style> and one <script> carry it, nothing else runs.
function page(html, csp) {
  const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return new Response(html.replaceAll('__NONCE__', nonce), {
    headers: headers({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp(nonce) }),
  });
}

const configured = (env) =>
  !!(env.FEEDBACK && env.ADMIN_PASSWORD_HASH && env.TURNSTILE_SECRET && env.IP_SALT && /^[\w-]{1,100}$/.test(env.TURNSTILE_SITEKEY ?? ''));

// ---------- session ----------

async function sign(env, payload) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`a4n-admin-session|${env.ADMIN_PASSWORD_HASH}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

async function newSession(env) {
  const payload = `${Math.floor(Date.now() / 1000) + SESSION_SECONDS}.${b64url(crypto.getRandomValues(new Uint8Array(12)))}`;
  return `${payload}.${await sign(env, payload)}`;
}

function cookieValue(request, name) {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

async function signedIn(request, env) {
  const value = cookieValue(request, SESSION_COOKIE);
  const m = /^(\d{1,12})\.([\w-]{16})\.([\w-]{43})$/.exec(value);
  if (!m) return false;
  const now = Math.floor(Date.now() / 1000);
  const exp = Number(m[1]);
  if (exp <= now || exp > now + SESSION_SECONDS) return false;
  const want = await sign(env, `${m[1]}.${m[2]}`);
  const enc = new TextEncoder();
  return sameBytes(enc.encode(m[3]), enc.encode(want));
}

const setCookie = (value, maxAge) => ({ 'set-cookie': `${SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Strict` });

// ---------- requests ----------

// POSTs must come from this site's own pages, as JSON.
function checkPost(request, url) {
  if (request.headers.get('origin') !== url.origin) reject(403, 'bad_origin');
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') reject(403, 'bad_origin');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) reject(415, 'bad_type');
}

async function readJson(request, fields, max = MAX_BODY) {
  let input;
  try {
    input = JSON.parse(await readCapped(request, max));
  } catch (e) {
    if (e instanceof Rejected) throw e;
    reject(400, 'bad_json');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject(400, 'bad_body');
  for (const key of Object.keys(input)) if (!fields.includes(key)) reject(400, 'unknown_field');
  return input;
}

async function kvCall(fn) {
  try {
    return await fn();
  } catch {
    reject(503, 'unavailable');
  }
}
const count = async (kv, key) => Number((await kvCall(() => kv.get(key))) ?? 0) || 0;

// ---------- sign-in ----------

async function login(request, env, url, fetchFn) {
  checkPost(request, url);
  const input = await readJson(request, ['password', 'token']);
  const { password, token } = input;
  if (typeof password !== 'string' || !password || password.length > MAX_PASSWORD) reject(400, 'bad_password');
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN) reject(400, 'bad_token');
  const ip = request.headers.get('cf-connecting-ip') ?? '';
  if (!ip && env.ALLOW_TEST_TURNSTILE !== '1') reject(400, 'no_ip');

  await verifyTurnstile(env, token, 'admin-login', url.hostname, fetchFn);

  const kv = env.FEEDBACK;
  const visitorKey = `adm:fail:ip:${await sha256Hex(`${env.IP_SALT}|admin|${ipBucket(ip)}`)}`;
  const dayKey = `adm:fail:day:${new Date().toISOString().slice(0, 10)}`;
  const [mine, everyone] = await Promise.all([count(kv, visitorKey), count(kv, dayKey)]);
  if (mine >= FAILS_PER_VISITOR || everyone >= FAILS_PER_DAY) reject(429, 'locked');

  if (!(await verifyPassword(password, env.ADMIN_PASSWORD_HASH))) {
    await kvCall(() => kv.put(visitorKey, String(mine + 1), { expirationTtl: LOCK_SECONDS }));
    await kvCall(() => kv.put(dayKey, String(everyone + 1), { expirationTtl: 2 * 24 * 60 * 60 }));
    // A malformed secret makes every password wrong: say so in the logs, not to the visitor.
    log(401, isPasswordHash(env.ADMIN_PASSWORD_HASH) ? 'wrong_password' : 'bad_password_hash_secret');
    return json(401, { ok: false, error: 'wrong', left: Math.max(0, FAILS_PER_VISITOR - mine - 1) });
  }
  if (mine) await kvCall(() => kv.delete(visitorKey));
  log(204, 'signed_in');
  return done(setCookie(await newSession(env), SESSION_SECONDS));
}

// ---------- data ----------

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v, max) => (Number.isInteger(v) && v >= 0 ? Math.min(v, max) : 0);
const reasons = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 10).map((x) => x.slice(0, 20)) : []);

// One list row, from key metadata or (answers stored before metadata existed) from the value.
function row(key, at, meta, mark, thread) {
  return {
    key,
    at,
    t: TAGS.includes(meta.t) ? meta.t : 'bug',
    r: reasons(meta.r),
    v: str(meta.v, 20),
    b: BROWSERS.includes(meta.b) ? meta.b : '',
    s: int(meta.s, 3),
    d: int(meta.d, 3),
    p: str(meta.p, 400),
    ...(meta.j ? { j: str(meta.j, 80) } : {}),
    ...mark,
    // Whether the answer has a ticket the reporter can read, and its conversation so far.
    ticket: meta.k === 1,
    thread,
  };
}

function metaFromValue(raw) {
  let a;
  try {
    a = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!a || typeof a !== 'object') return null;
  return {
    t: a.kind === 'uninstall' ? 'uninstall' : a.type === 'idea' ? 'idea' : 'bug',
    r: a.reasons, v: a.v, b: a.b ?? '', s: a.shots, d: a.shotsDropped ?? 0,
    p: typeof a.note === 'string' ? [...a.note].slice(0, 100).join('') : '',
  };
}

async function listKeys(kv, prefix, max) {
  const out = [];
  let cursor;
  do {
    const page = await kvCall(() => kv.list({ prefix, cursor }));
    out.push(...page.keys);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && out.length < max);
  return out;
}

async function answers(env) {
  const kv = env.FEEDBACK;
  const [reports, uninstalls, doneKeys, markKeys, uKeys, aKeys, seenKeys] = await Promise.all([
    listKeys(kv, 'report:', MAX_ANSWERS), listKeys(kv, 'uninstall:', MAX_ANSWERS),
    listKeys(kv, 'done:', 2 * MAX_ANSWERS), listKeys(kv, 'mark:', 2 * MAX_ANSWERS),
    listKeys(kv, 'msgu:', 2 * MAX_ANSWERS), listKeys(kv, 'msga:', 2 * MAX_ANSWERS), listKeys(kv, 'seen:', 2 * MAX_ANSWERS),
  ]);
  const byKey = (keys, prefix) => new Map(keys.map((k) => [k.name.slice(prefix.length), k.metadata]));
  const [uMeta, aMeta, seenMeta] = [byKey(uKeys, 'msgu:'), byKey(aKeys, 'msga:'), byKey(seenKeys, 'seen:')];
  const doneSet = new Set(doneKeys.map((k) => k.name.slice('done:'.length)));
  const marks = new Map(markKeys.map((k) => [k.name.slice('mark:'.length), k.metadata]));
  const valid = [...reports, ...uninstalls].filter((k) => ANSWER_KEY.test(k.name));
  const old = valid.filter((k) => typeof k.metadata?.t !== 'string').slice(0, MAX_OLD_READS);
  const oldMeta = new Map(await Promise.all(old.map(async (k) => [k.name, metaFromValue(await kvCall(() => kv.get(k.name)))])));
  const rows = [];
  for (const k of valid) {
    const meta = typeof k.metadata?.t === 'string' ? k.metadata : oldMeta.get(k.name);
    if (meta) rows.push(row(k.name, ANSWER_KEY.exec(k.name)[2], meta, markOf(marks.get(k.name), doneSet.has(k.name)), threadSummary(uMeta.get(k.name), aMeta.get(k.name), seenMeta.get(k.name))));
  }
  rows.sort((a, b) => b.at.localeCompare(a.at) || b.key.localeCompare(a.key));
  const day = new Date().toISOString().slice(0, 10);
  const [report, uninstall, shots] = await Promise.all(['report', 'uninstall', 'shots'].map((k) => count(kv, `rl:${day}:${k}`)));
  return json(200, {
    answers: rows,
    today: { report, uninstall, shots },
    caps: { report: PER_KIND_PER_DAY.report, uninstall: PER_KIND_PER_DAY.uninstall, shots: SHOTS_PER_DAY },
  });
}

function answerKey(value) {
  if (typeof value !== 'string' || !ANSWER_KEY.test(value)) reject(400, 'bad_key');
  return value;
}

async function answer(env, url) {
  const key = answerKey(url.searchParams.get('key'));
  const [raw, memo, mine, ours] = await Promise.all([
    kvCall(() => env.FEEDBACK.get(key)), kvCall(() => env.FEEDBACK.get(`mark:${key}`)),
    kvCall(() => env.FEEDBACK.get(`msgu:${key}`)), kvCall(() => env.FEEDBACK.get(`msga:${key}`)),
  ]);
  if (raw === null) reject(404, 'not_found');
  let a;
  try {
    a = JSON.parse(raw);
  } catch {
    reject(500, 'unreadable');
  }
  return json(200, {
    note: str(a.note, 2000), reasons: reasons(a.reasons), v: str(a.v, 20), b: BROWSERS.includes(a.b) ? a.b : '',
    shots: int(a.shots, 3), shotsDropped: int(a.shotsDropped, 3), memo: str(memo, MAX_MEMO),
    // k: the message's number on its side, which names its screenshots (rshot:/ashot:<id>:<k>:<i>)
    // and, for ours, which one to edit or unsend. e: when we last edited it (ms).
    msgs: merged(sideFrom(mine, 'u'), sideFrom(ours, 'a')).map(({ f, t, at, s, k, e }) => ({ f, t, at, ...(s || f === 'a' ? { k } : {}), ...(s ? { s } : {}), ...(e ? { e } : {}) })),
  });
}

// Screenshots are JPEG bytes the form checked (canvas headers only). Served as image/jpeg with
// nosniff and a sandbox policy, so even opened directly in a tab nothing in them can run.
async function shot(env, url) {
  const key = url.searchParams.get('key') ?? '';
  if (!SHOT_KEY.test(key) && !RSHOT_KEY.test(key) && !ASHOT_KEY.test(key)) reject(400, 'bad_key');
  const bytes = await kvCall(() => env.FEEDBACK.get(key, 'arrayBuffer'));
  if (bytes === null) reject(404, 'not_found');
  return new Response(bytes, {
    headers: headers({ 'content-type': 'image/jpeg', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline' }),
  });
}

// Changes any of status, star, archived and the private note; fields left out keep their value.
async function mark(request, env, url) {
  checkPost(request, url);
  const input = await readJson(request, ['key', 'status', 'star', 'archived', 'memo']);
  const key = answerKey(input.key);
  if (Object.keys(input).length < 2) reject(400, 'nothing_to_change');
  if ('status' in input && !STATUSES.includes(input.status)) reject(400, 'bad_status');
  if ('star' in input && typeof input.star !== 'boolean') reject(400, 'bad_star');
  if ('archived' in input && typeof input.archived !== 'boolean') reject(400, 'bad_archived');
  if ('memo' in input && (typeof input.memo !== 'string' || input.memo.length > MAX_MEMO)) reject(400, 'bad_memo');

  const kv = env.FEEDBACK;
  const [current, wasDone] = await Promise.all([kvCall(() => kv.getWithMetadata(`mark:${key}`)), kvCall(() => kv.get(`done:${key}`))]);
  const before = markOf(current.metadata, wasDone !== null);
  const status = input.status ?? before.status;
  const star = input.star ?? before.star;
  const archived = input.archived ?? before.archived;
  const memo = input.memo ?? str(current.value, MAX_MEMO);
  const since = status === before.status ? before.since : new Date().toISOString().slice(0, 16) + 'Z';

  const metadata = markMetadata({ status, star, archived, since }, memo);
  if (!metadata) await kvCall(() => kv.delete(`mark:${key}`));
  else await kvCall(() => kv.put(`mark:${key}`, memo, { metadata }));
  if (wasDone !== null) await kvCall(() => kv.delete(`done:${key}`));
  return done();
}

// Adds our message, with up to 3 JPEG screenshots, to the ticket's conversation; the reporter sees
// it on their ticket page.
async function replyTo(request, env, url) {
  checkPost(request, url);
  const input = await readJson(request, ['key', 'text', 'shots'], MAX_REPLY_BODY);
  const key = answerKey(input.key);
  const text = typeof input.text === 'string' ? input.text.replace(/\r\n?/g, '\n').trim() : '';
  if (text.length > MAX_ADMIN_TEXT) reject(400, 'bad_text');
  const shotText = input.shots ?? [];
  if (!Array.isArray(shotText) || shotText.length > MAX_REPLY_SHOTS) reject(400, 'bad_shot');
  shotText.forEach(checkShotShape);
  if (!text && !shotText.length) reject(400, 'bad_text');
  const shots = shotText.map(decodeShot);
  const kv = env.FEEDBACK;
  const [answer, mine, ours] = await Promise.all([
    kvCall(() => kv.getWithMetadata(key)), kvCall(() => kv.getWithMetadata(`msgu:${key}`)), kvCall(() => kv.get(`msga:${key}`)),
  ]);
  if (answer.value === null) reject(404, 'not_found');
  if (answer.metadata?.k !== 1) reject(400, 'no_ticket');
  const ourMsgs = sideFrom(ours, 'a');
  if (ourMsgs.length + (Number.isInteger(mine.metadata?.n) ? mine.metadata.n : 0) >= MAX_MSGS) reject(409, 'thread_full');
  // Screenshots first, named by the number this message will get, so a message never points at
  // pictures that were not stored.
  const id = key.slice(key.indexOf(':') + 1);
  for (const [i, bytes] of shots.entries()) {
    await kvCall(() => kv.put(`ashot:${id}:${ourMsgs.length + 1}:${i + 1}`, bytes, { expirationTtl: SHOT_TTL, metadata: { contentType: 'image/jpeg' } }));
  }
  // Only our own key is written: the reporter's messages live in msgu: and can't be overwritten.
  const next = withMessage(ourMsgs, { t: text, at: `${new Date().toISOString().slice(0, 16)}Z`, ts: Date.now(), ...(shots.length ? { s: shots.length } : {}) });
  await kvCall(() => kv.put(`msga:${key}`, next.value, { metadata: next.metadata }));
  return done();
}

// Our k-th message, still shown, from the ticket's stored conversation.
async function ourMessage(kv, key, k) {
  if (!Number.isInteger(k) || k < 1 || k > MAX_MSGS) reject(400, 'bad_message');
  const [answer, ours] = await Promise.all([kvCall(() => kv.get(key)), kvCall(() => kv.get(`msga:${key}`))]);
  if (answer === null) reject(404, 'not_found');
  const side = sideFrom(ours, 'a');
  const msg = side.find((m) => m.k === k);
  if (!msg || msg.gone) reject(404, 'no_message');
  return { side, msg, id: key.slice(key.indexOf(':') + 1) };
}

// Replaces the text and screenshots of one of our messages. keep lists the screenshots to keep
// (1-3, in the order they should show); shots adds new ones after them. The reporter sees "edited".
async function edit(request, env, url) {
  checkPost(request, url);
  const input = await readJson(request, ['key', 'k', 'text', 'keep', 'shots'], MAX_REPLY_BODY);
  const key = answerKey(input.key);
  const text = typeof input.text === 'string' ? input.text.replace(/\r\n?/g, '\n').trim() : '';
  if (text.length > MAX_ADMIN_TEXT) reject(400, 'bad_text');
  const keep = input.keep ?? [];
  const shotText = input.shots ?? [];
  if (!Array.isArray(keep) || !Array.isArray(shotText) || keep.length + shotText.length > MAX_REPLY_SHOTS) reject(400, 'bad_shot');
  shotText.forEach(checkShotShape);
  if (!text && !keep.length && !shotText.length) reject(400, 'bad_text');
  const kv = env.FEEDBACK;
  const { side, msg, id } = await ourMessage(kv, key, input.k);
  if (!keep.every((i) => Number.isInteger(i) && i >= 1 && i <= (msg.s ?? 0)) || new Set(keep).size !== keep.length) reject(400, 'bad_keep');
  // Every kept picture is read before any is written: keeping 2 alone moves it to slot 1.
  const kept = await Promise.all(keep.map((i) => kvCall(() => kv.get(`ashot:${id}:${msg.k}:${i}`, 'arrayBuffer'))));
  if (kept.some((b) => b === null)) reject(410, 'shot_expired');
  const shots = [...kept, ...shotText.map(decodeShot)];
  const moved = (i) => keep[i] !== i + 1;
  for (const [i, bytes] of shots.entries()) {
    if (i >= keep.length || moved(i)) {
      await kvCall(() => kv.put(`ashot:${id}:${msg.k}:${i + 1}`, bytes, { expirationTtl: SHOT_TTL, metadata: { contentType: 'image/jpeg' } }));
    }
  }
  for (let i = shots.length + 1; i <= (msg.s ?? 0); i++) await kvCall(() => kv.delete(`ashot:${id}:${msg.k}:${i}`));
  const { s: _s, ...rest } = msg;
  const next = sideValue(side.map((m) => (m === msg ? { ...rest, t: text, e: Date.now(), ...(shots.length ? { s: shots.length } : {}) } : m)));
  await kvCall(() => kv.put(`msga:${key}`, next.value, { metadata: next.metadata }));
  return done();
}

// Takes back one of our messages: its text and screenshots are deleted, and the reporter no
// longer sees it. Its slot stays (as {x:1}) so the numbers of later messages, which name their
// screenshots, don't shift.
async function unsend(request, env, url) {
  checkPost(request, url);
  const input = await readJson(request, ['key', 'k']);
  const key = answerKey(input.key);
  const kv = env.FEEDBACK;
  const { side, msg, id } = await ourMessage(kv, key, input.k);
  const next = sideValue(side.map((m) => (m === msg ? { ...m, gone: true } : m)));
  await kvCall(() => kv.put(`msga:${key}`, next.value, { metadata: next.metadata }));
  for (let i = 1; i <= (msg.s ?? 0); i++) await kvCall(() => kv.delete(`ashot:${id}:${msg.k}:${i}`));
  return done();
}

async function remove(request, env, url) {
  checkPost(request, url);
  const key = answerKey((await readJson(request, ['key'])).key);
  const id = key.slice(key.indexOf(':') + 1);
  const kv = env.FEEDBACK;
  // The ticket index ("tk:…") stays: the reporter's link then says the report was removed.
  const replyShots = [...await listKeys(kv, `rshot:${id}:`, 200), ...await listKeys(kv, `ashot:${id}:`, 200)].map((k) => k.name);
  for (const k of [key, `done:${key}`, `mark:${key}`, `msgu:${key}`, `msga:${key}`, `seen:${key}`, `shot:${id}:1`, `shot:${id}:2`, `shot:${id}:3`, ...replyShots]) await kvCall(() => kv.delete(k));
  log(204, 'deleted');
  return done();
}

// One log line per refusal or sign-in event: the code only, never a body, IP, cookie or header.
function log(status, code) {
  console.info(JSON.stringify({ event: 'admin', status, code }));
}

export async function handleAdmin(request, env, ui, fetchFn = fetch) {
  try {
    if (!configured(env)) return notFound();
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    if (path === '/admin' && method === 'GET') {
      if (await signedIn(request, env)) return page(ui.app, APP_CSP);
      return page(ui.login.replaceAll('__SITEKEY__', env.TURNSTILE_SITEKEY), LOGIN_CSP);
    }
    if (path === '/admin/login' && method === 'POST') return await login(request, env, url, fetchFn);

    if (!(await signedIn(request, env))) return notFound();
    if (path === '/admin/logout' && method === 'POST') {
      checkPost(request, url);
      return done(setCookie('', 0));
    }
    if (method === 'GET' && path === '/admin/api/answers') return await answers(env);
    if (method === 'GET' && path === '/admin/api/answer') return await answer(env, url);
    if (method === 'GET' && path === '/admin/api/shot') return await shot(env, url);
    if (method === 'POST' && path === '/admin/api/mark') return await mark(request, env, url);
    if (method === 'POST' && path === '/admin/api/reply') return await replyTo(request, env, url);
    if (method === 'POST' && path === '/admin/api/edit') return await edit(request, env, url);
    if (method === 'POST' && path === '/admin/api/unsend') return await unsend(request, env, url);
    if (method === 'POST' && path === '/admin/api/delete') return await remove(request, env, url);
    return notFound();
  } catch (e) {
    if (e instanceof Rejected) {
      log(e.status, e.message);
      return json(e.status, { ok: false, error: e.message });
    }
    log(500, `error:${e?.name ?? 'Error'}`);
    return json(500, { ok: false, error: 'error' });
  }
}

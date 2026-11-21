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

import { PER_KIND_PER_DAY, Rejected, SHOTS_PER_DAY, ipBucket, readCapped, sha256Hex, verifyTurnstile } from '../functions/api/send.js';
import { b64url, isPasswordHash, sameBytes, verifyPassword } from './password.js';

export const SESSION_COOKIE = '__Host-a4n_admin';
const SESSION_SECONDS = 12 * 60 * 60;
const FAILS_PER_VISITOR = 5;
const LOCK_SECONDS = 15 * 60;
const FAILS_PER_DAY = 30;
const MAX_BODY = 4096;
const MAX_PASSWORD = 256;
const MAX_TOKEN = 2048;
const MAX_ANSWERS = 5000; // per kind; far above the 60-a-day cap for the 180 days the charts show
const MAX_OLD_READS = 300; // answers stored before metadata existed are read one by one
const ANSWER_KEY = /^(report|uninstall):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)-[0-9a-f]{16}$/;
const SHOT_KEY = /^shot:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z-[0-9a-f]{16}:[1-3]$/;
const TAGS = ['bug', 'idea', 'uninstall'];
const BROWSERS = ['', 'chrome', 'firefox'];
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
const COMMON_CSP = "img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const LOGIN_CSP = (n) => `default-src 'none'; script-src 'nonce-${n}' ${TURNSTILE}; style-src 'nonce-${n}'; frame-src ${TURNSTILE}; ${COMMON_CSP}`;
const APP_CSP = (n) => `default-src 'none'; script-src 'nonce-${n}'; style-src 'nonce-${n}'; ${COMMON_CSP}`;

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

async function readJson(request, fields) {
  let input;
  try {
    input = JSON.parse(await readCapped(request, MAX_BODY));
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
function row(key, at, meta, isDone) {
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
    done: isDone,
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
  const [reports, uninstalls, doneKeys] = await Promise.all([
    listKeys(kv, 'report:', MAX_ANSWERS), listKeys(kv, 'uninstall:', MAX_ANSWERS), listKeys(kv, 'done:', 2 * MAX_ANSWERS),
  ]);
  const doneSet = new Set(doneKeys.map((k) => k.name.slice('done:'.length)));
  const valid = [...reports, ...uninstalls].filter((k) => ANSWER_KEY.test(k.name));
  const old = valid.filter((k) => typeof k.metadata?.t !== 'string').slice(0, MAX_OLD_READS);
  const oldMeta = new Map(await Promise.all(old.map(async (k) => [k.name, metaFromValue(await kvCall(() => kv.get(k.name)))])));
  const rows = [];
  for (const k of valid) {
    const meta = typeof k.metadata?.t === 'string' ? k.metadata : oldMeta.get(k.name);
    if (meta) rows.push(row(k.name, ANSWER_KEY.exec(k.name)[2], meta, doneSet.has(k.name)));
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
  const raw = await kvCall(() => env.FEEDBACK.get(key));
  if (raw === null) reject(404, 'not_found');
  let a;
  try {
    a = JSON.parse(raw);
  } catch {
    reject(500, 'unreadable');
  }
  return json(200, {
    note: str(a.note, 2000), reasons: reasons(a.reasons), v: str(a.v, 20), b: BROWSERS.includes(a.b) ? a.b : '',
    shots: int(a.shots, 3), shotsDropped: int(a.shotsDropped, 3),
  });
}

// Screenshots are JPEG bytes the form checked (canvas headers only). Served as image/jpeg with
// nosniff and a sandbox policy, so even opened directly in a tab nothing in them can run.
async function shot(env, url) {
  const key = url.searchParams.get('key') ?? '';
  if (!SHOT_KEY.test(key)) reject(400, 'bad_key');
  const bytes = await kvCall(() => env.FEEDBACK.get(key, 'arrayBuffer'));
  if (bytes === null) reject(404, 'not_found');
  return new Response(bytes, {
    headers: headers({ 'content-type': 'image/jpeg', 'content-security-policy': "default-src 'none'; sandbox", 'content-disposition': 'inline' }),
  });
}

async function markDone(request, env, url) {
  checkPost(request, url);
  const input = await readJson(request, ['key', 'done']);
  const key = answerKey(input.key);
  if (typeof input.done !== 'boolean') reject(400, 'bad_done');
  const kv = env.FEEDBACK;
  await kvCall(() => (input.done ? kv.put(`done:${key}`, '1') : kv.delete(`done:${key}`)));
  return done();
}

async function remove(request, env, url) {
  checkPost(request, url);
  const key = answerKey((await readJson(request, ['key'])).key);
  const id = key.slice(key.indexOf(':') + 1);
  const kv = env.FEEDBACK;
  for (const k of [key, `done:${key}`, `shot:${id}:1`, `shot:${id}:2`, `shot:${id}:3`]) await kvCall(() => kv.delete(k));
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
    if (method === 'POST' && path === '/admin/api/done') return await markDone(request, env, url);
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

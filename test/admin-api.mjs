// Unit tests for the /admin dashboard function (admin/server.js). Run: node --test test/admin-api.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAdmin, SESSION_COOKIE } from '../admin/server.js';
import { hashPassword, verifyPassword } from '../admin/password.js';

const ORIGIN = 'https://anime4nerd.pages.dev';
const PASSWORD = 'correct horse battery staple';
const UI = { app: '<html><script nonce="__NONCE__">app()</script></html>', login: '<html data-key="__SITEKEY__"><script nonce="__NONCE__">login()</script></html>' };
const logged = [];
console.info = (line) => logged.push(line);

// Workers KV in memory, with list() and metadata like the real binding.
function memoryKV() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const { value } = store.get(key);
      return type === 'arrayBuffer' ? value.buffer ?? value : value;
    },
    async getWithMetadata(key) {
      if (!store.has(key)) return { value: null, metadata: null };
      const { value, opts } = store.get(key);
      return { value, metadata: opts.metadata ?? null };
    },
    async put(key, value, opts = {}) { store.set(key, { value, opts }); },
    async delete(key) { store.delete(key); },
    async list({ prefix = '', cursor, limit = 1000 } = {}) {
      const names = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + limit);
      const done = start + limit >= names.length;
      return {
        keys: page.map((name) => ({ name, ...(store.get(name).opts.metadata ? { metadata: store.get(name).opts.metadata } : {}) })),
        list_complete: done,
        ...(done ? {} : { cursor: String(start + limit) }),
      };
    },
  };
}

const passTurnstile = async () => Response.json({ success: true, hostname: 'anime4nerd.pages.dev', action: 'admin-login' });
const failTurnstile = async () => Response.json({ success: false });

let hashed;
async function env(kv = memoryKV()) {
  hashed ??= await hashPassword(PASSWORD, { iterations: 1000 });
  return { FEEDBACK: kv, ADMIN_PASSWORD_HASH: hashed, TURNSTILE_SECRET: 's', TURNSTILE_SITEKEY: '0x4AAAAAAAtest', IP_SALT: 'salt' };
}

function req(path, { method = 'GET', body, cookie, origin = ORIGIN, ip = '203.0.113.7', type = 'application/json' } = {}) {
  const headers = { 'cf-connecting-ip': ip };
  if (cookie) headers.cookie = cookie;
  if (method !== 'GET') {
    headers.origin = origin;
    headers['content-type'] = type;
  }
  return new Request(`${ORIGIN}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const login = (e, password = PASSWORD, opts = {}) =>
  handleAdmin(req('/admin/login', { method: 'POST', body: { password, token: 'tok' }, ...opts }), e, UI, opts.turnstile ?? passTurnstile);

async function signedIn(e) {
  const res = await login(e);
  assert.equal(res.status, 204);
  return res.headers.get('set-cookie').split(';')[0];
}

const go = (path, e, opts = {}) => handleAdmin(req(path, opts), e, UI, passTurnstile);

// ---------- password hashing ----------

test('password hash verifies the right password only', async () => {
  const stored = await hashPassword(PASSWORD, { iterations: 1000 });
  assert.match(stored, /^pbkdf2-sha256\$1000\$[\w-]+\$[\w-]+$/);
  assert.equal(await verifyPassword(PASSWORD, stored), true);
  assert.equal(await verifyPassword('wrong', stored), false);
  assert.equal(await verifyPassword(PASSWORD, 'garbage'), false);
});

test('a stored hash with stray spaces or a line break still works', async () => {
  const stored = await hashPassword(PASSWORD, { iterations: 1000 });
  assert.equal(await verifyPassword(PASSWORD, ` ${stored}
`), true);
  const e = { ...(await env()), ADMIN_PASSWORD_HASH: `${stored}
` };
  assert.equal((await login(e)).status, 204);
});

test('a malformed hash secret is logged as such', async () => {
  const e = { ...(await env()), ADMIN_PASSWORD_HASH: 'pbkdf2-sha256$oops' };
  logged.length = 0;
  assert.equal((await login(e)).status, 401);
  assert.ok(logged.some((l) => l.includes('bad_password_hash_secret')));
});

test('two hashes of one password differ (random salt)', async () => {
  assert.notEqual(await hashPassword(PASSWORD, { iterations: 1000 }), await hashPassword(PASSWORD, { iterations: 1000 }));
});

// ---------- before sign-in ----------

test('GET /admin without a session shows the login page with strict headers', async () => {
  const e = await env();
  const res = await go('/admin', e);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /login\(\)/);
  assert.doesNotMatch(html, /app\(\)/);
  assert.doesNotMatch(html, /__NONCE__|__SITEKEY__/);
  assert.match(html, /data-key="0x4AAAAAAAtest"/);
  const nonce = /nonce="([^"]+)"/.exec(html)[1];
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp.includes(`script-src 'nonce-${nonce}' https://challenges.cloudflare.com`), csp);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
});

test('each page load gets a fresh nonce', async () => {
  const e = await env();
  const a = /nonce="([^"]+)"/.exec(await (await go('/admin', e)).text())[1];
  const b = /nonce="([^"]+)"/.exec(await (await go('/admin', e)).text())[1];
  assert.notEqual(a, b);
});

test('every other admin path is a plain 404 without a session', async () => {
  const e = await env();
  for (const path of ['/admin/api/answers', '/admin/api/answer?key=report:x', '/admin/api/shot?key=shot:x:1', '/admin/anything', '/admin/app.js']) {
    const res = await go(path, e);
    assert.equal(res.status, 404, path);
    assert.equal(await res.text(), 'Not found');
  }
  for (const path of ['/admin/api/mark', '/admin/api/delete']) {
    const res = await handleAdmin(req(path, { method: 'POST', body: { key: 'report:x' } }), e, UI, passTurnstile);
    assert.equal(res.status, 404, path);
  }
});

test('without ADMIN_PASSWORD_HASH every admin path is 404 (fails closed)', async () => {
  const e = { ...(await env()), ADMIN_PASSWORD_HASH: '' };
  assert.equal((await go('/admin', e)).status, 404);
  assert.equal((await login(e)).status, 404);
});

// ---------- signing in ----------

test('the right password sets a strict session cookie and opens the dashboard', async () => {
  const e = await env();
  const res = await login(e);
  assert.equal(res.status, 204);
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=43200/);
  const page = await go('/admin', e, { cookie: cookie.split(';')[0] });
  assert.match(await page.text(), /app\(\)/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-[^']+';/);
});

test('a wrong password says how many tries are left, then locks for 15 minutes', async () => {
  const e = await env();
  for (let left = 4; left >= 0; left--) {
    const res = await login(e, 'nope');
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: 'wrong', left });
  }
  const locked = await login(e);
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).error, 'locked');
  const entry = [...e.FEEDBACK.store].find(([k]) => k.startsWith('adm:fail:ip:'));
  assert.ok(entry);
  assert.equal(entry[1].opts.expirationTtl, 900);
});

test('the lock is per visitor; another address can still sign in', async () => {
  const e = await env();
  for (let i = 0; i < 5; i++) await login(e, 'nope');
  assert.equal((await login(e, PASSWORD, { ip: '198.51.100.9' })).status, 204);
});

test('many failures from many addresses lock every login for the day', async () => {
  const e = await env();
  for (let i = 0; i < 30; i++) await login(e, 'nope', { ip: `198.51.100.${i}` });
  const res = await login(e, PASSWORD, { ip: '192.0.2.1' });
  assert.equal(res.status, 429);
});

test('a successful sign-in clears the visitor counter', async () => {
  const e = await env();
  await login(e, 'nope');
  await login(e);
  assert.equal([...e.FEEDBACK.store.keys()].some((k) => k.startsWith('adm:fail:ip:')), false);
});

test('a failed Turnstile check refuses before the password is checked', async () => {
  const e = await env();
  const res = await login(e, PASSWORD, { turnstile: failTurnstile });
  assert.equal(res.status, 403);
  assert.equal([...e.FEEDBACK.store.keys()].length, 0);
});

test('Turnstile for another action or host is refused', async () => {
  const e = await env();
  const other = async () => Response.json({ success: true, hostname: 'anime4nerd.pages.dev', action: 'report' });
  assert.equal((await login(e, PASSWORD, { turnstile: other })).status, 403);
  const host = async () => Response.json({ success: true, hostname: 'evil.example', action: 'admin-login' });
  assert.equal((await login(e, PASSWORD, { turnstile: host })).status, 403);
});

test('login from another origin or without JSON is refused', async () => {
  const e = await env();
  assert.equal((await login(e, PASSWORD, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await login(e, PASSWORD, { type: 'text/plain' })).status, 415);
});

test('login rejects odd bodies', async () => {
  const e = await env();
  for (const body of [{}, { password: 1, token: 't' }, { password: 'x'.repeat(300), token: 't' }, { password: PASSWORD }, { password: PASSWORD, token: 't', extra: 1 }]) {
    const res = await handleAdmin(req('/admin/login', { method: 'POST', body }), e, UI, passTurnstile);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
  }
});

// ---------- sessions ----------

test('a tampered, foreign or expired session cookie is ignored', async () => {
  const e = await env();
  const cookie = await signedIn(e);
  const [name, value] = cookie.split('=');
  const [exp, nonce, sig] = value.split('.');
  const bad = [
    `${name}=${exp}.${nonce}.${sig.slice(0, -2)}AA`,
    `${name}=${Number(exp) + 1000}.${nonce}.${sig}`,
    `${name}=garbage`,
    `${name}=${Math.floor(Date.now() / 1000) - 10}.${nonce}.${sig}`,
  ];
  for (const c of bad) {
    assert.match(await (await go('/admin', e, { cookie: c })).text(), /login\(\)/, c);
    assert.equal((await go('/admin/api/answers', e, { cookie: c })).status, 404, c);
  }
});

test('changing the password ends every session', async () => {
  const e = await env();
  const cookie = await signedIn(e);
  const e2 = { ...e, ADMIN_PASSWORD_HASH: await hashPassword('another long password', { iterations: 1000 }) };
  assert.equal((await go('/admin/api/answers', e2, { cookie })).status, 404);
});

test('sign out clears the cookie', async () => {
  const e = await env();
  const cookie = await signedIn(e);
  const res = await handleAdmin(req('/admin/logout', { method: 'POST', cookie }), e, UI, passTurnstile);
  assert.equal(res.status, 204);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
});

// ---------- data ----------

const ID = '2026-11-20T18:42Z-0123456789abcdef';
const OLD = '2026-11-01T08:00Z-fedcba9876543210';

async function seeded() {
  const kv = memoryKV();
  await kv.put(`report:${ID}`, JSON.stringify({ kind: 'report', type: 'bug', reasons: ['slow'], note: 'Full note <b>here</b>', v: '1.2.4', b: 'chrome', at: '2026-11-20T18:42Z', shots: 1 }),
    { metadata: { t: 'bug', r: ['slow'], v: '1.2.4', b: 'chrome', s: 1, p: 'Full note <b>here</b>' } });
  // An answer stored before metadata existed: read from its value.
  await kv.put(`uninstall:${OLD}`, JSON.stringify({ kind: 'uninstall', reasons: ['trying'], note: '', v: '1.2.3', at: '2026-11-01T08:00Z', shots: 0 }));
  await kv.put(`shot:${ID}:1`, new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { metadata: { contentType: 'image/jpeg' } });
  await kv.put('report:not-a-real-key', '{}');
  await kv.put('rl:2026-11-20:report', '12');
  const e = await env(kv);
  return { e, kv, cookie: await signedIn(e) };
}

test('answers list comes from key metadata, with old answers read from their value', async () => {
  const { e, cookie } = await seeded();
  const res = await go('/admin/api/answers', e, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(body.answers.map((a) => a.key), [`report:${ID}`, `uninstall:${OLD}`]);
  assert.deepEqual(body.answers[0], { key: `report:${ID}`, at: '2026-11-20T18:42Z', t: 'bug', r: ['slow'], v: '1.2.4', b: 'chrome', s: 1, d: 0, p: 'Full note <b>here</b>', status: 'open', star: false, archived: false, since: '' });
  assert.deepEqual(body.answers[1], { key: `uninstall:${OLD}`, at: '2026-11-01T08:00Z', t: 'uninstall', r: ['trying'], v: '1.2.3', b: '', s: 0, d: 0, p: '', status: 'open', star: false, archived: false, since: '' });
  assert.deepEqual(Object.keys(body.caps).sort(), ['report', 'shots', 'uninstall']);
});

test('one answer returns its full note as data', async () => {
  const { e, cookie } = await seeded();
  const res = await go(`/admin/api/answer?key=report:${ID}`, e, { cookie });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).note, 'Full note <b>here</b>');
  assert.equal((await go('/admin/api/answer?key=rl:2026-11-20:report', e, { cookie })).status, 400);
  assert.equal((await go('/admin/api/answer?key=report:2026-11-20T18:42Z-0000000000000000', e, { cookie })).status, 404);
});

test('screenshots are served as sandboxed JPEG, only for shot keys', async () => {
  const { e, cookie } = await seeded();
  const res = await go(`/admin/api/shot?key=shot:${ID}:1`, e, { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('content-security-policy'), /sandbox/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  for (const key of [`report:${ID}`, `shot:${ID}:4`, 'shot:../x:1', 'IP_SALT']) {
    assert.equal((await go(`/admin/api/shot?key=${encodeURIComponent(key)}`, e, { cookie })).status, 400, key);
  }
});

const postAs = (e, cookie) => (path, body, opts = {}) => handleAdmin(req(path, { method: 'POST', body, cookie, ...opts }), e, UI, passTurnstile);
const listed = async (e, cookie) => (await (await go('/admin/api/answers', e, { cookie })).json()).answers[0];

test('mark sets status, star and archive; the list shows them without reading values', async () => {
  const { e, kv, cookie } = await seeded();
  const post = postAs(e, cookie);
  assert.equal((await post('/admin/api/mark', { key: `report:${ID}`, status: 'progress' })).status, 204);
  let a = await listed(e, cookie);
  assert.equal(a.status, 'progress');
  assert.match(a.since, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
  assert.equal((await post('/admin/api/mark', { key: `report:${ID}`, star: true, archived: true })).status, 204);
  a = await listed(e, cookie);
  assert.deepEqual([a.status, a.star, a.archived], ['progress', true, true]);
  assert.deepEqual(kv.store.get(`mark:report:${ID}`).opts.metadata, { s: 'progress', st: 1, a: 1, at: a.since });
});

test('the private note is stored as the mark value and comes back with the answer', async () => {
  const { e, kv, cookie } = await seeded();
  const post = postAs(e, cookie);
  assert.equal((await post('/admin/api/mark', { key: `report:${ID}`, memo: 'Fix in 1.2.6' })).status, 204);
  assert.equal(kv.store.get(`mark:report:${ID}`).value, 'Fix in 1.2.6');
  assert.equal((await (await go(`/admin/api/answer?key=report:${ID}`, e, { cookie })).json()).memo, 'Fix in 1.2.6');
  // Changing the status keeps the note.
  await post('/admin/api/mark', { key: `report:${ID}`, status: 'done' });
  assert.equal(kv.store.get(`mark:report:${ID}`).value, 'Fix in 1.2.6');
});

test('a mark back to all defaults removes its key', async () => {
  const { e, kv, cookie } = await seeded();
  const post = postAs(e, cookie);
  await post('/admin/api/mark', { key: `report:${ID}`, star: true, memo: 'x' });
  await post('/admin/api/mark', { key: `report:${ID}`, star: false, memo: '' });
  assert.ok(!kv.store.has(`mark:report:${ID}`));
});

test('an old done key reads as Done and is replaced by the first mark', async () => {
  const { e, kv, cookie } = await seeded();
  await kv.put(`done:report:${ID}`, '1');
  assert.equal((await listed(e, cookie)).status, 'done');
  await postAs(e, cookie)('/admin/api/mark', { key: `report:${ID}`, star: true });
  assert.ok(!kv.store.has(`done:report:${ID}`));
  const a = await listed(e, cookie);
  assert.deepEqual([a.status, a.star], ['done', true]);
});

test('mark rejects bad input and other origins', async () => {
  const { e, cookie } = await seeded();
  const post = postAs(e, cookie);
  const key = `report:${ID}`;
  for (const body of [{ key, status: 'closed' }, { key, star: 'yes' }, { key, archived: 1 }, { key, memo: 5 }, { key, memo: 'x'.repeat(2001) }, { key, extra: 1 }, { key: 'shot:x', star: true }, { key }]) {
    assert.equal((await post('/admin/api/mark', body)).status, 400, JSON.stringify(body).slice(0, 50));
  }
  assert.equal((await post('/admin/api/mark', { key, star: true }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/admin/api/done', { key, done: true })).status, 404);
});

test('delete removes the answer, its screenshots and its marks', async () => {
  const { e, kv, cookie } = await seeded();
  const post = (body) => handleAdmin(req('/admin/api/delete', { method: 'POST', body, cookie }), e, UI, passTurnstile);
  await kv.put(`done:report:${ID}`, '1');
  await kv.put(`mark:report:${ID}`, 'note', { metadata: { s: 'progress' } });
  assert.equal((await post({ key: `report:${ID}` })).status, 204);
  assert.deepEqual([...kv.store.keys()].filter((k) => k.includes(ID)), []);
  assert.ok(kv.store.has(`uninstall:${OLD}`));
  assert.equal((await post({ key: 'rl:2026-11-20:report' })).status, 400);
});

// Tests for anonymous tickets: the code /api/send hands out, reading tickets (/api/tickets),
// writing back (/api/reply) and the admin side of the conversation. Run: node --test test/tickets-api.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle as send } from '../functions/api/send.js';
import { handle as tickets } from '../functions/api/tickets.js';
import { handle as reply } from '../functions/api/reply.js';
import { handleAdmin } from '../admin/server.js';
import { hashPassword } from '../admin/password.js';
import { normCode } from '../server/tickets.js';

const ORIGIN = 'https://anime4nerd.pages.dev';
const CODE = /^A4N-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
console.info = () => {};

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
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort()
        .map((name) => ({ name, ...(store.get(name).opts.metadata ? { metadata: store.get(name).opts.metadata } : {}) }));
      return { keys, list_complete: true };
    },
  };
}

const pass = (action) => async () => Response.json({ success: true, hostname: 'anime4nerd.pages.dev', action });
let hashed;
async function env(kv = memoryKV()) {
  hashed ??= await hashPassword('pw for tests', { iterations: 1000 });
  return { FEEDBACK: kv, TURNSTILE_SECRET: 's', IP_SALT: 'salt', ADMIN_PASSWORD_HASH: hashed, TURNSTILE_SITEKEY: '0x4AAAAAAAtest' };
}

const req = (path, body, { origin = ORIGIN, ip = '203.0.113.7', cookie } = {}) => new Request(`${ORIGIN}${path}`, {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
const json = async (res) => ({ status: res.status, body: await res.json().catch(() => null), res });

const jpeg = () => {
  const b = new Uint8Array(100);
  b.set([0xff, 0xd8]);
  b.set([0xff, 0xc0, 0x00, 0x0b], 2);
  b.set([0xff, 0xda, 0x00, 0x08], 15);
  b.set([0xff, 0xd9], 98);
  return Buffer.from(b).toString('base64');
};

const sendReport = async (e, extra = {}, opts = {}) => json(await send(req('/api/send', { kind: 'report', reasons: ['look'], note: 'video went black', v: '1.2.5', b: 'chrome', token: 't', ...extra }, opts), e, pass('report')));
const sendUninstall = async (e, extra = {}) => json(await send(req('/api/send', { kind: 'uninstall', reasons: ['slow'], note: '', v: '1.2.5', token: 't', ...extra }), e, pass('uninstall')));
const read = async (e, body, opts) => json(await tickets(req('/api/tickets', body, opts), e));
const write = async (e, body, opts = {}) => json(await reply(req('/api/reply', { token: 't', ...body }, opts), e, opts.verify ?? pass('reply')));
const answerKey = (e) => [...e.FEEDBACK.store.keys()].find((k) => /^(report|uninstall):/.test(k));

const UI = { app: 'app', login: 'login' };
async function admin(e) {
  const res = await handleAdmin(req('/admin/login', { password: 'pw for tests', token: 'tok' }), e, UI,
    async () => Response.json({ success: true, hostname: 'anime4nerd.pages.dev', action: 'admin-login' }));
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return {
    post: async (path, body) => json(await handleAdmin(req(path, body, { cookie }), e, UI)),
    get: async (path) => json(await handleAdmin(new Request(`${ORIGIN}${path}`, { headers: { cookie } }), e, UI)),
  };
}

// ---------- codes ----------

test('a report gets a ticket code; only its hash is stored, pointing at the answer', async () => {
  const e = await env();
  const { status, body } = await sendReport(e);
  assert.equal(status, 200);
  assert.match(body.code, CODE);
  const key = answerKey(e);
  const index = [...e.FEEDBACK.store].filter(([k]) => k.startsWith('tk:'));
  assert.equal(index.length, 1);
  assert.match(index[0][0], /^tk:[0-9a-f]{64}$/);
  assert.equal(index[0][1].value, key);
  for (const [k, { value, opts }] of e.FEEDBACK.store) {
    assert.ok(!k.includes(body.code) && !String(value).includes(body.code) && !JSON.stringify(opts).includes(body.code), 'code stored in plain text');
  }
  assert.equal(e.FEEDBACK.store.get(key).opts.metadata.k, 1);
});

test('uninstall answers get a code only when they wrote a note', async () => {
  const e = await env();
  assert.equal((await sendUninstall(e)).body.code, undefined);
  assert.equal([...e.FEEDBACK.store.keys()].some((k) => k.startsWith('tk:')), false);
  const e2 = await env();
  assert.match((await sendUninstall(e2, { note: 'laggy on my laptop' })).body.code, CODE);
});

test('codes are read loosely: lower case, O for 0, I or L for 1, spaces, or the whole link', () => {
  assert.equal(normCode('a4n-7k2q-9mpx-4trd'), 'A4N-7K2Q-9MPX-4TRD');
  assert.equal(normCode('A4N-7K2Q-9MPX-4TRO'), 'A4N-7K2Q-9MPX-4TR0');
  assert.equal(normCode('A4N-7K2Q-9MPX-4TRI'), 'A4N-7K2Q-9MPX-4TR1');
  assert.equal(normCode(' https://anime4nerd.pages.dev/r/A4N-7K2Q-9MPX-4TRD '), 'A4N-7K2Q-9MPX-4TRD');
  for (const bad of ['', 'A4N-7K2Q-9MPX', 'A4N-7K2Q-9MPX-4TRU', 'B4N-7K2Q-9MPX-4TRD', 42, null]) assert.equal(normCode(bad), null, String(bad));
});

// ---------- reading ----------

test('reading a ticket shows the report and status, never the private note', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e, { shots: [jpeg()] });
  const key = answerKey(e);
  await e.FEEDBACK.put(`mark:${key}`, 'SECRET admin memo', { metadata: { s: 'progress', at: '2026-11-21T10:00Z' } });
  const { status, body } = await read(e, { codes: [code.toLowerCase()] });
  assert.equal(status, 200);
  const t = body.tickets[0];
  assert.deepEqual({ ...t, at: 0 }, { code, type: 'bug', at: 0, v: '1.2.5', b: 'chrome', note: 'video went black', shots: 1, status: 'progress', since: '2026-11-21T10:00Z', closed: false, msgs: [], unseen: 0 });
  assert.ok(!JSON.stringify(body).includes('SECRET'));
});

test('a ticket shows its subject when the report had one', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e, { subject: 'Black video on mkissa' });
  const { body } = await read(e, { codes: [code] });
  assert.equal(body.tickets[0].subject, 'Black video on mkissa');
});

test('unknown codes, deleted reports and archived ones each say so', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  const key = answerKey(e);
  assert.deepEqual((await read(e, { codes: ['A4N-0000-0000-0000'] })).body.tickets, [{ code: 'A4N-0000-0000-0000', unknown: true }]);
  await e.FEEDBACK.put(`mark:${key}`, '', { metadata: { s: 'open', a: 1 } });
  assert.equal((await read(e, { codes: [code] })).body.tickets[0].closed, true);
  await e.FEEDBACK.delete(key);
  assert.deepEqual((await read(e, { codes: [code] })).body.tickets, [{ code, gone: true }]);
});

test('reading refuses bad input and other origins', async () => {
  const e = await env();
  assert.equal((await read(e, { codes: Array(7).fill('A4N-0000-0000-0000') })).status, 400);
  assert.equal((await read(e, { codes: Array(6).fill('A4N-0000-0000-0000') })).status, 200);
  assert.equal((await read(e, { codes: 'A4N-0000-0000-0000' })).status, 400);
  assert.equal((await read(e, { codes: [], extra: 1 })).status, 400);
  assert.equal((await read(e, { codes: [] }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await read(e, { codes: [] }, { origin: 'null' })).status, 403);
  assert.equal((await read(e, { codes: [] }, { origin: 'chrome-extension://x/../evil' })).status, 403);
  // Site only: the extension makes no network requests, so its origins are refused too.
  assert.equal((await read(e, { codes: [] }, { origin: 'chrome-extension://kblnmcdmlgeidaclnhjmcffefmkehkpm' })).status, 403);
  assert.equal((await write(e, { code: 'A4N-0000-0000-0000', text: 'x' }, { origin: 'chrome-extension://kblnmcdmlgeidaclnhjmcffefmkehkpm' })).status, 403);
  // A malformed saved code reads as unknown, so one bad entry can't break the page.
  assert.deepEqual((await read(e, { codes: ['nope'] })).body.tickets, [{ code: 'nope', unknown: true }]);
});

// ---------- writing back ----------

test('the reporter can write back with screenshots; the reply is stored as a message', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  const { status } = await write(e, { code, text: 'still black on another site', shots: [jpeg()] });
  assert.equal(status, 200);
  const t = (await read(e, { codes: [code] })).body.tickets[0];
  assert.equal(t.msgs.length, 1);
  assert.deepEqual({ ...t.msgs[0], at: 0 }, { f: 'u', t: 'still black on another site', s: 1, at: 0 });
  assert.equal([...e.FEEDBACK.store.keys()].filter((k) => k.startsWith('rshot:')).length, 1);
});

test('writing back on a fixed ticket opens it again; on won\'t fix it stays; archived refuses', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  const key = answerKey(e);
  await e.FEEDBACK.put(`mark:${key}`, 'memo', { metadata: { s: 'done', at: '2026-11-21T10:00Z' } });
  await write(e, { code, text: 'still happening' });
  const mark = e.FEEDBACK.store.get(`mark:${key}`);
  assert.equal(mark.opts.metadata.s, 'open');
  assert.equal(mark.value, 'memo', 'the private note is kept');
  await e.FEEDBACK.put(`mark:${key}`, '', { metadata: { s: 'wontfix', at: '2026-11-21T10:00Z' } });
  assert.equal((await write(e, { code, text: 'please reconsider' })).status, 200);
  assert.equal(e.FEEDBACK.store.get(`mark:${key}`).opts.metadata.s, 'wontfix');
  await e.FEEDBACK.put(`mark:${key}`, '', { metadata: { s: 'cantfix', at: '2026-11-21T10:00Z' } });
  assert.equal((await write(e, { code, text: 'any workaround?' })).status, 200);
  assert.equal(e.FEEDBACK.store.get(`mark:${key}`).opts.metadata.s, 'cantfix', "can't fix stays closed too");
  await e.FEEDBACK.put(`mark:${key}`, '', { metadata: { s: 'open', a: 1 } });
  assert.deepEqual((await write(e, { code, text: 'hello?' })).body, { ok: false, error: 'closed' });
});

test('writing back needs Turnstile, a known code, and text or a screenshot', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  assert.equal((await write(e, { code, text: 'x' }, { verify: async () => Response.json({ success: false }) })).status, 403);
  assert.equal((await write(e, { code, text: 'x' }, { verify: pass('report') })).status, 403);
  assert.equal((await write(e, { code: 'A4N-0000-0000-0000', text: 'x' })).status, 404);
  assert.equal((await write(e, { code, text: '   ' })).status, 400);
  assert.equal((await write(e, { code, text: 'x'.repeat(1001) })).status, 400);
  assert.equal((await write(e, { code, text: 'x', extra: 1 })).status, 400);
});

test('write-backs are capped per visitor per day and per ticket', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  for (let i = 0; i < 10; i++) assert.equal((await write(e, { code, text: `m${i}` })).status, 200, `message ${i}`);
  assert.equal((await write(e, { code, text: 'one more' })).status, 429);
  // Another visitor can still write, until the ticket holds 50 messages.
  const key = answerKey(e);
  // Both sides count: 10 from the reporter above, 40 of ours.
  const ours = Array.from({ length: 40 }, (_, i) => ({ t: `a${i}`, at: '2026-11-21T10:00Z', ts: i }));
  await e.FEEDBACK.put(`msga:${key}`, JSON.stringify({ m: ours }), { metadata: { n: 40, ts: 40 } });
  assert.deepEqual((await write(e, { code, text: 'x' }, { ip: '198.51.100.4' })).body, { ok: false, error: 'thread_full' });
});

// ---------- admin side ----------

test('admin replies show on the ticket as unseen until the reporter reads it', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  const key = answerKey(e);
  const a = await admin(e);
  assert.equal((await a.post('/admin/api/reply', { key, text: 'Thanks, found it.' })).status, 204);
  let t = (await read(e, { codes: [code] })).body.tickets[0];
  assert.deepEqual([t.msgs.length, t.msgs[0].f, t.unseen], [1, 'a', 1]);
  // Reading with `seen` marks our messages read; the admin list then says so.
  assert.equal((await read(e, { codes: [code], seen: code })).body.tickets[0].unseen, 0, 'the read that marks it seen already says so');
  t = (await read(e, { codes: [code] })).body.tickets[0];
  assert.equal(t.unseen, 0);
  const row = (await a.get('/admin/api/answers')).body.answers[0];
  assert.deepEqual([row.ticket, row.thread], [true, { n: 1, last: 'a', seen: true }]);
});

test('the admin sees the conversation, and a reporter write-back marks it as waiting', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  const key = answerKey(e);
  const a = await admin(e);
  await a.post('/admin/api/reply', { key, text: 'Which site?' });
  await new Promise((r) => setTimeout(r, 5)); // messages are ordered by time
  await write(e, { code, text: 'mkissa.to' });
  const one = (await a.get(`/admin/api/answer?key=${encodeURIComponent(key)}`)).body;
  assert.deepEqual(one.msgs.map((m) => [m.f, m.t]), [['a', 'Which site?'], ['u', 'mkissa.to']]);
  // last "u": the reporter wrote last, so it waits on us (they have read our message, hence seen).
  assert.deepEqual((await a.get('/admin/api/answers')).body.answers[0].thread, { n: 2, last: 'u', seen: true });
});

test('the admin cannot reply to answers without a ticket, or with bad text', async () => {
  const e = await env();
  await sendUninstall(e);
  const a = await admin(e);
  assert.deepEqual((await a.post('/admin/api/reply', { key: answerKey(e), text: 'hi' })).body, { ok: false, error: 'no_ticket' });
  const e2 = await env();
  await sendReport(e2);
  const a2 = await admin(e2);
  assert.equal((await a2.post('/admin/api/reply', { key: answerKey(e2), text: '' })).status, 400);
  assert.equal((await a2.post('/admin/api/reply', { key: answerKey(e2), text: 'x'.repeat(2001) })).status, 400);
});

test('deleting an answer removes its conversation and reply screenshots; the code then reads as removed', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  const key = answerKey(e);
  await write(e, { code, text: 'see this', shots: [jpeg()] });
  const a = await admin(e);
  assert.equal((await a.post('/admin/api/delete', { key })).status, 204);
  assert.deepEqual([...e.FEEDBACK.store.keys()].filter((k) => /^(msgu|msga|seen|rshot|mark|report):/.test(k)), []);
  assert.deepEqual((await read(e, { codes: [code] })).body.tickets, [{ code, gone: true }]);
});

test('the admin can open reply screenshots, only by their own key shape', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  await write(e, { code, text: 'see this', shots: [jpeg()] });
  const a = await admin(e);
  const shotKey = [...e.FEEDBACK.store.keys()].find((k) => k.startsWith('rshot:'));
  const ok = await a.get(`/admin/api/shot?key=${encodeURIComponent(shotKey)}`);
  assert.equal(ok.res.headers.get('content-type'), 'image/jpeg');
  assert.equal((await a.get('/admin/api/shot?key=rshot:../x:1:1')).status, 400);
});

// ---------- admin screenshots ----------

const seeShot = async (e, body, opts = {}) => (await import('../functions/api/shot.js')).handle(req('/api/shot', body, opts), e);

test('the admin can reply with screenshots; the ticket shows them by message number', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  const key = answerKey(e);
  const id = key.slice(key.indexOf(':') + 1);
  const a = await admin(e);
  assert.equal((await a.post('/admin/api/reply', { key, text: 'first, no picture' })).status, 204);
  assert.equal((await a.post('/admin/api/reply', { key, text: 'like this', shots: [jpeg(), jpeg()] })).status, 204);
  assert.equal((await a.post('/admin/api/reply', { key, shots: [jpeg()] })).status, 204, 'a picture alone is enough');
  assert.deepEqual([...e.FEEDBACK.store.keys()].filter((k) => k.startsWith('ashot:')).sort(), [`ashot:${id}:2:1`, `ashot:${id}:2:2`, `ashot:${id}:3:1`]);
  assert.ok(e.FEEDBACK.store.get(`ashot:${id}:2:1`).opts.expirationTtl > 0, 'admin screenshots expire like the others');
  const t = (await read(e, { codes: [code] })).body.tickets[0];
  assert.deepEqual(t.msgs.map(({ f, t: text, s, k }) => [f, text, s, k]), [['a', 'first, no picture', undefined, undefined], ['a', 'like this', 2, 2], ['a', '', 1, 3]]);
  const one = (await a.get(`/admin/api/answer?key=${encodeURIComponent(key)}`)).body;
  assert.deepEqual(one.msgs.map(({ f, s, k }) => [f, s, k]), [['a', undefined, undefined], ['a', 2, 2], ['a', 1, 3]]);
  const img = await a.get(`/admin/api/shot?key=${encodeURIComponent(`ashot:${id}:2:1`)}`);
  assert.equal(img.res.headers.get('content-type'), 'image/jpeg');
});

test('admin screenshots are checked like the reporter\'s: at most 3, JPEG only', async () => {
  const e = await env();
  await sendReport(e);
  const key = answerKey(e);
  const a = await admin(e);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(92).fill(0)]).toString('base64');
  for (const shots of [[jpeg(), jpeg(), jpeg(), jpeg()], [png], 'x', [5]]) {
    assert.equal((await a.post('/admin/api/reply', { key, text: 'x', shots })).status, 400, JSON.stringify(shots).slice(0, 30));
  }
  assert.equal((await a.post('/admin/api/reply', { key, shots: [] })).status, 400, 'nothing to send');
  assert.equal([...e.FEEDBACK.store.keys()].some((k) => /^(ashot|msga):/.test(k)), false);
});

test('the reporter opens our screenshots with the ticket code, and nothing else', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e, { shots: [jpeg()] });
  const key = answerKey(e);
  const a = await admin(e);
  await a.post('/admin/api/reply', { key, text: 'see', shots: [jpeg()] });
  await write(e, { code, text: 'mine', shots: [jpeg()] });
  const ok = await seeShot(e, { code: code.toLowerCase(), k: 1, i: 1 });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/jpeg');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
  assert.match(ok.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual([...new Uint8Array(await ok.arrayBuffer())].slice(0, 2), [0xff, 0xd8]);
  assert.equal((await seeShot(e, { code, k: 1, i: 2 })).status, 404);
  assert.equal((await seeShot(e, { code: 'A4N-0000-0000-0000', k: 1, i: 1 })).status, 404);
  for (const bad of [{ code, k: 0, i: 1 }, { code, k: 1, i: 4 }, { code, k: '1', i: 1 }, { code, k: 51, i: 1 }, { code: 'nope', k: 1, i: 1 }, { code, k: 1, i: 1, f: 'u' }]) {
    assert.equal((await seeShot(e, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await seeShot(e, { code, k: 1, i: 1 }, { origin: 'https://evil.example' })).status, 403);
  await e.FEEDBACK.delete(key);
  assert.equal((await seeShot(e, { code, k: 1, i: 1 })).status, 404, 'a removed report shows nothing');
});

test('deleting an answer removes our screenshots too', async () => {
  const e = await env();
  await sendReport(e);
  const key = answerKey(e);
  const a = await admin(e);
  await a.post('/admin/api/reply', { key, text: 'see', shots: [jpeg(), jpeg()] });
  assert.equal((await a.post('/admin/api/delete', { key })).status, 204);
  assert.deepEqual([...e.FEEDBACK.store.keys()].filter((k) => k.startsWith('ashot:')), []);
});

// ---------- injection and abuse ----------

test('script and HTML in messages are stored and returned as plain JSON text, never as a page', async () => {
  const e = await env();
  const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'`${7*7}';
  const { body: { code } } = await sendReport(e, { note: xss });
  await write(e, { code, text: xss });
  const a = await admin(e);
  await a.post('/admin/api/reply', { key: answerKey(e), text: xss });
  const { res, body } = await read(e, { codes: [code] });
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  const t = body.tickets[0];
  assert.equal(t.note, xss);
  assert.deepEqual(t.msgs.map((m) => m.t), [xss, xss]);
});

test('invisible and direction-changing characters are removed from write-backs', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  await write(e, { code, text: 'ok‮gnp.exe​\u0000 done' });
  assert.equal((await read(e, { codes: [code] })).body.tickets[0].msgs[0].t, 'okgnp.exe done');
});

test('codes cannot reach any KV key but their own hashed index', async () => {
  const e = await env();
  await sendReport(e);
  const asked = [];
  const kv = e.FEEDBACK;
  const spy = { ...kv, get: (k, t) => { asked.push(k); return kv.get(k, t); }, getWithMetadata: (k) => { asked.push(k); return kv.getWithMetadata(k); } };
  const bad = [answerKey(e), `tk:${'0'.repeat(64)}`, 'mark:x', '../../admin', 'A4N-0000-0000-0000\u0000x', 'A4N-'.padEnd(190, 'Z')];
  const { body } = await read({ ...e, FEEDBACK: spy }, { codes: bad });
  assert.ok(body.tickets.every((t) => t.unknown), JSON.stringify(body));
  assert.deepEqual(asked, [], 'a malformed code made a KV read');
  for (const code of bad) assert.equal((await write({ ...e, FEEDBACK: spy }, { code, text: 'x' })).status, 400, code);
});

test('a ticket never shows internal keys, ids or the private note', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  const key = answerKey(e);
  await e.FEEDBACK.put(`mark:${key}`, 'PRIVATE note text', { metadata: { s: 'done', st: 1, at: '2026-11-21T10:00Z' } });
  const text = JSON.stringify((await read(e, { codes: [code] })).body);
  for (const leak of [key, key.slice(-16), 'PRIVATE', 'tk:', '"st"', 'star']) assert.ok(!text.includes(leak), `leaks ${leak}`);
});

test('oversized bodies and non-JPEG screenshots are refused before anything is stored', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  const before = e.FEEDBACK.store.size;
  const big = { codes: ['A4N-0000-0000-0000'], seen: 'x'.repeat(5000) };
  assert.equal((await read(e, big)).status, 413);
  const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(100, ' ')).toString('base64');
  assert.equal((await write(e, { code, text: 'x', shots: [html] })).status, 400);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array(92).fill(0)]).toString('base64');
  assert.equal((await write(e, { code, text: 'x', shots: [png] })).status, 400);
  assert.equal((await write(e, { code, text: 'x', shots: [jpeg(), jpeg(), jpeg(), jpeg()] })).status, 400);
  assert.equal(e.FEEDBACK.store.size, before, 'a refused request wrote to KV');
});

test('the admin reply endpoint needs a session and the site origin', async () => {
  const e = await env();
  await sendReport(e);
  const key = answerKey(e);
  const UIx = { app: 'app', login: 'login' };
  assert.equal((await handleAdmin(req('/admin/api/reply', { key, text: 'x' }), e, UIx)).status, 404, 'no session');
  const res = await handleAdmin(req('/admin/login', { password: 'pw for tests', token: 'tok' }), e, UIx,
    async () => Response.json({ success: true, hostname: 'anime4nerd.pages.dev', action: 'admin-login' }));
  const cookie = res.headers.get('set-cookie').split(';')[0];
  assert.equal((await handleAdmin(req('/admin/api/reply', { key, text: 'x' }, { cookie, origin: 'https://evil.example' }), e, UIx)).status, 403);
  assert.equal((await handleAdmin(req('/admin/api/reply', { key: 'tk:abc', text: 'x' }, { cookie }), e, UIx)).status, 400);
});

test('new codes are well spread: no repeats over many draws', async () => {
  const { newCode } = await import('../server/tickets.js');
  const seen = new Set();
  for (let i = 0; i < 20000; i++) seen.add(newCode());
  assert.equal(seen.size, 20000);
  assert.ok([...seen].every((c) => CODE.test(c)));
});

// ---------- concurrency and platform limits ----------

test('reading a ticket never rewrites a message key, so it cannot erase a newer reply', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  const key = answerKey(e);
  const a = await admin(e);
  await a.post('/admin/api/reply', { key, text: 'reply 1' });
  const kv = e.FEEDBACK;
  const writes = [];
  // The reporter reads (and marks read) while our second reply lands in between.
  const spy = { ...kv, put: async (k, v, o) => { writes.push(k); return kv.put(k, v, o); } };
  const pending = read({ ...e, FEEDBACK: spy }, { codes: [code], seen: code });
  await a.post('/admin/api/reply', { key, text: 'reply 2' });
  await pending;
  assert.deepEqual(writes, [`seen:${key}`]);
  const t = (await read(e, { codes: [code] })).body.tickets[0];
  assert.deepEqual(t.msgs.map((m) => m.t), ['reply 1', 'reply 2']);
});

test('a reporter write-back and our reply at the same moment both survive', async () => {
  const e = await env();
  const { body: { code } } = await sendReport(e);
  const key = answerKey(e);
  const a = await admin(e);
  await Promise.all([write(e, { code, text: 'from reporter' }), a.post('/admin/api/reply', { key, text: 'from us' })]);
  const texts = (await read(e, { codes: [code] })).body.tickets[0].msgs.map((m) => m.t).sort();
  assert.deepEqual(texts, ['from reporter', 'from us']);
});

test('a full batch of 6 tickets stays within 50 KV operations (the Free-plan subrequest limit)', async () => {
  const e = await env();
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await sendReport(e, { note: `n${i}` }, { ip: `198.51.100.${i}` })).body.code);
  const a = await admin(e);
  for (const k of [...e.FEEDBACK.store.keys()].filter((x) => x.startsWith('report:'))) await a.post('/admin/api/reply', { key: k, text: 'hi' });
  let ops = 0;
  const kv = e.FEEDBACK;
  const count = (fn) => (...args) => { ops++; return fn(...args); };
  const spy = { ...kv, get: count(kv.get), getWithMetadata: count(kv.getWithMetadata), put: count(kv.put), list: count(kv.list) };
  const { status, body } = await read({ ...e, FEEDBACK: spy }, { codes, seen: codes[0] });
  assert.equal(status, 200);
  assert.equal(body.tickets.filter((t) => t.msgs?.length === 1).length, 6);
  assert.ok(ops <= 50, `${ops} KV operations`);
});

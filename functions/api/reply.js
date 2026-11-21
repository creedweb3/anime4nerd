// POST /api/reply: the reporter writes back on their ticket, from the /tickets page.
//
// Body: {"code", "text", "shots"?, "token"}. Same order of work as /api/send, cheapest first:
// shape checks, Turnstile (action "reply"), then KV. A ticket the admin archived takes no more
// messages; writing back on one marked fixed opens it again; won't fix stays won't fix.
// Limits: 10 write-backs per visitor per day, 50 for everyone, 50 messages per ticket, and
// screenshots share /api/send's daily screenshot ceilings.
import {
  Rejected, SHOTS_PER_DAY, SHOTS_PER_VISITOR, SHOT_TTL, checkShotShape, cleanText, count, decodeShot,
  ipBucket, kvCall, logOutcome, readCapped, reply, setCount, sha256Hex, verifyTurnstile,
} from './send.js';
import { MAX_MSGS, MAX_REPORTER_TEXT, markMetadata, markOf, normCode, sideFrom, ticketKey, withMessage } from '../../server/tickets.js';

const MAX_BODY = 1_050_000; // three screenshots, as on /api/send
const MAX_TOKEN = 2048;
const MAX_SHOTS = 3;
export const REPLIES_PER_VISITOR_PER_DAY = 10;
// 50 x at most 4 writes (counters, the message, a reopened mark) keeps write-backs within the
// Free plan's 1,000 daily writes next to /api/send (see its ceilings comment).
export const REPLIES_PER_DAY = 50;

const reject = (status, code) => {
  throw new Rejected(status, code);
};

function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) reject(400, 'bad_body');
  for (const k of Object.keys(input)) if (!['code', 'text', 'shots', 'token'].includes(k)) reject(400, 'unknown_field');
  const code = normCode(input.code);
  if (!code) reject(400, 'bad_code');
  const text = cleanText(input.text, MAX_REPORTER_TEXT);
  const shots = input.shots ?? [];
  if (!Array.isArray(shots) || shots.length > MAX_SHOTS) reject(400, 'bad_shot');
  shots.forEach(checkShotShape);
  if (!text && !shots.length) reject(400, 'empty');
  if (typeof input.token !== 'string' || !input.token || input.token.length > MAX_TOKEN) reject(400, 'bad_token');
  return { code, text, shots, token: input.token };
}

export async function handle(request, env, fetchFn = fetch) {
  try {
    if (!env.FEEDBACK || !env.TURNSTILE_SECRET || !env.IP_SALT) reject(503, 'not_configured');
    const url = new URL(request.url);
    if (request.headers.get('origin') !== url.origin) reject(403, 'bad_origin');
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) reject(415, 'bad_type');
    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY) reject(413, 'too_large');
    const ip = request.headers.get('cf-connecting-ip') ?? '';
    if (!ip && env.ALLOW_TEST_TURNSTILE !== '1') reject(400, 'no_ip');
    let input;
    try {
      input = JSON.parse(await readCapped(request, MAX_BODY));
    } catch (e) {
      if (e instanceof Rejected) throw e;
      reject(400, 'bad_json');
    }
    const { code, text, shots: shotText, token } = validate(input);

    await verifyTurnstile(env, token, 'reply', url.hostname, fetchFn);

    const kv = env.FEEDBACK;
    const index = await ticketKey(code);
    const key = await kvCall(() => kv.get(index));
    if (!key) reject(404, 'unknown');
    const [answer, mark, done, mine, ours] = await Promise.all([
      kvCall(() => kv.get(key)),
      kvCall(() => kv.getWithMetadata(`mark:${key}`)),
      kvCall(() => kv.get(`done:${key}`)),
      kvCall(() => kv.get(`msgu:${key}`)),
      kvCall(() => kv.getWithMetadata(`msga:${key}`)),
    ]);
    if (answer === null) reject(404, 'gone');
    const status = markOf(mark.metadata, done !== null);
    if (status.archived) reject(403, 'closed');
    const myMsgs = sideFrom(mine, 'u');
    if (myMsgs.length + (Number.isInteger(ours.metadata?.n) ? ours.metadata.n : 0) >= MAX_MSGS) reject(409, 'thread_full');

    const minute = `${new Date().toISOString().slice(0, 16)}Z`;
    const day = minute.slice(0, 10);
    const visitor = await sha256Hex(`${env.IP_SALT}|${day}|${ipBucket(ip)}`);
    const visitorKey = `rl:${day}:${visitor}:reply`;
    const allKey = `rl:${day}:reply`;
    const myCount = await count(kv, visitorKey);
    if (myCount >= REPLIES_PER_VISITOR_PER_DAY) reject(429, 'rate_limited');
    const all = await count(kv, allKey);
    if (all >= REPLIES_PER_DAY) reject(429, 'daily_limit');

    const shots = shotText.map(decodeShot);
    await setCount(kv, visitorKey, myCount + 1);

    // Screenshots past either daily ceiling are dropped; the message still goes through.
    const shotKey = `rl:${day}:shots`;
    const visitorShotKey = `rl:${day}:${visitor}:shots`;
    let kept = [];
    if (shots.length) {
      const [shotCount, visitorShots] = await Promise.all([count(kv, shotKey), count(kv, visitorShotKey)]);
      kept = shots.slice(0, Math.max(0, Math.min(SHOTS_PER_DAY - shotCount, SHOTS_PER_VISITOR - visitorShots)));
      const id = key.slice(key.indexOf(':') + 1);
      for (const [i, bytes] of kept.entries()) {
        await kvCall(() => kv.put(`rshot:${id}:${myMsgs.length + 1}:${i + 1}`, bytes, { expirationTtl: SHOT_TTL, metadata: { contentType: 'image/jpeg' } }));
      }
      if (kept.length) {
        await setCount(kv, shotKey, shotCount + kept.length);
        await setCount(kv, visitorShotKey, visitorShots + kept.length);
      }
    }
    if (!text && !kept.length) reject(429, 'shots_limit');

    // Only the reporter's own key is written: our replies live in msga: and can't be overwritten.
    // Writing back also counts as having read everything before it (server/tickets.js unseenCount).
    const next = withMessage(myMsgs, { t: text, at: minute, ts: Date.now(), ...(kept.length ? { s: kept.length } : {}) });
    await kvCall(() => kv.put(`msgu:${key}`, next.value, { metadata: next.metadata }));
    // Still broken after a fix: the ticket opens again, keeping the admin's note, star and so on.
    if (status.status === 'done') {
      const reopened = markMetadata({ ...status, status: 'open', since: minute }, mark.value ?? '');
      if (reopened) await kvCall(() => kv.put(`mark:${key}`, mark.value ?? '', { metadata: reopened }));
      else await kvCall(() => kv.delete(`mark:${key}`));
      if (done !== null) await kvCall(() => kv.delete(`done:${key}`));
    }
    await setCount(kv, allKey, all + 1);
    return reply(200, { ok: true });
  } catch (e) {
    if (e instanceof Rejected) {
      logOutcome(e.status, e.message);
      return reply(e.status, { ok: false, error: e.message });
    }
    logOutcome(500, `error:${e?.name ?? 'Error'}`);
    return reply(500, { ok: false, error: 'error' });
  }
}

export const onRequestPost = ({ request, env }) => handle(request, env);

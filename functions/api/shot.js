// POST /api/shot: one screenshot we attached to a reply, for the reporter's /tickets page.
//
// Body: {"code", "k", "i"}: the ticket code, the number of our message (k, from the ticket's
// messages) and the picture in it (1-3). Only our own screenshots ("ashot:") are served: the code
// is the key, as for /api/tickets, so it is sent in the body, never in a URL. Costs four KV
// reads, no writes. Only a picture of a message still shown is served: never one of an unsent
// message, or a slot past the message's count, even if a key was left behind. The bytes are JPEG we stored from the admin page; they go out as image/jpeg with
// nosniff and a sandbox policy, so nothing in them can run even if opened on their own.
import { Rejected, kvCall, logOutcome, readCapped, reply } from './send.js';
import { MAX_MSGS, normCode, sideFrom, ticketKey } from '../../server/tickets.js';

const MAX_BODY = 512;

const reject = (status, code) => {
  throw new Rejected(status, code);
};

const inRange = (v, max) => Number.isInteger(v) && v >= 1 && v <= max;

export async function handle(request, env) {
  try {
    if (!env.FEEDBACK) reject(503, 'not_configured');
    const url = new URL(request.url);
    if (request.headers.get('origin') !== url.origin) reject(403, 'bad_origin');
    if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) reject(415, 'bad_type');
    let input;
    try {
      input = JSON.parse(await readCapped(request, MAX_BODY));
    } catch (e) {
      if (e instanceof Rejected) throw e;
      reject(400, 'bad_json');
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) reject(400, 'bad_body');
    for (const k of Object.keys(input)) if (!['code', 'k', 'i'].includes(k)) reject(400, 'unknown_field');
    const code = normCode(input.code);
    if (!code || !inRange(input.k, MAX_MSGS) || !inRange(input.i, 3)) reject(400, 'bad_shot');

    const kv = env.FEEDBACK;
    const index = await ticketKey(code);
    const key = await kvCall(() => kv.get(index));
    if (!key) reject(404, 'not_found');
    // The answer itself must still exist: a removed report shows nothing.
    const [answer, ours] = await Promise.all([kvCall(() => kv.get(key)), kvCall(() => kv.get(`msga:${key}`))]);
    if (answer === null) reject(404, 'not_found');
    const msg = sideFrom(ours, 'a').find((m) => m.k === input.k);
    if (!msg || msg.gone || input.i > (msg.s ?? 0)) reject(404, 'not_found');
    const id = key.slice(key.indexOf(':') + 1);
    const bytes = await kvCall(() => kv.get(`ashot:${id}:${input.k}:${input.i}`, 'arrayBuffer'));
    if (bytes === null) reject(404, 'not_found');
    return new Response(bytes, {
      headers: {
        'content-type': 'image/jpeg',
        'content-security-policy': "default-src 'none'; sandbox",
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
        'referrer-policy': 'no-referrer',
      },
    });
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

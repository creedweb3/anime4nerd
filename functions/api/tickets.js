// POST /api/tickets: reads tickets by their codes, for the /tickets page and the site's top bar.
//
// Body: {"codes": ["A4N-…", …], "seen": "A4N-…"?}. Each code comes back as the ticket (see
// publicView in server/tickets.js), {code, gone: true} when the answer was deleted, or
// {code, unknown: true}. "seen" names the ticket the reporter has open: it is marked read, the
// only write this endpoint makes, and only into its own small "seen:" key (never the messages).
// Never returns the admin's private note. No Turnstile and no counters: reading costs KV reads
// only, and codes are too long to guess (server/tickets.js).
//
// At most 6 codes a request: each costs up to 7 KV operations, and a Free-plan request may make
// at most 50. Clients send larger lists in batches.
import { Rejected, kvCall, logOutcome, readCapped, reply } from './send.js';
import { markOf, merged, normCode, publicView, sideFrom, ticketKey, unseenCount } from '../../server/tickets.js';

const MAX_BODY = 4096;
export const MAX_CODES = 6;

const reject = (status, code) => {
  throw new Rejected(status, code);
};

async function readOne(kv, raw, seen) {
  const code = normCode(raw);
  if (!code) return { code: raw, unknown: true };
  const index = await ticketKey(code);
  const key = await kvCall(() => kv.get(index));
  if (!key) return { code, unknown: true };
  const [answer, mark, done, mine, ours, seenAt] = await Promise.all([
    kvCall(() => kv.get(key)),
    kvCall(() => kv.getWithMetadata(`mark:${key}`)),
    kvCall(() => kv.get(`done:${key}`)),
    kvCall(() => kv.getWithMetadata(`msgu:${key}`)),
    kvCall(() => kv.getWithMetadata(`msga:${key}`)),
    kvCall(() => kv.getWithMetadata(`seen:${key}`)),
  ]);
  if (answer === null) return { code, gone: true };
  const ourMsgs = sideFrom(ours.value, 'a');
  let unseen = unseenCount(ourMsgs, mine.metadata?.ts, seenAt.metadata?.ts);
  if (seen === code && unseen) {
    await kvCall(() => kv.put(`seen:${key}`, '', { metadata: { ts: Date.now() } }));
    unseen = 0;
  }
  return publicView(code, answer, markOf(mark.metadata, done !== null), merged(sideFrom(mine.value, 'u'), ourMsgs), unseen);
}

export async function handle(request, env) {
  try {
    if (!env.FEEDBACK) reject(503, 'not_configured');
    const url = new URL(request.url);
    // The site's own pages only. Other pages can't read this anyway (no CORS headers, and a JSON
    // POST needs a preflight we refuse); the check keeps out simple cross-site posts too.
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
    for (const k of Object.keys(input)) if (k !== 'codes' && k !== 'seen') reject(400, 'unknown_field');
    const { codes } = input;
    if (!Array.isArray(codes) || codes.length > MAX_CODES || !codes.every((c) => typeof c === 'string' && c.length <= 200)) reject(400, 'bad_codes');
    const seen = normCode(input.seen);
    const tickets = [];
    for (const raw of codes) tickets.push(await readOne(env.FEEDBACK, raw, seen));
    return reply(200, { tickets });
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

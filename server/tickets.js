// Anonymous tickets: one secret code per report (and per uninstall answer with a note), and the
// conversation about it. Shared by /api/send, /api/tickets, /api/reply and /admin.
//
// The code is the only key to a ticket: whoever has it can read and write the conversation. It is
// shown once, on the thank-you screen, and never stored: KV keeps only "tk:<SHA-256 of the code>",
// whose value is the answer's key. A code has 60 random bits (12 Crockford base-32 characters),
// far too many to guess at KV's read rate, so lookups are not counted (counting would cost writes).
//
// Keys, next to the answer "<kind>:<id>" and its admin mark "mark:<kind>:<id>":
//   tk:<sha256 hex>        value: the answer key
//   msgu:<kind>:<id>       the reporter's messages, value {"m":[{t,at,ts,s?}]}, metadata {n, ts}
//   msga:<kind>:<id>       our messages, same shape
//   seen:<kind>:<id>       metadata {ts}: when the reporter last read the ticket
//   rshot:<id>:<k>:<i>     JPEG i (1-3) of the reporter's k-th message (60-day TTL)
// Each side writes only its own key, and reading never rewrites a message key: KV has no
// compare-and-swap, so a shared key would let one writer replace the other's newer copy.
// "at" is the minute shown on screen; "ts" (milliseconds) orders the two sides.
//
// Nothing here touches KV: callers read and write, so their own error handling applies.

// Crockford base 32: no I, L, O or U, so a code read aloud or typed by hand survives.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUP = `[${ALPHABET}]{4}`;
const CODE = new RegExp(`^A4N-${GROUP}-${GROUP}-${GROUP}$`);

export const MAX_MSGS = 50; // per ticket, both sides together
export const MAX_REPORTER_TEXT = 1000;
export const MAX_ADMIN_TEXT = 2000;
export const STATUSES = ['open', 'progress', 'done', 'wontfix', 'cantfix'];

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => ALPHABET[b & 31]).join('');
  return `A4N-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

// The code as typed or pasted (any case, spaces, the whole /r/ link, O for 0, I or L for 1), or null.
export function normCode(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  const tail = value.trim().split('/').pop().toUpperCase().replace(/\s+/g, '');
  const [prefix, ...groups] = tail.split('-');
  if (prefix !== 'A4N') return null;
  const code = `A4N-${groups.map((g) => g.replace(/O/g, '0').replace(/[IL]/g, '1')).join('-')}`;
  return CODE.test(code) ? code : null;
}

export async function ticketKey(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`a4n-ticket|${code}`));
  return `tk:${[...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

// The admin mark of one answer, from its mark metadata or an old "done:" key.
export function markOf(meta, isDone) {
  return {
    status: STATUSES.includes(meta?.s) ? meta.s : isDone ? 'done' : 'open',
    star: meta?.st === 1,
    archived: meta?.a === 1,
    since: typeof meta?.at === 'string' ? meta.at.slice(0, 17) : '',
  };
}

// Mark metadata for a mark; null when it is back to all defaults (the key can then be deleted).
export function markMetadata({ status, star, archived, since }, memo) {
  if (status === 'open' && !star && !archived && !memo) return null;
  return { s: status, ...(star ? { st: 1 } : {}), ...(archived ? { a: 1 } : {}), ...(since ? { at: since } : {}) };
}

// One side's messages from its stored value; anything unreadable counts as none.
export function sideFrom(raw, f) {
  if (raw === null || raw === undefined) return [];
  try {
    const m = JSON.parse(raw)?.m;
    if (!Array.isArray(m)) return [];
    return m.filter((x) => x && typeof x.t === 'string' && typeof x.at === 'string' && Number.isFinite(x.ts))
      .map((x, i) => ({ f, t: x.t, at: x.at, ts: x.ts, k: i + 1, ...(Number.isInteger(x.s) && x.s > 0 ? { s: Math.min(x.s, 3) } : {}) }));
  } catch {
    return [];
  }
}

// The value and metadata to store after adding one message to a side.
export function withMessage(side, msg) {
  const next = [...side.map(({ t, at, ts, s }) => ({ t, at, ts, ...(s ? { s } : {}) })), msg];
  return { value: JSON.stringify({ m: next }), metadata: { n: next.length, ts: msg.ts } };
}

// Both sides in time order (the reporter's first on a tie: they wrote what we answered).
export function merged(mine, ours) {
  return [...mine, ...ours].sort((a, b) => a.ts - b.ts || (a.f === b.f ? a.k - b.k : a.f === 'u' ? -1 : 1));
}

// Our messages the reporter has not read: newer than their last visit and their last message.
export function unseenCount(ours, mineTs, seenTs) {
  const read = Math.max(Number(mineTs) || 0, Number(seenTs) || 0);
  return ours.filter((m) => m.ts > read).length;
}

// The same from list metadata alone (admin list): whether our latest message was read.
export function threadSummary(uMeta, aMeta, seenMeta) {
  const nu = Number.isInteger(uMeta?.n) ? uMeta.n : 0;
  const na = Number.isInteger(aMeta?.n) ? aMeta.n : 0;
  if (!nu && !na) return null;
  const uts = Number(uMeta?.ts) || 0;
  const ats = Number(aMeta?.ts) || 0;
  return { n: nu + na, last: uts >= ats && nu ? 'u' : 'a', seen: !na || Math.max(uts, Number(seenMeta?.ts) || 0) >= ats };
}

// Messages as clients see them: who, text, minute, screenshot count.
export const shown = (msgs) => msgs.map(({ f, t, at, s }) => ({ f, t, at, ...(s ? { s } : {}) }));

// What the reporter sees: their own answer, the status, and the conversation. Never the private note.
export function publicView(code, answerRaw, mark, msgs, unseen) {
  let a = {};
  try {
    a = JSON.parse(answerRaw) ?? {};
  } catch { /* an unreadable answer still shows its status and messages */ }
  const kind = a.kind === 'uninstall' ? 'uninstall' : a.type === 'idea' ? 'idea' : 'bug';
  return {
    code,
    type: kind,
    at: typeof a.at === 'string' ? a.at.slice(0, 17) : '',
    v: typeof a.v === 'string' ? a.v.slice(0, 20) : '',
    b: a.b === 'chrome' || a.b === 'firefox' ? a.b : '',
    ...(typeof a.subject === 'string' && a.subject ? { subject: a.subject.slice(0, 80) } : {}),
    note: typeof a.note === 'string' ? a.note.slice(0, 2000) : '',
    shots: Number.isInteger(a.shots) ? Math.min(Math.max(a.shots, 0), 3) : 0,
    status: mark.status,
    since: mark.since,
    closed: mark.archived,
    msgs: shown(msgs),
    unseen,
  };
}

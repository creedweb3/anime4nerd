// Prints every answer from the site's /uninstalled and /report forms, newest first.
// Run: node scripts/feedback.mjs   (needs `npx wrangler login` once)
//
// Reads Workers KV through Wrangler, so it uses Wrangler's own login and keeps no token here.
// Answers are untrusted text typed by strangers: every value is cleaned of escape sequences and
// invisible characters before it reaches the terminal.

import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const NAMESPACE_ID = 'a30e3d521b274ae8b89bed3716011cd9'; // anime4nerd-feedback (an id, not a secret)
const WRANGLER = 'wrangler@4.155.0';
const ANSWER_KEY = /^(uninstall|report):(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})Z-[0-9a-f]{16}$/;

// C0/C1 controls except newline (this covers ESC, so no escape sequence survives), soft hyphen,
// zero-width characters, bidi controls, line/paragraph separators, word joiners, the BOM,
// interlinear annotations and Unicode tag characters.
const UNSAFE_RANGES = [
  [0x00, 0x09], [0x0b, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x180e, 0x180e], [0x200b, 0x200f],
  [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
];
const cp = (n) => `\\u{${n.toString(16)}}`;
const UNSAFE = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => `${cp(a)}-${cp(b)}`).join('')}]`, 'gu');

export const terminalSafe = (text) => String(text).replace(UNSAFE, '');

export const isAnswerKey = (name) => ANSWER_KEY.test(name);

// Keys are "<kind>:<time>-<id>"; the part after the colon sorts by time.
const timePart = (key) => key.slice(key.indexOf(':') + 1);
export const newestFirst = (keys) => [...keys].sort((a, b) => timePart(b).localeCompare(timePart(a)));

const indent = (text, pad) => text.split('\n').map((line) => pad + line).join('\n');

export function formatAnswer(key, raw) {
  const [, kind, day, time] = ANSWER_KEY.exec(key);
  let a;
  try {
    a = JSON.parse(raw);
  } catch {
    return `${day} ${time} UTC  ${kind}\n  (unreadable value)`;
  }
  const safe = (v) => terminalSafe(v ?? '');
  const head = [`${day} ${time} UTC`, a.type ? `${kind} / ${safe(a.type)}` : kind, [a.v ? `v${safe(a.v)}` : '', safe(a.b)].filter(Boolean).join(' ')];
  const lines = [head.filter(Boolean).join('  ')];
  if (Array.isArray(a.reasons) && a.reasons.length) lines.push(`  reasons: ${a.reasons.map(safe).join(', ')}`);
  const shots = Number(a.shots) || 0;
  if (shots) {
    const id = key.slice(key.indexOf(':') + 1);
    lines.push(`  screenshots: ${Array.from({ length: shots }, (_, i) => `shot:${id}:${i + 1}`).join(', ')}`);
  }
  if (a.shotsDropped) lines.push(`  screenshots dropped: ${safe(a.shotsDropped)}`);
  if (a.note) lines.push('  note:', indent(safe(a.note), '    '));
  return lines.join('\n');
}

function wrangler(args) {
  // npx is a .cmd file on Windows and needs a shell, so the line goes to the shell as one string.
  // Every argument is a constant or a key that matched ANSWER_KEY (letters, digits, ':' and '-'),
  // so nothing from KV can inject into the command line.
  return execSync(['npx', '--yes', WRANGLER, ...args].join(' '), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function main() {
  let listed;
  try {
    const out = wrangler(['kv', 'key', 'list', '--namespace-id', NAMESPACE_ID, '--remote']);
    listed = JSON.parse(out.slice(out.indexOf('[')));
  } catch (e) {
    console.error('Could not list KV keys. Log in once with: npx wrangler login');
    console.error(terminalSafe(e.stderr || e.message));
    process.exit(1);
  }
  const keys = newestFirst(listed.map((k) => k.name).filter(isAnswerKey));
  if (!keys.length) {
    console.log('No answers yet.');
    return;
  }
  console.log(`${keys.length} answer(s), newest first\n`);
  for (const key of keys) {
    let raw;
    try {
      const out = wrangler(['kv', 'key', 'get', key, '--namespace-id', NAMESPACE_ID, '--remote', '--text']);
      raw = out.slice(Math.max(0, out.indexOf('{')));
    } catch {
      raw = '';
    }
    console.log(`${formatAnswer(key, raw)}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

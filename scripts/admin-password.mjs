// Makes the ADMIN_PASSWORD_HASH secret for the /admin dashboard. Run on your own machine:
//   node scripts/admin-password.mjs
// It asks for the password twice (nothing is shown while you type) and prints one line,
// "pbkdf2-sha256$…". Save that line as the ADMIN_PASSWORD_HASH secret in Cloudflare Pages
// (see docs/FEEDBACK_SETUP.md). The password itself is never printed or saved.
//   node scripts/admin-password.mjs --check   tests a password against a hash line you saved.

import { createInterface } from 'node:readline';
import { hashPassword, isPasswordHash, verifyPassword } from '../admin/password.js';

const MIN_LENGTH = 16;

// One readline for both questions. It echoes nothing, so typing stays hidden; the prompts are
// written straight to the terminal.
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
rl._writeToOutput = () => {};
const lines = rl[Symbol.asyncIterator]();
async function ask(question) {
  process.stdout.write(question);
  const { value = '' } = await lines.next();
  process.stdout.write('\n');
  return value;
}

// --check: tests a password against a saved hash line, locally, without using sign-in tries.
if (process.argv.includes('--check')) {
  const hash = await ask('Saved hash line (pbkdf2-sha256$…): ');
  const password = await ask('Password: ');
  rl.close();
  if (!isPasswordHash(hash)) console.log('That is not a complete hash line. Copy it again, all of it.');
  else console.log((await verifyPassword(password, hash)) ? 'Match: this password signs in with this hash.' : 'No match: the password differs from the one this hash was made from.');
  process.exit(0);
}

const first = await ask('Admin password: ');
if (first.length < MIN_LENGTH) {
  console.error(`Use at least ${MIN_LENGTH} characters (a few random words work well).`);
  process.exit(1);
}
if ((await ask('Again: ')) !== first) {
  console.error('The two passwords differ. Nothing was made.');
  process.exit(1);
}
rl.close();
console.log(await hashPassword(first));

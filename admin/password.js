// Admin password hashing: PBKDF2-SHA256 with a random 16-byte salt, stored as one string
// "pbkdf2-sha256$<iterations>$<salt>$<hash>" (salt and hash in base64url).
//
// Runs both in Node (scripts/admin-password.mjs makes the hash on your own machine) and in the
// Cloudflare Worker (checks a sign-in). 30,000 iterations take about 4 ms of CPU, inside the
// Workers Free plan's 10 ms per request (100,000 took about 15 ms). The password's length does the
// real work against guessing: the script asks for at least 16 characters.

export const ITERATIONS = 30_000;
const MAX_ITERATIONS = 100_000; // the most Workers' WebCrypto allows
const HASH_BYTES = 32;
const SALT_BYTES = 16;
const FORMAT = /^pbkdf2-sha256\$(\d{1,6})\$([\w-]{16,64})\$([\w-]{32,128})$/;

export const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function fromB64url(text) {
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, HASH_BYTES * 8);
  return new Uint8Array(bits);
}

// Compares every byte whatever the first difference, so the time taken says nothing about where
// two values differ.
export function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password, { iterations = ITERATIONS } = {}) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(await derive(password, salt, iterations))}`;
}

export async function verifyPassword(password, stored) {
  const m = FORMAT.exec(stored ?? '');
  if (!m) return false;
  const iterations = Number(m[1]);
  if (iterations < 1000 || iterations > MAX_ITERATIONS) return false;
  return sameBytes(await derive(password, fromB64url(m[2]), iterations), fromB64url(m[3]));
}

// Checks site/build.mjs output: every inline script is allowed by its hash in that page's CSP,
// no page allows inline scripts in general, only the form pages may load Turnstile, the site key
// is filled in, and a Cloudflare Pages build without a real key fails. Run: node --test test/site-build.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const build = join(import.meta.dirname, '..', 'site', 'build.mjs');
const out = join(import.meta.dirname, '..', 'site', 'public');
const PAGES = { '/': 'index.html', '/privacy': 'privacy.html', '/uninstalled': 'uninstalled.html', '/report': 'report.html' };
const FORMS = ['/uninstalled', '/report'];

function policies() {
  const text = readFileSync(join(out, '_headers'), 'utf8');
  const map = {};
  let path = null;
  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) path = line.trim() === '/*' ? '/' : line.trim();
    const m = /^\s+Content-Security-Policy: (.*)$/.exec(line);
    if (m && path) map[path] = m[1];
  }
  return { text, map };
}

test('every page CSP allows exactly its own inline scripts', () => {
  execFileSync(process.execPath, [build], { env: { ...process.env, CF_PAGES: '', TURNSTILE_SITEKEY: '0x4AAAAAAATestKey' }, stdio: 'pipe' });
  const { text, map } = policies();
  for (const [path, file] of Object.entries(PAGES)) {
    const html = readFileSync(join(out, file), 'utf8');
    assert.ok(!html.includes('\r'), `${file} has CR characters`);
    const csp = map[path];
    assert.ok(csp, `no CSP for ${path}`);
    const scriptSrc = /script-src ([^;]*)/.exec(csp)[1];
    assert.ok(!scriptSrc.includes('unsafe-inline'), `${path} allows any inline script`);
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    for (const [, body] of inline) {
      const hash = `'sha256-${createHash('sha256').update(body).digest('base64')}'`;
      assert.ok(scriptSrc.includes(hash), `${path} misses the hash of an inline script`);
    }
    assert.equal(scriptSrc.split(' ').filter((t) => t.startsWith("'sha256-")).length, inline.length);
    const turnstile = csp.includes('challenges.cloudflare.com');
    assert.equal(turnstile, FORMS.includes(path), `${path}: Turnstile allowed = ${turnstile}`);
    assert.equal(csp.includes("connect-src 'self'"), FORMS.includes(path));
    if (FORMS.includes(path)) {
      assert.ok(html.includes('data-sitekey="0x4AAAAAAATestKey"'));
      assert.ok(!html.includes('__TURNSTILE_SITEKEY__'));
    }
  }
  assert.match(text, /Permissions-Policy: camera=\(\)/);
  assert.match(text, /X-Content-Type-Options: nosniff/);
});

test('a Cloudflare Pages build without the real site key fails', () => {
  const r = spawnSync(process.execPath, [build], { env: { ...process.env, CF_PAGES: '1', TURNSTILE_SITEKEY: '' }, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TURNSTILE_SITEKEY is not set/);
  const bad = spawnSync(process.execPath, [build], { env: { ...process.env, TURNSTILE_SITEKEY: 'x"><script>' }, encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  // Leave a normal local build behind.
  execFileSync(process.execPath, [build], { env: { ...process.env, CF_PAGES: '', TURNSTILE_SITEKEY: '' }, stdio: 'pipe' });
});

// Checks site/build.mjs output: every inline script is allowed by its hash in that page's CSP,
// no page allows inline scripts in general, only the form pages may load Turnstile, the site key
// is filled in, the popup frame is the built popup under its own policy, and a Cloudflare Pages
// build without a real key fails. Run (after npm run build): node --test test/site-build.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const build = join(import.meta.dirname, '..', 'site', 'build.mjs');
const out = join(import.meta.dirname, '..', 'site', 'public');
const PAGES = { '/': 'index.html', '/privacy': 'privacy.html', '/uninstalled': 'uninstalled.html', '/report': 'report.html', '/tickets': 'tickets.html' };
const FORMS = ['/uninstalled', '/report', '/tickets'];

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
    // Every page loads assets/tickets.js and may ask /api/tickets for the top-bar count.
    assert.ok(scriptSrc.split(' ').includes("'self'"), `${path} cannot load its own scripts`);
    assert.ok(csp.includes("connect-src 'self'"), `${path} cannot call /api`);
    assert.ok(html.includes('assets/tickets.js'), `${path} misses assets/tickets.js`);
    if (FORMS.includes(path)) {
      assert.ok(html.includes('data-sitekey="0x4AAAAAAATestKey"'));
      assert.ok(!html.includes('__TURNSTILE_SITEKEY__'));
    }
  }
  // A ticket link shows the tickets page, under the tickets page's own policy.
  assert.equal(readFileSync(join(out, '_redirects'), 'utf8'), '/r/*  /tickets  200\n');
  assert.equal(map['/r/*'], map['/tickets']);
  // Only the home page frames anything of its own: the real popup at /popup/.
  for (const path of Object.keys(PAGES)) {
    assert.equal(/frame-src[^;]*'self'/.test(map[path]), path === '/', `${path}: frame-src 'self'`);
  }
  // The popup frame: the built extension popup, current, with no inline scripts, frameable by this site only.
  const dist = join(import.meta.dirname, '..', 'dist');
  for (const f of ['popup.js', 'popup.css']) {
    assert.ok(readFileSync(join(out, 'popup', f)).equals(readFileSync(join(dist, f))), `popup/${f} differs from dist/${f}`);
  }
  const frame = readFileSync(join(out, 'popup', 'index.html'), 'utf8');
  assert.ok(!/<script>/.test(frame), 'popup/index.html has an inline script');
  assert.match(frame, /<script src="stub\.js"><\/script>\s*<script src="popup\.js"><\/script>/);
  for (const path of ['/popup', '/popup/*']) {
    const csp = map[path];
    assert.ok(csp, `no CSP for ${path}`);
    assert.match(csp, /script-src 'self';/);
    assert.match(csp, /frame-ancestors 'self'/);
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

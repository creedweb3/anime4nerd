// Wraps the body-only pages in site/ into full HTML documents in site/public/
// for static hosting such as Cloudflare Pages (privacy.html is served at /privacy). No dependencies.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'public');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });

// Turnstile site key (public). Set TURNSTILE_SITEKEY in the Pages build settings. Local builds
// fall back to Cloudflare's always-pass test key; a Cloudflare Pages build (CF_PAGES=1) without
// the real key fails instead of shipping forms that cannot work.
const TEST_SITEKEY = '1x00000000000000000000AA';
const sitekey = process.env.TURNSTILE_SITEKEY || (process.env.CF_PAGES ? '' : TEST_SITEKEY);
if (!sitekey) throw new Error('TURNSTILE_SITEKEY is not set in the Cloudflare Pages build settings');
if (!/^[\w-]+$/.test(sitekey)) throw new Error('TURNSTILE_SITEKEY has unexpected characters');
if (sitekey === TEST_SITEKEY) console.warn('TURNSTILE_SITEKEY not set: using the Turnstile test key');

// Pages and the URL path Cloudflare Pages serves each one at.
const PAGES = { 'index.html': '/', 'privacy.html': '/privacy', 'uninstalled.html': '/uninstalled', 'report.html': '/report', 'tickets.html': '/tickets', 'howitworks.html': '/howitworks' };
// What the form pages need beyond the others: Turnstile, and (report, tickets) blob: thumbnails of
// picked screenshots. Every page loads assets/tickets.js ('self') and may call /api/tickets for
// the top-bar count (connect-src 'self').
const TURNSTILE = 'https://challenges.cloudflare.com';
const FORMS = {
  '/uninstalled': { img: '' },
  '/report': { img: ' blob:' },
  '/tickets': { img: ' blob:' },
};

// The home page shows the real extension popup in frames: the built dist/popup.html, popup.css and
// popup.js, copied here on every build so the pictures never go stale, with site/popup/stub.js
// standing in for chrome.* (served at /popup/).
const dist = join(here, '..', 'dist');
const POPUP_FILES = ['popup.html', 'popup.css', 'popup.js'];
// dist/ is not committed: a Cloudflare Pages build (CF_PAGES=1, build command "node site/build.mjs")
// always builds the extension first, and a local build does when dist/ has no popup yet.
if (process.env.CF_PAGES || POPUP_FILES.some((f) => !existsSync(join(dist, f)))) {
  execFileSync(process.execPath, [join(here, '..', 'build.mjs')], { cwd: join(here, '..'), stdio: 'inherit' });
}
for (const f of POPUP_FILES) {
  if (!existsSync(join(dist, f))) throw new Error(`dist/${f} is missing after building the extension`);
}
cpSync(join(here, 'popup'), join(out, 'popup'), { recursive: true });
for (const f of ['popup.css', 'popup.js']) cpSync(join(dist, f), join(out, 'popup', f));
{
  const POPUP_JS = '<script src="popup.js"></script>';
  const POPUP_CSS = '<link rel="stylesheet" href="popup.css" />';
  const popup = readFileSync(join(dist, 'popup.html'), 'utf8').replace(/\r\n?/g, '\n');
  if (!popup.includes(POPUP_JS) || !popup.includes(POPUP_CSS) || popup.match(/<script/g).length !== 1) {
    throw new Error('dist/popup.html changed shape: update the popup frame in site/build.mjs');
  }
  writeFileSync(
    join(out, 'popup', 'index.html'),
    popup
      .replace('<meta charset="utf-8" />', '<meta charset="utf-8" />\n  <meta name="robots" content="noindex" />')
      .replace(POPUP_CSS, `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" />\n  ${POPUP_CSS}\n  <link rel="stylesheet" href="frame.css" />`)
      .replace(POPUP_JS, `<script src="stub.js"></script>\n  ${POPUP_JS}`),
  );
}
// The popup frame: its own scripts only, no inline ones, and only this site may frame it.
const POPUP_POLICY = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

// CSP allowing exactly the inline scripts of one page (by hash) instead of any inline script.
function cspFor(html, path) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => sha256(m[1]));
  const form = Object.hasOwn(FORMS, path);
  const img = form ? FORMS[path].img : '';
  const script = [...hashes, "'self'", ...(form ? [TURNSTILE] : [])].join(' ');
  // Frames: Turnstile on the form pages, the popup frame (/popup/) on the home page.
  const frames = [...(form ? [TURNSTILE] : []), ...(path === '/' ? ["'self'"] : [])];
  const extra = `${frames.length ? `frame-src ${frames.join(' ')}; ` : ''}connect-src 'self'; `;
  return `default-src 'none'; img-src 'self'${img}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src ${script}; ${extra}base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}

const policies = {};
for (const [page, path] of Object.entries(PAGES)) {
  // LF only: browsers hash inline scripts after turning CRLF into LF, and a Windows checkout is CRLF.
  const src = readFileSync(join(here, page), 'utf8')
    .replace(/\r\n?/g, '\n')
    .replace(/<meta name="claude:[^>]*>\s*/, '')
    .replaceAll('__TURNSTILE_SITEKEY__', sitekey);
  // Head is everything up to the last <link>; the rest is the body.
  const split = src.indexOf('\n', src.lastIndexOf('<link ')) + 1;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${src.slice(0, split)}</head>
<body>
${src.slice(split)}</body>
</html>
`;
  writeFileSync(join(out, page), html);
  policies[path] = cspFor(html, path);
}

// Security headers for Cloudflare Pages. "/*" carries the home page's policy, because Pages
// answers unknown paths with index.html; every other page replaces it with its own.
const rules = Object.entries(policies)
  .filter(([path]) => path !== '/')
  .map(([path, policy]) => `${path}\n  ! Content-Security-Policy\n  Content-Security-Policy: ${policy}\n`);
// A ticket link /r/<code> shows the tickets page (its script reads the code from the address),
// with the tickets page's own policy.
writeFileSync(join(out, '_redirects'), '/r/*  /tickets  200\n');
rules.push(`/r/*\n  ! Content-Security-Policy\n  Content-Security-Policy: ${policies['/tickets']}\n`);
for (const path of ['/popup', '/popup/*']) rules.push(`${path}\n  ! Content-Security-Policy\n  Content-Security-Policy: ${POPUP_POLICY}\n`);
writeFileSync(
  join(out, '_headers'),
  `/*
  Content-Security-Policy: ${policies['/']}
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()

${rules.join('\n')}`,
);
console.log('site built:', out);

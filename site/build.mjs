// Wraps the body-only pages in site/ into full HTML documents in site/public/
// for static hosting such as Cloudflare Pages (privacy.html is served at /privacy). No dependencies.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const PAGES = { 'index.html': '/', 'privacy.html': '/privacy', 'uninstalled.html': '/uninstalled', 'report.html': '/report' };
// What the two form pages need beyond the others: assets/send.js, Turnstile, POST /api/send,
// and (report) blob: thumbnails of picked screenshots.
const TURNSTILE = 'https://challenges.cloudflare.com';
const FORMS = {
  '/uninstalled': { img: '' },
  '/report': { img: ' blob:' },
};

const sha256 = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

// CSP allowing exactly the inline scripts of one page (by hash) instead of any inline script.
function cspFor(html, path) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => sha256(m[1]));
  const form = Object.hasOwn(FORMS, path);
  const img = form ? FORMS[path].img : '';
  const script = [...hashes, ...(form ? ["'self'", TURNSTILE] : [])].join(' ') || "'none'";
  const extra = form ? `frame-src ${TURNSTILE}; connect-src 'self'; ` : '';
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

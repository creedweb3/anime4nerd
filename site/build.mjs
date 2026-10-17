// Wraps the body-only pages in site/ into full HTML documents in site/public/
// for static hosting such as Cloudflare Pages (privacy.html is served at /privacy). No dependencies.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'public');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, 'assets'), join(out, 'assets'), { recursive: true });

for (const page of ['index.html', 'privacy.html']) {
  const src = readFileSync(join(here, page), 'utf8').replace(/<meta name="claude:[^>]*>\s*/, '');
  // Head is everything up to the last <link>; the rest is the body.
  const split = src.indexOf('\n', src.lastIndexOf('<link ')) + 1;
  writeFileSync(
    join(out, page),
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${src.slice(0, split)}</head>
<body>
${src.slice(split)}</body>
</html>
`,
  );
}

// Security headers for Cloudflare Pages. The pages load only Google Fonts and their own inline script.
writeFileSync(
  join(out, '_headers'),
  `/*
  Content-Security-Policy: default-src 'none'; img-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
`,
);
console.log('site built:', out);

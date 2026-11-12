// End-to-end check of the site links in a real Chromium browser with the built extension:
// the popup's bug chip points at /report with version and browser, and removing the extension
// opens /uninstalled with the version. Nothing is submitted.
//
// Needs Playwright (global or local), a Chromium browser and a fresh `npm run build`.
//
//   node test/site-links-e2e.mjs "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" [screenshot dir]

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const [exe, shots] = process.argv.slice(2);
if (!exe) { console.error('usage: node test/site-links-e2e.mjs <path to Chromium browser> [screenshot dir]'); process.exit(2); }

function loadPlaywright() {
  for (const base of [root, path.join(process.env.APPDATA ?? '', 'npm/node_modules/')]) {
    try { return createRequire(path.join(base, 'x.js'))('playwright'); } catch { /* try next */ }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const { chromium } = loadPlaywright();

const version = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8')).version;
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`); };

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'a4k-links-prof-')), {
  headless: false,
  executablePath: exe,
  viewport: { width: 380, height: 640 },
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});
// Answer the site's pages with a stub where Playwright can intercept them. The uninstall tab is
// opened by the browser itself and may bypass this and load the real page; the test never fills
// in or submits any form, so at most that is one ordinary page visit.
await ctx.route('https://anime4nerd.pages.dev/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: 'stub' }));
try {
  const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 10000 });
  const extId = new URL(sw.url()).host;

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  const chip = await popup.evaluate(() => {
    const a = document.querySelector('#report');
    const bar = a.parentElement;
    return { href: a.href, target: a.target, last: bar.lastElementChild === a, label: a.getAttribute('aria-label') };
  });
  const wantReport = `https://anime4nerd.pages.dev/report?v=${version}&b=chrome`;
  check('bug chip opens the report page', chip.href === wantReport, chip.href);
  check('bug chip is last in the top bar, new tab, labelled', chip.last && chip.target === '_blank' && chip.label === 'Report a problem');
  if (shots) await popup.screenshot({ path: path.join(shots, 'popup-bug-chip.png'), clip: { x: 0, y: 0, width: 380, height: 60 } });

  // Removing the extension closes its pages, so watch from an ordinary tab.
  const keep = await ctx.newPage();
  void popup.evaluate(() => chrome.management.uninstallSelf()).catch(() => {});
  let urls = [];
  for (let i = 0; i < 40 && !urls.some((u) => u.includes('/uninstalled')); i++) {
    await keep.waitForTimeout(250);
    urls = ctx.pages().map((p) => p.url());
  }
  const wantBye = `https://anime4nerd.pages.dev/uninstalled?v=${version}`;
  check('removal opens the uninstall page', urls.includes(wantBye), urls.join(' | '));
} finally {
  await ctx.close();
}
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);

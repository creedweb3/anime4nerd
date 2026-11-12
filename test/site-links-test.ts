// Unit tests for the site links the extension opens (src/site-links.ts). Runs in Node, once per
// build target (`npm run test:links` does both):
//   npx esbuild test/site-links-test.ts --bundle --platform=node --format=esm --define:__FIREFOX__=false --outfile=test/site-links-test.js && node test/site-links-test.js
import assert from 'node:assert/strict';
import { BROWSER, reportUrl, uninstallUrl } from '../src/site-links';

assert.equal(BROWSER, __FIREFOX__ ? 'firefox' : 'chrome');

assert.equal(uninstallUrl('1.2.4'), 'https://anime4nerd.pages.dev/uninstalled?v=1.2.4');
assert.equal(reportUrl('1.2.4', 'chrome'), 'https://anime4nerd.pages.dev/report?v=1.2.4&b=chrome');
assert.equal(reportUrl('1.2.4', 'firefox'), 'https://anime4nerd.pages.dev/report?v=1.2.4&b=firefox');
// Only a plain x.y.z version is passed on; anything else is dropped, never escaped into the URL.
assert.equal(uninstallUrl('1.2.4&evil=1'), 'https://anime4nerd.pages.dev/uninstalled');
assert.equal(reportUrl('', 'chrome'), 'https://anime4nerd.pages.dev/report?b=chrome');
assert.equal(uninstallUrl(''), 'https://anime4nerd.pages.dev/uninstalled');
assert.equal(uninstallUrl('1.2.4\n'), 'https://anime4nerd.pages.dev/uninstalled');
assert.equal(uninstallUrl('1.2.4.5'), 'https://anime4nerd.pages.dev/uninstalled');
console.log('site-links: all passed');

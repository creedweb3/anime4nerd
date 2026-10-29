import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
// --firefox builds dist-firefox/ from the same sources, with a Firefox manifest (see firefoxManifest).
const firefox = process.argv.includes('--firefox');
const outdir = firefox ? 'dist-firefox' : 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  target: firefox ? 'firefox128' : 'chrome120',
  // Firefox's chrome.* is a callback-era alias; browser.* is the same API with promises everywhere.
  define: firefox ? { chrome: 'browser', __FIREFOX__: 'true' } : { __FIREFOX__: 'false' },
  loader: { '.glsl': 'text' },
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
  outdir,
};

const configs = [
  // Isolated-world content script. Must be a classic script (iife).
  { ...common, entryPoints: ['src/content.ts'], format: 'iife' },
  // Page-world (MAIN) script that redirects bare-video fullscreen to the player container.
  { ...common, entryPoints: ['src/fullscreen-redirect.ts'], format: 'iife' },
  // Lazy GPU bundle, loaded via import(chrome.runtime.getURL('gpu.js')).
  { ...common, entryPoints: ['src/gpu.ts'], format: 'esm' },
  { ...common, entryPoints: ['src/popup.ts'], format: 'iife' },
  { ...common, entryPoints: ['src/background.ts'], format: 'iife' },
];

// Firefox has no background service worker, ignores use_dynamic_url, and needs a fixed add-on id
// plus the data-collection declaration AMO requires (140+ desktop, 142+ Android understand it).
function firefoxManifest() {
  const m = JSON.parse(readFileSync('manifest.json', 'utf8'));
  delete m.minimum_chrome_version;
  m.background = { scripts: ['background.js'] };
  m.web_accessible_resources = m.web_accessible_resources.map(({ use_dynamic_url, ...r }) => r);
  m.browser_specific_settings = {
    gecko: {
      id: 'anime4nerd@creedweb3.github.io',
      strict_min_version: '140.0',
      data_collection_permissions: { required: ['none'] },
    },
    gecko_android: { strict_min_version: '142.0' },
  };
  writeFileSync(`${outdir}/manifest.json`, `${JSON.stringify(m, null, 2)}\n`);
}

function copyStatic() {
  if (firefox) firefoxManifest();
  else cpSync('manifest.json', `${outdir}/manifest.json`);
  for (const f of ['src/content.css', 'src/popup.html', 'src/popup.css', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'SECURITY.md']) {
    cpSync(f, `${outdir}/${f.split('/').pop()}`);
  }
  cpSync('src/shaders/LICENSE', `${outdir}/LICENSE.anime4k`);
  cpSync('icons', `${outdir}/icons`, { recursive: true });
}

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  copyStatic();
  console.log('watching...');
} else {
  await Promise.all(configs.map((c) => build(c)));
  copyStatic();
}

import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const outdir = 'dist';

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const common = {
  bundle: true,
  target: 'chrome120',
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

function copyStatic() {
  for (const f of ['manifest.json', 'src/content.css', 'src/popup.html', 'src/popup.css', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'PRIVACY.md', 'SECURITY.md']) {
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

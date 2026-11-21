// One "fullscreen screen" for fullscreen-color-demo.html: the real FullscreenMenu (src/fullscreen-menu.ts)
// over a picture drawn by the real renderer (src/gpu.ts: Anime4K + the color shader), with a fake
// chrome.* storage. ?v=A..E adds one design variant for color controls on top of the real menu
// (fullscreen-color-variants.ts). Design preview only: nothing here talks to the extension.
//
// Build: npx esbuild test/fullscreen-color-frame.ts --bundle --format=esm --loader:.glsl=text
//        --define:__FIREFOX__=false --outfile=test/fullscreen-color-frame.js

import { FullscreenMenu } from '../src/fullscreen-menu';
import { EMPTY_META } from '../src/media-meta';
import {
  Settings, VideoInfo, chainKey, loadSettings, loadSources, onSettingsChanged, onSourcesChanged, requestedScale,
} from '../src/settings';
import {
  BUILT_IN_PROFILES, ColorState, appliedColor, loadColor, normalizeColor, normalizeValues, onColorChanged, saveColor,
} from '../src/color';
import { createAnime4kRenderer, type Anime4kRenderer } from '../src/gpu';
import { mountVariant, type MenuParts } from './fullscreen-color-variants';

// --- fake chrome.* -------------------------------------------------------------------------
const KEY = 'player.example::blob:';
type Listener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;
const listeners: Listener[] = [];
const start = normalizeColor(undefined);
const slice = BUILT_IN_PROFILES.find((p) => p.id === 'p-slice')!;
// Two profiles the user saved in the popup, after the included ones (full grades, as all profiles are).
const yours = [
  { id: 'u-night', name: 'night', v: normalizeValues({ brightness: 0.96, contrast: 0.94, saturation: 0.9, gamma: 1.08, vibrance: 1.1, temperature: 18, tint: 2, deband: 30, grain: 0.02 }) },
  { id: 'u-crisp', name: 'crisp', v: normalizeValues({ brightness: 1.01, contrast: 1.08, saturation: 1.1, gamma: 0.97, vibrance: 1.2, temperature: -4, deband: 35, grain: 0 }) },
];
const store: Record<string, Record<string, unknown>> = {
  sync: { anime4k: { mode: 'auto', preset: 'A', darkenLines: false, thinLines: false, upscale: 'auto' } },
  local: { 'anime4k-sources': { [KEY]: true }, 'anime4k-color': { ...start, profiles: [...start.profiles, ...yours], profile: slice.id, values: { ...slice.v } } },
};
const area = (name: string) => ({
  async get(k: string) { return k in store[name] ? { [k]: structuredClone(store[name][k]) } : {}; },
  async set(obj: Record<string, unknown>) {
    const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
    for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: store[name][k], newValue: structuredClone(v) }; store[name][k] = structuredClone(v); }
    for (const l of listeners) l(changes, name);
  },
});
(window as unknown as { chrome: unknown }).chrome = {
  storage: { sync: area('sync'), local: area('local'), onChanged: { addListener: (f: Listener) => listeners.push(f) } },
  runtime: { id: 'demo', getURL: (p: string) => p, onMessage: { addListener() {} }, sendMessage: async () => undefined },
};

// --- state the picture and the menu read ------------------------------------------------------
let settings: Settings;
let enabled = true;
let color: ColorState;

// --- the picture: a slow pan over a still, drawn by the real renderer --------------------------
const SRC_W = 480;
const SRC_H = 270;
const FPS = 24;
const stage = document.getElementById('stage') as HTMLElement;
const src = document.createElement('canvas');
src.width = SRC_W; src.height = SRC_H;
const sg = src.getContext('2d')!;
let still: ImageBitmap;
let renderer: Anime4kRenderer | null = null;
let canvas: HTMLCanvasElement | null = null;
let builtKey = '';
let building = 0;
let renderError = '';

/** "auto" picks the smallest of 2x, 4x, 8x that fills the screen height, as the content script does. */
function scale(): number {
  const want = requestedScale(settings.upscale);
  if (want) return want;
  const need = (innerHeight * devicePixelRatio) / SRC_H;
  return need <= 2 ? 2 : need <= 4 ? 4 : 8;
}
/** Colors drawn now: on an upscaled video, or on any video with "also use colors when not upscaled". */
const colorsShown = () => (enabled || color.always ? appliedColor(color) : null);

async function rebuild() {
  const key = enabled ? `up|${chainKey(settings)}|${scale()}` : 'plain';
  if (key === builtKey) return;
  builtKey = key;
  const gen = ++building;
  const next = document.createElement('canvas');
  next.className = 'pic';
  const first = await createImageBitmap(src);
  try {
    const r = await createAnime4kRenderer(first, next, settings, (m) => { renderError = m; }, enabled ? scale() : 1, { colorOnly: !enabled, deband: true });
    if (gen !== building) { r.destroy(); return; }
    renderer?.destroy();
    canvas?.remove();
    renderer = r;
    canvas = next;
    renderer.setColor(colorsShown());
    stage.prepend(next);
    renderError = '';
  } catch (e) {
    renderError = (e as Error).message;
  } finally {
    first.close();
  }
}

let t0 = performance.now();
let last = 0;
let busyFrame = false;
let drawn: number[] = []; // times of the last second's frames: the fps the menu shows
async function tick(now: number) {
  requestAnimationFrame(tick);
  if (now - last < 1000 / FPS || busyFrame || !renderer) return;
  last = now;
  busyFrame = true;
  // Ken Burns: a slow zoom and drift, so the frame changes like playing video.
  const s = (now - t0) / 1000;
  const z = 1.08 + 0.05 * Math.sin(s / 7);
  const w = still.width / z, h = still.height / z;
  const x = (still.width - w) * (0.5 + 0.45 * Math.sin(s / 11)), y = (still.height - h) * (0.5 + 0.4 * Math.cos(s / 9));
  sg.drawImage(still, x, y, w, h, 0, 0, SRC_W, SRC_H);
  const bmp = await createImageBitmap(src);
  drawn = [...drawn.filter((d) => now - d < 1000), now];
  try { renderer?.render(bmp); } catch (e) { renderError = (e as Error).message; builtKey = ''; void rebuild(); }
  bmp.close();
  busyFrame = false;
}

// --- the video the menu reports ---------------------------------------------------------------
// ?long=1: the longest texts the card can get (title, episode, site) with an "8x capped" note,
// to check every line stays on one line inside the panel.
const LONG = new URLSearchParams(location.search).get('long') === '1';
const LONG_HOST = 'a-very-long-streaming-site-name.example.co.uk';
const LONG_PAGE = {
  meta: { ...EMPTY_META, title: 'An Extremely Long Series Title That Never Seems To End At All', season: 2, episode: 1158,
    episodeName: 'The Longest Episode Name Anyone Has Ever Written For A Show Like This', source: 'demo' },
  host: LONG_HOST,
};
function info(): VideoInfo {
  const st = renderer?.stats();
  if (LONG && st) {
    return {
      id: 'demo#1', key: KEY, frameHost: LONG_HOST, mediaHost: 'blob:', width: 3840, height: 2160, playing: true, sourceFps: FPS,
      enabled: true, status: 'Active', message: '', loadCapped: true,
      stats: { ...st, fps: drawn.length, sourceFps: FPS, outputWidth: 15360, outputHeight: 8640 },
      media: null,
    };
  }
  return {
    id: 'demo#1', key: KEY, frameHost: 'player.example', mediaHost: 'blob:',
    width: SRC_W, height: SRC_H, playing: true, sourceFps: FPS, enabled, colorOnly: !enabled && colorsShown() !== null,
    status: renderError ? 'Unavailable' : enabled ? 'Active' : 'Off', message: renderError,
    stats: enabled && st ? { ...st, fps: drawn.length, sourceFps: FPS } : null,
    media: null,
  };
}

// --- start ------------------------------------------------------------------------------------
async function main() {
  settings = await loadSettings();
  enabled = !!(await loadSources())[KEY];
  color = await loadColor();
  // fetch + createImageBitmap: img.decode() can stall in a background frame.
  // The user's anime frame (local test file, not in git), cropped to the picture without its black side bars.
  still = await createImageBitmap(await (await fetch('./demo-frame.webp')).blob(), 241, 0, 1438, 857);
  sg.drawImage(still, 0, 0, SRC_W, SRC_H);
  await rebuild();

  // The real menu. Its shadow root is closed; keep a handle on it so the variant can add to it.
  let shadow: ShadowRoot | null = null;
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) { shadow = attach.call(this, init); return shadow; };
  if (LONG) settings = { ...settings, upscale: '8x' };
  const menu = new FullscreenMenu(info, () => settings, () => color, async () => (LONG ? LONG_PAGE : null));
  Element.prototype.attachShadow = attach;
  menu.mount(document.body);
  const m = menu as unknown as Record<string, HTMLElement>;
  const parts: MenuParts = { menu, shadow: shadow!, source: src, host: m.host, wrap: m.wrap, toggle: m.toggle, panel: m.panel, status: m.status };

  onSettingsChanged((s) => { settings = s; void rebuild(); menu.refresh(); });
  onSourcesChanged((s) => { enabled = !!s[KEY]; void rebuild(); menu.refresh(); });
  onColorChanged((c) => { color = c; renderer?.setColor(colorsShown()); menu.refresh(); });
  addEventListener('resize', () => { void rebuild(); });

  const variant = new URLSearchParams(location.search).get('v') ?? 'A';
  // ?v=real: the menu as built in src/ (its own color tab), with no design variant added.
  if (variant !== 'real') await mountVariant(variant, parts);
  // The demo page: ?open=color opens the menu on the color tab; messages switch the design in
  // place, or change the values the way the popup would (so "edited in popup" can be seen).
  const tab = (window as unknown as { colorTab?: { setDesign(c: string, t?: string): void; openColor(): void } }).colorTab;
  const q = new URLSearchParams(location.search);
  if (q.get('open') === 'color') tab?.openColor();
  if (q.get('open') === 'upscale') parts.toggle.click(); // the menu open on its first tab (screenshots)
  const popupEdit = () => saveColor((c) => ({ values: { ...c.values, temperature: Math.min(100, c.values.temperature + 12), saturation: Math.min(3, c.values.saturation + 0.1) } }));
  if (q.get('edit') === '1') await popupEdit(); // as if changed in the popup (screenshots)
  // As if custom values were set in the popup: custom becomes the selected profile.
  const popupCustom = () => saveColor((c) => { const v = { ...c.values, temperature: Math.min(100, c.values.temperature + 20) }; return { profile: 'custom', custom: v, values: v }; });
  if (q.get('custom') === '1') await popupCustom();
  addEventListener('message', (e) => {
    if (e.source !== parent) return;
    if (e.data?.type === 'design' && typeof e.data.c === 'string') { tab?.setDesign(e.data.c, typeof e.data.t === 'string' ? e.data.t : undefined); tab?.openColor(); }
    if (e.data?.type === 'popup-edit') void popupEdit();
    if (e.data?.type === 'popup-custom') void popupCustom();
  });

  // The player's own controls fade with the mouse, as the menu button does.
  const chrome = document.getElementById('player-ui')!;
  let idle = 0;
  const wake = () => {
    menu.wake();
    chrome.classList.remove('idle');
    clearTimeout(idle);
    idle = window.setTimeout(() => chrome.classList.add('idle'), 2500);
  };
  addEventListener('mousemove', wake);
  addEventListener('pointerdown', wake);
  wake();
  t0 = performance.now();
  requestAnimationFrame(tick);
  // For checks from outside: what the picture shows now.
  Object.assign(window, { demo: { colorsShown, state: () => ({ color, settings, enabled, renderError, builtKey }), parts } });
}
void main();

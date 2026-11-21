// The site's copy of the real popup (popup.html, popup.css and popup.js from the extension's
// dist/, copied in by site/build.mjs) runs on this fake chrome.*, which answers like a page playing
// one video. Modelled on test/popup-live.html. Fictional names only. Nothing is stored or sent:
// every setting lives in this frame's memory and resets on reload.
// Query: pages=N plays a manga chapter of N pages instead of the video; new=1 opens it right after
// an update (the "new v1.3.0" chip); color=1 starts with a ready-made look and one saved profile.
// Hash: tab=color|upscale opens that folder tab.
(() => {
  const COLOR = 'anime4k-color';
  const q = new URLSearchParams(location.search);
  const PAGES = Number(q.get('pages')) || 0;
  const store = {
    sync: { anime4k: { mode: 'auto', preset: 'A', darkenLines: false, thinLines: true, upscale: 'auto' } },
    local: { 'anime4k-sources': { 'stream.example::blob:': true } },
  };
  if (q.get('new') === '1') store.local['anime4k-whats-new'] = '1.3.0';
  if (PAGES) store.local['a4k-manga'] = { 'reader.example': true };
  if (q.get('color') === '1') {
    // The five included looks (src/color.ts BUILT_IN_PROFILES) plus one of the visitor's own.
    const looks = [
      { id: 'p-slice', name: 'slice of life', v: { contrast: 1.03, saturation: 1.02, gamma: 1.02, vibrance: 1.29, temperature: 4, deband: 35, grain: 0.01 } },
      { id: 'p-sunlit', name: 'sunlit', v: { brightness: 0.97, contrast: 0.92, saturation: 1.03, gamma: 1.04, vibrance: 1.25, temperature: 14, deband: 35, grain: 0.01 } },
      { id: 'p-shonen', name: 'shonen', v: { brightness: 0.99, contrast: 1.03, saturation: 1.23, gamma: 1.14, vibrance: 1.57, deband: 35, grain: 0.01 } },
      { id: 'p-moody', name: 'moody', v: { brightness: 0.98, contrast: 0.92, saturation: 0.74, gamma: 1.1, vibrance: 1.07, temperature: -12, tint: 11, deband: 20, grain: 0.04 } },
      { id: 'p-vintage', name: 'vintage', v: { saturation: 1.45, gamma: 1.22, temperature: -5, tint: 5, deband: 25 } },
      { id: 'm0', name: 'late night', v: { brightness: 0.96, contrast: 1.06, saturation: 0.95, gamma: 1.08, vibrance: 1.1, temperature: -8, tint: 2, deband: 30, grain: 0.02 } },
    ];
    const full = (v) => ({ brightness: 1, contrast: 1, saturation: 1, gamma: 1, hue: 0, vibrance: 1, temperature: 0, tint: 0, deband: 0, grain: 0, ...v });
    store.local[COLOR] = { on: true, always: false, profile: 'p-sunlit', values: full(looks[1].v), profiles: looks.map((p) => ({ ...p, v: full(p.v) })) };
  }

  const listeners = [];
  const area = (name) => ({
    async get(keys) {
      const all = store[name];
      if (keys == null) return structuredClone(all);
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      return Object.fromEntries(list.filter((k) => k in all).map((k) => [k, structuredClone(all[k])]));
    },
    async set(obj) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: store[name][k], newValue: structuredClone(v) };
        store[name][k] = structuredClone(v);
      }
      for (const fn of listeners) fn(changes, name);
    },
    async remove(keys) { for (const k of [].concat(keys)) delete store[name][k]; },
  });

  // One 1080p video in a normal-size player. GPU time per frame is the site's measured RTX 2060
  // cost of the preset; 4x about doubles it, and 8x is held at 4x (8K output, the extension's cap).
  const COST = { A: 15.1, B: 15.0, C: 13.2, AA: 23.7, BB: 24.0, CA: 15.8 };
  const samples = [];
  let tick = 0;
  function video() {
    const enabled = !!store.local['anime4k-sources']?.['stream.example::blob:'];
    const s = store.sync.anime4k;
    const scale = s.upscale === '4x' || s.upscale === '8x' ? 4 : 2;
    const ms = ((COST[s.preset] ?? 15.1) + (s.darkenLines ? 0.4 : 0) - (s.thinLines ? 0 : 0.9)) * (scale / 2);
    tick += 1;
    for (let i = 0; i < 6; i++) samples.push(ms * (0.92 + Math.sin((tick * 6 + i) / 7) * 0.06 + Math.random() * 0.1));
    while (samples.length > 120) samples.shift();
    return {
      id: 'stream.example#1', key: 'stream.example::blob:', frameHost: 'stream.example', mediaHost: 'blob:',
      width: 1920, height: 1080, playing: true, sourceFps: 23.976, enabled,
      status: enabled ? 'Active' : 'Off', message: '',
      stats: enabled ? { gpuMs: samples[samples.length - 1], samples: samples.slice(), cpuMs: 0.4, fps: 23.976, passes: 9, textureBytes: (scale === 4 ? 384 : 96) * 1048576, outputWidth: 1920 * scale, outputHeight: 1080 * scale, timerSupported: true, sourceFps: 23.976 } : null,
      media: null,
    };
  }
  // A manga chapter of PAGES pages: 40 upscaled, two in progress, the rest queued.
  function manga() {
    const loaded = Math.min(PAGES, 120);
    const marks = Array.from({ length: loaded }, (_, i) => (i < 40 ? 'done' : i < 42 ? 'now' : 'todo'));
    return {
      on: true, kind: 'images', meta: { series: 'Moonlit Ronin', volume: null, chapter: '12', chapterTitle: null },
      marks, first: 0, loading: 0, total: PAGES, reasons: ['demo'], current: 40, done: 40, failed: 0, lastError: null,
      grey: true, size: { w: 1100, h: 1600 }, perPageMs: 180, pageMs: 420, imageHost: 'reader.example', protocol: 5,
      host: 'reader.example', renders: 40,
    };
  }
  const META = { title: 'Starlight Academy', season: 1, episode: 3, episodeName: 'The Night Before the Festival', subtitle: null, source: 'demo' };
  const url = PAGES ? 'https://reader.example/moonlit-ronin/12' : 'https://stream.example/watch/starlight-academy-3';

  window.chrome = {
    runtime: {
      getManifest: () => ({ version: '1.3.0' }),
      getURL: (p) => p,
      onMessage: { addListener() {} },
      sendMessage: async () => undefined,
    },
    storage: { sync: area('sync'), local: area('local'), onChanged: { addListener: (fn) => listeners.push(fn) } },
    tabs: {
      query: async () => [{ id: 1, url, active: true }],
      sendMessage: async (_tab, msg) => {
        if (msg?.type === 'a4k-list') return PAGES ? [] : [video()];
        if (msg?.type === 'a4k-manga-status') return PAGES ? manga() : null;
        if (msg?.type === 'a4k-page-meta') return PAGES ? null : META;
        return null;
      },
    },
    webNavigation: { getAllFrames: async () => [{ frameId: 0, url }] },
    scripting: { insertCSS: async () => {}, executeScript: async () => [] },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {} },
  };

  // The page around this frame: open a folder tab on request, and report this popup's size and
  // its color values (for the preview picture beside it). Same origin only.
  const post = (msg) => { if (parent !== window) parent.postMessage(msg, location.origin); };
  const goTo = (t) => document.querySelector(`.c-tab[data-t="${t}"]`)?.click();
  addEventListener('message', (e) => { if (e.origin === location.origin && e.data?.type === 'tab') goTo(e.data.tab); });
  addEventListener('DOMContentLoaded', () => {
    const tab = new URLSearchParams(location.hash.slice(1)).get('tab');
    // popup.js wires the tabs up after its first async load; give it a moment.
    if (tab) setTimeout(() => goTo(tab), 250);
    let last = '';
    const report = () => {
      const b = document.body;
      const size = `${b.offsetWidth}x${b.offsetHeight}`;
      if (size !== last) { last = size; post({ type: 'size', w: b.offsetWidth, h: b.offsetHeight }); }
    };
    new ResizeObserver(report).observe(document.body);
    report();
    const color = async () => {
      const s = store.local[COLOR];
      post({ type: 'color', on: !!s && s.on !== false, v: s?.values ?? {} });
    };
    listeners.push((c, name) => { if (name === 'local' && c[COLOR]) void color(); });
    void color();
  });
})();

// On-video menu for fullscreen players, where the toolbar popup can't open.
// A small ☰ button in the top-right corner opens a compact panel (on/off, preset,
// upscale); the button fades out when the mouse is idle, like player controls.

import {
  PRESETS, Settings, Upscale, VideoInfo, capNote, dropsFrames, saveSettings, setSource,
} from './settings';

const IDLE_MS = 2500;
const POLL_MS = 500; // perf refresh while the panel is open
const BARS = 48; // frame-time bars, as in the popup
const UPSCALES: [Upscale, string][] = [['auto', 'auto'], ['2x', '2×'], ['4x', '4×'], ['8x', '8×'], ['16x', '16×'], ['32x', '32×']];
// Inline !important beats page stylesheets, so a page can't quietly hide, move or blow up the menu.
const PINNED_STYLE: [string, string][] = [
  ['position', 'fixed'], ['top', '16px'], ['right', '16px'], ['left', 'auto'], ['bottom', 'auto'],
  ['z-index', '2147483647'], ['opacity', '1'], ['visibility', 'visible'], ['transform', 'none'],
  ['filter', 'none'], ['clip-path', 'none'], ['zoom', '1'], ['pointer-events', 'auto'],
];
// Players toggle play / fullscreen on these; the menu must swallow them.
const SWALLOW = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'keydown'];

const CSS = `
:host { all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483647;
  font: 12px/1.5 "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace; color: #e4e4e4; }
.wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; transition: opacity .2s; }
.wrap.idle:not(.open) { opacity: 0; pointer-events: none; }
button { font: inherit; color: inherit; cursor: pointer; }
.toggle { width: 34px; height: 34px; border: 1px solid #3a3a3a; background: rgba(11,11,11,.85); font-size: 16px; line-height: 1; }
.toggle:hover, .toggle[aria-expanded="true"] { border-color: #e4e4e4; }
.panel { width: 260px; padding: 10px; border: 1px solid #3a3a3a; background: rgba(11,11,11,.94); display: grid; gap: 8px; }
.panel[hidden] { display: none; }
.head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.meta { color: #8d8d8d; font-size: 11px; }
.perf { font-size: 11px; color: #8d8d8d; }
.perf.ok { color: #9fd3a8; } .perf.warn { color: #e3c58a; } .perf.bad { color: #e39a9a; }
.graph { display: block; width: 100%; height: 24px; }
.label { color: #585858; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
.row { display: flex; flex-wrap: wrap; gap: 4px; }
.opt { border: 1px solid #3a3a3a; background: transparent; color: #8d8d8d; padding: 3px 8px; font-size: 11px; }
.opt:hover { color: #e4e4e4; }
.opt[aria-checked="true"] { background: #fff; border-color: #fff; color: #000; }
.power[aria-checked="true"] { background: #9fd3a8; border-color: #9fd3a8; }
.effect::before { content: "+ "; }
.effect[aria-checked="true"]::before { content: "✓ "; }
`;

export class FullscreenMenu {
  private readonly host = document.createElement('div');

  private readonly wrap = document.createElement('div');

  private readonly toggle = document.createElement('button');

  private readonly panel = document.createElement('div');

  private readonly meta = document.createElement('div');

  private readonly power = document.createElement('button');

  private readonly perf = document.createElement('div');

  private readonly graph = document.createElement('canvas');

  private idleTimer: number | null = null;

  private pollTimer: number | null = null;

  constructor(private readonly target: () => VideoInfo | null, private readonly settings: () => Settings) {
    for (const [k, v] of PINNED_STYLE) this.host.style.setProperty(k, v, 'important');
    const shadow = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.wrap.className = 'wrap';
    this.toggle.className = 'toggle';
    this.toggle.type = 'button';
    this.toggle.textContent = '☰';
    this.toggle.title = 'Anime4Nerd';
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.addEventListener('click', () => this.setOpen(!this.wrap.classList.contains('open')));
    this.panel.className = 'panel';
    this.panel.hidden = true;

    const head = document.createElement('div');
    head.className = 'head';
    const title = document.createElement('b');
    title.textContent = 'anime4nerd';
    this.power.className = 'opt power';
    this.power.type = 'button';
    this.power.setAttribute('role', 'switch');
    this.power.addEventListener('click', (e) => {
      if (!this.genuine(e)) return;
      const t = this.target();
      if (t) setSource(t.key, !t.enabled).catch(() => {});
    });
    head.append(title, this.power);
    this.meta.className = 'meta';
    this.perf.className = 'perf';
    this.graph.className = 'graph';
    this.graph.title = 'GPU time per frame, last 2 s · dashed = frame limit · red = late';

    this.panel.append(
      head, this.meta, this.perf, this.graph,
      this.group('preset', PRESETS.map((p) => [p.value, p.label]), (v) => ({ preset: v as Settings['preset'] }), 'preset'),
      this.effects(),
      this.group('upscale', UPSCALES, (v) => ({ upscale: v as Upscale }), 'upscale'),
    );
    this.wrap.append(this.toggle, this.panel);
    shadow.append(style, this.wrap);
    for (const ev of SWALLOW) this.host.addEventListener(ev, (e) => e.stopPropagation());
  }

  private group(name: string, opts: [string, string][], patch: (v: string) => Partial<Settings>, field: 'preset' | 'upscale'): HTMLElement {
    const box = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = name;
    const row = document.createElement('div');
    row.className = 'row';
    row.setAttribute('role', 'radiogroup');
    for (const [value, text] of opts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.setAttribute('role', 'radio');
      b.dataset[field] = value;
      b.textContent = text;
      b.addEventListener('click', (e) => { if (this.genuine(e)) saveSettings(patch(value)).catch(() => {}); });
      row.append(b);
    }
    box.append(label, row);
    return box;
  }

  /**
   * A real user click on a menu the page hasn't tampered with. Guards against clickjacking:
   * a page restyling the menu to be invisible or huge so the user's clicks change settings.
   */
  private genuine(e: Event): boolean {
    if (!e.isTrusted) return false;
    const r = this.host.getBoundingClientRect();
    if (Math.abs(r.width - this.host.offsetWidth) > 1 || Math.abs(r.height - this.host.offsetHeight) > 1) return false; // scaled
    if (r.width > 320 || r.height > 480) return false; // bigger than the menu ever is
    if (getComputedStyle(this.host).filter !== 'none') return false;
    for (let n: Element | null = this.host; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (Number(cs.opacity) < 0.5 || cs.visibility !== 'visible') return false;
    }
    return true;
  }

  /** Darken / thin lines on-off switches, as in the popup. */
  private effects(): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';
    for (const [field, text] of [['darkenLines', 'darken lines'], ['thinLines', 'thin lines']] as const) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt effect';
      b.setAttribute('role', 'switch');
      b.dataset.field = field;
      b.textContent = text;
      b.addEventListener('click', (e) => { if (this.genuine(e)) saveSettings((cur) => ({ [field]: !cur[field] })).catch(() => {}); });
      row.append(b);
    }
    return row;
  }

  /** Show the menu inside `container` (the fullscreen element or its shadow root), or remove it when null. */
  mount(container: Element | ShadowRoot | null) {
    if (!container) { this.host.remove(); this.setOpen(false); return; }
    if (this.host.parentNode !== container) { container.append(this.host); this.wake(); }
    this.refresh();
  }

  /** Mouse moved: show the button again and restart the idle fade. */
  wake() {
    if (!this.host.isConnected) return;
    this.wrap.classList.remove('idle');
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => { this.idleTimer = null; this.wrap.classList.add('idle'); }, IDLE_MS);
  }

  refresh() {
    if (!this.host.isConnected) return;
    const t = this.target();
    const s = this.settings();
    this.power.textContent = t?.enabled ? 'on' : 'off';
    this.power.setAttribute('aria-checked', String(!!t?.enabled));
    const st = t?.stats;
    const scale = st && t ? Math.round(st.outputHeight / t.height) : 0;
    this.meta.textContent = !t ? '' : st
      ? `${t.height}p → ${st.outputWidth}×${st.outputHeight} (${scale}×)${capNote(s.upscale, scale)}`
      : `${t.height}p · ${t.status.toLowerCase()}`;
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('[data-preset]')) b.setAttribute('aria-checked', String(b.dataset.preset === s.preset));
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('[data-upscale]')) b.setAttribute('aria-checked', String(b.dataset.upscale === s.upscale));
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('[data-field]')) {
      b.setAttribute('aria-checked', String(s[b.dataset.field as 'darkenLines' | 'thinLines']));
    }
    if (!this.panel.hidden) this.paintPerf(t);
  }

  /** One-line verdict plus frame-time bars, using the same rules as the popup's performance panel. */
  private paintPerf(t: VideoInfo | null) {
    const s = t?.stats ?? null;
    const live = !!t && !!s && t.playing && s.fps > 0;
    const fps = t?.sourceFps ?? s?.sourceFps ?? null;
    const budget = fps ? 1000 / fps : null;
    const gpu = s?.gpuMs ?? null;
    const load = live && budget !== null && gpu !== null ? gpu / budget : null;
    let cls = 'dim';
    let verdict = s ? 'paused' : (t?.status.toLowerCase() ?? '');
    if (live) {
      const drops = load === null && !s!.timerSupported ? dropsFrames(s!.fps, fps) : null;
      if (drops !== null) { cls = drops ? 'bad' : 'ok'; verdict = drops ? 'dropping frames' : 'keeping up'; } else if (load === null) { cls = 'ok'; verdict = 'running'; } else if (load > 1) { cls = 'bad'; verdict = 'dropping frames'; } else if (load > 0.8) { cls = 'warn'; verdict = 'near limit'; } else { cls = 'ok'; verdict = 'keeping up'; }
    }
    this.perf.className = `perf ${cls}`;
    const noTimer = !!s && !s.timerSupported; // e.g. Firefox: no GPU timer queries, so no bars
    this.perf.textContent = `gpu ${gpu === null ? (noTimer ? 'n/a' : '—') : `${gpu.toFixed(1)} ms`}${budget === null ? '' : ` / ${budget.toFixed(0)} ms`} · ${verdict}`;
    this.graph.style.display = noTimer ? 'none' : '';
    this.drawBars(s?.samples ?? [], budget, live);
  }

  private drawBars(samples: number[], budget: number | null, live: boolean) {
    const c = this.graph;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    const shown = samples.slice(-BARS);
    const top = Math.max(budget ?? 0, ...shown, 1);
    const bw = w / BARS;
    g.globalAlpha = live ? 1 : 0.45;
    shown.forEach((ms, i) => {
      const bh = Math.max(1, (ms / top) * h);
      g.fillStyle = budget !== null && ms > budget ? '#e39a9a' : '#d0d0d0';
      g.fillRect((BARS - shown.length + i) * bw, h - bh, bw - 1, bh);
    });
    if (budget === null) return;
    g.globalAlpha = 1;
    g.strokeStyle = '#585858';
    g.setLineDash([3, 3]);
    const y = Math.round(h - (budget / top) * h) + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }

  private setOpen(open: boolean) {
    this.panel.hidden = !open;
    this.toggle.textContent = open ? '✕' : '☰';
    this.toggle.setAttribute('aria-expanded', String(open));
    this.wrap.classList.toggle('open', open);
    if (this.pollTimer !== null) { window.clearInterval(this.pollTimer); this.pollTimer = null; }
    if (open) {
      this.refresh();
      this.pollTimer = window.setInterval(() => this.refresh(), POLL_MS);
    }
  }
}

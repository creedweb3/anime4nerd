// On-video menu for fullscreen players, where the toolbar popup can't open.
// A small ☰ button in the top-right corner opens a compact panel: the status box (on/off,
// performance), then folder tabs as in the popup: "upscale" (preset, effects, upscale) and
// "color" (profiles, see fullscreen-color.ts). The button fades out when the mouse is idle, like
// player controls. If a control of the player already sits in that corner, the button moves down
// the edge to a free spot.

import type { ColorState } from './color';
import { COLOR_TAB_CSS, FullscreenColorTab, colorsShown } from './fullscreen-color';
import { EMPTY_META, type PageLabel, videoLabel } from './media-meta';
import {
  PRESETS, Settings, Upscale, VideoInfo, capNote, frameVerdict, liftLoadCap, saveSettings, VERDICT_TEXT, setSource,
} from './settings';

const IDLE_MS = 2500;
const POLL_MS = 500; // perf refresh while the panel is open
const BARS = 48; // frame-time bars, as in the popup
const UPSCALES: [Upscale, string][] = [['auto', 'auto'], ['2x', '2×'], ['4x', '4×'], ['8x', '8×']];
// Inline !important beats page stylesheets, so a page can't quietly hide, move or blow up the menu.
const PINNED_STYLE: [string, string][] = [
  ['position', 'fixed'], ['top', '16px'], ['right', '16px'], ['left', 'auto'], ['bottom', 'auto'],
  ['z-index', '2147483647'], ['opacity', '1'], ['visibility', 'visible'], ['transform', 'none'],
  ['filter', 'none'], ['clip-path', 'none'], ['zoom', '1'], ['pointer-events', 'auto'],
];
// Players toggle play / fullscreen on these; the menu must swallow them.
const SWALLOW = ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'wheel', 'keydown'];

// Where the button may sit: distance from the top of the screen, down the right edge.
const SLOT_TOPS = [16, 64, 112, 160, 208, 256];
const EDGE_PX = 16; // gap to the right edge
const BUTTON_PX = 34; // side of the ☰ button (see .toggle)
const MENU_MAX_PX = 480; // tallest the open menu gets (see genuine())
const MENU_MAX_W_PX = 320; // widest it is: a 296px panel + 2 × 10px padding + 2 × 1px border = 318 (see genuine())
const PLACE_EVERY_MS = 400; // how often the spot is re-checked while the mouse moves
// What counts as a player control: real controls, and anything that shows a hand cursor.
const CONTROL = 'button, a[href], input, select, textarea, summary, [role="button"], [role="menuitem"], [role="tab"], [onclick]';
// A clickable element this large is a click-to-play surface, not a control to keep clear of.
const SURFACE_PX = 200;

/** True if a control of the page lies under the size x size square at (x, y), ignoring `self`. */
function coversControl(root: Document | ShadowRoot, self: Element, x: number, y: number, size: number): boolean {
  const inset = 3;
  const points = [[inset, inset], [size - inset, inset], [inset, size - inset], [size - inset, size - inset], [size / 2, size / 2]];
  for (const [dx, dy] of points) {
    for (const el of root.elementsFromPoint(x + dx, y + dy)) {
      if (el === self || el instanceof HTMLVideoElement || el.classList.contains('a4k-canvas')) continue;
      const control = el.closest(CONTROL) ?? (getComputedStyle(el).cursor === 'pointer' ? el : null);
      if (!control) continue;
      const r = control.getBoundingClientRect();
      if (r.width > 0 && r.width <= SURFACE_PX && r.height <= SURFACE_PX) return true;
    }
  }
  return false;
}

/** Sets `text` into `el`, with the "N× capped" note (`note`) inside it in the warn colour. */
function withNote(el: HTMLElement, text: string, note: string) {
  const at = note ? text.lastIndexOf(note) : -1;
  if (at < 0) { el.textContent = text; return; }
  const span = document.createElement('span');
  span.className = 'capn';
  span.textContent = note;
  el.replaceChildren(text.slice(0, at), span, text.slice(at + note.length));
}

const CSS = `
:host { all: initial; color-scheme: dark; position: fixed; top: 16px; right: 16px; z-index: 2147483647;
  font: 12px/1.5 "JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace; color: #e4e4e4; }
.wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; transition: opacity .2s; user-select: none; -webkit-user-select: none; }
.wrap.idle:not(.open) { opacity: 0; pointer-events: none; }
button { font: inherit; color: inherit; cursor: pointer; }
/* Own focus ring and pressed look, as in the popup: the browser defaults must not show over a video. */
button:focus-visible { outline: 1px solid #fff; outline-offset: 1px; }
button:active { filter: brightness(1.25); }
.toggle { width: 34px; height: 34px; border: 1px solid #3a3a3a; background: rgba(11,11,11,.85); font-size: 16px; line-height: 1; }
.toggle:hover, .toggle[aria-expanded="true"] { border-color: #e4e4e4; }
.panel { width: 296px; padding: 10px; border: 1px solid #3a3a3a; background: rgba(11,11,11,.94); display: grid; gap: 8px; box-shadow: 0 24px 40px -18px #000;
  overflow: hidden auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: #3a3a3a transparent; }
.panel[hidden] { display: none; }
/* Status box: tinted like the popup's video card, green while upscaling and red while off. */
.status { display: grid; gap: 5px; padding: 10px 12px; border: 1px solid rgba(227,154,154,.45);
  background: linear-gradient(135deg, rgba(227,154,154,.14), rgba(227,154,154,.02) 60%, transparent) #0b0b0b; }
.status.on { border-color: rgba(159,211,168,.6);
  background: linear-gradient(135deg, rgba(159,211,168,.16), rgba(159,211,168,.02) 60%, transparent) #0b0b0b; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; min-width: 0; }
/* The card rows, as the popup's video card: one line each, cut with an ellipsis. */
.title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; line-height: 1.3; }
.episode { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 19px; opacity: .85; }
.tag { flex: none; max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid rgba(227,154,154,.4); padding: 1px 6px; font-size: 10px; color: rgba(227,154,154,.85); }
.status.on .tag { border-color: rgba(159,211,168,.5); color: #9fd3a8; }
.tag[hidden] { display: none; }
.epname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status.quality .epname { color: #8d8d8d; }
.meta { display: flex; min-width: 0; white-space: nowrap; color: #585858; font-size: 11px; }
.meta .site { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.meta .res { flex: none; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
.meta .res.why { flex: 1 1 auto; color: #e39a9a; opacity: .85; }
.capn { color: #e3c58a; }
.perf { font-size: 11px; color: #8d8d8d; }
.perf.ok { color: #9fd3a8; } .perf.warn { color: #e3c58a; } .perf.bad { color: #e39a9a; }
.graph { display: block; width: 100%; height: 20px; }
.switch { flex: none; width: 36px; height: 20px; padding: 0; position: relative; border: 1px solid rgba(227,154,154,.45); background: #0b0b0b; }
.switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; background: rgba(227,154,154,.75); transition: left .08s, background .08s; }
.switch[aria-checked="true"] { border-color: rgba(159,211,168,.6); }
.switch[aria-checked="true"]::after { left: 18px; background: #9fd3a8; }
.switch:hover { border-color: #e4e4e4; }
.label { color: #585858; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; margin-top: 2px; }
.row { display: flex; gap: 4px; }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; }
.opt { flex: 1; border: 1px solid #3a3a3a; background: transparent; color: #8d8d8d; padding: 3px 0; font-size: 11px; text-align: center; }
.opt:hover { color: #e4e4e4; }
.opt[aria-checked="true"] { background: #fff; border-color: #fff; color: #000; }
.effect::before { content: "+ "; }
.effect[aria-checked="true"]::before { content: "✓ "; }
/* Folder tabs joined to a bordered box, as the popup's .c-tabs over its panels. The tab behind is
   see-through, so it takes the menu's own background. */
.fold { display: grid; }
.ftabs { display: grid; grid-template-columns: 1fr 1fr; margin-bottom: -1px; position: relative; z-index: 1; }
.ftab { border: 1px solid transparent; border-bottom-color: #262626; background: transparent; color: #585858; font-size: 11px; padding: 5px 0 4px; }
.ftab[aria-selected="true"] { background: #111; border-color: #262626; border-bottom-color: #111; color: #fff; font-weight: 600; }
.ftab:hover:not([aria-selected="true"]) { color: #e4e4e4; }
/* each tab's dot: the performance verdict on "upscale", colors in use (green) or not (red) on "color" */
.tdot { margin-left: 6px; font-weight: 400; font-size: 9px; vertical-align: 1px; color: #8d8d8d; }
.tdot.ok { color: #9fd3a8; } .tdot.warn { color: #e3c58a; } .tdot.bad { color: #e39a9a; } .tdot.off { color: rgba(227,154,154,.9); }
.tbox { box-sizing: border-box; border: 1px solid #262626; background: #111; padding: 10px; }
.tpage { display: grid; gap: 8px; }
.tpage > .label:first-child { margin-top: 0; }
.tpage[hidden] { display: none; }
${COLOR_TAB_CSS}`;

export class FullscreenMenu {
  private readonly host = document.createElement('div');

  private readonly wrap = document.createElement('div');

  private readonly toggle = document.createElement('button');

  private readonly panel = document.createElement('div');

  private readonly status = document.createElement('div');

  private readonly title = document.createElement('div');

  private readonly tag = document.createElement('span');

  private readonly epName = document.createElement('span');

  private readonly meta = document.createElement('div');

  private readonly siteEl = document.createElement('span');

  private readonly resEl = document.createElement('span');

  /** The tab's page title / episode and host, fetched each time the menu opens. */
  private page: PageLabel | null = null;

  private readonly power = document.createElement('button');

  private readonly perf = document.createElement('div');

  private readonly graph = document.createElement('canvas');

  private readonly colorTab = new FullscreenColorTab((e) => this.genuine(e));

  /** The box under the folder tabs; it scrolls when the menu would pass MENU_MAX_PX. */
  private readonly box = document.createElement('div');

  private readonly tabs = document.createElement('div');

  private readonly upDot = document.createElement('span');

  private readonly colorDot = document.createElement('span');

  private fitFrame: number | null = null;

  private idleTimer: number | null = null;

  private pollTimer: number | null = null;

  private top = SLOT_TOPS[0]; // the button's current spot

  private placedAt = -Infinity;

  private placeTimer: number | null = null;

  constructor(
    private readonly target: () => VideoInfo | null,
    private readonly settings: () => Settings,
    private readonly color: () => ColorState,
    private readonly loadPage: () => Promise<PageLabel | null> = async () => null,
  ) {
    for (const [k, v] of PINNED_STYLE) this.host.style.setProperty(k, v, 'important');
    const shadow = this.host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    this.wrap.className = 'wrap';
    this.toggle.className = 'toggle';
    this.toggle.type = 'button';
    this.toggle.textContent = '☰';
    this.toggle.setAttribute('aria-label', 'Anime4Nerd'); // not title: its tooltip is drawn by the system
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.addEventListener('click', () => this.setOpen(!this.wrap.classList.contains('open')));
    this.panel.className = 'panel';
    this.panel.hidden = true;

    const head = document.createElement('div');
    head.className = 'head';
    this.title.className = 'title';
    this.power.className = 'switch';
    this.power.type = 'button';
    this.power.setAttribute('role', 'switch');
    this.power.setAttribute('aria-label', 'Upscale this video');
    this.power.addEventListener('click', (e) => {
      if (!this.genuine(e)) return;
      const t = this.target();
      if (t) setSource(t.key, !t.enabled).catch(() => {});
    });
    head.append(this.title, this.power);
    // As the popup's video card: title, then "E12" tag + episode name, then "site · 1080p → …".
    const episode = document.createElement('div');
    episode.className = 'episode';
    this.tag.className = 'tag';
    this.epName.className = 'epname';
    episode.append(this.tag, this.epName);
    this.siteEl.className = 'site';
    this.resEl.className = 'res';
    this.meta.append(this.siteEl, this.resEl);
    this.meta.className = 'meta';
    this.perf.className = 'perf';
    this.graph.className = 'graph';
    this.graph.setAttribute('role', 'img');
    this.graph.setAttribute('aria-label', 'GPU time per frame, last 2 s · dashed = frame limit · red = late');

    this.status.className = 'status';
    this.status.append(head, episode, this.meta, this.perf, this.graph);
    const upPage = document.createElement('div');
    upPage.className = 'tpage';
    upPage.append(
      ...this.group('preset', PRESETS.map((p) => [p.value, p.label]), (v) => ({ preset: v as Settings['preset'] }), 'preset', 'grid'),
      this.effects(),
      ...this.group('upscale', UPSCALES, (v) => ({ upscale: v as Upscale }), 'upscale', 'row'),
    );
    this.colorTab.el.classList.add('tpage');
    this.colorTab.el.hidden = true;
    this.box.className = 'tbox';
    this.box.setAttribute('role', 'tabpanel');
    this.box.append(upPage, this.colorTab.el);
    this.tabs.className = 'ftabs';
    this.tabs.setAttribute('role', 'tablist');
    this.tabs.append(this.tab('upscale', upPage, this.upDot), this.tab('color', this.colorTab.el, this.colorDot));
    this.selectTab(upPage);
    const fold = document.createElement('div');
    fold.className = 'fold';
    fold.append(this.tabs, this.box);
    this.panel.append(this.status, fold);
    this.wrap.append(this.toggle, this.panel);
    shadow.append(style, this.wrap);
    for (const ev of SWALLOW) this.host.addEventListener(ev, (e) => e.stopPropagation());
    // The status box grows when its graph appears and the color list can grow; the screen can
    // shrink: keep within MENU_MAX_PX.
    new ResizeObserver(() => this.queueFit()).observe(this.panel);
    window.addEventListener('resize', () => this.queueFit(), { passive: true });
  }

  /** A folder tab showing `page`, with its status dot. */
  private tab(name: string, page: HTMLElement, dot: HTMLElement): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ftab';
    b.setAttribute('role', 'tab');
    b.textContent = name;
    dot.className = 'tdot';
    dot.textContent = '●';
    b.append(dot);
    b.addEventListener('click', (e) => { if (this.genuine(e)) this.selectTab(page); });
    return b;
  }

  private selectTab(page: HTMLElement) {
    const pages = [...this.box.children] as HTMLElement[];
    pages.forEach((p, i) => {
      p.hidden = p !== page;
      this.tabs.children[i]?.setAttribute('aria-selected', String(p === page));
    });
    this.fit();
  }

  /** Runs fit() once on the next frame: changing the box from inside the observer would re-trigger it. */
  private queueFit() {
    if (this.fitFrame !== null) return;
    this.fitFrame = requestAnimationFrame(() => { this.fitFrame = null; this.fit(); });
  }

  /**
   * Keeps the open menu within MENU_MAX_PX (and the screen): past it, the whole panel scrolls as
   * one, so there is never a scrollbar nested inside another box.
   * Uses fractional heights and floors the box, so the menu never ends up a fraction past the
   * limit, where genuine() would refuse every click.
   */
  private fit() {
    if (this.panel.hidden || !this.host.isConnected) return;
    const r = this.host.getBoundingClientRect();
    const limit = Math.min(MENU_MAX_PX, innerHeight - r.top - EDGE_PX);
    const fixed = r.height - this.panel.getBoundingClientRect().height; // the toggle button and the gap
    const allowed = Math.floor(limit - fixed);
    const natural = this.panel.scrollHeight + 2; // content and padding, plus the two borders
    // max-height counts the content only: take the padding and the borders off.
    const cs = getComputedStyle(this.panel);
    const edges = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, k) => sum + parseFloat(cs[k as 'paddingTop']), 0);
    const max = natural > allowed ? `${Math.max(0, allowed - edges)}px` : '';
    if (this.panel.style.maxHeight !== max) this.panel.style.maxHeight = max;
  }

  /** A label and its radio buttons, laid out as an even `grid` (3 per row) or a single `row`. */
  private group(name: string, opts: [string, string][], patch: (v: string) => Partial<Settings>, field: 'preset' | 'upscale', layout: 'grid' | 'row'): HTMLElement[] {
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = name;
    const row = document.createElement('div');
    row.className = layout;
    row.setAttribute('role', 'radiogroup');
    for (const [value, text] of opts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt';
      b.setAttribute('role', 'radio');
      b.dataset[field] = value;
      b.textContent = text;
      b.addEventListener('click', (e) => {
        if (!this.genuine(e)) return;
        // The upscale already chosen, clicked again: run it again even if the GPU-load cap held it down.
        if (field === 'upscale' && this.settings().upscale === value) liftLoadCap().catch(() => {});
        else saveSettings(patch(value)).catch(() => {});
      });
      row.append(b);
    }
    return [label, row];
  }

  /**
   * A real user click on a menu the page hasn't tampered with. Guards against clickjacking:
   * a page restyling the menu to be invisible or huge so the user's clicks change settings.
   */
  private genuine(e: Event): boolean {
    if (!e.isTrusted) return false;
    const r = this.host.getBoundingClientRect();
    if (Math.abs(r.width - this.host.offsetWidth) > 1 || Math.abs(r.height - this.host.offsetHeight) > 1) return false; // scaled
    if (r.width > MENU_MAX_W_PX || r.height > MENU_MAX_PX) return false; // bigger than the menu ever is
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
    if (this.host.parentNode !== container) { container.append(this.host); this.setTop(SLOT_TOPS[0]); this.wake(); }
    this.refresh();
  }

  private setTop(top: number) {
    this.top = top;
    this.host.style.setProperty('top', `${top}px`, 'important');
  }

  /**
   * Keep the button off the player's own controls: stay where it is while that spot is free,
   * else take the first free spot down the right edge. Not while the menu is open or the
   * mouse is on the button, so it never moves from under the pointer.
   */
  private place() {
    // The delayed call can land after fullscreen ended and the button was removed; its root
    // would then be the button itself, which has no elementsFromPoint.
    if (!this.host.isConnected) return;
    const now = performance.now();
    if (now - this.placedAt < PLACE_EVERY_MS || this.wrap.classList.contains('open') || this.toggle.matches(':hover')) return;
    this.placedAt = now;
    const root = this.host.getRootNode() as Document | ShadowRoot;
    const x = innerWidth - EDGE_PX - BUTTON_PX;
    const free = (top: number) => (top === SLOT_TOPS[0] || top + MENU_MAX_PX <= innerHeight) && !coversControl(root, this.host, x, top, BUTTON_PX);
    const top = [this.top, ...SLOT_TOPS].find(free);
    if (top !== undefined && top !== this.top) this.setTop(top);
  }

  /** Mouse moved: show the button again and restart the idle fade. */
  wake() {
    if (!this.host.isConnected) return;
    this.place();
    // Players show their controls on the same mouse move, often a moment later: look again.
    if (this.placeTimer === null) this.placeTimer = window.setTimeout(() => { this.placeTimer = null; this.place(); }, PLACE_EVERY_MS + 100);
    this.wrap.classList.remove('idle');
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => { this.idleTimer = null; this.wrap.classList.add('idle'); }, IDLE_MS);
  }

  refresh() {
    if (!this.host.isConnected) return;
    const t = this.target();
    const s = this.settings();
    this.power.setAttribute('aria-checked', String(!!t?.enabled));
    this.status.classList.toggle('on', !!t?.enabled);
    this.paintCard(t, s);
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('[data-preset]')) b.setAttribute('aria-checked', String(b.dataset.preset === s.preset));
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('[data-upscale]')) b.setAttribute('aria-checked', String(b.dataset.upscale === s.upscale));
    for (const b of this.panel.querySelectorAll<HTMLButtonElement>('[data-field]')) {
      b.setAttribute('aria-checked', String(s[b.dataset.field as 'darkenLines' | 'thinLines']));
    }
    const c = this.color();
    const upscaled = !!t?.enabled;
    this.colorTab.render(c, upscaled);
    const shown = colorsShown(c, upscaled);
    this.colorDot.className = `tdot ${shown ? 'ok' : 'off'}`;
    this.colorDot.setAttribute('aria-label', shown ? 'colors in use' : 'colors not in use');
    if (!this.panel.hidden) this.paintPerf(t);
  }

  /**
   * The status box's card rows, by the popup's rules (popup.ts patchCard):
   * - episode name known: "E12" tag + the name; info line "site · 1080p → 3840×2160 (2×)".
   * - no episode name: the quality stands beside the tag ("1080p" is the tag when there is no
   *   episode either); info line "site · stream <stream host>".
   * - not possible: the info line says why.
   * "N× capped" shows in the warn colour.
   */
  private paintCard(t: VideoInfo | null, s: Settings) {
    if (!t) { for (const e of [this.title, this.tag, this.epName, this.siteEl, this.resEl]) e.textContent = ''; return; }
    const site = this.page?.host || t.frameHost;
    const { title, tag, episodeName } = videoLabel(this.page?.meta ?? EMPTY_META, t.media, site);
    const p = (h: number) => (h ? `${h}p` : '?');
    const st = t.stats;
    const outH = st?.outputHeight ?? t.height * 2; // 2x is the default before rendering starts
    const out = st ? `${st.outputWidth}×${st.outputHeight}` : p(outH);
    const scale = t.height ? Math.round(outH / t.height) : 0;
    const capFull = st ? capNote(s.upscale, scale, t.loadCapped) : ''; // " · 8× capped: GPU load"
    const cap = capFull.replace(/: .*$/, '').replace(/^ · /, '');
    const output = `→ ${out} (${scale}×)${cap ? ` · ${cap}` : ''}`;
    const impossible = t.status === 'Unavailable';
    let rowTag = tag;
    let rowText = episodeName;
    let info = t.height ? ` · ${p(t.height)} ${output}` : '';
    const quality = !impossible && !episodeName && !!t.height;
    if (quality) {
      rowText = tag ? `${p(t.height)} ${output}` : output;
      info = ` · stream ${t.mediaHost}`;
      if (!tag) rowTag = p(t.height);
    }
    this.status.classList.toggle('quality', quality);
    this.title.textContent = title;
    this.tag.textContent = rowTag;
    this.tag.hidden = !rowTag;
    withNote(this.epName, rowText, cap);
    this.siteEl.textContent = impossible ? '' : site;
    this.resEl.classList.toggle('why', impossible);
    if (impossible) this.resEl.textContent = t.message;
    else withNote(this.resEl, info, cap);
    if (capFull) this.meta.setAttribute('aria-label', `${site}${info}${capFull}`);
    else this.meta.removeAttribute('aria-label');
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
      const fv = load === null && !s!.timerSupported ? frameVerdict(s!.fps, fps) : null;
      if (fv) { cls = fv; verdict = VERDICT_TEXT[fv]; } else if (load === null) { cls = 'ok'; verdict = 'running'; } else if (load > 1) { cls = 'bad'; verdict = 'dropping frames'; } else if (load > 0.8) { cls = 'warn'; verdict = 'near limit'; } else { cls = 'ok'; verdict = 'keeping up'; }
    }
    this.perf.className = `perf ${cls}`;
    // The upscale tab's dot: the verdict's colour while upscaling, red while off.
    this.upDot.className = `tdot ${t?.enabled ? cls : 'off'}`;
    this.upDot.setAttribute('aria-label', t?.enabled ? verdict : 'off');
    const noTimer = !!s && !s.timerSupported; // e.g. Firefox: no GPU timer queries, so no bars
    // No GPU timer: frames drawn vs the video's fps, e.g. "57 / 60 fps · near limit".
    this.perf.textContent = noTimer
      ? `${live ? s!.fps.toFixed(0) : '—'} / ${fps === null ? '—' : fps.toFixed(0)} fps · ${verdict}`
      : `gpu ${gpu === null ? '—' : `${gpu.toFixed(1)} ms`}${budget === null ? '' : ` / ${budget.toFixed(0)} ms`} · ${verdict}`;
    this.graph.style.display = noTimer ? 'none' : '';
    this.drawBars(s?.samples ?? [], budget, live); // while paused, the page keeps the last 2 s of playback
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
      // The page can move to the next episode while in fullscreen: ask again on each open.
      this.loadPage().then((p) => { this.page = p; this.refresh(); }, () => {});
      this.refresh();
      this.pollTimer = window.setInterval(() => this.refresh(), POLL_MS);
    }
  }
}

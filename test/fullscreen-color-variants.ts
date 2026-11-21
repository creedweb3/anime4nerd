// Design variants for color controls in the fullscreen menu (fullscreen-color-demo.html). Each adds
// to the real FullscreenMenu: its own elements go into the menu's shadow root and reuse its CSS.
// The sliders are a port of popup-color.ts's (that module cannot be imported outside the popup:
// it reads the popup's DOM when loaded). State goes through the real color.ts (saveColor).

import type { FullscreenMenu } from '../src/fullscreen-menu';
import { DESIGN_CSS, buildDesign } from './fullscreen-color-tab-designs';
import {
  COLOR_KEYS, COLOR_RANGE, COLOR_UNIT, NEUTRAL_COLOR, PERCENT_KEYS, UNIPOLAR,
  ColorKey, ColorProfile, ColorState, ColorValues, formatColor, isNeutral, loadColor, onColorChanged, sameValues, saveColor, snapColor, toPosition, toValue,
} from '../src/color';

export interface MenuParts {
  menu: FullscreenMenu; shadow: ShadowRoot; source: HTMLCanvasElement; host: HTMLElement; wrap: HTMLElement;
  toggle: HTMLElement; panel: HTMLElement; status: HTMLElement;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};
export const button = (cls: string, text = '', label = '') => {
  const b = el('button', cls, text);
  b.type = 'button';
  if (label) b.setAttribute('aria-label', label);
  return b;
};

// --- color state (as the popup: edits on neutral or a saved profile become "custom") -------------
let cur: ColorState;
export const subs: (() => void)[] = [];
/** The color state now (for the color tab designs). */
export const state = (): ColorState => cur;
/** Whether the video is upscaled now (the status box's switch); option A sets it. */
let upscaled = () => true;
export const upscaledNow = (): boolean => upscaled();
export { persist };
const paint = () => { for (const f of subs) f(); };
function persist(patch: Partial<ColorState>) {
  cur = { ...cur, ...patch };
  void saveColor(patch);
  paint();
}
export const rows = (): ColorProfile[] => [...cur.profiles, { id: 'custom', name: 'custom', v: cur.custom }];
export const nameOf = (id: string) => rows().find((p) => p.id === id)?.name ?? 'neutral';
export function pick(id: string) {
  const p = rows().find((r) => r.id === id);
  if (p) persist({ profile: id, values: { ...p.v } });
}
function setValue(k: ColorKey, v: number) {
  // As the popup: a saved profile stays selected, marked as changed; neutral (built in) becomes custom.
  const values = { ...cur.values, [k]: v };
  const p = cur.profiles.find((x) => x.id === cur.profile);
  const patch: Partial<ColorState> = { values };
  if (cur.profile === 'custom') patch.custom = values;
  else if (p?.builtIn && !sameValues(values, p.v)) Object.assign(patch, { profile: 'custom', custom: values });
  persist(patch);
}
/** The selected profile's own values (custom and neutral: neutral); the reset icon compares with and resets to these. */
const baseValues = (): ColorValues => cur.profiles.find((x) => x.id === cur.profile)?.v ?? NEUTRAL_COLOR;
/** A saved profile whose values differ from those on screen (the popup's amber dot). */
const dirty = () => { const p = cur.profiles.find((x) => x.id === cur.profile); return !!p && !p.builtIn && !sameValues(cur.values, p.v); };
export const step = (by: number) => {
  const r = rows();
  pick(r[(r.findIndex((p) => p.id === cur.profile) + by + r.length) % r.length].id);
};

// --- shared pieces --------------------------------------------------------------------------
const CSS = `
[hidden] { display: none !important; } /* wins over .grid, .row and the rest */
.wrap { --line:#262626; --line2:#3a3a3a; --fg:#e4e4e4; --dim:#8d8d8d; --faint:#585858; --on:#fff; --ok:#9fd3a8; --bg:#0b0b0b; --panel:#111; }
.wrap.idle.copen { opacity: 1; pointer-events: auto; }
.lrow { display: flex; align-items: center; gap: 8px; margin-top: 2px; }
.lrow .label { margin: 0 auto 0 0; }
.lrow .switch { width: 32px; height: 18px; }
.lrow .switch::after { width: 12px; height: 12px; }
.lrow .switch[aria-checked="true"]::after { left: 16px; }
.link { border: 0; background: transparent; padding: 0; color: var(--dim); font-size: 11px; }
.link:hover { color: var(--on); }
.dot { color: var(--ok); font-size: 8px; margin-left: 5px; vertical-align: 1px; }
.off-dim { transition: opacity .12s; }
.coff .off-dim { opacity: .35; pointer-events: none; }
/* numbered profiles, as the popup's profile list */
.plist { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8px; }
.plist.one { grid-template-columns: 1fr; }
.pi { display: grid; grid-template-columns: 2ch minmax(0,1fr); column-gap: 6px; align-items: center; padding: 1px 4px; border: 1px solid transparent; background: transparent; color: var(--fg); text-align: left; font-size: 12px; }
.pi:hover { border-color: var(--line2); }
.pi .n { color: var(--faint); font-size: 11px; text-align: right; font-variant-numeric: tabular-nums; }
.pi b { font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pi[aria-checked="true"] .n { color: var(--ok); font-weight: 600; }
.pi[aria-checked="true"] b { color: var(--on); font-weight: 600; }
.pi.custom b { font-style: italic; }
.plist:not(.one) .pi.custom { grid-column: 1 / -1; }
/* A: the popup's profile list (.pf-list .mode-opt): number, name, current number green, custom bullet */
.plist.pop { gap: 0 4px; }
.plist.pop .pi { padding: 4px 4px 4px 6px; }
.plist.pop .pi:hover, .plist.pop .pi:focus-visible { background: #1a1a1a; border-color: var(--line2); outline: none; }
.plist.pop .pi b { font-size: 12.5px; line-height: 18px; color: var(--fg); }
.plist.pop .pi[aria-checked="true"] b { color: var(--on); font-weight: 600; }
.plist.pop .pi.custom .n { font-weight: 700; font-size: 1.4em; line-height: 0; text-align: center; }
.mp-btn { border: 1px solid var(--line2); background: transparent; color: var(--dim); font-size: 11px; padding: 4px 10px; white-space: nowrap; }
.mp-btn:hover { color: var(--on); border-color: var(--on); }
.pf-mod { font-style: normal; color: #e3c58a; font-size: 8px; letter-spacing: 0; margin-left: 5px; vertical-align: 1px; flex: none; }
.pf-name { display: flex; align-items: baseline; min-width: 0; margin-right: auto; color: var(--faint); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; white-space: nowrap; }
.pf-name b { color: var(--on); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.grid2 { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 4px; }
.grid2 .opt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 6px; }
.grid2 .opt.custom { grid-column: 1 / -1; font-style: italic; }
/* sliders: name · track · reset · number (popup.css .cs rules) */
.cs-list { display: grid; gap: 2px; }
.cs { display: grid; grid-template-columns: 11ch 1fr max-content; align-items: center; gap: 8px; height: 22px; }
.cs-end { display: grid; grid-template-columns: 13px 4ch; column-gap: 6px; align-items: center; margin-left: -2px; font-size: 11px; }
.cs-end .cs-val, .cs-end .cs-edit { grid-column: 2; justify-self: end; text-align: right; }
.cs-reset { grid-column: 1; width: 13px; height: 16px; display: grid; place-items: center; padding: 0; border: 0; background: transparent; color: var(--dim); visibility: hidden; }
.cs.edited .cs-reset { visibility: visible; } /* only where the value differs from the selected profile */
.cs-reset:hover, .cs-reset:focus-visible { color: var(--on); }
.cs-name { color: var(--dim); font-size: 11px; }
.cs.changed .cs-name { color: var(--fg); }
.cs-val { justify-self: end; color: var(--faint); font-size: 11px; font-weight: 400; text-align: right; font-variant-numeric: tabular-nums; cursor: text; text-decoration: underline dotted var(--faint); text-underline-offset: 3px; }
.cs-val:hover { color: var(--on); text-decoration-style: solid; text-decoration-color: var(--on); }
.cs-val:focus-visible { outline: 1px solid #fff; outline-offset: 1px; }
.cs.changed .cs-val { color: var(--on); font-weight: 600; }
.cs-track { position: relative; height: 22px; cursor: pointer; touch-action: none; }
.cs-track::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; border-top: 1px solid var(--line2); }
.cs-zero { position: absolute; left: var(--z); top: 6px; height: 10px; border-left: 1px solid var(--faint); }
.cs-fill { position: absolute; left: var(--a); width: var(--w); top: calc(50% - 1px); height: 3px; background: var(--on); }
.cs-thumb { position: absolute; left: clamp(0px, calc(var(--p) - 4px), calc(100% - 8px)); top: 4px; width: 8px; height: 14px; background: var(--bg); border: 1px solid var(--dim); }
.cs.changed .cs-thumb { background: var(--on); border-color: var(--on); }
.cs-track:hover .cs-thumb { border-color: var(--on); }
.cs-track:focus-visible { outline: none; }
.cs-track:focus-visible .cs-thumb { outline: 1px solid var(--on); outline-offset: 1px; }
.cs.long .cs-reset { transform: translateX(-4px); }
.cs-edit { justify-self: end; display: inline-flex; align-items: baseline; }
.cs-unit { color: var(--on); font-size: 11px; font-weight: 600; }
.cs-input { padding: 0; border: 0; border-bottom: 1px solid var(--dim); background: transparent; color: var(--on); caret-color: var(--on); font: inherit; font-size: 11px; font-weight: 600; line-height: 16px; text-align: right; outline: none; }
.cs-input::selection { background: var(--line2); color: var(--on); }
/* A: folder tabs */
/* A: folder tabs joined to a bordered box, as the popup's .c-tabs / .c-tab over .panel */
.fold { display: grid; }
.ftabs { display: grid; grid-template-columns: 1fr 1fr; margin-bottom: -1px; position: relative; z-index: 1; }
.ftab { border: 1px solid transparent; border-bottom-color: var(--line); background: transparent; /* the menu's own see-through background, so the tab behind blends in */ color: var(--faint); font-size: 11px; padding: 5px 0 4px; transition: border-color .12s, color .12s; }
.ftab[aria-selected="true"] { background: var(--panel); border-color: var(--line); border-bottom-color: var(--panel); color: var(--on); font-weight: 600; }
.ftab:hover:not([aria-selected="true"]) { color: var(--fg); }
.ftab .dot { font-size: 9px; }
/* the upscale tab's dot: the performance verdict in its colour, as the popup's .t-verdict */
.t-verdict { margin-left: 6px; font-weight: 400; font-size: 9px; vertical-align: 1px; }
.t-verdict.ok { color: #9fd3a8; } .t-verdict.warn { color: #e3c58a; } .t-verdict.bad { color: #e39a9a; } .t-verdict.dim { color: var(--dim); }
.t-verdict.off { color: rgba(227,154,154,.9); }
.tbox { box-sizing: border-box; border: 1px solid var(--line); background: var(--panel); padding: 10px; overflow: hidden auto; overscroll-behavior: contain; }
/* the popup's scrollbar: a 10px lane with a 4px thumb, no arrows, no track */
.tbox::-webkit-scrollbar { width: 10px; }
.tbox::-webkit-scrollbar-track { background: transparent; }
.tbox::-webkit-scrollbar-button { display: none; }
.tbox::-webkit-scrollbar-thumb { background: var(--line2); background-clip: padding-box; border: 3px solid transparent; }
.tbox::-webkit-scrollbar-thumb:hover { background-color: var(--dim); }
@supports not selector(::-webkit-scrollbar) { .tbox { scrollbar-width: thin; scrollbar-color: var(--line2) transparent; } }
.tpage { display: grid; gap: 8px; }
.tbox .tpage > .label:first-child { margin-top: 0; }
/* the color tab: head (profile · name, on/off), sliders, the "not upscaled" card (popup .tab-color) */
.cpage { position: relative; }
.chead { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; min-height: 22px; }
.cpage .adjust { margin-top: 8px; }
.chead .back { padding: 2px 8px; }
.ap-card { display: flex; align-items: center; gap: 10px; margin-top: 10px; padding: 7px 10px; cursor: pointer; border: 1px solid var(--line2); background: var(--bg); transition: border-color .12s, opacity .12s; }
.ap-card:hover { border-color: var(--dim); }
.ap-text { display: flex; flex-direction: column; flex: 1; min-width: 0; }
.ap-text b { color: var(--fg); font-size: 11px; font-weight: 600; }
.ap-text small { color: var(--dim); font-size: 11px; }
.ap-ico { flex: none; align-self: center; color: var(--dim); }
.ap-card.on .ap-x { display: none; }
.ap-card .switch { flex: none; }
.pfwrap { position: relative; margin-right: auto; min-width: 0; }
.pf-open { border: 0; background: transparent; padding: 0 13px 0 0; position: relative; color: var(--faint); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; white-space: nowrap; }
.pf-open b { color: var(--on); font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pf-open { display: flex; align-items: baseline; max-width: 100%; }
.pf-open::after { content: ""; position: absolute; right: 0; top: 50%; margin-top: -1px; border: 3px solid transparent; border-top-color: currentColor; }
.pf-open:hover, .pf-open[aria-expanded="true"] { color: var(--fg); }
.drop { position: absolute; left: -6px; top: 100%; margin-top: 6px; z-index: 5; min-width: 160px; padding: 2px; border: 1px solid var(--line2); background: var(--panel); box-shadow: 0 10px 18px -8px #000; }
.drop.up { top: auto; bottom: 100%; margin: 0 0 8px; }
.drop[hidden] { display: none; }
.listing > :not(.keep) { opacity: .4; filter: blur(1.5px); pointer-events: none; }
/* C: drill-in page */
.back { border: 0; background: transparent; padding: 0; color: var(--dim); font-size: 11px; }
.back:hover { color: var(--on); }
/* D: second button and its own panel on the other side */
.btns { display: flex; gap: 6px; }
.ctoggle { position: relative; display: grid; place-items: center; }
.ctoggle:hover, .ctoggle[aria-expanded="true"] { border-color: #e4e4e4; }
.ctoggle .dot { position: absolute; right: 3px; top: 1px; margin: 0; }
.cpanel { position: fixed; top: 16px; left: 16px; }
`;

const RESET_SVG = '<svg viewBox="0 0 12 12" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6a3.5 3.5 0 1 0 1.1-2.55"/><path d="M2.3 1.6v2.2h2.2"/></svg>';
const DROP_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/></svg>';

/** One slider row, wired as in popup-color.ts: drag (Shift finer), wheel, arrows, Home/0/double click, typed value. */
function slider(k: ColorKey): HTMLElement {
  const lo = UNIPOLAR.has(k) ? 0 : -1;
  const row = el('div', 'cs');
  row.dataset.k = k;
  row.innerHTML = `<span class="cs-name">${k}</span><div class="cs-track" role="slider" tabindex="0" aria-label="${k}" aria-valuemin="${COLOR_RANGE[k][0]}" aria-valuemax="${COLOR_RANGE[k][1]}"><i class="cs-zero"></i><i class="cs-fill"></i><i class="cs-thumb"></i></div>`
    + `<span class="cs-end"><button type="button" class="cs-reset" aria-label="reset ${k}">${RESET_SVG}</button><b class="cs-val" tabindex="0" role="button" aria-label="type a value for ${k}"></b></span>`;
  const track = row.querySelector('.cs-track') as HTMLElement;
  let val = row.querySelector('.cs-val') as HTMLElement;
  const frac = (t: number) => ((t - lo) / (1 - lo)) * 100;
  const v = () => cur.values[k];
  const set = (nv: number) => { const n = snapColor(k, nv); if (n !== v()) setValue(k, n); };
  const stepBy = (n: number) => set(v() + n * COLOR_UNIT[k]);
  const reset = () => set(baseValues()[k]);
  subs.push(() => {
    const p = frac(toPosition(k, v())), z = frac(0);
    track.style.cssText = `--p:${p}%;--z:${z}%;--a:${Math.min(p, z)}%;--w:${Math.abs(p - z)}%`;
    const text = formatColor(k, v());
    row.classList.toggle('changed', v() !== NEUTRAL_COLOR[k]);
    row.classList.toggle('edited', v() !== baseValues()[k]);
    row.classList.toggle('long', text.length > 4);
    val.textContent = text;
    track.setAttribute('aria-valuenow', String(v()));
    track.setAttribute('aria-valuetext', text);
  });
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    track.setPointerCapture(e.pointerId);
    const r = track.getBoundingClientRect();
    if (!(e.target as Element).classList.contains('cs-thumb')) set(toValue(k, clamp(lo + ((e.clientX - r.left) / r.width) * (1 - lo), lo, 1)));
    let last = e.clientX;
    let raw = toPosition(k, v());
    const move = (ev: PointerEvent) => {
      raw = clamp(raw + ((ev.clientX - last) / r.width) * (1 - lo) * (ev.shiftKey ? 0.1 : 1), lo, 1);
      last = ev.clientX;
      set(toValue(k, raw));
    };
    const up = () => { track.removeEventListener('pointermove', move); track.removeEventListener('pointerup', up); track.removeEventListener('lostpointercapture', up); };
    track.addEventListener('pointermove', move);
    track.addEventListener('pointerup', up);
    track.addEventListener('lostpointercapture', up);
  });
  let acc = 0;
  track.addEventListener('wheel', (e) => {
    e.preventDefault();
    const px = e.deltaY * ([1, 40, 400][e.deltaMode] ?? 1);
    if (Math.sign(px) !== Math.sign(acc)) acc = 0;
    acc += px;
    const notches = Math.trunc(acc / 100);
    if (!notches) return;
    acc -= notches * 100;
    stepBy(-notches * (e.shiftKey ? 10 : 1));
  }, { passive: false });
  track.addEventListener('keydown', (e) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    const n = e.key in keys ? keys[e.key] * (e.shiftKey ? 10 : 1) : ({ PageUp: 10, PageDown: -10 } as Record<string, number>)[e.key];
    if (n) { stepBy(n); e.preventDefault(); }
    if (e.key === 'Home' || e.key === '0') { reset(); e.preventDefault(); }
  });
  track.addEventListener('dblclick', reset);
  (row.querySelector('.cs-reset') as HTMLElement).addEventListener('click', () => { reset(); track.focus(); });
  const typeIn = () => {
    const pct = PERCENT_KEYS.has(k);
    const inp = el('input', 'cs-input');
    inp.value = pct ? String(Math.round(v() * 100)) : v().toFixed(COLOR_UNIT[k] >= 1 ? 0 : 2);
    inp.style.width = `${Math.max(2, inp.value.length) + 0.3}ch`;
    inp.addEventListener('input', () => { inp.style.width = `${Math.max(2, inp.value.length) + 0.3}ch`; });
    const box = el('span', 'cs-edit');
    box.append(inp);
    if (pct) box.append(el('span', 'cs-unit', '%'));
    val.replaceWith(box);
    inp.select();
    let done = false;
    const close = (apply: boolean) => {
      if (done) return;
      done = true;
      const typed = parseFloat(inp.value.replace('−', '-').replace(/[^0-9.+-]/g, ''));
      box.replaceWith(val);
      if (apply && Number.isFinite(typed)) set(pct ? typed / 100 : typed);
      val.focus();
    };
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(true); if (e.key === 'Escape') { e.preventDefault(); close(false); } });
    inp.addEventListener('blur', () => close(true));
  };
  val.addEventListener('click', typeIn);
  val.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); typeIn(); } });
  return row;
}
export const sliders = (only: readonly ColorKey[] = COLOR_KEYS) => { const list = el('div', 'cs-list off-dim'); for (const k of only) list.append(slider(k)); return list; };

export function switchBtn(label: string, get: () => boolean, set: (on: boolean) => void): HTMLElement {
  const b = button('switch', '', label);
  b.setAttribute('role', 'switch');
  b.addEventListener('click', () => set(!get()));
  subs.push(() => b.setAttribute('aria-checked', String(get())));
  return b;
}
export const colorsSwitch = () => switchBtn('Colors on', () => cur.on, (on) => persist({ on }));
export const alwaysSwitch = () => switchBtn('Also use colors when a video is not upscaled', () => cur.always, (always) => persist({ always }));

/** A label on the left and things on the right, e.g. "COLOR ··· [switch]". */
function labelRow(text: string, ...right: HTMLElement[]): HTMLElement {
  const r = el('div', 'lrow');
  r.append(el('div', 'label', text), ...right);
  return r;
}

/** Numbered profiles (1-9 as in the popup), custom last with a bullet. */
export function profileList(cols: 'one' | 'two', onPick: () => void = () => {}): HTMLElement {
  const list = el('div', `plist ${cols === 'one' ? 'one' : ''} off-dim`);
  list.setAttribute('role', 'radiogroup');
  list.setAttribute('aria-label', 'Profile');
  subs.push(() => {
    list.replaceChildren(...rows().map((p, i) => {
      const custom = p.id === 'custom';
      const b = button(`pi${custom ? ' custom' : ''}`);
      b.setAttribute('role', 'radio');
      b.dataset.id = p.id;
      b.setAttribute('aria-checked', String(p.id === cur.profile));
      b.append(el('span', 'n', custom ? '•' : String(i + 1)), el('b', '', p.name));
      b.addEventListener('click', () => { pick(p.id); onPick(); });
      return b;
    }));
  });
  return list;
}

/** Saved profiles as chips in the menu's own .opt style, two per row. Custom is left out (the panel
 * would pass 480 px); while it is on, no chip is lit and the adjust page names it. */
function chips(): HTMLElement {
  const g = el('div', 'grid2 off-dim');
  g.setAttribute('role', 'radiogroup');
  subs.push(() => {
    g.replaceChildren(...cur.profiles.map((p) => {
      const b = button(`opt${p.id === 'custom' ? ' custom' : ''}`, p.name);
      b.setAttribute('role', 'radio');
      b.dataset.id = p.id;
      b.setAttribute('aria-checked', String(p.id === cur.profile));
      b.addEventListener('click', () => pick(p.id));
      return b;
    }));
  });
  return g;
}

/** "PROFILE ▾ name": opens a numbered list under it; the rest of `scope` steps back meanwhile. */
function profileMenu(scope: () => HTMLElement, up = false): HTMLElement {
  const wrap = el('div', 'pfwrap keep');
  const open = button('pf-open off-dim');
  open.setAttribute('aria-haspopup', 'listbox');
  const drop = el('div', `drop${up ? ' up' : ''}`);
  drop.hidden = true;
  const setOpen = (o: boolean) => { drop.hidden = !o; open.setAttribute('aria-expanded', String(o)); scope().classList.toggle('listing', o); };
  drop.append(profileList('one', () => { setOpen(false); open.focus(); }));
  open.addEventListener('click', () => { setOpen(drop.hidden === true); if (!drop.hidden) drop.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); open.focus(); } });
  subs.push(() => { open.innerHTML = '<span>profile ·&nbsp;</span><b></b>'; (open.querySelector('b') as HTMLElement).textContent = nameOf(cur.profile); });
  wrap.append(open, drop);
  return wrap;
}

/** Inside a color area: 1-9 picks that profile, arrows move between list buttons. */
export function keys(area: HTMLElement) {
  area.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.cs-track, input')) return;
    if (/^[1-9]$/.test(e.key) && Number(e.key) <= cur.profiles.length) { e.preventDefault(); pick(cur.profiles[Number(e.key) - 1].id); }
    const list = t.closest('.plist, .grid2, .pcols');
    if (list && ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) {
      const bs = [...list.querySelectorAll<HTMLElement>('button')];
      const i = bs.indexOf(t);
      bs[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length]?.focus();
      e.preventDefault();
    }
  });
}

// --- the variants -----------------------------------------------------------------------------
/** A: folder tabs "upscale | color" joined to a bordered box, as in the popup. On the color tab the
 * status box keeps only its head; if the menu would still pass 480 px the box scrolls. */
const ALWAYS_SVG = '<svg class="ap-ico" viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="1.5" y="3" width="13" height="9" rx="1"/><path d="M5.5 14.5h5"/><path class="ap-x" d="M3 1.5l10 12"/></svg>';
const MENU_MAX = 480;
const PANEL_W = 296; // + 2 x 10px padding + 2 x 1px border = 318px // fullscreen-menu.ts genuine(): taller and clicks are ignored

export function alwaysCard(): HTMLElement {
  const card = el('div', 'ap-card off-dim');
  card.innerHTML = `${ALWAYS_SVG}<span class="ap-text"><b>also use colors when not upscaled</b><small></small></span>`;
  const sw = alwaysSwitch();
  card.append(sw);
  card.addEventListener('click', (e) => { if (!(e.target as Element).closest('.switch')) sw.click(); });
  subs.push(() => {
    card.classList.toggle('on', cur.always);
    (card.querySelector('small') as HTMLElement).textContent = cur.always ? 'currently: every video' : 'currently: upscaled videos only';
  });
  return card;
}

/** "PROFILE · name ●" (amber dot: changed since saved), as the popup's color head. */
export function profileName(label = true): HTMLElement {
  const n = el('span', 'pf-name');
  subs.push(() => {
    n.replaceChildren(...(label ? [el('span', '', 'profile · ')] : []), el('b', '', nameOf(cur.profile)));
    if (dirty()) n.append(el('i', 'pf-mod', '●'));
  });
  return n;
}

function tabs(p: MenuParts) {
  // 296px, not 260: two columns of profile names fit without "…"; the menu stays within 320px.
  p.panel.style.width = `${PANEL_W}px`;
  const up = el('div', 'tpage');
  up.append(...[...p.panel.children].filter((c) => c !== p.status));
  // The color tab: one of the profiles-only designs in fullscreen-color-tab-designs.ts (?c=A1..A6).
  // setDesign swaps it in place (the demo page asks by postMessage), so a switch shows at once.
  upscaled = () => p.status.classList.contains('on');
  const q0 = new URLSearchParams(location.search);
  let design = q0.get('c') ?? 'A1';
  let style = q0.get('tg') ?? 't4a'; // tg, not t: the demo page's t is a cache-buster
  let built = buildDesign(design, style);
  let co = built.main;
  co.hidden = true;
  const box = el('div', 'tbox');
  box.setAttribute('role', 'tabpanel');
  box.append(up, co);
  const bar = el('div', 'ftabs');
  bar.setAttribute('role', 'tablist');
  const dot = el('span', 'dot', '●');
  // Keep the whole menu within MENU_MAX: past it, the box scrolls instead of growing.
  const fit = () => {
    if (p.panel.hidden) return;
    const r = p.host.getBoundingClientRect();
    const limit = Math.min(MENU_MAX, innerHeight - r.top - 16); // and never past the bottom of a small screen
    const allowed = Math.floor(limit - (r.height - box.offsetHeight)); // whole pixels: 480.5 would round to 481
    const natural = box.scrollHeight + 2; // content and padding, plus the two borders
    const max = natural > allowed ? `${Math.max(0, allowed)}px` : '';
    if (box.style.maxHeight !== max) box.style.maxHeight = max;
  };
  // The status box grows when its graph appears, so look again whenever the menu changes size.
  new ResizeObserver(fit).observe(p.panel);
  const showPage = (page: HTMLElement) => {
    for (const x of [up, co]) x.hidden = x !== page;
    box.scrollTop = 0;
    fit();
  };
  const tab = (name: string, page: HTMLElement) => {
    const b = button('ftab', name);
    b.setAttribute('role', 'tab');
    b.addEventListener('click', () => {
      for (const x of bar.children) x.setAttribute('aria-selected', String(x === b));
      showPage(page === box ? co : page);
    });
    return b;
  };
  const tu = tab('upscale', up), tc = tab('color', box); // box: the color page is looked up when clicked
  tu.setAttribute('aria-selected', 'true'); tc.setAttribute('aria-selected', 'false');
  tc.append(dot);
  // Green only when colors really reach the picture: switched on, not neutral, and the video is
  // upscaled or "always" is on. Otherwise red, like the upscale tab's off dot.
  const paintColorDot = () => {
    const shown = cur.on && !isNeutral(cur.values) && (p.status.classList.contains('on') || cur.always);
    dot.className = `t-verdict ${shown ? 'ok' : 'off'}`;
    dot.setAttribute('aria-label', shown ? 'colors in use' : 'colors not in use');
  };
  subs.push(paintColorDot);
  // The upscale tab carries the status box's verdict as a dot in its colour (popup: t-verdict).
  const verdict = el('span', 't-verdict', '●');
  tu.append(verdict);
  const perf = p.status.querySelector('.perf') as HTMLElement;
  const mirror = () => {
    paint(); // the dot, and the color tab's "not upscaled" state, follow the upscale switch
    const on = p.status.classList.contains('on');
    verdict.className = `t-verdict ${on ? [...perf.classList].find((c) => c !== 'perf') ?? 'dim' : 'off'}`;
    verdict.setAttribute('aria-label', on ? perf.textContent ?? '' : 'off');
  };
  new MutationObserver(mirror).observe(p.status, { subtree: true, attributes: true, attributeFilter: ['class'] });
  mirror();
  bar.append(tu, tc);
  const fold = el('div', 'fold');
  fold.append(bar, box);
  p.panel.append(fold);
  new MutationObserver(fit).observe(p.panel, { attributes: true, attributeFilter: ['hidden'] });
  addEventListener('resize', fit);
  /** Swaps the design (c: A1|A2) and/or the toggle style (t: t1..t4) in place. */
  const setDesign = (c: string = design, t: string = style) => {
    design = c; style = t;
    const shown = !co.hidden;
    built.drop();
    built = buildDesign(design, style);
    built.main.hidden = !shown;
    co.replaceWith(built.main);
    co = built.main;
    paint();
    fit();
  };
  /** Opens the menu on the color tab (the demo page's switches show the design at once). */
  const openColor = () => {
    if (p.panel.hidden) p.toggle.click();
    tc.click();
  };
  Object.assign(window, { colorTab: { setDesign, openColor } });
}

/** B: compact. Under the upscale controls: colors on/off and the numbered profile list; nothing else. */
function compact(p: MenuParts) {
  const area = el('div', 'tpage');
  area.append(labelRow('color', colorsSwitch()), profileList('two'));
  p.panel.append(area);
  keys(area);
}

/** C: profile chips + on/off; "adjust" turns the panel into a sliders page with a way back. */
function chipsMore(p: MenuParts) {
  const main = [...p.panel.children] as HTMLElement[];
  const area = el('div', 'tpage');
  const more = button('link off-dim', 'adjust ›', 'Adjust colors');
  area.append(labelRow('color', more, colorsSwitch()), chips());
  const page = el('div', 'tpage');
  page.hidden = true;
  const back = button('back', '‹ back', 'Back to the menu');
  const head = el('div', 'lrow keep');
  const pm = profileMenu(() => page);
  pm.style.marginLeft = '6px';
  head.append(back, pm, colorsSwitch());
  const always = labelRow('always', alwaysSwitch());
  always.classList.add('off-dim');
  page.append(head, sliders(), always);
  const show = (adjust: boolean) => {
    for (const c of [...main, area]) c.hidden = adjust;
    if (adjust) p.status.hidden = true;
    page.hidden = !adjust;
    (adjust ? back : more).focus();
  };
  more.addEventListener('click', () => show(true));
  back.addEventListener('click', () => show(false));
  page.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !(e.target as Element).closest('.drop, input')) show(false); });
  p.panel.append(area, page);
  keys(area); keys(page);
  // Closing the menu returns it to the main page.
  new MutationObserver(() => { if (p.panel.hidden && !page.hidden) show(false); }).observe(p.panel, { attributes: true, attributeFilter: ['hidden'] });
}

/** D: a second button left of ☰ opens a color panel of its own on the left edge of the screen. */
function secondButton(p: MenuParts) {
  const btns = el('div', 'btns');
  const ct = button('toggle ctoggle', '', 'Colors');
  ct.innerHTML = DROP_SVG;
  const dot = el('span', 'dot', '●');
  ct.append(dot);
  ct.setAttribute('aria-expanded', 'false');
  p.toggle.before(btns);
  btns.append(ct, p.toggle);
  const panel = el('div', 'panel cpanel');
  panel.hidden = true;
  const head = el('div', 'head keep');
  head.append(el('b', '', 'colors'), colorsSwitch());
  const always = labelRow('always', alwaysSwitch());
  always.classList.add('off-dim');
  panel.append(head, el('div', 'label off-dim', 'profile'), profileList('two'), el('div', 'label off-dim', 'adjust'), sliders(), always);
  p.wrap.append(panel);
  const setOpen = (o: boolean) => { panel.hidden = !o; ct.setAttribute('aria-expanded', String(o)); p.wrap.classList.toggle('copen', o); };
  ct.addEventListener('click', () => setOpen(panel.hidden === true));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOpen(false); ct.focus(); } });
  subs.push(() => { dot.hidden = !cur.on || isNeutral(cur.values); });
  keys(panel);
}

/** E: a slim bar at the bottom: on/off, ‹ profile ›, with the numbered list opening upwards. */
function bottomBar(p: MenuParts) {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:50%;right:auto;top:auto;bottom:76px;transform:translateX(-50%);z-index:2147483647';
  const sh = host.attachShadow({ mode: 'open' });
  const style = el('style');
  style.textContent = `${p.shadow.querySelector('style')!.textContent}\n${CSS}
.wrap { flex-direction: row; }
.bar { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 8px 0 10px; border: 1px solid #3a3a3a; background: rgba(11,11,11,.94); box-shadow: 0 24px 40px -18px #000; }
.bar .label { margin: 0; }
.arrow { border: 0; background: transparent; color: var(--dim); font-size: 14px; padding: 0 2px; }
.arrow:hover { color: var(--on); }
.count { color: var(--faint); font-size: 11px; font-variant-numeric: tabular-nums; }
.pfwrap { margin: 0; }
.pf-open { padding-right: 13px; }
.pf-open { letter-spacing: 0; text-transform: none; font-size: 0; }
.pf-open b { display: inline-block; min-width: 13ch; text-align: center; font-size: 12px; }
.drop { left: 50%; transform: translateX(-50%); }`;
  const wrap = el('div', 'wrap');
  const bar = el('div', 'bar');
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Colors');
  const prev = button('arrow off-dim', '‹', 'Previous profile');
  const next = button('arrow off-dim', '›', 'Next profile');
  const count = el('span', 'count off-dim');
  prev.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  bar.append(el('div', 'label', 'color'), colorsSwitch(), prev, profileMenu(() => bar, true), next, count);
  bar.addEventListener('keydown', (e) => {
    if ((e.target as Element).closest('.drop')) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); step(e.key === 'ArrowLeft' ? -1 : 1); }
  });
  subs.push(() => { const i = rows().findIndex((r) => r.id === cur.profile); count.textContent = `${i + 1}/${rows().length}`; bar.classList.toggle('coff', !cur.on); });
  wrap.append(bar);
  sh.append(style, wrap);
  keys(bar);
  for (const ev of ['click', 'dblclick', 'mousedown', 'pointerdown', 'keydown', 'wheel']) host.addEventListener(ev, (e) => e.stopPropagation());
  document.body.append(host);
  // Fades with the menu button (idle mouse), stays while its list is open.
  const fade = () => wrap.classList.toggle('idle', p.wrap.classList.contains('idle') && !bar.classList.contains('listing'));
  new MutationObserver(fade).observe(p.wrap, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(fade).observe(bar, { attributes: true, attributeFilter: ['class'] });
  Object.assign(window, { barRoot: sh });
}

const VARIANTS: Record<string, (p: MenuParts) => void> = { A: tabs, B: compact, C: chipsMore, D: secondButton, E: bottomBar };

export async function mountVariant(v: string, p: MenuParts): Promise<void> {
  cur = await loadColor();
  const style = el('style');
  style.textContent = CSS + DESIGN_CSS;
  p.shadow.append(style);
  (VARIANTS[v] ?? tabs)(p);
  // Colors off: everything but the switch steps back (as in the popup).
  subs.push(() => { p.wrap.classList.toggle('coff', !cur.on); });
  paint();
  // A change from elsewhere (the popup) shows here too, as it would in the content script.
  onColorChanged((s) => { if (JSON.stringify(s) !== JSON.stringify(cur)) { cur = s; paint(); } });
  Object.assign(window, { colorCtl: { get: () => cur, pick, setValue } });
}
export type { ColorValues };

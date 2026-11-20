// The fullscreen menu's color tab: profiles only (fine tuning stays in the popup).
// Two chips (colors on/off, "always": also when not upscaled), a caption saying where colors go
// or what state they are in, a line, then the saved profiles numbered in two columns. Keys 1-9
// pick a profile, arrows move between profiles. State lives in chrome.storage via color.ts; this
// tab only shows it and writes the user's picks.

import { type ColorState, isNeutral, sameValues, saveColor } from './color';

export const COLOR_TAB_CSS = `
.cpage { display: grid; gap: 8px; }
.crow, .pcols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 9px; }
.pcols { row-gap: 4px; }
/* chips: icon + word, the menu's button look; white when on, crossed icon and dim word when off. No hover effect. */
.chip { display: grid; grid-auto-flow: column; place-items: center; justify-content: center; gap: 6px; height: 24.5px; padding: 0 8px;
  border: 1px solid #3a3a3a; background: transparent; color: #8d8d8d; font-size: 11px; }
.chip .w { color: #585858; }
.chip[aria-checked="true"] { background: #fff; border-color: #fff; color: #000; }
.chip[aria-checked="true"] .w { color: #000; }
.chip[aria-checked="true"] .x { display: none; }
/* the caption: one fixed line, then a line splitting the toggles from the profiles (8px either side) */
.ccap { height: 17px; margin-top: -4px; padding-bottom: 5px; border-bottom: 1px solid #262626; display: flex; align-items: center; justify-content: center; }
.ccap .ed { color: #8d8d8d; font-size: 11px; white-space: nowrap; }
.ccap .ed i { font-style: normal; color: #e3c58a; font-size: 9px; margin-right: 6px; vertical-align: 1px; }
.ccap .ed.na i { color: #e39a9a; }
/* "colors on/off" centred under the colors chip, where colors go centred under the always chip */
.ccap .ed.split { flex: 1; display: grid; grid-template-columns: 1fr 1fr; column-gap: 9px; text-align: center; }
.ccap .ed.split .dim { color: #585858; }
/* profiles: the popup's numbered list; the current one keeps the hover card, green number, white bold name */
.pr { position: relative; display: grid; grid-template-columns: 2ch minmax(0, 1fr); column-gap: 6px; padding: 3px 8px;
  border: 1px solid transparent; background: transparent; color: #e4e4e4; font-size: 11px; text-align: left; }
.pr:hover, .pr:focus-visible, .pr[aria-checked="true"] { background: #1a1a1a; border-color: #3a3a3a; outline: none; }
.pr .k { color: #585858; text-align: right; font-variant-numeric: tabular-nums; }
.pr b { font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr[aria-checked="true"] .k { color: #9fd3a8; font-weight: 600; }
.pr[aria-checked="true"] b { color: #fff; font-weight: 600; }
.pr.c1::after { content: ""; position: absolute; top: -3px; bottom: -3px; right: -5px; border-right: 1px solid #3a3a3a; pointer-events: none; }
/* colors off: the profiles and "always" step back; on but not reaching the picture: the profiles do */
.off-dim { transition: opacity .12s; }
.cpage.coff .off-dim { opacity: .35; pointer-events: none; }
.cpage.na .pcols { opacity: .35; }
`;

const DROP_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M8 1.8C8 1.8 3.5 6.8 3.5 9.8a4.5 4.5 0 0 0 9 0C12.5 6.8 8 1.8 8 1.8z"/><path class="x" d="M3 2l10 12"/></svg>';
const SCREEN_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="1.5" y="3" width="13" height="9" rx="1"/><path d="M5.5 14.5h5"/><path class="x" d="M3 1.5l10 12"/></svg>';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Colors reach the picture: switched on, not neutral, and the video is upscaled or "always" is on. */
export function colorsShown(c: ColorState, upscaled: boolean): boolean {
  return c.on && !isNeutral(c.values) && (upscaled || c.always);
}

/** The state line, one thing at a time: not upscaled (on, but not applied), custom, edited in the popup. */
function stateText(c: ColorState, upscaled: boolean): string {
  if (c.on && !upscaled && !c.always) return 'not upscaled';
  if (c.profile === 'custom') return 'custom';
  const p = c.profiles.find((x) => x.id === c.profile);
  return p && !p.builtIn && !sameValues(c.values, p.v) ? 'edited in popup' : '';
}

export class FullscreenColorTab {
  readonly el = el('div', 'cpage');

  private readonly colorsChip: HTMLButtonElement;

  private readonly alwaysChip: HTMLButtonElement;

  private readonly caption = el('span', 'ed');

  private readonly grid = el('div', 'pcols off-dim');

  private cur: ColorState | null = null;

  private shownList = '';

  /** `genuine` vets every click (the menu's clickjacking guard). */
  constructor(private readonly genuine: (e: Event) => boolean) {
    this.colorsChip = this.chip(DROP_SVG, 'colors', '', (c) => ({ on: !c.on }));
    this.alwaysChip = this.chip(SCREEN_SVG, 'always', ' off-dim', (c) => ({ always: !c.always }));
    const chips = el('div', 'crow');
    chips.append(this.colorsChip, this.alwaysChip);
    const cap = el('div', 'ccap');
    cap.append(this.caption);
    this.grid.setAttribute('role', 'radiogroup');
    this.grid.setAttribute('aria-label', 'Color profile');
    this.el.append(chips, cap, this.grid);
    this.el.addEventListener('keydown', (e) => this.onKey(e));
  }

  private chip(svg: string, word: string, extra: string, flip: (c: ColorState) => Partial<ColorState>): HTMLButtonElement {
    const b = el('button', `chip${extra}`);
    b.type = 'button';
    b.setAttribute('role', 'switch');
    b.innerHTML = svg; // a fixed icon from this file
    b.append(el('span', 'w', word));
    b.addEventListener('click', (e) => { if (this.genuine(e)) saveColor(flip).catch(() => {}); });
    return b;
  }

  /** Picks a saved profile: its values become the current ones. */
  private pick(id: string) {
    saveColor((c) => {
      const p = c.profiles.find((x) => x.id === id);
      return p ? { profile: id, values: { ...p.v } } : {};
    }).catch(() => {});
  }

  private onKey(e: KeyboardEvent) {
    // genuine(): a page that hid the menu must not have the user's key presses change settings.
    if (!this.cur?.on || !this.genuine(e)) return;
    if (/^[1-9]$/.test(e.key)) {
      const p = this.cur.profiles[Number(e.key) - 1];
      if (p) { e.preventDefault(); this.pick(p.id); }
      return;
    }
    const t = e.target as HTMLElement;
    if (!t.closest('.pcols') || !['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const bs = [...this.grid.querySelectorAll<HTMLElement>('button')];
    const i = bs.indexOf(t);
    const forward = e.key === 'ArrowDown' || e.key === 'ArrowRight';
    bs[(i + (forward ? 1 : -1) + bs.length) % bs.length]?.focus();
    e.preventDefault();
  }

  /** Shows `c`; `upscaled`: the video in fullscreen is upscaled now. */
  render(c: ColorState, upscaled: boolean) {
    this.cur = c;
    const state = stateText(c, upscaled);
    this.el.classList.toggle('coff', !c.on);
    // Colors off: the dimmed controls are out of reach for the keyboard too, as for the mouse.
    this.grid.inert = !c.on;
    this.alwaysChip.inert = !c.on;
    this.el.classList.toggle('na', state === 'not upscaled');
    this.colorsChip.setAttribute('aria-checked', String(c.on));
    this.colorsChip.setAttribute('aria-label', c.on ? 'colors: on' : 'colors: off');
    this.alwaysChip.setAttribute('aria-checked', String(c.always));
    this.alwaysChip.setAttribute('aria-label', c.always ? 'always: also when not upscaled' : 'always: off, upscaled videos only');
    this.paintCaption(c, state);
    this.paintProfiles(c);
  }

  private paintCaption(c: ColorState, state: string) {
    const ed = this.caption;
    ed.classList.toggle('na', state === 'not upscaled');
    ed.classList.toggle('split', !state);
    if (state) {
      ed.replaceChildren(el('i', '', '●'), state);
      ed.setAttribute('aria-label', state === 'not upscaled' ? 'Colors not applied: the video is not upscaled' : state);
      return;
    }
    const where = c.always ? 'every video' : 'upscaled only';
    ed.replaceChildren(el('span', '', c.on ? 'colors on' : 'colors off'), el('span', c.on ? '' : 'dim', where));
    ed.setAttribute('aria-label', c.on ? `colors on, ${where}` : 'colors off');
  }

  /** Rebuilt only when the list changes: a rebuilt button would drop the keyboard focus. */
  private paintProfiles(c: ColorState) {
    const sig = c.profiles.map((p) => `${p.id}\n${p.name}`).join('\n');
    if (sig !== this.shownList) {
      this.shownList = sig;
      // A rename or a new profile from the popup rebuilds the list: keep the focus on the same profile.
      const root = this.grid.getRootNode() as Document | ShadowRoot;
      const focused = (root.activeElement as HTMLElement | null)?.closest<HTMLElement>('.pr')?.dataset.id;
      this.grid.replaceChildren(...c.profiles.map((p, i) => {
        const b = el('button', i % 2 === 0 ? 'pr c1' : 'pr');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.dataset.id = p.id;
        b.append(el('span', 'k', i < 9 ? String(i + 1) : ''), el('b', '', p.name));
        b.addEventListener('click', (e) => { if (this.genuine(e)) this.pick(p.id); });
        return b;
      }));
      if (focused) [...this.grid.querySelectorAll<HTMLElement>('.pr')].find((b) => b.dataset.id === focused)?.focus();
    }
    for (const b of this.grid.querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-checked', String(b.dataset.id === c.profile));
  }
}

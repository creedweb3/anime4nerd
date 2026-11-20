// Designs of option A's color tab in fullscreen (fullscreen-color-demo.html, #v=A&c=A1|A2).
// Profiles only: no sliders in fullscreen. Both designs follow the upscale tab next to them: the
// menu's .label heading, the menu's controls at their own size (one row = one .opt button high),
// 8px between groups and 4px inside a group, all on the box's content width. Both keep colors
// on/off and "always" (also use colors when not upscaled) as the menu's "✓ / +" toggles, the 1-9
// keys, and say "edited in popup" when the values differ from the selected saved profile
// (fullscreen offers no update, save or reset for that).

import type { ColorProfile } from '../src/color';
import { button, el, keys, persist, pick, state, subs, upscaledNow } from './fullscreen-color-variants';

export const DESIGN_CSS = `
.cpage { display: grid; gap: 8px; }
/* heading row: the menu's .label on the left, "● edited in popup" on the right when it applies */
.lrow2 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.lrow2 .label { margin: 0; }
.lrow2 .ed { color: var(--dim); font-size: 10px; white-space: nowrap; }
.lrow2 .ed i { font-style: normal; color: #e3c58a; font-size: 8px; margin-right: 5px; vertical-align: 1px; }
.cpage > .row .opt { flex: 1 1 0; }
/* the heading: one fixed height (a menu button's) in every style and state */
.lrow2 { align-items: center; height: 15px; } /* the menu's .label line: one fixed height in every state */
.hright { display: flex; align-items: center; gap: 4px; min-width: 0; }
.hright .ed { margin-right: 4px; }
.lrow2 .ed.na i { color: #e39a9a; }
/* colors on but not applied (video not upscaled, always off): the profiles step back */
.cpage.na .pcols { opacity: .35; transition: opacity .12s; }
/* t4: square icon toggles, as tall as a menu button; white when on; a tip under each */
.ib { position: relative; display: grid; place-items: center; width: 26px; height: 24.5px; padding: 0; border: 1px solid #3a3a3a; background: transparent; color: #8d8d8d; }
.ib:not(.chip):hover { color: #e4e4e4; border-color: #e4e4e4; }
.ib[aria-checked="true"] { background: #fff; border-color: #fff; color: #000; }
.ib[aria-checked="true"] .x { display: none; }
.ib .tip { position: absolute; right: 0; top: calc(100% + 4px); z-index: 6; padding: 3px 6px; border: 1px solid #3a3a3a; background: #111; color: #e4e4e4; font-size: 10px; white-space: nowrap; visibility: hidden; pointer-events: none; }
.ib:hover .tip, .ib:focus-visible .tip { visibility: visible; }
/* the chips: icon + word centred, the menu's button style: white when on; crossed icon and dim word when off.
   They sit on the profile grid's two columns, with its column gap (A1 list 9px, A2 tiles 4px). */
.crow { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 4px; }
.crow.plist2 { column-gap: 9px; }
.cap2 { height: 17px; margin-top: -4px; display: flex; align-items: center; justify-content: center; }
/* a line under the caption, splitting the toggles from the profiles (asked for by the user) */
.cap2 { box-sizing: content-box; padding-bottom: 5px; border-bottom: 1px solid #262626; } /* text to line = line to profiles = 8px, measured */
.cap2 .ed { color: #8d8d8d; font-size: 11px; white-space: nowrap; }
.cap2 .ed i { font-style: normal; color: #e3c58a; font-size: 9px; margin-right: 6px; vertical-align: 1px; }
.cap2 .ed.na i { color: #e39a9a; }
/* The mode line in two halves on the chips' columns (same column gap as the chip row above), each centred under its chip */
.cap2 .ed.split { flex: 1; display: grid; grid-template-columns: 1fr 1fr; align-items: center; text-align: center; }
.cap2 .ed.split { column-gap: 4px; }
.crow.plist2 + .cap2 .ed.split { column-gap: 9px; }
.cap2 .ed.split .sr.dim { color: #585858; }
.cap2.left { justify-content: flex-start; }
.ib.chip { width: auto; grid-auto-flow: column; justify-content: center; gap: 6px; padding: 0 8px; font-size: 11px; }
.ib.chip .w { color: #585858; }
.ib.chip[aria-checked="true"] .w { color: #000; }
/* No hover effect on the chips (the user's call); the look changes only with on/off. Keyboard focus keeps an outline. */
.ib.chip:focus-visible { outline: 1px solid #fff; outline-offset: 1px; }
.ib.chip .tip { left: 0; right: 0; white-space: normal; text-align: left; } /* spans its chip, wraps: never past the menu edge */
/* both designs: two equal columns, 4px apart; an odd count leaves the last row's right cell empty */
.pcols { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; }
.pcols .k { color: var(--faint); text-align: right; font-variant-numeric: tabular-nums; }
.pcols b { font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* A1 list: the popup's profile list. Rows as tall as a menu button, no box until hovered;
   the current one: green number, white bold name. A line between the columns. */
.plist2 { column-gap: 9px; }
.plist2 .pr { position: relative; display: grid; grid-template-columns: 2ch minmax(0, 1fr); column-gap: 6px; padding: 3px 8px; border: 1px solid transparent; background: transparent; color: var(--fg); font-size: 11px; text-align: left; }
.plist2 .pr:hover, .plist2 .pr:focus-visible { background: #1a1a1a; border-color: #3a3a3a; outline: none; }
.plist2 .pr[aria-checked="true"] { background: #1a1a1a; border-color: #3a3a3a; } /* the selected row keeps the hover card */
.plist2 .pr[aria-checked="true"] .k { color: #9fd3a8; font-weight: 600; }
.plist2 .pr[aria-checked="true"] b { color: #fff; font-weight: 600; }
.plist2 .pr.c1::after { content: ""; position: absolute; top: -3px; bottom: -3px; right: -5px; border-right: 1px solid #3a3a3a; pointer-events: none; }
/* A2 tiles: the preset tiles' own button (.opt), number and name; white when selected */
/* A3-A5: list and tiles combined. Same grid as A2 (two columns, 4px apart, 24.5px rows), so the
   chips above line up; one row = number column + name, as in the list. */
.hyb .pr { position: relative; display: grid; grid-template-columns: 2ch minmax(0, 1fr); column-gap: 6px; padding: 3px 8px; border: 1px solid transparent; background: transparent; color: var(--fg); font-size: 11px; text-align: left; }
.hyb .pr:focus-visible { outline: 1px solid #fff; outline-offset: 1px; }
/* A3: quiet rows; hover shows the tile outline; the selected row is A2's white tile */
.hyb-tile .pr:hover { border-color: #3a3a3a; }
.hyb-tile .pr[aria-checked="true"] { background: #fff; border-color: #fff; color: #000; }
.hyb-tile .pr[aria-checked="true"] .k { color: #000; }
.hyb-tile .pr[aria-checked="true"] b { font-weight: 600; }
/* A4: faint tiles; selected: white outline, green number, bold white name (no fill) */
.hyb-faint .pr { border-color: rgba(255,255,255,.08); background: rgba(255,255,255,.03); }
.hyb-faint .pr:hover { border-color: #3a3a3a; }
.hyb-faint .pr[aria-checked="true"] { border-color: #fff; }
.hyb-faint .pr[aria-checked="true"] .k { color: #9fd3a8; font-weight: 600; }
.hyb-faint .pr[aria-checked="true"] b { color: #fff; font-weight: 600; }
/* A5: list rows; selected: a 2px white bar on the left edge, green number, bold white name */
.hyb-bar .pr:hover { background: #1a1a1a; }
.hyb-bar .pr[aria-checked="true"]::before { content: ""; position: absolute; left: -1px; top: -1px; bottom: -1px; width: 2px; background: #fff; }
.hyb-bar .pr[aria-checked="true"] { background: #1a1a1a; }
.hyb-bar .pr[aria-checked="true"] .k { color: #9fd3a8; font-weight: 600; }
.hyb-bar .pr[aria-checked="true"] b { color: #fff; font-weight: 600; }
.ptiles2 .opt { display: grid; grid-template-columns: 2ch minmax(0, 1fr); column-gap: 6px; padding: 3px 8px; text-align: left; }
.ptiles2 .opt[aria-checked="true"] .k { color: #000; }
.ptiles2 .opt[aria-checked="true"] b { font-weight: 600; }
`;

/** The selected saved profile has values that differ from it (changed in the popup, not saved). */
function edited(): boolean {
  const s = state();
  const p = s.profiles.find((x) => x.id === s.profile);
  return !!p && !p.builtIn && JSON.stringify(p.v) !== JSON.stringify(s.values);
}
/** Colors switched on but not reaching the picture: the video is not upscaled and "always" is off. */
const notApplied = () => state().on && !upscaledNow() && !state().always;

/** The state line, one thing at a time: not upscaled (colors on, not applied), custom, edited in popup. */
function stateText(): string {
  return notApplied() ? 'not upscaled' : state().profile === 'custom' ? 'custom' : edited() ? 'edited in popup' : '';
}
/** Paints "● <state>" into `ed`; with `fallback`, shows that (no dot) when there is no state. */
function paintState(ed: HTMLElement, fallback = ''): void {
  const text = stateText();
  ed.hidden = !text && !fallback;
  ed.classList.toggle('na', notApplied());
  ed.classList.toggle('quiet', !text);
  ed.replaceChildren(...(text ? [el('i', '', '●'), text] : [fallback]));
  ed.setAttribute('aria-label', notApplied() ? 'Colors not applied: the video is not upscaled' : text || fallback);
}
const setOn = (on: boolean) => persist({ on });
const setAlways = (always: boolean) => persist({ always });

const SCREEN_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="1.5" y="3" width="13" height="9" rx="1"/><path d="M5.5 14.5h5"/><path class="x" d="M3 1.5l10 12"/></svg>';
const DROP_SVG = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M8 1.8C8 1.8 3.5 6.8 3.5 9.8a4.5 4.5 0 0 0 9 0C12.5 6.8 8 1.8 8 1.8z"/><path class="x" d="M3 2l10 12"/></svg>';

/**
 * t4: two icon toggles, a drop for colors and a screen for always, white when on, crossed out when
 * off; a tip on hover or focus. `words`: the icon carries its word ("colors", "always") as a chip.
 */
function t4Icons(words = false): HTMLElement[] {
  const icon = (svg: string, word: string, tipOn: string, tipOff: string, get: () => boolean, set: (v: boolean) => void, cls: string) => {
    const b = button(`ib ${cls}${words ? ' chip' : ''}`, '', tipOn);
    b.setAttribute('role', 'switch');
    b.innerHTML = svg;
    if (words) b.append(el('span', 'w', word));
    // The chips carry their word, so no hover tip (the user found it annoying); only screen readers get the state.
    const tip = words ? null : b.appendChild(el('span', 'tip'));
    b.addEventListener('click', () => set(!get()));
    subs.push(() => {
      const label = get() ? tipOn : tipOff;
      b.setAttribute('aria-checked', String(get()));
      if (tip) tip.textContent = label;
      b.setAttribute('aria-label', label);
    });
    return b;
  };
  return [
    icon(DROP_SVG, 'colors', 'colors: on', 'colors: off', () => state().on, setOn, 'cico'),
    icon(SCREEN_SVG, 'always', 'always: also when not upscaled', 'always: off, upscaled videos only', () => state().always, setAlways, 'aico2 off-dim'),
  ];
}

/** The two toggles as icon + word chips on the profile grid's two columns: colors left, always right. */
function chipRow(gridCls: string): HTMLElement {
  const row = el('div', `crow ${gridCls}`);
  row.append(...t4Icons(true));
  return row;
}

/** Where colors go now, in a few words. */
const modeText = () => (!state().on ? 'colors off' : state().always ? 'colors on · every video' : 'colors on · upscaled only');

/**
 * The caption under the chips: where colors go now, or, when one applies, the state in its place
 * ("● not upscaled", "● custom", "● edited in popup"). One fixed line, so the height never changes.
 */
function caption(): HTMLElement {
  const cap = el('div', 'cap2');
  const ed = el('span', 'ed');
  cap.append(ed);
  subs.push(() => {
    paintState(ed, modeText());
    ed.classList.remove('split');
    if (stateText()) return;
    // The plain mode line gets its own dot: green when colors are on, red when off.
    // Two halves on the chips' columns: "● colors on/off" centred under the colors chip, where colors
    // go centred under the always chip (dimmed while colors are off).
    const left = el('span', 'sl', state().on ? 'colors on' : 'colors off');
    const right = el('span', `sr${state().on ? '' : ' dim'}`, state().always ? 'every video' : 'upscaled only');
    ed.classList.add('split');
    ed.replaceChildren(left, right);
  });
  return cap;
}

/** The page: the chips on the grid's columns, the caption under them, then the profiles. */
function page(grid: HTMLElement): HTMLElement {
  const main = el('div', 'cpage');
  // Colors on but not reaching the picture: the profiles step back, as when colors are off.
  subs.push(() => main.classList.toggle('na', notApplied()));
  main.append(chipRow(grid.classList.contains('plist2') ? 'plist2' : 'ptiles2'), caption(), grid);
  return main;
}
/** Saved profiles numbered 1-9 in two columns, row by row. No custom: it can't be adjusted in fullscreen. */
function profiles(cls: string, itemCls: string): HTMLElement {
  const g = el('div', `pcols ${cls} off-dim`);
  g.setAttribute('role', 'radiogroup');
  g.setAttribute('aria-label', 'Profile');
  let shown = '';
  subs.push(() => {
    // Rebuild only when the profiles change: a rebuilt button would drop the keyboard focus.
    const list = state().profiles;
    const sig = list.map((p) => `${p.id}:${p.name}`).join('|');
    if (sig === shown) {
      for (const b of g.children) b.setAttribute('aria-checked', String((b as HTMLElement).dataset.id === state().profile));
      return;
    }
    shown = sig;
    g.replaceChildren(...list.map((p: ColorProfile, i) => {
      const b = button(`${itemCls}${i % 2 === 0 ? ' c1' : ''}`);
      b.setAttribute('role', 'radio');
      b.dataset.id = p.id;
      b.setAttribute('aria-checked', String(p.id === state().profile));
      b.append(el('span', 'k', String(i + 1)), el('b', '', p.name));
      b.addEventListener('click', () => pick(p.id));
      return b;
    }));
  });
  return g;
}

/** A1 list: the popup's numbered list, two columns, a line between them. */
const a1 = () => profiles('plist2', 'pr');
/** A2 tiles: the preset tiles' buttons, number and name, two equal columns. */
const a2 = () => profiles('ptiles2', 'opt');

/** A3 rows that become a tile: quiet list rows; the selected one a white tile, a tile outline on hover. */
const a3 = () => profiles('hyb hyb-tile', 'pr');
/** A4 faint tiles with list numbers: barely-there tiles; selected: white outline, green number, bold white name. */
const a4 = () => profiles('hyb hyb-faint', 'pr');
/** A5 list with a marker: list rows; the selected one has a white bar on its left edge. */
const a5 = () => profiles('hyb hyb-bar', 'pr');

export const COLOR_TABS: Record<string, () => HTMLElement> = { A1: a1, A2: a2, A3: a3, A4: a4, A5: a5 };
/** Builds a design; returns it and a function that drops its paint callbacks. (`_t`: toggle style; only t4a is left.) */
export function buildDesign(c: string, _t?: string): { main: HTMLElement; drop: () => void } {
  const from = subs.length;
  const main = page((COLOR_TABS[c] ?? a1)());
  keys(main);
  const mine = subs.slice(from);
  return { main, drop: () => { for (const f of mine) subs.splice(subs.indexOf(f), 1); } };
}

// The popup's folder tabs (upscale · color) and the color tab: ten sliders, the profile menu in
// the color head, the colors on/off switch and "also use colors when not upscaled". The state
// lives in chrome.storage.local (color.ts); the content script applies `values`.

import {
  COLOR_KEYS, COLOR_RANGE, COLOR_UNIT, MAX_PROFILES, NEUTRAL_COLOR, PERCENT_KEYS, PROFILE_NAME_MAX, UNIPOLAR,
  ColorKey, ColorProfile, ColorState, ColorValues, DEFAULT_COLOR,
  cleanName, formatColor, isNeutral, loadColor, normalizeColor, onColorChanged, sameValues, saveColor,
  snapColor, toPosition, toValue,
} from './color';

const byQ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// --- state and its writes -------------------------------------------------------------
const WRITE_MS = 50; // slider moves are written at most this often; the last one always is
let cur: ColorState = DEFAULT_COLOR;
let pending: Partial<ColorState> = {};
let writeTimer = 0;
let lastWrite = 0;
let inflight = 0;

function flush() {
  const patch = pending;
  pending = {};
  lastWrite = performance.now();
  inflight += 1;
  void saveColor(patch).finally(() => { inflight -= 1; });
}

/** Updates the popup's state at once and stores it: at once, or (throttle) at most every WRITE_MS. */
function persist(patch: Partial<ColorState>, throttle = false) {
  cur = { ...cur, ...patch };
  pending = { ...pending, ...patch };
  if (writeTimer) {
    if (throttle) return;
    window.clearTimeout(writeTimer);
    writeTimer = 0;
  }
  const wait = throttle ? WRITE_MS - (performance.now() - lastWrite) : 0;
  if (wait <= 0) flush();
  else writeTimer = window.setTimeout(() => { writeTimer = 0; flush(); }, wait);
}

// The popup closing inside the throttle window must still store the last slider value.
window.addEventListener('pagehide', () => {
  if (!writeTimer) return;
  window.clearTimeout(writeTimer);
  writeTimer = 0;
  flush();
});

// --- sliders ------------------------------------------------------------------------------
interface Slider { el: HTMLElement; set(v: number, emit?: boolean): void; setBase(v: number): void }

const FINE = 0.1; // Shift while dragging: ten times finer
const NOTCH_PX = 100; // one wheel notch; many mice and touchpads send it as several small events
const WHEEL_UNIT_PX = [1, 40, 400]; // deltaMode pixels, lines, pages
const RESET_SVG = '<svg viewBox="0 0 12 12" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6a3.5 3.5 0 1 0 1.1-2.55"/><path d="M2.3 1.6v2.2h2.2"/></svg>';

function sliderRow(k: ColorKey): HTMLElement {
  const [min, max] = COLOR_RANGE[k];
  const row = document.createElement('div');
  row.className = 'cs cs-row';
  row.dataset.k = k;
  row.innerHTML = `<span class="cs-name">${k}</span>`
    + `<div class="cs-track" role="slider" tabindex="0" aria-label="${k}" aria-valuemin="${min}" aria-valuemax="${max}"><i class="cs-zero"></i><i class="cs-fill"></i><i class="cs-thumb"></i></div>`
    + `<span class="cs-end"><button type="button" class="cs-reset" aria-label="reset ${k}" data-tip="reset ${k}">${RESET_SVG}</button>`
    + `<b class="cs-val" tabindex="0" role="button" aria-label="type a value for ${k}"></b></span>`;
  return row;
}

/** Drag: the thumb stays under the pointer (Shift: finer); a press on the bare track jumps there first. */
function wireDrag(track: HTMLElement, lo: number, getPos: () => number, setPos: (t: number) => void) {
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    track.setPointerCapture(e.pointerId);
    const r = track.getBoundingClientRect();
    if (!(e.target as Element).classList.contains('cs-thumb')) setPos(lo + ((e.clientX - r.left) / r.width) * (1 - lo));
    let last = e.clientX;
    let raw = getPos(); // unrounded, so slow drags still add up
    const move = (ev: PointerEvent) => {
      raw = clamp(raw + ((ev.clientX - last) / r.width) * (1 - lo) * (ev.shiftKey ? FINE : 1), lo, 1);
      last = ev.clientX;
      setPos(raw);
    };
    // A touch or pen drag can end in a cancel or a lost capture instead of pointerup.
    const ends = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;
    const up = () => { track.removeEventListener('pointermove', move); for (const ev of ends) track.removeEventListener(ev, up); };
    track.addEventListener('pointermove', move);
    for (const ev of ends) track.addEventListener(ev, up);
  });
}

/** The wheel: one step per notch, counted by distance (Shift: ten). */
function wireWheel(track: HTMLElement, step: (n: number) => void) {
  let acc = 0;
  track.addEventListener('wheel', (e) => {
    e.preventDefault();
    const px = e.deltaY * (WHEEL_UNIT_PX[e.deltaMode] ?? 1);
    if (Math.sign(px) !== Math.sign(acc)) acc = 0; // a change of direction starts fresh
    acc += px;
    const notches = Math.trunc(acc / NOTCH_PX);
    if (!notches) return;
    acc -= notches * NOTCH_PX;
    step(-notches * (e.shiftKey ? 10 : 1));
  }, { passive: false });
}

const KEY_STEPS: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
const PAGE_STEPS: Record<string, number> = { PageUp: 10, PageDown: -10 };

/** Arrows: one step (Shift: ten); PageUp/PageDown: ten; Home, 0 or a double click: neutral. */
function wireKeys(track: HTMLElement, step: (n: number) => void, reset: () => void) {
  track.addEventListener('keydown', (e) => {
    const n = e.key in KEY_STEPS ? KEY_STEPS[e.key] * (e.shiftKey ? 10 : 1) : PAGE_STEPS[e.key];
    if (n) { step(n); e.preventDefault(); }
    if (e.key === 'Home' || e.key === '0') { reset(); e.preventDefault(); }
  });
  track.addEventListener('dblclick', reset);
}

/** Click the number (or Enter on it) to type a value; the percent ones are typed as percent. */
function wireTyping(val: HTMLElement, k: ColorKey, get: () => number, set: (v: number) => void) {
  const open = () => {
    const asPct = PERCENT_KEYS.has(k);
    const inp = document.createElement('input');
    inp.className = 'cs-input';
    inp.value = asPct ? String(Math.round(get() * 100)) : get().toFixed(COLOR_UNIT[k] >= 1 ? 0 : 2);
    inp.setAttribute('aria-label', k);
    inp.inputMode = 'decimal';
    const fitWidth = () => { inp.style.width = `${Math.max(2, inp.value.length) + 0.3}ch`; }; // Firefox has no field-sizing
    fitWidth();
    inp.addEventListener('input', fitWidth);
    const box = document.createElement('span');
    box.className = 'cs-edit';
    box.append(inp);
    if (asPct) box.insertAdjacentHTML('beforeend', '<span class="cs-unit">%</span>');
    val.replaceWith(box);
    inp.select();
    let done = false;
    const close = (apply: boolean) => {
      if (done) return;
      done = true;
      const typed = parseFloat(inp.value.replace('−', '-').replace(/[^0-9.+-]/g, ''));
      box.replaceWith(val);
      if (apply && Number.isFinite(typed)) set(asPct ? typed / 100 : typed);
      val.focus();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(true);
      if (e.key === 'Escape') { e.preventDefault(); close(false); } // Esc would close the popup
    });
    inp.addEventListener('blur', () => close(true));
  };
  val.addEventListener('click', open);
  val.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
}

/** A custom slider: a thin track, a tick at neutral, a fill from neutral to the thumb. Values are color.ts units. */
function makeSlider(k: ColorKey, onInput: (k: ColorKey, v: number) => void): Slider {
  const lo = UNIPOLAR.has(k) ? 0 : -1;
  const row = sliderRow(k);
  const track = byQ<HTMLElement>('.cs-track', row);
  const val = byQ<HTMLElement>('.cs-val', row);
  const frac = (t: number) => ((t - lo) / (1 - lo)) * 100; // percent across the track
  let v = NEUTRAL_COLOR[k];
  // The selected profile's own value: ↺ shows (and resets to it) only when the value differs.
  let base = NEUTRAL_COLOR[k];
  function paint() {
    const p = frac(toPosition(k, v)), z = frac(0);
    track.style.setProperty('--p', `${p}%`);
    track.style.setProperty('--z', `${z}%`);
    track.style.setProperty('--a', `${Math.min(p, z)}%`);
    track.style.setProperty('--w', `${Math.abs(p - z)}%`);
    const text = formatColor(k, v);
    row.classList.toggle('changed', v !== NEUTRAL_COLOR[k]);
    row.classList.toggle('edited', v !== base);
    row.classList.toggle('long', text.length > 4);
    val.textContent = text;
    track.setAttribute('aria-valuenow', String(v));
    track.setAttribute('aria-valuetext', text);
  }
  function set(nv: number, emit = true) {
    const next = snapColor(k, nv);
    const moved = next !== v;
    v = next;
    paint();
    if (emit && moved) onInput(k, v);
  }
  const step = (n: number) => set(v + n * COLOR_UNIT[k]);
  const reset = () => set(base);
  wireDrag(track, lo, () => toPosition(k, v), (t) => set(toValue(k, clamp(t, lo, 1))));
  wireWheel(track, step);
  wireKeys(track, step, reset);
  wireTyping(val, k, () => v, set);
  byQ<HTMLElement>('.cs-reset', row).addEventListener('click', () => { reset(); track.focus(); });
  paint();
  return { el: row, set, setBase(b: number) { base = b; paint(); } };
}

const sliders = {} as Record<ColorKey, Slider>;

function showValues(v: ColorValues) {
  for (const k of COLOR_KEYS) sliders[k].set(v[k], false);
}

// --- elements ------------------------------------------------------------------------------
const panel = byQ<HTMLElement>('#color');
const host = byQ<HTMLElement>('#pf');
const acts = byQ<HTMLElement>('#pf-actions');
const tabsEl = byQ<HTMLElement>('#c-tabs');
const changedDot = byQ<HTMLElement>('#c-dot');
const power = byQ<HTMLInputElement>('#c-power');
const always = byQ<HTMLElement>('#c-always');
const alwaysInput = byQ<HTMLInputElement>('input', always);
const alwaysState = byQ<HTMLElement>('#c-always-state');

// --- profiles ------------------------------------------------------------------------------
type Naming = { mode: 'new' } | { mode: 'rename'; id: string } | null;
interface Row { id: string; name: string; builtIn?: boolean }

const TWO_COLS_FROM = 9; // rows, counting custom
let open = false;
let activeRow = -1;
let moreFor: string | null = null;
let confirmDelete = false;
let naming: Naming = null;
let asking: HTMLElement | null = null;
let shownLine = ''; // what the head and the line under it showed when last rendered

const saved = () => cur.profiles;
const byId = (id: string): ColorProfile | undefined => saved().find((p) => p.id === id);
const rows = (): Row[] => [...saved(), { id: 'custom', name: 'custom' }];
const twoCols = () => rows().length >= TWO_COLS_FROM;
const colRows = () => Math.ceil(saved().length / 2);
const currentName = () => (cur.profile === 'custom' ? 'custom' : byId(cur.profile)?.name ?? 'neutral');

/** A saved profile whose values differ from those on screen. */
function dirty(): boolean {
  const p = byId(cur.profile);
  return !!p && !p.builtIn && !sameValues(cur.values, p.v);
}
const customToSave = () => cur.profile === 'custom' && !isNeutral(cur.custom);
const lineKey = () => `${cur.profile}|${currentName()}|${dirty()}|${customToSave()}`;

function setOpen(o: boolean) {
  open = o;
  document.body.classList.toggle('pf-listing', o); // not 'pf-open': that is the head button's class
  if (!o) { moreFor = null; confirmDelete = false; activeRow = -1; }
}
function closeList() { setOpen(false); renderProfiles(); }

/** Selects a profile: its values go on screen. */
function switchTo(id: string) {
  naming = null; moreFor = null; confirmDelete = false;
  const values = id === 'custom' ? cur.custom : byId(id)?.v ?? NEUTRAL_COLOR;
  persist({ profile: id, values: { ...values } });
  showValues(values);
  paintDot();
  closeList();
}

/** Picking another profile while this one has unsaved changes asks first (once), in the popup. */
function pick(id: string) {
  if (dirty() && id !== cur.profile) {
    setOpen(false);
    renderProfiles();
    ask(id === 'custom' ? 'custom' : byId(id)?.name ?? '', () => switchTo(id));
    return;
  }
  switchTo(id);
}

function saveNew(name: string) {
  const p: ColorProfile = { id: `p-${Date.now().toString(36)}`, name, v: { ...cur.values } };
  persist({ profiles: [...saved(), p], profile: p.id });
}
function updateProfile() {
  persist({ profiles: saved().map((p) => (p.id === cur.profile ? { ...p, v: { ...cur.values } } : p)) });
  renderProfiles();
}
function rename(id: string, name: string) {
  persist({ profiles: saved().map((p) => (p.id === id ? { ...p, name } : p)) });
}
function remove(id: string) {
  const patch: Partial<ColorState> = { profiles: saved().filter((p) => p.id !== id) };
  if (cur.profile === id) Object.assign(patch, { profile: 'custom', custom: { ...cur.values } });
  moreFor = null; confirmDelete = false;
  persist(patch);
  renderProfiles();
}
/** A changed profile goes back to its saved values; custom goes back to neutral. */
function resetProfile() {
  if (cur.profile === 'custom') { switchTo('neutral'); return; }
  const p = byId(cur.profile);
  if (p) applyValues(p.v);
}

/** The name field, in the dotted-underline type-in style. Enter saves, Escape cancels. */
const nameField = (value: string) => `<input class="pf-input" maxlength="${PROFILE_NAME_MAX}" placeholder="name" value="${esc(value)}" aria-label="profile name" />`;

function optionHtml(p: Row, i: number): string {
  const two = twoCols();
  const custom = p.id === 'custom';
  const cls = `mode-opt${i === activeRow ? ' active' : ''}${two && !custom && i < colRows() ? ' c1' : ''}`;
  const style = custom && two ? ` style="grid-row: ${colRows() + 1}"` : '';
  const name = naming?.mode === 'rename' && naming.id === p.id ? nameField(p.name) : `<b>${esc(p.name)}</b>`;
  const dots = p.builtIn || custom ? '<span class="pf-dots" aria-hidden="true"></span>' : `<button type="button" class="pf-dots" aria-label="more for ${esc(p.name)}"></button>`;
  const more = moreFor === p.id
    ? `<span class="mode-list pf-more" role="menu"><span class="mode-opt" role="menuitem" data-act="rename"><b>rename</b></span><span class="mode-opt${confirmDelete ? ' warn' : ''}" role="menuitem" data-act="delete"><b>${confirmDelete ? 'delete?' : 'delete'}</b></span></span>`
    : '';
  return `<div class="${cls}" role="option" aria-selected="${p.id === cur.profile}" data-id="${esc(p.id)}" data-i="${i}"${style}>`
    + `<span class="pf-num">${custom ? '<i class="pf-bul">•</i>' : i + 1}</span>${name}${dots}${more}</div>`;
}

function menuHtml(): string {
  const mod = dirty() ? '<i class="pf-mod">●</i>' : '';
  const btn = `<button type="button" class="pf-open" aria-haspopup="listbox" aria-expanded="${open}"><span class="pf-lbl">profile ·&nbsp;</span><b>${esc(currentName())}</b>${mod}</button>`;
  if (!open) return btn;
  return `${btn}<div class="mode-list pf-list${twoCols() ? ' two' : ''}" role="listbox" aria-label="Profile" style="--rows: ${colRows()}">${rows().map(optionHtml).join('')}</div>`;
}

/** The line under the head: update profile · save new · reset (custom: save new · reset), or the name field. */
function actionsHtml(): string {
  const note = '<span class="pf-note"><i class="pf-mod">●</i>unsaved changes</span>';
  const btn = (act: string, text: string) => `<button type="button" class="pf-act" data-act="${act}">${text}</button>`;
  // At the profile limit "save new" gives way to the limit itself: a further one would be dropped when stored.
  const saveNew = saved().length < MAX_PROFILES ? btn('new', 'save new')
    : `<span class="pf-full" data-tip="delete a profile to save a new one">${MAX_PROFILES} max</span>`;
  if (naming?.mode === 'new') return `<span class="pf-note">name</span>${nameField('')}`;
  if (dirty()) return note + btn('update', 'update profile') + saveNew + btn('reset', 'reset');
  if (customToSave()) return note + saveNew + btn('reset', 'reset');
  return '';
}

/** Each slider's ↺ compares with the selected profile (custom and neutral: with neutral). */
function setBases() {
  const base = byId(cur.profile)?.v ?? NEUTRAL_COLOR;
  for (const k of COLOR_KEYS) sliders[k].setBase(base[k]);
}

function renderProfiles() {
  shownLine = lineKey();
  setBases();
  host.innerHTML = menuHtml();
  acts.innerHTML = actionsHtml();
  wireMenuButton();
  wireList();
  wireActs();
  wireNameField();
}

const focusList = () => host.querySelector<HTMLElement>('.pf-list')?.focus();
const focusOpen = () => host.querySelector<HTMLElement>('.pf-open')?.focus();

function wireMenuButton() {
  const btn = byQ<HTMLButtonElement>('.pf-open', host);
  btn.addEventListener('click', () => { setOpen(!open); renderProfiles(); if (open) focusList(); });
  btn.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' || open) return;
    e.preventDefault();
    setOpen(true);
    activeRow = rows().findIndex((p) => p.id === cur.profile);
    renderProfiles();
    focusList();
  });
}

function moveActive(to: number) { activeRow = to; renderProfiles(); focusList(); }

function onListKey(e: KeyboardEvent) {
  const n = rows().length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); moveActive((activeRow + (e.key === 'ArrowDown' ? 1 : -1) + n) % n); }
  // In two columns, left and right jump to the same row in the other column.
  if (twoCols() && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && activeRow >= 0 && activeRow < saved().length) {
    const next = activeRow + (e.key === 'ArrowRight' ? colRows() : -colRows());
    if (next >= 0 && next < saved().length) { e.preventDefault(); moveActive(next); }
  }
  if (e.key === 'Enter' && activeRow >= 0) { e.preventDefault(); pick(rows()[activeRow].id); focusOpen(); }
  if (e.key === 'Escape') { e.preventDefault(); closeList(); focusOpen(); } // Esc would close the popup
  // 1-9 picks that profile, as numbered in the list.
  if (/^[1-9]$/.test(e.key) && Number(e.key) <= saved().length) { e.preventDefault(); pick(saved()[Number(e.key) - 1].id); focusOpen(); }
}

function wireList() {
  const list = host.querySelector<HTMLElement>('.pf-list');
  if (!list) return;
  list.tabIndex = -1;
  list.addEventListener('keydown', onListKey);
  const opts = [...list.querySelectorAll<HTMLElement>(':scope > .mode-opt')];
  for (const opt of opts) {
    opt.addEventListener('pointerenter', () => {
      for (const o of opts) o.classList.toggle('active', o === opt);
      activeRow = Number(opt.dataset.i);
    });
    opt.addEventListener('click', (e) => {
      if ((e.target as Element).closest('.pf-dots, .pf-more, .pf-input')) return;
      pick(opt.dataset.id ?? 'neutral');
    });
  }
  for (const b of list.querySelectorAll<HTMLElement>('button.pf-dots')) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = b.closest<HTMLElement>('[data-id]')?.dataset.id ?? null;
      moreFor = moreFor === id ? null : id;
      confirmDelete = false;
      renderProfiles();
      focusList();
    });
  }
}

function onAct(act: string, id: string | undefined) {
  if (act === 'update') { updateProfile(); return; }
  if (act === 'reset') { resetProfile(); return; }
  if (act === 'new') naming = { mode: 'new' };
  if (act === 'rename' && id) { naming = { mode: 'rename', id }; moreFor = null; }
  if (act === 'delete' && id) {
    if (confirmDelete) { remove(id); return; } // delete asks twice
    confirmDelete = true;
  }
  renderProfiles();
}

function wireActs() {
  for (const b of [...host.querySelectorAll<HTMLElement>('[data-act]'), ...acts.querySelectorAll<HTMLElement>('[data-act]')]) {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onAct(b.dataset.act ?? '', b.closest<HTMLElement>('[data-id]')?.dataset.id);
    });
  }
}

function wireNameField() {
  const inp = host.querySelector<HTMLInputElement>('.pf-input') ?? acts.querySelector<HTMLInputElement>('.pf-input');
  if (!inp) return;
  inp.focus();
  inp.select();
  const done = (ok: boolean) => {
    if (!naming) return;
    const name = cleanName(inp.value);
    const n = naming;
    naming = null;
    if (ok && name) { if (n.mode === 'new') saveNew(name); else rename(n.id, name); }
    renderProfiles();
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') { e.preventDefault(); done(false); }
  });
  inp.addEventListener('blur', () => done(true));
}

// --- "unsaved changes" card ------------------------------------------------------------------
/**
 * "night has unsaved changes": update profile (save, then switch) · discard (drop them, then
 * switch) · cancel (stay). A card over the color panel; everything but the header steps back.
 * Escape or a click outside it is "cancel". to: what the user is switching to; go: that switch.
 */
function ask(to: string, go: () => void) {
  asking = document.createElement('div');
  asking.className = 'pf-confirm';
  asking.setAttribute('role', 'alertdialog');
  asking.setAttribute('aria-label', 'Unsaved changes');
  asking.innerHTML = `<b><span class="pf-mod">●</span>${esc(currentName())} has unsaved changes</b>`
    + `<small>switching to ${esc(to)} drops them</small>`
    + '<span class="pf-confirm-row"><button type="button" class="mp-btn primary" data-ans="update">update profile</button><button type="button" class="mp-btn" data-ans="discard">discard</button><button type="button" class="mp-btn" data-ans="cancel">cancel</button></span>';
  const r = panel.getBoundingClientRect();
  asking.style.left = `${r.left + 10}px`;
  asking.style.width = `${r.width - 20}px`;
  asking.style.top = `${r.top + 36}px`;
  document.body.append(asking); // a child of <body>, so the whole popup can step back behind it
  document.body.classList.add('pf-asking');
  for (const b of asking.querySelectorAll<HTMLElement>('[data-ans]')) {
    b.addEventListener('click', () => answer(b.dataset.ans ?? 'cancel', go));
  }
  asking.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    endAsk();
    focusOpen();
  });
  byQ<HTMLElement>('.primary', asking).focus();
}

function answer(ans: string, go: () => void) {
  endAsk();
  if (ans === 'update') { updateProfile(); go(); }
  if (ans === 'discard') { const p = byId(cur.profile); if (p) applyValues(p.v); go(); }
  focusOpen();
}

function endAsk() {
  asking?.remove();
  asking = null;
  document.body.classList.remove('pf-asking');
}

/** As with the mode list: a click outside the list (or the card) closes it, and only closes it. */
function wireOutsideClicks() {
  let swallowClick = false;
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Node;
    if (asking && !asking.contains(t)) { e.preventDefault(); swallowClick = true; endAsk(); return; }
    if (!open || host.contains(t)) return;
    e.preventDefault();
    swallowClick = true;
    closeList();
  });
  // ...so the click that closed it does not also press whatever was under the pointer.
  document.addEventListener('click', (e) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

// --- values ---------------------------------------------------------------------------------
/** Whether the open video is upscaled; null with no video (the dot then follows the colors alone). */
let upscaled: boolean | null = null;

/** The color tab's dot, as the fullscreen menu's: green only when colors reach the video, else red. */
function paintDot() {
  const applied = cur.on && !isNeutral(cur.values) && ((upscaled ?? true) || cur.always);
  changedDot.hidden = false;
  changedDot.classList.toggle('off', !applied);
  changedDot.setAttribute('aria-label', applied ? 'colors in use' : 'colors not in use');
}

/** popup.ts: the open video changed (or its upscale switch did). */
export function setColorVideo(isUpscaled: boolean | null): void {
  if (isUpscaled === upscaled) return;
  upscaled = isUpscaled;
  paintDot();
}

/**
 * New values on screen. On a saved profile it stays selected, marked as changed, until "update
 * profile"; on neutral (which cannot be changed) the values become "custom".
 */
function valuesChanged(values: ColorValues, throttle: boolean) {
  const patch: Partial<ColorState> = { values };
  const p = byId(cur.profile);
  if (cur.profile === 'custom') patch.custom = values;
  else if (p?.builtIn && !sameValues(values, p.v)) Object.assign(patch, { profile: 'custom', custom: values });
  persist(patch, throttle);
  paintDot();
  if (!naming && lineKey() !== shownLine) renderProfiles();
}

/** Puts a profile's values on screen without changing which profile is selected. */
function applyValues(v: ColorValues) {
  showValues(v);
  valuesChanged({ ...v }, false);
}

// --- colors on/off, "also when not upscaled" -------------------------------------------------
function paintSwitches() {
  power.checked = cur.on;
  document.body.classList.toggle('colors-off', !cur.on);
  alwaysInput.checked = cur.always;
  always.classList.toggle('on', cur.always);
  alwaysState.textContent = cur.always ? 'currently: every video' : 'currently: upscaled videos only';
  paintDot();
}

function wireSwitches() {
  power.addEventListener('change', () => { persist({ on: power.checked }); paintSwitches(); });
  alwaysInput.addEventListener('change', () => { persist({ always: alwaysInput.checked }); paintSwitches(); });
}

// --- tabs -------------------------------------------------------------------------------------
type Tab = 'upscale' | 'color';

function selectTab(t: Tab) {
  document.body.dataset.tab = t;
  for (const b of tabsEl.querySelectorAll<HTMLElement>('.c-tab')) b.setAttribute('aria-selected', String(b.dataset.t === t));
}

/** Leaving the color tab with unsaved profile changes asks first (update profile / discard / cancel). */
function goTo(t: Tab) {
  if (t === 'color' || document.body.dataset.tab !== 'color' || !dirty()) { selectTab(t); return; }
  setOpen(false);
  renderProfiles();
  ask(t, () => selectTab(t));
}

/** The performance verdict rides on the upscale tab: only its dot, in its colour; its words are the tooltip. */
function mirrorVerdict() {
  const verdict = byQ<HTMLElement>('#verdict');
  const dot = byQ<HTMLElement>('#t-verdict');
  const paint = () => {
    const words = (verdict.textContent ?? '').replace(/^●\s*/, '');
    dot.textContent = '●';
    dot.hidden = verdict.hidden;
    dot.dataset.tip = words;
    dot.setAttribute('aria-label', words);
    dot.className = `t-verdict ${[...verdict.classList].filter((c) => c !== 'verdict').join(' ')}`;
  };
  new MutationObserver(paint).observe(verdict, { childList: true, characterData: true, subtree: true, attributes: true });
  paint();
}

function wireTabs() {
  for (const b of tabsEl.querySelectorAll<HTMLElement>('.c-tab')) b.addEventListener('click', () => goTo(b.dataset.t as Tab));
}

// --- start ------------------------------------------------------------------------------------
function paintAll() {
  showValues(cur.values);
  paintSwitches();
  if (!naming) renderProfiles();
}

/** Another popup changed the colors: take them, unless this popup is still writing its own. */
function onStored(s: ColorState) {
  if (writeTimer || inflight) return;
  if (JSON.stringify(s) === JSON.stringify(normalizeColor(cur))) return;
  cur = s;
  paintAll();
}

export function initColorTab(): void {
  const list = byQ<HTMLElement>('#cs-list');
  for (const k of COLOR_KEYS) {
    sliders[k] = makeSlider(k, (key, v) => valuesChanged({ ...cur.values, [key]: v }, true));
    list.append(sliders[k].el);
  }
  wireTabs();
  wireSwitches();
  wireOutsideClicks();
  mirrorVerdict();
  paintAll();
  void loadColor().then((s) => { cur = s; paintAll(); });
  onColorChanged(onStored);
}

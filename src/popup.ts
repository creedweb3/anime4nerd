import {
  Message, Mode, PRESETS, Settings, Suggest, VideoInfo, capNote, frameVerdict, liftLoadCap, loadSettings, onSettingsChanged, onSourcesChanged, saveSettings,
  setSource,
} from './settings';
import { EMPTY_META, MediaMeta, videoLabel } from './media-meta';
import { WHATS_NEW_URL, clearWhatsNew, pendingWhatsNew } from './whats-new';
import { REVIEW_URL, RateAction, cardFor, loadRate, pendingLevel } from './rate-prompt';
import { MANGA_PROTOCOL, loadMangaSites, onMangaSitesChanged, setMangaSites } from './manga-sites';
import type { MangaStatus } from './manga';
import type { MangaMeta } from './manga-meta';
import { BROWSER, reportUrl } from './site-links';
import { TICKETS_URL, hasTickets } from './tickets';
import { initColorTab, setColorVideo } from './popup-color';
import { accessOrigins, missingAccess } from './site-access';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const hintEl = $('#hint');
const modeBtn = $<HTMLButtonElement>('#mode');
const gpuChip = $('#gpuchip');
const clockEl = $('#clock');
const countEl = $('#count');
const presetNameEl = $('#presetName');
const sourcesEl = $('#sources');
const emptyEl = $('#empty');
const presetsEl = $('#presets');
// popup.html carries a plain /report link; this adds the version and browser.
$<HTMLAnchorElement>('#report').href = reportUrl(chrome.runtime.getManifest().version, BROWSER);
// With report tickets on the site (tickets.ts), the icon opens them; replies are shown there.
hasTickets().then((yes) => {
  if (!yes) return;
  const report = $<HTMLAnchorElement>('#report');
  report.href = TICKETS_URL;
  report.dataset.tip = 'Your tickets';
  report.setAttribute('aria-label', 'Your tickets');
}, () => {});
const perf = {
  verdict: $('#verdict'), load: $('#k-load'), ms: $('#k-ms'), fps: $('#k-fps'), avg: $('#k-avg'), limit: $('#k-limit'), late: $('#k-late'),
  bars: $('#bars'),
};

let settings: Settings;
let tabId: number | undefined;
let tabHost = '';
let pageMeta: MediaMeta = EMPTY_META;
const BARS = 48;

const lastBudget = new Map<string, number>(); // video id -> last known frame limit (ms)
const pendingToggle = new Map<string, boolean>(); // key -> desired state until storage echoes it
let pointerBusy = false;
// Cleared on window, not the card: a press that drags off the card must not leave it set,
// or patchCard would stop updating checkboxes for the rest of the popup's life.
for (const ev of ['pointerup', 'pointercancel'] as const) window.addEventListener(ev, () => { pointerBusy = false; });
// The one video card that is open (full); the others are compact rows. The performance panel
// follows it. Chosen when the popup opens (see pickOpen) and changed only by a click on a compact card.
let openId: string | null = null;

// --- presets / effects --------------------------------------------------------
const PRESET_DESC: Record<string, string> = {
  A: 'sharp', B: 'soft', C: 'denoise', AA: 'sharper, heavy', BB: 'softer, heavy', CA: 'denoise+sharp',
};
for (const p of PRESETS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tile';
  b.dataset.preset = p.value;
  b.setAttribute('role', 'menuitemradio');
  const name = document.createElement('b');
  name.textContent = p.label;
  const desc = document.createElement('small');
  desc.textContent = PRESET_DESC[p.value];
  b.append(name, desc);
  b.addEventListener('click', () => { void saveSettings({ preset: p.value }); });
  presetsEl.append(b);
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-field]')) {
  b.addEventListener('click', () => {
    const f = b.dataset.field as 'darkenLines' | 'thinLines';
    void saveSettings((cur) => ({ [f]: !cur[f] }));
  });
}
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-upscale]')) {
  b.addEventListener('click', () => {
    const up = b.dataset.upscale as Settings['upscale'];
    // The option already chosen, clicked again: run it again even if the GPU-load cap held it down.
    if (settings?.upscale === up) void liftLoadCap().catch(() => {});
    else void saveSettings({ upscale: up });
  });
}

// --- tooltips: one box for every [data-tip] (a native title= tooltip is drawn by the system) ---
const TIP_DELAY_MS = 400;
const TIP_GAP = 4; // px between the tooltip, its element and the popup edge
const tipEl = $('#tip');
let tipFor: HTMLElement | null = null; // the element the tooltip is shown for, or waiting to be
let tipTimer = 0;

function setTip(el: HTMLElement, text: string) {
  if (text) el.dataset.tip = text; else delete el.dataset.tip;
}

const isCut = (el: HTMLElement) => el.scrollWidth > el.clientWidth;

/** The element's tooltip; when its text is cut, the full text comes first. */
function setCutTip(el: HTMLElement, tip = '') {
  setTip(el, isCut(el) && el.textContent ? [el.textContent, tip].filter(Boolean).join(' · ') : tip);
}

function hideTip() {
  window.clearTimeout(tipTimer);
  tipFor?.removeAttribute('aria-describedby');
  tipFor = null;
  tipEl.hidden = true;
}

function showTip() {
  const el = tipFor;
  const text = el?.dataset.tip;
  if (!el || !text || !el.isConnected || el.getAttribute('aria-expanded') === 'true') { hideTip(); return; }
  tipEl.textContent = text;
  tipEl.hidden = false;
  // Measure it at the corner: at its last place the popup edge could squeeze its width.
  tipEl.style.left = '0';
  tipEl.style.top = '0';
  // An aria-label with the same words is already read: describing it again would say it twice.
  if (el.getAttribute('aria-label') !== text) el.setAttribute('aria-describedby', 'tip');
  // Under the element, or above it when there is no room; never past an edge of the popup.
  const r = el.getBoundingClientRect();
  const box = document.body.getBoundingClientRect(); // the popup: body is as wide and as tall as its window
  const left = Math.min(r.left, box.right - tipEl.offsetWidth - TIP_GAP);
  const below = r.bottom + TIP_GAP;
  const top = below + tipEl.offsetHeight + TIP_GAP <= box.bottom ? below : r.top - tipEl.offsetHeight - TIP_GAP;
  tipEl.style.left = `${Math.max(box.left + TIP_GAP, left)}px`;
  tipEl.style.top = `${Math.max(box.top + TIP_GAP, top)}px`;
}

function armTip(target: EventTarget | null, delay: number) {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;
  if (el === tipFor) return;
  hideTip();
  if (!el) return;
  tipFor = el;
  if (delay) tipTimer = window.setTimeout(showTip, delay); else showTip();
}

document.addEventListener('pointerover', (e) => armTip(e.target, TIP_DELAY_MS));
document.addEventListener('pointerout', (e) => {
  if (tipFor && !(e.relatedTarget instanceof Node && tipFor.contains(e.relatedTarget))) hideTip();
});
// Keyboard focus shows it at once; focus that follows a click does not.
document.addEventListener('focusin', (e) => { if (e.target instanceof Element && e.target.matches(':focus-visible')) armTip(e.target, 0); });
document.addEventListener('focusout', hideTip);
document.addEventListener('pointerdown', hideTip);
document.addEventListener('scroll', hideTip, true); // capture: scrolling boxes inside the popup too
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || tipEl.hidden) return;
  e.preventDefault(); // Esc closes the tooltip, not the popup
  hideTip();
});
// The browser's own right-click menu (Back, Reload, Inspect) is not part of the popup.
document.addEventListener('contextmenu', (e) => e.preventDefault());

// --- mode dropdown: a button and a list of the popup's own (WAI-ARIA select-only combobox) ---
// The keyboard focus stays on the button; the highlighted row is its aria-activedescendant.
const TYPEAHEAD_MS = 500;
const modeList = $('#mode-list');
const modeOpts = [...modeList.querySelectorAll<HTMLElement>('[role="option"]')];
let modeActive = 0; // the highlighted row while the list is open
let typed = '';
let typedAt = 0;

function paintMode(m: Mode) {
  modeBtn.value = m;
  if (modeBtn.textContent !== m) modeBtn.textContent = m;
  for (const o of modeOpts) o.setAttribute('aria-selected', String(o.dataset.mode === m));
}

function setModeActive(i: number) {
  modeActive = Math.max(0, Math.min(modeOpts.length - 1, i));
  modeOpts.forEach((o, n) => o.classList.toggle('active', n === modeActive));
  modeBtn.setAttribute('aria-activedescendant', modeOpts[modeActive].id);
}

function openModeList(open: boolean) {
  if (open === !modeList.hidden) return;
  modeList.hidden = !open;
  modeBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    hideTip();
    document.body.scrollTop = 0; // the list hangs under the chip: a scrolled popup goes to the top first
    setModeActive(modeOpts.findIndex((o) => o.dataset.mode === modeBtn.value));
  } else {
    modeBtn.removeAttribute('aria-activedescendant');
    typed = '';
  }
}

function pickMode(i: number) {
  const m = modeOpts[i].dataset.mode as Mode;
  openModeList(false);
  if (m === modeBtn.value) return;
  paintMode(m);
  void saveSettings({ mode: m });
}

function modeOptAt(e: Event): number {
  return modeOpts.indexOf((e.target as Element).closest<HTMLElement>('[role="option"]')!);
}

/** Arrows, Home and End move the highlight (opening the list first); letters jump to a name. */
function onModeKey(e: KeyboardEvent) {
  const open = !modeList.hidden;
  const at = open ? modeActive : modeOpts.findIndex((o) => o.dataset.mode === modeBtn.value);
  let to = -1;
  if (e.key === 'Escape') {
    if (!open) return; // closed: Esc closes the popup as usual
    e.stopPropagation();
    openModeList(false);
  } else if (e.key === 'ArrowDown') to = open ? at + 1 : at;
  else if (e.key === 'ArrowUp') to = open ? at - 1 : at;
  else if (e.key === 'Home') to = 0;
  else if (e.key === 'End') to = modeOpts.length - 1;
  else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    typed = e.timeStamp - typedAt > TYPEAHEAD_MS ? e.key.toLowerCase() : typed + e.key.toLowerCase();
    typedAt = e.timeStamp;
    // The same letter again goes to the next name that starts with it ("a": auto, then anime).
    const repeat = [...typed].every((ch) => ch === typed[0]);
    const want = repeat ? typed[0] : typed;
    for (let n = 0; n < modeOpts.length && to < 0; n += 1) {
      const i = (at + n + (repeat ? 1 : 0)) % modeOpts.length;
      if (modeOpts[i].dataset.mode!.startsWith(want)) to = i;
    }
    if (to < 0) return;
  } else return; // Enter and Space reach the button as a click
  e.preventDefault();
  if (to >= 0) { openModeList(true); setModeActive(to); }
}

// A click from the keyboard (Enter, Space: detail 0) on the open list picks the highlighted row.
modeBtn.addEventListener('click', (e) => {
  const open = !modeList.hidden;
  if (open && e.detail === 0) pickMode(modeActive); else openModeList(!open);
});
modeBtn.addEventListener('keydown', onModeKey);
modeBtn.addEventListener('blur', () => openModeList(false));
// A press outside the open list only closes it: caught before any button sees it (capture
// phase), and its click is swallowed, so the control under the dimmed popup does not fire.
let swallowClick = false;
document.addEventListener('pointerdown', (e) => {
  swallowClick = false; // a press that ended without a click (dragged away) must not eat the next one
  if (modeList.hidden || $('#modeChip').contains(e.target as Node)) return;
  e.preventDefault();
  e.stopPropagation();
  openModeList(false);
  swallowClick = true;
}, true);
document.addEventListener('click', (e) => {
  if (!swallowClick) return;
  swallowClick = false;
  e.preventDefault();
  e.stopPropagation();
}, true);
modeList.addEventListener('mousedown', (e) => e.preventDefault()); // a press on a row must not take the focus off the button
modeList.addEventListener('pointermove', (e) => { const i = modeOptAt(e); if (i >= 0 && i !== modeActive) setModeActive(i); });
modeList.addEventListener('click', (e) => { const i = modeOptAt(e); if (i >= 0) pickMode(i); });
function mode(): Mode { return settings ? settings.mode : 'auto'; }

function paintSettings(s: Settings) {
  settings = s;
  paintMode(s.mode);
  presetNameEl.textContent = PRESETS.find((p) => p.value === s.preset)?.label ?? s.preset;
  for (const b of presetsEl.querySelectorAll<HTMLButtonElement>('[data-preset]')) {
    b.setAttribute('aria-checked', String(b.dataset.preset === s.preset));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-field]')) {
    b.setAttribute('aria-checked', String(s[b.dataset.field as 'darkenLines' | 'thinLines']));
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-upscale]')) {
    b.setAttribute('aria-checked', String(b.dataset.upscale === s.upscale));
  }
}

// --- helpers ---------------------------------------------------------------------
// Frames webNavigation does not list: Chromium leaves out blob: frames, where some players live.
// An all-frames executeScript answers with every frame's id; it is asked at most every few seconds,
// and its frames are only added to webNavigation's list, never taken away from it.
const FRAME_PROBE_MS = 3000;
let probedFrames: number[] = [];
let lastFrameProbe = -Infinity;
function probeFrames(id: number) {
  if (performance.now() - lastFrameProbe < FRAME_PROBE_MS) return;
  lastFrameProbe = performance.now();
  chrome.scripting.executeScript({ target: { tabId: id, allFrames: true }, func: () => 0 })
    .then((hits) => { probedFrames = (hits ?? []).map((h) => h.frameId); }, () => { /* a frame refused: keep the last list */ });
}

async function sendToFrames<T>(msg: Message): Promise<{ frameId: number; value: T }[]> {
  if (tabId === undefined) return [];
  probeFrames(tabId);
  let frames: { frameId: number }[] = [{ frameId: 0 }];
  try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? frames; } catch { /* keep main frame */ }
  const extra = probedFrames.filter((id) => !frames.some((f) => f.frameId === id)).map((frameId) => ({ frameId }));
  frames = [...frames, ...extra];
  const results = await Promise.allSettled(frames.map(async (f) => ({
    frameId: f.frameId,
    value: await chrome.tabs.sendMessage(tabId!, msg, { frameId: f.frameId }) as T,
  })));
  return results.flatMap((r) => (r.status === 'fulfilled' && r.value.value != null ? [r.value] : []));
}

function pLabel(h: number): string { return h ? `${h}p` : '?'; }

/** Merge page metadata with the player frame's Media Session data. */
function labelFor(v: VideoInfo): { title: string; tag: string; episodeName: string } {
  return videoLabel(pageMeta, v.media, tabHost || v.frameHost);
}

interface CardState { cls: string; text: string; tip: string }
const UPSCALING = '● Upscaling';
const NOT_POSSIBLE = '● Not possible';

/** What a video is doing, in a word or two (no performance verdict); the long reason is the tooltip. */
function cardState(v: VideoInfo): CardState {
  if (mode() === 'manga') return { cls: 'dim', text: '● Paused', tip: 'Manga mode: videos are not upscaled' };
  // Not upscaled, but drawing the color controls ("also use colors when not upscaled").
  if (!v.enabled && v.colorOnly && v.status === 'Active') return { cls: 'ok', text: '● Colors only', tip: 'Not upscaled; your colors are applied. Tap to upscale' };
  if (!v.enabled) return { cls: 'off', text: '● Off', tip: 'Tap to turn on' };
  switch (v.status) {
    case 'Active': return v.playing ? { cls: 'ok', text: UPSCALING, tip: '' } : { cls: 'dim', text: '● Paused', tip: '' };
    case 'Loading': return { cls: 'warn', text: '● Starting…', tip: '' };
    case 'Waiting': return { cls: 'dim', text: '● Waiting', tip: 'Waiting for the video to start' };
    case 'Suspended': return { cls: 'dim', text: '● Suspended', tip: 'Paused while the video is in fullscreen, picture-in-picture or a hidden tab' };
    case 'Unavailable': return { cls: 'bad', text: NOT_POSSIBLE, tip: v.message };
    default: return { cls: 'dim', text: '● Off', tip: '' };
  }
}

/** A few plain words for why a video cannot be upscaled; the full message stays in the tooltip. Unknown reasons: their first clause. */
function shortReason(message: string): string {
  if (/cross-origin|CORS/i.test(message)) return 'this site blocks access to its video';
  if (/texture limit/i.test(message)) return 'too large for this GPU';
  if (/WebGL|GPU/i.test(message)) return 'the GPU is not available';
  return message.split(/[.(;:]/)[0].trim().toLowerCase();
}

/**
 * The card to open: the video that is upscaling right now; of several, the one that is playing.
 * Otherwise the video that is playing, otherwise the largest, otherwise the first in the list.
 */
function pickOpen(videos: VideoInfo[]): VideoInfo | null {
  const rank = (v: VideoInfo) => [Number(v.enabled && v.status === 'Active'), Number(v.playing), v.width * v.height];
  const beats = (a: number[], b: number[]) => { const at = a.findIndex((n, i) => n !== b[i]); return at >= 0 && a[at] > b[at]; };
  return videos.reduce<VideoInfo | null>((best, v) => (!best || beats(rank(v), rank(best)) ? v : best), null);
}

function budgetFor(v: VideoInfo): number | null {
  const src = v.sourceFps ?? v.stats?.sourceFps ?? ((v.playing && v.stats && v.stats.fps >= 10) ? v.stats.fps : null);
  if (src) lastBudget.set(v.id, 1000 / src);
  return lastBudget.get(v.id) ?? null;
}

// --- card: built once per video id, then patched in place ------------------------
interface Card {
  el: HTMLElement; key: string; cb: HTMLInputElement;
  title: HTMLElement; tag: HTMLElement; epName: HTMLElement; meta: HTMLElement; host: HTMLElement; res: HTMLElement; why: HTMLElement; hint: HTMLElement;
  long: { title: string; cut: boolean } | null; // does this title fit on one line: measured once per title
}
const cards = new Map<string, Card>();
let besideReader = false; // a manga reader is on the page: every video card stays compact

function buildCard(v: VideoInfo): Card {
  const el = document.createElement('div');
  el.className = 'source';
  el.dataset.id = v.id;
  el.innerHTML = `
    <div class="line"><div class="title"></div><label class="switch"><input type="checkbox" /></label></div>
    <div class="episode"><span class="tag"></span><span class="epname"></span></div>
    <div class="meta"><span class="host"></span><span class="res"></span><span class="why"></span></div>
    <div class="hint" hidden></div>`;
  const q = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
  const card: Card = {
    el, key: v.key, cb: q<HTMLInputElement>('input'),
    title: q('.title'), tag: q('.tag'), epName: q('.epname'), meta: q('.meta'), host: q('.host'), res: q('.res'), why: q('.why'),
    hint: q('.hint'), long: null,
  };
  const flip = (on: boolean) => {
    if (mode() === 'manga') return; // videos are paused: the switch is disabled
    pendingToggle.set(card.key, on);
    card.cb.checked = on;
    el.classList.toggle('on', on);
    void setSource(card.key, on).then(() => { setTimeout(() => { void refresh(); }, 60); });
  };
  const sw = q('.switch');
  sw.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); pointerBusy = true; flip(!card.cb.checked); });
  sw.addEventListener('click', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // A compact card: its switch alone flips it; a press anywhere else opens it and folds the open one.
    if (!el.classList.contains('compact')) { pointerBusy = true; flip(!card.cb.checked); } else if (!besideReader) { openId = v.id; void refresh(); }
  });
  card.cb.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(!card.cb.checked); } });
  return card;
}

function setText(el: HTMLElement, text: string) { if (el.textContent !== text) el.textContent = text; }

/** setText, with the "N× capped" note (`note`, e.g. "4× capped") inside `text` in the warn colour. */
function setTextNote(el: HTMLElement, text: string, note: string) {
  const at = note ? text.lastIndexOf(note) : -1;
  if (at < 0) { if (el.querySelector('.capn') || el.textContent !== text) el.textContent = text; return; }
  if (el.textContent === text && el.querySelector('.capn')) return;
  const span = document.createElement('span');
  span.className = 'capn';
  span.textContent = note;
  el.replaceChildren(text.slice(0, at), span, text.slice(at + note.length));
}

/** Whether the card's title is cut on one line (the two-line layout would hide that, so it is measured without it). */
function titleIsLong(c: Card, title: string): boolean {
  if (c.long?.title !== title) {
    c.el.classList.remove('two-line');
    c.long = c.title.clientWidth ? { title, cut: isCut(c.title) } : null; // no width: the cards are hidden
  }
  return !!c.long?.cut;
}

/**
 * The open card has three rows: title, tag row, info line. Compact cards show the title row only.
 * - episode name known: "S1 E12" tag + the name; info line "host · 1080p → 3840×2160 (2×)".
 * - no episode name: the quality stands beside the tag ("1080p" is the tag when there is no
 *   episode either); info line "host · stream <stream host>".
 * - no episode at all and a title too long for one line: the title takes two lines and the tag
 *   row ("1080p" tag, "→ output · host") stands in for the info line.
 * - not possible: the info line says why in a few words (the resolution means nothing then).
 * The card is the same height in every case.
 */
function patchCard(c: Card, v: VideoInfo, open: boolean) {
  c.key = v.key;
  const { title, tag, episodeName } = labelFor(v);
  const st = cardState(v);
  const impossible = st.text === NOT_POSSIBLE;
  const host = tabHost || v.frameHost;
  // Real output size while rendering (2x, or 4x on large displays); 2x is the default before that.
  const outH = v.stats?.outputHeight ?? v.height * 2;
  const out = v.stats ? `${v.stats.outputWidth}×${v.stats.outputHeight}` : pLabel(outH);
  const scale = v.height ? Math.round(outH / v.height) : 0;
  // " · 8× capped: GPU limit": the card says "· 8× capped", the tooltip says why.
  const cap = v.stats && settings ? capNote(settings.upscale, scale, v.loadCapped) : '';
  const capTip = cap.replace(/^ · /, '');
  const output = `→ ${out} (${scale}×)${cap.replace(/: .*$/, '')}`;
  const frames = v.frameHost !== tabHost ? `player frame: ${v.frameHost} · stream: ${v.mediaHost}` : `stream: ${v.mediaHost}`;

  c.el.classList.toggle('compact', !open);
  c.el.dataset.state = st.cls;
  setText(c.title, title);
  let rowTag = tag;
  let rowText = episodeName;
  let info = v.height ? ` · ${pLabel(v.height)} ${output}` : '';
  let layout: '' | 'quality' | 'two-line' = '';
  if (open && !impossible && !episodeName && v.height) {
    if (!tag && titleIsLong(c, title)) {
      layout = 'two-line';
      rowText = `${output} · ${host}`;
    } else {
      layout = 'quality';
      rowText = tag ? `${pLabel(v.height)} ${output}` : output;
      info = ` · stream ${v.mediaHost}`;
    }
    if (!tag) rowTag = pLabel(v.height);
  }
  c.el.classList.toggle('quality', layout === 'quality');
  c.el.classList.toggle('two-line', layout === 'two-line');
  setText(c.tag, rowTag);
  c.tag.hidden = !rowTag;
  const capShort = cap.replace(/: .*$/, '').replace(/^ · /, ''); // "4× capped", in the warn colour wherever it shows
  setTextNote(c.epName, rowText, capShort);
  setText(c.host, host);
  setTextNote(c.res, info, capShort);
  setText(c.why, impossible ? shortReason(v.message) : '');
  c.host.hidden = c.res.hidden = impossible;
  c.why.hidden = !impossible;
  // A site that blocks its video often offers other servers (players) for the same episode.
  const blocked = impossible && /cross-origin|CORS/i.test(v.message);
  setText(c.hint, blocked ? 'try another server or source' : ''); // its "tip" label is CSS (.hint::before)
  c.hint.hidden = !blocked;

  if (open) {
    setTip(c.el, '');
    setTip(c.title, (layout === 'two-line' ? c.title.scrollHeight > c.title.clientHeight + 1 : isCut(c.title)) ? title : '');
    setCutTip(c.tag);
    setCutTip(c.epName, layout ? [layout === 'two-line' ? frames : '', capTip].filter(Boolean).join(' · ') : '');
    // Whether the host is cut depends on the final layout (fonts, the scrollbar, the card opening),
    // which can settle after this patch: decide now, and again on the next frame.
    const metaTip = () => setTip(c.meta, impossible ? v.message : [isCut(c.host) ? host : '', frames, layout ? '' : capTip].filter(Boolean).join(' · '));
    metaTip();
    requestAnimationFrame(metaTip);
  } else {
    // Everything the rows would say, and the state the dot stands for.
    setTip(c.title, '');
    setTip(c.el, [
      title, [tag, episodeName].filter(Boolean).join(' '), `${host}${v.height ? ` · ${pLabel(v.height)} → ${out} (${scale}×)${cap}` : ''}`,
      st.tip ? `${st.text.slice(2)}: ${st.tip}` : st.text.slice(2),
    ].filter(Boolean).join(' · '));
  }
  const paused = mode() === 'manga';
  c.cb.disabled = paused;
  c.el.classList.toggle('paused', paused);
  if (!pointerBusy) {
    c.cb.checked = v.enabled;
    c.el.classList.toggle('on', v.enabled);
  }
}

// --- performance panel: fixed DOM, values patched ----------------------------------
const barEls: HTMLElement[] = [];
const limitEl = document.createElement('s');
for (let i = 0; i < BARS; i += 1) { const b = document.createElement('i'); barEls.push(b); perf.bars.append(b); }
perf.bars.append(limitEl);
const tiles = [perf.load, perf.ms, perf.fps, perf.avg, perf.limit, perf.late];
const GPU_LABELS = tiles.map((el) => el.previousElementSibling!.textContent!);
// No GPU timer (Firefox): the same tiles show frame-rate figures instead.
const FRAME_LABELS = ['Video', 'Frames kept', 'Output', 'Missed', 'Frame limit', 'Passes · VRAM'];

/** No-GPU-timer tiles: the video's fps, share of its frames drawn, frames missed, passes and VRAM. */
function paintFrameTiles(v: VideoInfo, s: NonNullable<VideoInfo['stats']>, live: boolean) {
  const src = v.sourceFps ?? s.sourceFps;
  const fv = live ? frameVerdict(s.fps, src) : null;
  setText(perf.load, src ? `${src.toFixed(0)} fps` : '—');
  setText(perf.ms, fv && src ? `${Math.round(Math.min(s.fps / src, 1) * 100)}%` : '—');
  setText(perf.avg, fv && src ? `${Math.max(0, Math.round(src - s.fps))} / s` : '—');
  setText(perf.late, `${s.passes} · ${Math.round(s.textureBytes / 1048576)} MB`);
  perf.load.className = perf.late.className = '';
  perf.ms.className = perf.avg.className = fv ?? '';
}

/**
 * The one status, in the panel's heading: the open card's state in that state's colour; a video
 * that is behind reads "Near limit" or "Dropping frames" instead of "Upscaling". The tooltip is
 * the state's long reason and what the graph shows (also the tooltip of the graph).
 */
function paintVerdict(st: CardState | null, behind: 'warn' | 'bad' | null, legend: string) {
  perf.verdict.hidden = !st; // no card: nothing to report
  setTip(perf.bars, legend);
  if (!st) return;
  const late = st.text === UPSCALING ? behind : null;
  setText(perf.verdict, late === 'warn' ? '● Near limit' : late === 'bad' ? '● Dropping frames' : st.text);
  perf.verdict.className = `verdict ${late ?? st.cls}`;
  setTip(perf.verdict, [st.tip, legend].filter(Boolean).join(' · '));
}

function paintPerf(v: VideoInfo | null) {
  const f = (n: number | null, d = 1) => (n === null ? '—' : n.toFixed(d));
  const noTimer = !!v?.enabled && !!v.stats && !v.stats.timerSupported;
  tiles.forEach((el, i) => setText(el.previousElementSibling as HTMLElement, (noTimer ? FRAME_LABELS : GPU_LABELS)[i]));
  setTip(tiles[0], ''); // the manga panel uses it
  perf.bars.style.display = noTimer ? 'none' : '';

  // Off: everything cleared.
  if (!v || !v.enabled) {
    for (const el of [perf.load, perf.ms, perf.avg, perf.limit, perf.late]) { setText(el, '—'); el.className = ''; }
    setText(perf.fps, '—');
    for (const bar of barEls) { bar.className = 'empty'; bar.style.height = '1px'; }
    limitEl.style.display = 'none';
    paintVerdict(v ? cardState(v) : null, null, v ? 'turn the video on to start measuring' : 'no video');
    return;
  }

  const s = v.stats;
  const live = !!s && v.playing && s.fps > 0;
  const budget = budgetFor(v);
  const samples = s?.samples ?? []; // while paused, the page keeps the last 2 s of playback
  const avg = samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : null;
  const peak = samples.length ? Math.max(...samples) : null;
  const late = budget !== null && samples.length ? samples.filter((ms) => ms > budget).length : null;
  const gpuMs = s?.gpuMs ?? null;
  const load = live && budget !== null && gpuMs !== null ? gpuMs / budget : null;

  setText(perf.load, load === null ? '—' : `${Math.round(load * 100)}%`);
  perf.load.className = load === null ? '' : load > 1 ? 'bad' : load > 0.8 ? 'warn' : 'ok';
  setText(perf.ms, gpuMs === null ? (s && !s.timerSupported ? 'n/a' : '—') : `${f(gpuMs)} ms`);
  setText(perf.fps, live ? `${s!.fps.toFixed(0)} fps` : 'paused');
  setText(perf.avg, avg === null ? '—' : `${f(avg, 0)} · ${f(peak, 0)}`);
  setText(perf.limit, budget === null ? '—' : `${f(budget, 0)} ms`);
  setText(perf.late, late === null ? '—' : `${late} / 2 s`);
  perf.late.className = late ? (late > 3 ? 'bad' : 'warn') : '';
  if (noTimer) paintFrameTiles(v, s!, live);

  // Behind: from the GPU time against the frame limit, or without a GPU timer from the frames drawn.
  let speed: 'ok' | 'warn' | 'bad' | null = null;
  if (live) speed = load !== null ? (load > 1 ? 'bad' : load > 0.8 ? 'warn' : 'ok') : s!.timerSupported ? null : frameVerdict(s!.fps, v.sourceFps ?? s!.sourceFps);

  const scale = Math.max(budget ?? 0, peak ?? 0, 1);
  const shown = samples.slice(-BARS);
  for (let i = 0; i < BARS; i += 1) {
    const idx = i - (BARS - shown.length);
    const b = barEls[i];
    if (idx < 0) { b.className = 'empty'; b.style.height = '1px'; continue; }
    const ms = shown[idx];
    b.className = `${budget !== null && ms > budget ? 'over' : ''}${live ? '' : ' stale'}`;
    b.style.height = `${Math.max(4, Math.round((ms / scale) * 100))}%`;
  }
  limitEl.style.display = budget !== null ? '' : 'none';
  if (budget !== null) limitEl.style.bottom = `${Math.round((budget / scale) * 100)}%`;
  paintVerdict(cardState(v), speed === 'ok' ? null : speed,
    samples.length ? `last 2 s · dashed = limit · red = late${live ? '' : ' · last run'}` : s && !s.timerSupported ? 'GPU timing not available in this browser' : 'no measurements yet');
}

// --- popup size -----------------------------------------------------------------------
const WINDOW_SETTLE_MS = 400; // longer than the browser takes to resize the popup window to its content
let cutSince: number | null = null; // since when the window has been lower than body
let windowHeight = window.innerHeight;

/**
 * After each repaint. Browser zoom above 100% leaves a window lower than body's 600px limit, and
 * content under the window's edge could not be reached: the window's height becomes body's
 * max-height, so body scrolls. It is set only once the window has stayed too low for a while,
 * that is, has refused to grow: a window that is still growing must not be held small by it.
 * Then the scrollbar's lane: it is added to the popup's width only while body scrolls. The
 * content's width does not depend on it, so this cannot flip back and forth.
 */
function fitViewport() {
  const { body } = document;
  if (!__FIREFOX__) { // Firefox panels size themselves differently and were not measured: body keeps its 600px limit there
    const room = window.innerHeight + 1; // a body of 543.5px in a window of 543px is not cut
    if (body.style.maxHeight) { if (body.scrollHeight <= room) body.style.maxHeight = ''; }
    else if (body.offsetHeight <= room) cutSince = null;
    else if (cutSince === null) cutSince = performance.now();
    else if (performance.now() - cutSince >= WINDOW_SETTLE_MS) body.style.maxHeight = `${window.innerHeight}px`;
  }
  document.documentElement.classList.toggle('scrolls', body.scrollHeight > body.clientHeight);
}
// A new window height (the zoom changed, or the window grew after all): measure again from the start.
window.addEventListener('resize', () => {
  if (window.innerHeight === windowHeight) return; // the width alone: the scrollbar's lane came or went
  windowHeight = window.innerHeight;
  document.body.style.maxHeight = '';
  cutSince = null;
});

// --- refresh ------------------------------------------------------------------------
let refreshing = false;
async function refresh() {
  if (refreshing || !settings) return; // a repaint asked for before the settings are read: start-up does one right after
  refreshing = true;
  try {
    const [found, metas, mangaReplies] = await Promise.all([
      sendToFrames<VideoInfo[]>({ type: 'a4k-list' }),
      sendToFrames<MediaMeta | null>({ type: 'a4k-page-meta' }),
      sendToFrames<MangaStatus | null>({ type: 'a4k-manga-status' }),
    ]);
    const top = metas.find((m) => m.frameId === 0)?.value;
    if (top) pageMeta = top;

    const list: { v: VideoInfo; frameId: number }[] = [];
    for (const { frameId, value } of found) for (let v of value) {
      v = { ...v, id: `${frameId}:${v.id}` }; // a video's own id is unique in its frame only
      const pend = pendingToggle.get(v.key);
      if (pend !== undefined) { if (pend === v.enabled) pendingToggle.delete(v.key); else v = { ...v, enabled: pend }; }
      list.push({ v, frameId });
    }

    const detected = pickManga(mangaReplies);
    const manga = mode() === 'anime' ? null : detected; // mode 'anime': no manga card or page map
    // A reader: the page map stands in for the performance panel (also beside a video, whose card
    // is then compact), and the state chip is the manga tag.
    const reader = manga?.s.kind === 'images';
    besideReader = reader;
    // The open card stays the open card for as long as its video is there: it does not jump.
    if (!list.some((x) => x.v.id === openId)) openId = pickOpen(list.map((x) => x.v))?.id ?? null;
    const open = reader ? null : list.find((x) => x.v.id === openId) ?? null;

    // Reconcile cards: keep existing nodes, add new, remove gone. No innerHTML churn.
    const seen = new Set<string>();
    list.forEach((x, i) => {
      const { v } = x;
      seen.add(v.id);
      let c = cards.get(v.id);
      if (!c) { c = buildCard(v); cards.set(v.id, c); }
      if (sourcesEl.children[i] !== c.el) sourcesEl.insertBefore(c.el, sourcesEl.children[i] ?? null);
      patchCard(c, v, x === open); // after it is on the page: its texts are measured
    });
    for (const [id, c] of cards) if (!seen.has(id)) { c.el.remove(); cards.delete(id); }
    countEl.textContent = list.length > 1 ? `${list.length} videos` : '';
    // No frame answered at all: the page's content script is missing or orphaned (tab opened
    // before an extension reload). Inject a fresh copy once, as the background does on install.
    if (!found.length && !mangaReplies.length && !injected && tabId !== undefined && mangaHost) {
      injected = true;
      void injectContent(tabId);
    }
    try { paintMangaCard(manga); paintPageMap(manga); } catch { /* never let the manga card stop the rest of the popup */ }
    const offered = paintPrompt(detected, list.map((x) => x.v));
    sourcesEl.hidden = offered === 'anime'; // the preview stands in for the paused video cards
    // No video: a frame the browser gives us no access to may hold it. Say so instead of "No video found yet".
    if (list.length === 0) void checkAccess(); else missingSites = [];
    const blocked = list.length === 0 && !manga && !offered && missingSites.length > 0;
    accessEl.hidden = !blocked;
    emptyEl.hidden = list.length > 0 || !!manga || !!offered || blocked; // "No video found yet" would contradict the preview
    const reading = !!manga && list.length === 0;
    setText($('#nowLabel'), reading ? 'reading now' : 'playing now');
    $('#perf').hidden = reader;
    // Colors only reach videos: a manga page with no video gets no folder tabs, only the upscale side.
    document.body.classList.toggle('no-tabs', reading);
    hintEl.classList.toggle('manga', reading && reader);

    // The performance panel follows the open card; a manga page without a video gets manga figures.
    if (reading) paintMangaPerf(manga!); else if (!reader) paintPerf(open?.v ?? null);
    setColorVideo(open?.v ? open.v.enabled : null);
    // Said once: on a video page the performance heading already reads "● Paused", so the preview drops its own.
    ($('.mp-paused') as HTMLElement | null)?.toggleAttribute('hidden', offered === 'anime');

    const active = list.filter((x) => x.v.status === 'Active' && x.v.enabled).length;
    const on = list.filter((x) => x.v.enabled).length;
    let gpuMs: number | null = null;
    for (const { v } of list) if (v.enabled && v.playing && v.stats?.gpuMs != null) gpuMs = (gpuMs ?? 0) + v.stats.gpuMs;
    const paused = gpuMs === null && list.some((x) => x.v.enabled && x.v.status === 'Active') && !list.some((x) => x.v.enabled && x.v.playing);
    const mangaBusy = reading && manga!.s.on && manga!.s.done > 0;
    hintEl.textContent = reading ? (mangaBusy ? `manga · ${settings.preset.toLowerCase()}` : 'manga')
      : list.length === 0 ? 'off' : active ? `on · ${settings.preset.toLowerCase()}` : !on ? 'off' : mode() === 'manga' ? 'paused' : 'starting';
    hintEl.classList.toggle('on', active > 0 || mangaBusy);
    // Without GPU timing (Firefox) the chip shows the frame rate drawn instead.
    const drawn = list.find((x) => x.v.enabled && x.v.playing && x.v.stats && !x.v.stats.timerSupported && x.v.stats.fps > 0)?.v.stats;
    const perPage = reading && reader && mangaOn() && manga!.s.on ? pageTime(manga!.s) : null;
    gpuChip.textContent = perPage !== null ? `${fmtTime(perPage)} / page`
      : gpuMs !== null ? `gpu ${gpuMs.toFixed(1)} ms` : drawn ? `${drawn.fps.toFixed(0)} fps` : paused ? 'paused' : 'gpu —';
    gpuChip.classList.toggle('on', perPage !== null || gpuMs !== null || !!drawn);
    fitViewport();
  } finally {
    refreshing = false;
  }
}

function tick() {
  const d = new Date();
  clockEl.textContent = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

chrome.runtime.onMessage.addListener((msg: Message) => {
  if (msg?.type === 'a4k-changed') void refresh();
});

/** Show the post-update chip once, in place of the clock: opening the popup counts as seeing it. */
async function showWhatsNew() {
  const version = await pendingWhatsNew().catch(() => null);
  if (!version) return;
  const note = $<HTMLAnchorElement>('#whatsnew');
  note.href = WHATS_NEW_URL;
  note.textContent = `● new v${version}`;
  note.hidden = false;
  clockEl.replaceWith(note);
  setCutTip(note, `Updated to v${version} · see what's new`);
  await clearWhatsNew().catch(() => {});
}

/** Rating card at a new milestone. Answers go to the background, which stores them. */
async function showRateCard() {
  const state = await loadRate().catch(() => null);
  const level = state && pendingLevel(state);
  if (!state || !level) return;
  const card = cardFor(state, level);
  const el = $('#rate');
  el.classList.add(`lv${card.level}`);
  setText($('#rate-badge'), card.badge);
  setText($('#rate-big'), card.big);
  setText($('#rate-l1'), card.lines[0]);
  setText($('#rate-l2'), card.lines[1]);
  const go = $<HTMLAnchorElement>('#rate-go');
  go.href = REVIEW_URL;
  const done = $('#rate-done');
  done.hidden = !card.alreadyRated;
  const answer = (action: RateAction) => {
    el.hidden = true;
    chrome.runtime.sendMessage({ type: 'a4k-rate', action, level: card.level } satisfies Message).catch(() => {});
  };
  go.addEventListener('click', () => answer('clicked'));
  go.addEventListener('auxclick', (e) => { if (e.button === 1) answer('clicked'); }); // middle-click opens a tab too
  done.addEventListener('click', () => answer('rated'));
  $('#rate-x').addEventListener('click', () => answer('dismiss'));
  el.hidden = false;
}

// --- manga mode (local prototype, Chrome build only) -------------------------------
let mangaHost = ''; // the address-bar host the switch belongs to
let mangaSiteOn = false; // stored switch state for mangaHost
let mangaPending: boolean | null = null; // clicked state until storage echoes it
let injected = false;

// --- site access ---------------------------------------------------------------------
const accessEl = $('#access');
let tabUrl: string | undefined; // the address-bar URL (absent when the browser withholds it)
let missingSites: string[] = []; // host patterns of this tab's page and frames the browser withholds
let checkingAccess = false;

async function checkAccess() {
  if (checkingAccess || tabId === undefined) return;
  checkingAccess = true;
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null);
    const origins = accessOrigins([tabUrl, ...(frames ?? []).map((f) => f.url)]);
    missingSites = await missingAccess(origins, (o) => chrome.permissions.contains({ origins: [o] }));
  } finally {
    checkingAccess = false;
  }
}

// The browser's own prompt. Firefox may close the popup while it shows; the background then
// injects the scripts when access is granted (permissions.onAdded), so nothing is lost.
function initAccess() {
  $('#access-go').addEventListener('click', () => {
    const origins = missingSites;
    if (!origins.length || tabId === undefined) return;
    const id = tabId;
    // request() must be the first call in the click, or the browser refuses it as not user-initiated.
    chrome.permissions.request({ origins }).then((granted) => {
      if (!granted) return;
      missingSites = [];
      void injectContent(id).then(refresh);
    }, () => {});
  });
}

async function injectContent(id: number) {
  const target = { tabId: id, allFrames: true };
  await chrome.scripting.insertCSS({ target, files: ['content.css'] }).catch(() => {});
  await chrome.scripting.executeScript({ target, files: ['content.js'] }).catch(() => {});
}

interface MangaView { s: MangaStatus; meta: MangaMeta; stale: boolean; frameHost: string | null; frameId: number }
let lastManga: MangaView | null = null; // what the card shows; its frame host is switched on with the site

/** The frame with the reader (most pages; a canvas reader only if no frame has images), and the best title. */
function pickManga(replies: { frameId: number; value: MangaStatus | null }[]): MangaView | null {
  // A page script from before an extension update may answer with an older shape: fill in what it lacks.
  const fixed = replies.map((r) => (r.value ? { frameId: r.frameId, value: {
    ...r.value, marks: r.value.marks ?? [], total: r.value.total ?? r.value.marks?.length ?? 0, reasons: r.value.reasons ?? [],
  } } : r));
  const found = fixed.filter((r): r is { frameId: number; value: MangaStatus } => !!r.value?.kind);
  if (!found.length) return null;
  const rank = (s: MangaStatus) => (s.kind === 'images' ? 1e6 : 0) + s.marks.length;
  // The top page wins when it shows the pages itself: an embedded frame must not outrank it by faking more.
  const topFound = found.find((r) => r.frameId === 0 && r.value.kind === 'images');
  const best = topFound ?? found.reduce((a, b) => (rank(b.value) > rank(a.value) ? b : a));
  // A reader in an iframe from another host is switched on with the site only when it is the one
  // frame showing pages; with several candidates (ads imitating a reader) none is trusted.
  const framesWithPages = found.filter((r) => r.frameId !== 0 && r.value.kind === 'images');
  const frameHost = !topFound && framesWithPages.length === 1 && best === framesWithPages[0] ? best.value.host : null;
  // The reader is often an iframe with a bare title; the top page usually names the chapter.
  const top = replies.find((r) => r.frameId === 0)?.value?.meta;
  const meta = top?.chapter ? top : best.value.meta.chapter ? best.value.meta : top?.series ? top : best.value.meta;
  return { s: best.value, meta, stale: best.value.protocol !== MANGA_PROTOCOL, frameHost, frameId: best.frameId };
}

function mangaOn(): boolean { return mangaPending ?? mangaSiteOn; }

function paintMangaCard(m: MangaView | null) {
  lastManga = m;
  const card = $('#manga-card');
  card.hidden = !m;
  // Manga pages are always 2x, so the upscale row does not apply (and the popup must fit without scrolling).
  $('#upscale').hidden = $('#upscale-head').hidden = !!m && m.s.kind === 'images';
  if (!m) return;
  const { s, meta } = m;
  const on = mangaOn();
  card.classList.toggle('on', on && s.kind === 'images');
  card.classList.toggle('unsupported', s.kind === 'canvas' && !on); // an unsupported reader can still be switched off
  $<HTMLInputElement>('#manga-switch input').checked = on && s.kind === 'images';
  setText($('#manga-title'), meta.series ?? mangaHost);
  setCutTip($('#manga-title'), s.reasons.length ? `Detected: ${s.reasons.join(' · ')}` : '');
  const tag = $('#manga-tag');
  tag.hidden = !meta.chapter;
  setText(tag, mangaTag(meta));
  setCutTip(tag);
  // One line: "9 pages · colour · 2000×2798"; source size and host in the tooltip.
  const upscaled = on && s.done > 0;
  const nameEl = $('#manga-name');
  setText(nameEl, mangaLine(m, upscaled));
  setCutTip(nameEl, [
    s.size ? `${s.size.w}×${s.size.h}${upscaled ? ` → ${s.size.w * 2}×${s.size.h * 2}` : ''}` : '',
    s.imageHost ? `pages from ${s.imageHost}` : '',
  ].filter(Boolean).join(' · '));

  // Not running: one short line that says why (the long reason is its tooltip). Running: the progress bar and the four counts.
  let cls = '';
  let text = '';
  let why = '';
  if (m.stale) { cls = 'warn'; text = '● Reload'; why = 'Anime4Nerd was updated: reload this page to finish'; }
  else if (s.kind === 'canvas') { cls = 'bad'; text = NOT_POSSIBLE; why = 'This reader draws pages on a canvas, so they cannot be upscaled yet'; }
  else if (!on) { cls = 'off'; text = '● off · switch on to upscale this chapter'; }
  else if (!s.on) { cls = 'dim'; text = '● starting…'; }
  const state = $('#manga-state');
  state.hidden = !text;
  state.className = `state ${cls}`;
  setText(state, text);
  setCutTip(state, why);
  $('#manga-prog').hidden = !!text;
  setTip(card, text ? '' : 'Alt+M compares a page with its original');
  if (text) return;
  const states = pageStates(s, true);
  const counts = countStates(states);
  paintPageBar(states, counts);
  for (const k of CELL_STATES) {
    const box = $(`.mc-counts [data-k="${k}"]`);
    setText(box.querySelector('b')!, String(counts[k]));
    box.classList.toggle('zero', counts[k] === 0);
  }
  setTip($('.mc-counts [data-k="fail"]'), counts.fail ? `last error: ${s.lastError ?? 'unknown error'}` : '');
}

function mangaTag(meta: MangaMeta): string {
  return `${meta.volume ? `vol ${meta.volume} · ` : ''}ch ${meta.chapter ?? ''}`;
}

/** The card's second line: "9 pages · colour · 2000×2798" (the output size once pages are upscaled). */
function mangaLine({ s, meta }: MangaView, upscaled: boolean): string {
  if (s.kind === 'canvas') return 'pages drawn on a canvas';
  const n = s.total; // pages in the chapter, from its page counter or still-loading slots
  const size = s.size ? (upscaled ? `${s.size.w * 2}×${s.size.h * 2}` : `${s.size.w}×${s.size.h}`) : '';
  const colour = s.grey === null ? '' : s.grey ? 'b&w' : 'colour';
  return [meta.chapterTitle, `${n} page${n === 1 ? '' : 's'}`, colour, size].filter(Boolean).join(' · ');
}

// --- pages of the chapter: one state each, shared by the card's bar and the page map --------
const CELL_STATES = ['done', 'now', 'fail', 'wait'] as const;
type CellState = typeof CELL_STATES[number];

/**
 * The state of every page of the chapter. The reader's own list (s.marks: the pages on the page
 * now) can be shorter and start later (s.first; an older page script does not send it). Pages
 * outside it, and every page while the site is off, are waiting.
 */
function pageStates(s: MangaStatus, on: boolean): CellState[] {
  const first = s.first ?? 0;
  return Array.from({ length: s.total }, (_, i) => {
    const mark = on ? s.marks[i - first] : undefined;
    return mark === 'done' || mark === 'now' || mark === 'fail' ? mark : 'wait';
  });
}

function countStates(states: CellState[]): Record<CellState, number> {
  const counts: Record<CellState, number> = { done: 0, now: 0, fail: 0, wait: 0 };
  for (const st of states) counts[st] += 1;
  return counts;
}

// The card is 312px wide inside: with 2px gaps, 80 blocks are still 1.9px each. More pages than
// that get one segment per state, as wide as its share of the pages.
const MC_MAX_BLOCKS = 80;
const pageBar = $('#mc-pages');

function paintPageBar(states: CellState[], counts: Record<CellState, number>) {
  const shares = states.length > MC_MAX_BLOCKS;
  const want = shares ? CELL_STATES.length : states.length;
  if (pageBar.classList.contains('shares') !== shares) { pageBar.replaceChildren(); pageBar.classList.toggle('shares', shares); }
  while (pageBar.children.length > want) pageBar.lastElementChild!.remove();
  while (pageBar.children.length < want) pageBar.append(document.createElement('i'));
  for (let i = 0; i < want; i += 1) {
    const block = pageBar.children[i] as HTMLElement;
    const st = shares ? CELL_STATES[i] : states[i];
    if (block.className !== st) block.className = st;
    if (!shares) continue;
    block.style.flexGrow = String(counts[st]);
    block.hidden = counts[st] === 0;
  }
  pageBar.setAttribute('aria-label', `${counts.done} of ${states.length} pages upscaled`);
}

// --- page map: one cell per page of the chapter, built once and recoloured in place --------
const PMAP_COLS = 12; // as in popup.css
const UNKNOWN = '–';
const CELL_WORD: Record<CellState, string> = { done: 'done', now: 'in progress', fail: 'failed', wait: 'waiting' };
const pmap = {
  panel: $('#pmap'), count: $('#pmap-count'), grid: $('#pmap-grid'), per: $('#pmap-per'), left: $('#pmap-left'),
  sets: $('#pmap-sets'), prev: $<HTMLButtonElement>('#pmap-prev'), next: $<HTMLButtonElement>('#pmap-next'), range: $('#pmap-range'),
};
/** Pages shown at once: ten rows of 12. A longer chapter gets arrows to step through sets of this many. */
const PMAP_SET = 120;
/** The set the arrows picked; null follows the page being read. */
let pmapPicked: number | null = null;
let pmapSet = 0;

/** Start to shown for one page; the GPU pass alone until a whole page has been timed. */
function pageTime(s: MangaStatus): number | null { return s.pageMs ?? s.perPageMs ?? null; }

function fmtTime(ms: number): string {
  const sec = ms / 1000;
  if (sec < 9.95) return `${sec.toFixed(1)} s`;
  return sec < 59.5 ? `${Math.round(sec)} s` : `${Math.round(sec / 60)} min`;
}

function paintPageMap(m: MangaView | null) {
  const show = !!m && m.s.kind === 'images';
  pmap.panel.hidden = !show;
  if (!show) return;
  const { s } = m;
  const wanted = mangaOn();
  const on = wanted && s.on;
  const n = s.total;
  while (pmap.grid.children.length > n) pmap.grid.lastElementChild!.remove();
  for (let i = pmap.grid.children.length; i < n; i += 1) {
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.tabIndex = -1;
    cell.textContent = String(i + 1);
    pmap.grid.append(cell);
  }
  // One tab stop for the whole map (the arrow keys move inside it): a long chapter must not put
  // hundreds of Tab presses before the presets.
  if (!pmap.grid.querySelector('[tabindex="0"]') && pmap.grid.firstElementChild) (pmap.grid.firstElementChild as HTMLElement).tabIndex = 0;
  // Cells stand for chapter pages; the reader's own list (loaded pages, then those still loading)
  // can be shorter and start later. An older page script sends neither figure.
  const first = s.first ?? 0;
  const reading = Math.floor((first + (s.current ?? 0)) / PMAP_SET);
  showSet(pmapPicked ?? reading);
  const reachable = s.marks.length + (s.loading ?? 0);

  const states = pageStates(s, on);
  const counts = countStates(states);
  for (let i = 0; i < n; i += 1) {
    const at = i - first;
    const state = states[i];
    const cell = pmap.grid.children[i] as HTMLElement;
    const cls = state === 'wait' ? 'pcell' : `pcell ${state}`;
    if (cell.className !== cls) cell.className = cls;
    // A page the reader has not put on the page cannot be scrolled to: same look, not a control.
    const there = at >= 0 && at < reachable;
    const label = there ? `go to page ${i + 1}, ${wanted ? CELL_WORD[state] : 'off'}` : `page ${i + 1}, not loaded yet`;
    if (cell.dataset.tip !== label) { cell.dataset.tip = label; cell.setAttribute('aria-label', label); }
    const page = there ? String(at) : '';
    if (cell.dataset.page !== page) {
      cell.dataset.page = page;
      if (there) cell.removeAttribute('aria-disabled'); else cell.setAttribute('aria-disabled', 'true');
    }
  }

  setText(pmap.count, `● ${counts.done} / ${n}`);
  pmap.count.className = `verdict ${!on ? 'dim' : counts.fail ? 'warn' : 'ok'}`;
  const per = on ? pageTime(s) : null;
  // Only pages the reader has on the page get upscaled, so only those count as left.
  const left = s.marks.filter((mk) => mk === 'now' || mk === 'todo').length + (s.loading ?? 0);
  setText(pmap.per, per === null ? UNKNOWN : fmtTime(per));
  pmap.per.className = per === null ? '' : 'ok';
  // Several pages are worked on at once, so pages times the time of one is the upper end.
  setText(pmap.left, per === null || !left ? UNKNOWN : `~${fmtTime(per * left)}`);
  setTip(pmap.left, per === null || !left ? '' : 'at most: several pages are worked on at once');
}

/** Shows one set of PMAP_SET cells; the arrows only when the chapter has more than one set. */
function showSet(set: number) {
  const n = pmap.grid.children.length;
  const last = Math.max(0, Math.ceil(n / PMAP_SET) - 1);
  pmapSet = Math.min(Math.max(set, 0), last);
  pmap.sets.hidden = last === 0;
  const from = pmapSet * PMAP_SET;
  const to = Math.min(from + PMAP_SET, n);
  for (let i = 0; i < n; i += 1) {
    const cell = pmap.grid.children[i] as HTMLElement;
    const out = i < from || i >= to;
    if (cell.hidden !== out) cell.hidden = out;
  }
  if (last === 0) return;
  setText(pmap.range, `${from + 1}–${to}`);
  pmap.prev.disabled = pmapSet === 0;
  pmap.next.disabled = pmapSet === last;
  // The map's one tab stop moves into the set on show, so Tab still reaches the map.
  const stop = pmap.grid.querySelector<HTMLElement>('[tabindex="0"]');
  if (stop?.hidden) { stop.tabIndex = -1; (pmap.grid.children[from] as HTMLElement).tabIndex = 0; }
}

function stepSet(by: number) {
  pmapPicked = pmapSet + by;
  showSet(pmapPicked);
}

/** A cell scrolls the reader to its page. Buttons turn Enter and Space into clicks themselves. */
function onPageMapClick(e: MouseEvent) {
  const cell = (e.target as HTMLElement).closest<HTMLElement>('.pcell');
  if (!cell || !cell.dataset.page || tabId === undefined || !lastManga) return;
  const msg: Message = { type: 'a4k-manga-goto', index: Number(cell.dataset.page) };
  chrome.tabs.sendMessage(tabId, msg, { frameId: lastManga.frameId }).catch(() => { /* the tab is gone or reloading */ });
}

/** Arrow keys walk the map: one cell left or right, one row up or down. */
const PMAP_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -PMAP_COLS, ArrowDown: PMAP_COLS };
function onPageMapKey(e: KeyboardEvent) {
  const step = PMAP_STEPS[e.key];
  const from = Array.prototype.indexOf.call(pmap.grid.children, e.target);
  if (step === undefined || from < 0) return;
  e.preventDefault(); // the arrows would scroll the popup
  const to = from + step;
  if (to < 0 || to >= pmap.grid.children.length) return;
  // Walking past the set shows the next one.
  if (Math.floor(to / PMAP_SET) !== pmapSet) { pmapPicked = Math.floor(to / PMAP_SET); showSet(pmapPicked); }
  (pmap.grid.children[to] as HTMLElement).focus();
}

/** The cell that has the focus is the map's one tab stop, so Tab comes back to it. */
function onPageMapFocus(e: FocusEvent) {
  const cell = (e.target as HTMLElement).closest<HTMLElement>('.pcell');
  if (!cell) return;
  for (const el of pmap.grid.querySelectorAll<HTMLElement>('[tabindex="0"]')) el.tabIndex = -1;
  cell.tabIndex = 0;
}

const MANGA_LABELS = ['GPU / page', 'Pages', 'Output', 'Mode', 'Failed', 'Next'];
function paintMangaPerf({ s }: MangaView) {
  const on = mangaOn() && s.on && s.kind === 'images';
  const loaded = s.marks.length;
  const n = s.total;
  tiles.forEach((el, i) => setText(el.previousElementSibling as HTMLElement, MANGA_LABELS[i]));
  perf.bars.style.display = 'none';
  limitEl.style.display = 'none';
  const next = s.marks.findIndex((mk, i) => mk === 'todo' && i >= (s.current ?? 0));
  const values: [string, string][] = [
    [on && s.perPageMs !== null ? `${Math.round(s.perPageMs)} ms` : '—', ''],
    [s.kind === 'images' ? `${s.done} / ${n}` : '—', s.failed ? 'warn' : on && s.done ? 'ok' : ''],
    [on && s.size && s.done ? `${s.size.w * 2}×${s.size.h * 2}` : '—', ''],
    [s.grey === null ? '—' : s.grey ? 'b&w' : 'colour', ''],
    [on ? String(s.failed) : '—', s.failed ? 'warn' : on ? 'ok' : ''],
    [on && next >= 0 ? `p. ${next + 1}` : '—', ''],
  ];
  tiles.forEach((el, i) => { setText(el, values[i][0]); el.className = values[i][1]; });
  // The whole page (read or download, GPU, encode) overlaps with the next pages, so it is the tooltip.
  setTip(tiles[0], on && s.pageMs != null ? `whole page, start to shown: ${Math.round(s.pageMs)} ms` : '');
  let vc = 'dim';
  let vt = '● off';
  if (s.kind === 'canvas') vt = '● n/a';
  else if (on && s.failed) { vc = 'warn'; vt = '● partly'; }
  else if (on && loaded && s.done === loaded) { vc = 'ok'; vt = loaded < n ? '● waiting for pages' : '● done'; }
  else if (on) { vc = 'ok'; vt = '● upscaling'; }
  perf.verdict.hidden = false;
  setText(perf.verdict, vt);
  perf.verdict.className = `verdict ${vc}`;
  setTip(perf.verdict, s.kind === 'images' ? 'pages upscaled 2× · Mode C or C+A suits b&w' : 'not supported on this reader yet');
}

function initMangaCard(url: string | undefined) {
  try { const u = new URL(url ?? ''); if (u.protocol === 'http:' || u.protocol === 'https:') mangaHost = u.hostname; } catch { /* no url */ }
  if (!mangaHost) return;
  pmap.grid.addEventListener('click', onPageMapClick);
  pmap.grid.addEventListener('keydown', onPageMapKey);
  pmap.grid.addEventListener('focusin', onPageMapFocus);
  pmap.prev.addEventListener('click', () => stepSet(-1));
  pmap.next.addEventListener('click', () => stepSet(1));
  void loadMangaSites().then((sites) => { mangaSiteOn = sites[mangaHost] === true; void refresh(); });
  onMangaSitesChanged((sites) => {
    mangaSiteOn = sites[mangaHost] === true;
    if (mangaPending === mangaSiteOn) mangaPending = null;
    void refresh();
  });
  const card = $('#manga-card');
  card.addEventListener('click', (e) => {
    e.preventDefault();
    if (card.classList.contains('unsupported')) return;
    const want = !mangaOn();
    mangaPending = want;
    // The reader may be an iframe from another host: switch that host on too, since the user is
    // switching on this chapter. Other frames on the site (ads) stay off.
    const hosts = new Set([mangaHost, lastManga?.frameHost].filter((h): h is string => !!h));
    setMangaSites([...hosts], want).catch(() => { mangaPending = null; void refresh(); });
    void refresh();
  });
}

// --- mode suggestion (Chrome build only) -----------------------------------------------
// Mode 'anime' on a manga reader, or mode 'manga' on a page with a video: "playing now" shows the
// card the page would get, locked, with a button to switch, and the mode chip turns red. After a
// switch a line confirms for a moment, with an undo. Esc hides either until the popup reopens.
const PROMPT_DONE_MS = 4000;
const prompt = {
  box: $('#mp-preview'), title: $('#mp-title'), tag: $('#mp-tag'), name: $('#mp-name'), go: $('#mp-go'), auto: $('#mp-auto'),
  done: $('#mp-done'), doneText: $('#mp-done-text'), undo: $('#mp-undo'),
};
let promptKind: Suggest | null = null; // the mode the preview offers
let promptHidden = false; // Esc was pressed in this popup
let promptDone: { mode: Mode; prev: Mode; timer: number } | null = null; // the confirmation after a switch

/** Hiding a part of the suggestion must not drop the keyboard focus: it goes to the mode dropdown. */
function showPromptPart(el: HTMLElement, on: boolean) {
  if (!on && el.contains(document.activeElement)) modeBtn.focus();
  el.hidden = !on;
}

function showPrompt(on: boolean) {
  showPromptPart(prompt.box, on);
  $('#modeChip').classList.toggle('mp-ind-frame', on);
}

function endPromptDone() {
  if (!promptDone) return;
  window.clearTimeout(promptDone.timer);
  promptDone = null;
  showPromptPart(prompt.done, false);
}

/** Shows or hides the preview; returns the mode it offers while it shows. */
function paintPrompt(found: MangaView | null, videos: VideoInfo[]): Suggest | null {
  if (promptDone && mode() !== promptDone.mode) endPromptDone(); // the mode was changed by hand meanwhile
  // Only a reader whose pages can be upscaled is offered: the condition the manga card switches on.
  // A page with both a reader and a video fits mode 'manga': no offer to switch back.
  const reader = found?.s.kind === 'images';
  promptKind = mode() === 'anime' && reader ? 'manga' : mode() === 'manga' && videos.length && !reader ? 'anime' : null;
  if (!promptKind || promptHidden) { showPrompt(false); return null; }
  let tag: string;
  if (promptKind === 'manga') {
    setText(prompt.title, found!.meta.series ?? mangaHost);
    tag = found!.meta.chapter ? mangaTag(found!.meta) : '';
    setText(prompt.name, mangaLine(found!, false));
  } else {
    // The largest video is the one being watched (others are previews or ads).
    const v = videos.reduce((a, b) => (b.height > a.height ? b : a));
    const label = labelFor(v);
    setText(prompt.title, label.title);
    tag = label.tag;
    setText(prompt.name, [label.episodeName, v.height ? pLabel(v.height) : ''].filter(Boolean).join(' · '));
  }
  setText(prompt.tag, tag);
  prompt.tag.hidden = !tag;
  setTip(prompt.name, prompt.name.textContent ?? ''); // the line is cut when it is long
  setText(prompt.go, `switch to ${promptKind}`);
  showPrompt(true);
  setCutTip(prompt.title);
  setCutTip(prompt.tag);
  return promptKind;
}

/** Switches the mode (live, through saveSettings) and confirms: "now in manga mode", with an undo. */
async function promptSwitch(to: Mode) {
  const prev = mode();
  paintSettings(await saveSettings({ mode: to }));
  if (promptDone) window.clearTimeout(promptDone.timer);
  promptDone = { mode: to, prev, timer: window.setTimeout(() => { endPromptDone(); void refresh(); }, PROMPT_DONE_MS) };
  setText(prompt.doneText, `now in ${to} mode`);
  showPromptPart(prompt.done, true);
  prompt.undo.focus();
  showPrompt(false);
  void refresh();
}

function initPrompt() {
  prompt.go.addEventListener('click', () => { if (promptKind) void promptSwitch(promptKind); });
  prompt.auto.addEventListener('click', () => { void promptSwitch('auto'); });
  prompt.undo.addEventListener('click', () => {
    if (!promptDone) return;
    const { prev } = promptDone;
    endPromptDone();
    void saveSettings({ mode: prev }).then((s) => { paintSettings(s); void refresh(); });
  });
  for (const el of [prompt.box, prompt.done]) el.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); // Esc would close the popup
    e.stopPropagation();
    if (promptDone) endPromptDone(); else { promptHidden = true; showPrompt(false); void refresh(); }
  });
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  try { tabHost = new URL(tab?.url ?? '').host; } catch { /* no url permission */ }
  tabUrl = tab?.url;
  tick();
  initColorTab();
  void showWhatsNew();
  void showRateCard();
  initMangaCard(tab?.url);
  initPrompt();
  initAccess();
  paintSettings(await loadSettings());
  onSettingsChanged((s) => { paintSettings(s); void refresh(); });
  onSourcesChanged(() => { void refresh(); });
  await refresh();
  setInterval(refresh, 500);
  setInterval(tick, 10000);
})();

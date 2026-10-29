import {
  Message, PRESETS, Settings, VideoInfo, capNote, loadSettings, onSettingsChanged, onSourcesChanged, saveSettings, setSource,
} from './settings';
import { EMPTY_META, MediaMeta } from './media-meta';
import { WHATS_NEW_URL, clearWhatsNew, pendingWhatsNew } from './whats-new';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const hintEl = $('#hint');
const gpuChip = $('#gpuchip');
const clockEl = $('#clock');
const countEl = $('#count');
const presetNameEl = $('#presetName');
const sourcesEl = $('#sources');
const emptyEl = $('#empty');
const presetsEl = $('#presets');
const perf = {
  verdict: $('#verdict'), load: $('#k-load'), ms: $('#k-ms'), fps: $('#k-fps'), avg: $('#k-avg'), limit: $('#k-limit'), late: $('#k-late'),
  bars: $('#bars'), legend: $('#legend'),
};

let settings: Settings;
let tabId: number | undefined;
let tabHost = '';
let pageMeta: MediaMeta = EMPTY_META;
const BARS = 48;

const lastBudget = new Map<string, number>(); // video id -> last known frame limit (ms)
const lastSamples = new Map<string, number[]>(); // video id -> last graph, kept while paused
const pendingToggle = new Map<string, boolean>(); // key -> desired state until storage echoes it
let pointerBusy = false;
// Cleared on window, not the card: a press that drags off the card must not leave it set,
// or patchCard would stop updating checkboxes for the rest of the popup's life.
for (const ev of ['pointerup', 'pointercancel'] as const) window.addEventListener(ev, () => { pointerBusy = false; });
let focusId: string | null = null; // which video the performance panel follows

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
  b.addEventListener('click', () => { void saveSettings({ upscale: b.dataset.upscale as Settings['upscale'] }); });
}
function paintSettings(s: Settings) {
  settings = s;
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
async function sendToFrames<T>(msg: Message): Promise<{ frameId: number; value: T }[]> {
  if (tabId === undefined) return [];
  let frames: { frameId: number }[] = [{ frameId: 0 }];
  try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? frames; } catch { /* keep main frame */ }
  const results = await Promise.allSettled(frames.map(async (f) => ({
    frameId: f.frameId,
    value: await chrome.tabs.sendMessage(tabId!, msg, { frameId: f.frameId }) as T,
  })));
  return results.flatMap((r) => (r.status === 'fulfilled' && r.value.value != null ? [r.value] : []));
}

function pLabel(h: number): string { return h ? `${h}p` : '?'; }

/** Merge page metadata with the player frame's Media Session data. */
function labelFor(v: VideoInfo): { title: string; tag: string; episodeName: string } {
  const m: MediaMeta = { ...pageMeta };
  if (v.media) {
    if (!m.title && v.media.album) m.title = v.media.album;
    if (!m.episodeName && v.media.title && v.media.title !== m.title) m.episodeName = v.media.title;
    if (!m.title && v.media.title) m.title = v.media.title;
    if (!m.subtitle && v.media.artist) m.subtitle = v.media.artist;
  }
  const title = m.title || tabHost || v.frameHost;
  let tag = '';
  if (m.episode !== null) tag = m.season !== null ? `S${m.season} E${m.episode}` : `E${m.episode}`;
  let episodeName = m.episodeName && m.episodeName !== title ? m.episodeName : (m.episode === null && m.subtitle ? m.subtitle : '');
  if (/^\s*(episode|ep\.?|e)\s*#?\d+\s*$/i.test(episodeName) || episodeName.replace(/\s+/g, '').toLowerCase() === tag.replace(/\s+/g, '').toLowerCase()) episodeName = '';
  // No real name: say "Episode N" next to the tag rather than leaving the line bare.
  if (!episodeName && m.episode !== null) episodeName = `Episode ${m.episode}`;
  return { title, tag, episodeName };
}

/** Card state word: only what the card is doing, no performance verdict. */
function cardState(v: VideoInfo): { cls: string; text: string } {
  if (!v.enabled) return { cls: 'off', text: '● Off · tap to turn on' };
  switch (v.status) {
    case 'Active': return v.playing ? { cls: 'ok', text: '● Upscaling' } : { cls: 'dim', text: '● Paused' };
    case 'Loading': return { cls: 'warn', text: '● Starting…' };
    case 'Waiting': return { cls: 'dim', text: '● Waiting for video' };
    case 'Suspended': return { cls: 'dim', text: '● Paused (fullscreen / PiP / hidden tab)' };
    case 'Unavailable': return { cls: 'bad', text: `● Not possible — ${v.message.toLowerCase()}` };
    default: return { cls: 'dim', text: '● Off' };
  }
}

function budgetFor(v: VideoInfo): number | null {
  const src = v.sourceFps ?? v.stats?.sourceFps ?? ((v.playing && v.stats && v.stats.fps >= 10) ? v.stats.fps : null);
  if (src) lastBudget.set(v.id, 1000 / src);
  return lastBudget.get(v.id) ?? null;
}

// --- card: built once per video id, then patched in place ------------------------
interface Card {
  el: HTMLElement; key: string; cb: HTMLInputElement;
  title: HTMLElement; episode: HTMLElement; tag: HTMLElement; epName: HTMLElement; meta: HTMLElement; state: HTMLElement;
}
const cards = new Map<string, Card>();

function buildCard(v: VideoInfo): Card {
  const el = document.createElement('div');
  el.className = 'source';
  el.dataset.id = v.id;
  el.innerHTML = `
    <div class="line"><div class="title"></div><label class="switch"><input type="checkbox" /></label></div>
    <div class="episode"><span class="tag"></span><span class="epname"></span></div>
    <div class="meta"></div>
    <div class="hr"></div>
    <div class="state"></div>`;
  const q = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
  const card: Card = {
    el, key: v.key, cb: q<HTMLInputElement>('input'),
    title: q('.title'), episode: q('.episode'), tag: q('.tag'), epName: q('.epname'), meta: q('.meta'), state: q('.state'),
  };
  const flip = (on: boolean) => {
    pendingToggle.set(card.key, on);
    card.cb.checked = on;
    el.classList.toggle('on', on);
    void setSource(card.key, on).then(() => { setTimeout(() => { void refresh(); }, 60); });
  };
  const sw = q('.switch');
  sw.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); pointerBusy = true; flip(!card.cb.checked); });
  sw.addEventListener('click', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => { if (e.button === 0) { pointerBusy = true; flip(!card.cb.checked); } });
  card.cb.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(!card.cb.checked); } });
  el.addEventListener('mouseenter', () => { focusId = v.id; });
  return card;
}

function setText(el: HTMLElement, text: string) { if (el.textContent !== text) el.textContent = text; }

function patchCard(c: Card, v: VideoInfo) {
  c.key = v.key;
  const { title, tag, episodeName } = labelFor(v);
  setText(c.title, title);
  setText(c.tag, tag);
  c.tag.hidden = !tag;
  setText(c.epName, episodeName);
  c.episode.hidden = !tag && !episodeName;
  // Real output size while rendering (2x, or 4x on large displays); 2x is the default before that.
  const outH = v.stats?.outputHeight ?? v.height * 2;
  const out = v.stats ? `${v.stats.outputWidth}×${v.stats.outputHeight}` : pLabel(outH);
  const scale = v.height ? Math.round(outH / v.height) : 0;
  const capped = v.stats && settings ? capNote(settings.upscale, scale) : '';
  const res = v.height ? ` · ${pLabel(v.height)} → ${out} (${scale}×)${capped}` : '';
  setText(c.meta, `${tabHost || v.frameHost}${res}`);
  c.meta.title = v.frameHost !== tabHost ? `player frame: ${v.frameHost} · stream: ${v.mediaHost}` : `stream: ${v.mediaHost}`;
  const st = cardState(v);
  setText(c.state, st.text);
  c.state.className = `state ${st.cls}`;
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

function paintPerf(v: VideoInfo | null) {
  const f = (n: number | null, d = 1) => (n === null ? '—' : n.toFixed(d));

  // Off: everything cleared.
  if (!v || !v.enabled) {
    for (const el of [perf.load, perf.ms, perf.avg, perf.limit, perf.late]) { setText(el, '—'); el.className = ''; }
    setText(perf.fps, '—');
    setText(perf.verdict, '● off'); perf.verdict.className = 'verdict dim';
    for (const bar of barEls) { bar.className = 'empty'; bar.style.height = '1px'; }
    limitEl.style.display = 'none';
    setText(perf.legend, v ? 'turn the video on to start measuring' : 'no video');
    if (v) lastSamples.delete(v.id);
    return;
  }

  const s = v.stats;
  const live = !!s && v.playing && s.fps > 0;
  const budget = budgetFor(v);
  const samples = s && s.samples.length ? s.samples : (lastSamples.get(v.id) ?? []);
  if (s && s.samples.length) lastSamples.set(v.id, s.samples);
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

  let vc = 'dim'; let vt = '● paused';
  if (v.status === 'Unavailable') { vc = 'bad'; vt = '● not possible'; } else if (v.status === 'Loading') { vc = 'warn'; vt = '● starting'; } else if (live) {
    if (load === null) { vc = 'ok'; vt = '● running'; } else if (load > 1) { vc = 'bad'; vt = '● dropping frames'; } else if (load > 0.8) { vc = 'warn'; vt = '● near limit'; } else { vc = 'ok'; vt = '● keeping up'; }
  }
  setText(perf.verdict, vt);
  perf.verdict.className = `verdict ${vc}`;

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
  setText(perf.legend, samples.length ? `last 2 s · dashed = limit · red = late${live ? '' : ' · last run'}` : s && !s.timerSupported ? 'GPU timing not available in this browser' : 'no measurements yet');
}

// --- refresh ------------------------------------------------------------------------
let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const [found, metas] = await Promise.all([
      sendToFrames<VideoInfo[]>({ type: 'a4k-list' }),
      sendToFrames<MediaMeta | null>({ type: 'a4k-page-meta' }),
    ]);
    const top = metas.find((m) => m.frameId === 0)?.value;
    if (top) pageMeta = top;

    const list: { v: VideoInfo; frameId: number }[] = [];
    for (const { frameId, value } of found) for (let v of value) {
      const pend = pendingToggle.get(v.key);
      if (pend !== undefined) { if (pend === v.enabled) pendingToggle.delete(v.key); else v = { ...v, enabled: pend }; }
      list.push({ v, frameId });
    }

    // Reconcile cards: keep existing nodes, add new, remove gone. No innerHTML churn.
    const seen = new Set<string>();
    list.forEach(({ v }, i) => {
      seen.add(v.id);
      let c = cards.get(v.id);
      if (!c) { c = buildCard(v); cards.set(v.id, c); }
      patchCard(c, v);
      if (sourcesEl.children[i] !== c.el) sourcesEl.insertBefore(c.el, sourcesEl.children[i] ?? null);
    });
    for (const [id, c] of cards) if (!seen.has(id)) { c.el.remove(); cards.delete(id); }
    emptyEl.hidden = list.length > 0;
    countEl.textContent = list.length > 1 ? `${list.length} videos` : '';

    // Performance panel follows: hovered card, else first enabled, else first.
    const pick = list.find((x) => x.v.id === focusId) ?? list.find((x) => x.v.enabled) ?? list[0] ?? null;
    paintPerf(pick?.v ?? null);

    const active = list.filter((x) => x.v.status === 'Active' && x.v.enabled).length;
    const on = list.filter((x) => x.v.enabled).length;
    let gpuMs: number | null = null;
    for (const { v } of list) if (v.enabled && v.stats?.gpuMs != null) gpuMs = (gpuMs ?? 0) + v.stats.gpuMs;
    hintEl.textContent = list.length === 0 ? 'off' : active ? `on · ${settings.preset.toLowerCase()}` : on ? 'starting' : 'off';
    hintEl.classList.toggle('on', active > 0);
    gpuChip.textContent = gpuMs === null ? 'gpu —' : `gpu ${gpuMs.toFixed(1)} ms`;
    gpuChip.classList.toggle('on', gpuMs !== null);
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

/** Show the post-update banner once: opening the popup counts as seeing it. */
async function showWhatsNew() {
  const version = await pendingWhatsNew().catch(() => null);
  if (!version) return;
  const note = $<HTMLAnchorElement>('#whatsnew');
  note.href = WHATS_NEW_URL;
  setText($('#whatsnew-ver'), version);
  note.hidden = false;
  await clearWhatsNew().catch(() => {});
}

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  try { tabHost = new URL(tab?.url ?? '').host; } catch { /* no url permission */ }
  tick();
  void showWhatsNew();
  paintSettings(await loadSettings());
  onSettingsChanged((s) => { paintSettings(s); void refresh(); });
  onSourcesChanged(() => { void refresh(); });
  await refresh();
  setInterval(refresh, 500);
  setInterval(tick, 10000);
})();

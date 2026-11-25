// Service worker.
//
// Content scripts declared in the manifest only reach pages loaded after the extension is
// installed or updated. On install/update, inject into every frame of already-open tabs so the
// user does not have to reload. Frames are injected one at a time: a single allFrames call fails
// as a whole if any one frame (chrome://, the web store, a PDF viewer) refuses scripts.
// The content script guards against running twice.

import { markUpdated, onWhatsNewChanged, pendingWhatsNew, restoreBadge } from './whats-new';
import { RateAction, addWatch, applyAction, markReturning, updateRate } from './rate-prompt';
import type { Message, Suggest } from './settings';
import { addressBlocked, isMetadataHost, isPrivateHost } from './private-host';
import { DocIps } from './doc-ips';
import { uninstallUrl } from './site-links';

const RATE_ACTIONS: readonly RateAction[] = ['dismiss', 'clicked', 'rated'];

// After removal the browser opens the site's optional feedback page. The URL carries only the
// version; the page sends answers only if the user fills it in and presses send. A failure here
// must not stop the rest of the background script, so it is logged and ignored.
function setUninstallPage(): void {
  const warn = (e: unknown) => console.warn('Anime4Nerd: could not set the uninstall page', e);
  try {
    chrome.runtime.setUninstallURL(uninstallUrl(chrome.runtime.getManifest().version)).catch(warn);
  } catch (e) {
    warn(e);
  }
}
setUninstallPage();

async function injectTab(tabId: number): Promise<void> {
  let frames: { frameId: number }[] = [];
  try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? []; } catch { return; }
  for (const f of frames) {
    const target = { tabId, frameIds: [f.frameId] };
    await chrome.scripting.insertCSS({ target, files: ['content.css'] }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ['content.js'] }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ['fullscreen-redirect.js'], world: 'MAIN' }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  const version = chrome.runtime.getManifest().version;
  if (details.reason === 'update' && details.previousVersion !== version) await markUpdated(version).catch(() => {});
  if (details.reason === 'update') await markReturning().catch(() => {});
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.allSettled(tabs.map((t) => (t.id ? injectTab(t.id) : Promise.resolve())));
});

chrome.runtime.onStartup.addListener(() => { void restoreBadge().catch(() => {}); });

// Site access granted from the popup's "allow" button (or the browser's own menu): open tabs on
// those sites get the scripts now, without a reload. The popup may already be closed (Firefox
// closes it while its permission prompt shows), so this is done here.
chrome.permissions.onAdded.addListener(async ({ origins }) => {
  if (!origins?.length) return;
  // Every web tab, not only tabs whose address matches: the host granted is often a player frame
  // inside another site. Frames that still refuse fail one by one; the content script guards
  // against running twice.
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => []);
  await Promise.allSettled(tabs.map((t) => (t.id !== undefined ? injectTab(t.id) : Promise.resolve())));
});

// Rating card counters, and manga page images. Only this extension's own
// pages and content scripts can send runtime messages here; values are clamped again in addWatch.
chrome.runtime.onMessage.addListener((msg: Message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return false;
  if (msg?.type === 'a4k-watch') void updateRate((s) => addWatch(s, msg.seconds, msg.episodes)).catch(() => {});
  else if (msg?.type === 'a4k-rate' && RATE_ACTIONS.includes(msg.action)) void updateRate((s) => applyAction(s, msg.action, msg.level)).catch(() => {});
  else if (msg?.type === 'a4k-top-meta') {
    // A player frame's fullscreen menu: the top page's title / episode and the tab's host, as the
    // popup shows them. Only the asking tab's own top frame is asked.
    const tab = sender.tab;
    if (tab?.id === undefined) { respond(null); return false; }
    let host = '';
    try { host = tab.url ? new URL(tab.url).hostname : ''; } catch { /* no host */ }
    chrome.tabs.sendMessage(tab.id, { type: 'a4k-page-meta' } satisfies Message, { frameId: 0 })
      .then((meta: unknown) => respond({ meta: meta ?? null, host }), () => respond({ meta: null, host }));
    return true; // answers asynchronously
  }
  else if (msg?.type === 'a4k-suggest') {
    const { tab, frameId } = sender;
    const kind = msg.kind === 'manga' || msg.kind === 'anime' || msg.kind === 'reader' ? msg.kind : null;
    if (tab?.id !== undefined && frameId !== undefined) updateSuggestions((m) => withFrame(m, `${tab.id}:${frameId}`, kind));
  } else if (msg?.type === 'a4k-frames-gone') {
    if (sender.tab?.id !== undefined) forgetGoneFrames(sender.tab.id);
  } else if (msg?.type === 'a4k-fetch-image') {
    if (!sender.tab?.url || sender.frameId === undefined) { respond({ error: 'Only page frames may ask.' }); return false; }
    // The asking frame's own origin decides the local-address exemption, not the tab around it.
    const frame = `${sender.tab.id}:${sender.documentId}`;
    limited(sender.tab.id ?? -1, () => fetchImage(msg.url, sender.origin ?? sender.url ?? '', frame)).then(respond, (e: unknown) => respond({ error: e instanceof Error ? e.message : String(e) }));
    return true; // answers asynchronously
  }
  return false;
});

/** Largest manga page image the background will fetch for a content script. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 20000;
/** Image fetches running at once for one tab, and how many more of that tab may wait. */
const MAX_FETCHES = 3;
const MAX_WAITING = 32;
/** Redirects followed for one image. */
const MAX_REDIRECTS = 5;
/** Tabs that may fetch images at once: bounds what the worker holds in memory. */
const MAX_LANES = 8;
const IMAGE_TYPE = /^image\/(?:jpeg|png|webp|gif|avif|bmp)(?=\s*(?:;|$))/i;

interface Lane { running: number; waiting: (() => void)[] }
const lanes = new Map<number, Lane>();

/**
 * Runs at most MAX_FETCHES jobs at once for each tab, so the frames of a tab cannot make the
 * worker hold many images, and one tab cannot keep another tab waiting.
 */
async function limited<T>(tabId: number, job: () => Promise<T>): Promise<T> {
  if (!lanes.has(tabId) && lanes.size >= MAX_LANES) throw new Error('Too many image requests.');
  const lane = lanes.get(tabId) ?? { running: 0, waiting: [] };
  lanes.set(tabId, lane);
  if (lane.running >= MAX_FETCHES) {
    if (lane.waiting.length >= MAX_WAITING) throw new Error('Too many image requests.');
    await new Promise<void>((go) => lane.waiting.push(go)); // the finishing job hands over its slot
  } else lane.running++;
  try { return await job(); } finally {
    const next = lane.waiting.shift();
    if (next) next();
    else if (--lane.running === 0) lanes.delete(tabId);
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname; } catch { return ''; }
}

// ---- response addresses -----------------------------------------------------------------
// fetch() does not say which address answered; webRequest does. Two things are recorded: the
// address each document came from, and the address of each image fetch made below.

const FRAME_IPS = 'a4k-frame-ips';
/** How long to wait for the webRequest event after fetch() has the response headers. */
const IP_WAIT_MS = 2000;
type FrameIps = Record<string, string>;
let frameIps: Promise<FrameIps> | null = null;
const loadFrameIps = () => frameIps ??= chrome.storage.session.get(FRAME_IPS).then((got) => (got[FRAME_IPS] ?? {}) as FrameIps);
let frameIpWrite: Promise<unknown> = Promise.resolve();

/** Applies one change to the stored frame addresses; changes run in order. */
function updateFrameIps(change: (m: FrameIps) => FrameIps): void {
  frameIpWrite = frameIpWrite.then(async () => {
    const next = change(await loadFrameIps());
    frameIps = Promise.resolve(next);
    await chrome.storage.session.set({ [FRAME_IPS]: next });
  }).catch(() => {});
}

const withoutTab = <T>(m: Record<string, T>, tabId: number): Record<string, T> => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(`${tabId}:`)));

// ---- mode suggestion badge -------------------------------------------------------------
// Page scripts say when the mode leaves their frame's content alone (content.ts); the tab then
// gets a one-letter badge on the toolbar icon, so the user notices without opening the popup.
// The badge is set for the tab only. While the "what's new" badge is pending it is held back,
// and clearing it (text: null) falls back to the global badge, so NEW is never hidden or lost.

const SUGGESTIONS = 'a4k-suggest';
/** `${tabId}:${frameId}` -> the mode that frame's content needs, or 'reader': a reader the mode fits. */
type Suggestions = Record<string, Suggest | 'reader'>;
const BADGE: Record<Suggest, { text: string; title: string }> = {
  manga: { text: 'M', title: 'Anime4Nerd · manga detected · open to switch to manga mode' },
  anime: { text: 'V', title: 'Anime4Nerd · video detected · open to switch to anime mode' },
};
let suggestWrite: Promise<unknown> = Promise.resolve();

function withFrame(m: Suggestions, key: string, kind: Suggest | 'reader' | null): Suggestions {
  const { [key]: _old, ...rest } = m;
  return kind ? { ...rest, [key]: kind } : rest;
}

const tabsOf = (m: Suggestions) => Object.keys(m).map((k) => parseInt(k, 10));

/** Shows or clears the badge of each given tab: shown unless NEW is pending. */
async function paintBadges(tabIds: Set<number>, m: Suggestions): Promise<void> {
  if (!tabIds.size) return;
  const held = await pendingWhatsNew();
  const defaultTitle = chrome.runtime.getManifest().action?.default_title ?? '';
  for (const tabId of tabIds) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) continue; // closed
    // A reader in any frame: mode 'manga' fits the tab, as the popup decides (paintPrompt).
    const kinds = Object.entries(m).filter(([k]) => k.startsWith(`${tabId}:`)).map(([, v]) => v);
    const kind = kinds.includes('reader') ? undefined : kinds.find((v) => v !== 'reader');
    const show = !!kind && !held;
    await Promise.all(show ? [
      chrome.action.setBadgeText({ tabId, text: BADGE[kind].text }),
      // Same monochrome as the popup and the NEW badge.
      chrome.action.setBadgeBackgroundColor({ tabId, color: '#e4e4e4' }),
      chrome.action.setBadgeTextColor({ tabId, color: '#0b0b0b' }),
      chrome.action.setTitle({ tabId, title: BADGE[kind].title }),
    ] : [
      // null, not '': the tab goes back to the global badge. The typings do not know it yet.
      chrome.action.setBadgeText({ tabId, text: null as unknown as string }),
      chrome.action.setTitle({ tabId, title: defaultTitle }),
    ]).catch(() => {}); // the tab closed meanwhile
  }
}

/**
 * Applies one change to the stored suggestions and repaints the tabs whose frames it touched
 * (every tab with a suggestion when nothing was changed); changes run in order.
 */
function updateSuggestions(change: (m: Suggestions) => Suggestions): void {
  suggestWrite = suggestWrite.then(async () => {
    const cur = ((await chrome.storage.session.get(SUGGESTIONS))[SUGGESTIONS] ?? {}) as Suggestions;
    const next = change(cur);
    if (next === cur) { await paintBadges(new Set(tabsOf(cur)), cur); return; }
    const touched = [...Object.keys(cur), ...Object.keys(next)].filter((k) => cur[k] !== next[k]);
    if (!touched.length) return;
    await chrome.storage.session.set({ [SUGGESTIONS]: next });
    await paintBadges(new Set(touched.map((k) => parseInt(k, 10))), next);
  }).catch(() => {});
}

/** Drops what the removed frames of a tab said: a removed iframe sends no navigation event. */
function forgetGoneFrames(tabId: number): void {
  void chrome.webNavigation.getAllFrames({ tabId }).then((frames) => {
    const live = new Set((frames ?? []).map((f) => `${tabId}:${f.frameId}`));
    updateSuggestions((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(`${tabId}:`) || live.has(k))));
  }).catch(() => {});
}

// A new page in the tab: the browser drops the tab's badge itself; forget what the old page said.
chrome.webNavigation.onCommitted.addListener((d) => {
  updateSuggestions((m) => (d.frameId === 0 ? withoutTab(m, d.tabId) : withFrame(m, `${d.tabId}:${d.frameId}`, null)));
});
chrome.tabs.onRemoved.addListener((tabId) => updateSuggestions((m) => withoutTab(m, tabId)));
// A discarded tab comes back under a new id; its page reports again when it loads.
chrome.tabs.onReplaced.addListener((_added, removed) => updateSuggestions((m) => withoutTab(m, removed)));
// NEW became pending or was seen: every badge is decided again.
onWhatsNewChanged(() => updateSuggestions((m) => m));

interface Hop { ip: string | null; next?: string }
interface PendingFetch { id?: string; settle: (hop: Hop) => void; done: Promise<void> }
const pendingByUrl = new Map<string, PendingFetch>();
const pendingById = new Map<string, PendingFetch>();

{
  // The address each document came from, in either event order (src/doc-ips.ts).
  const docIps = new DocIps();
  const frameKey = (d: { tabId: number; frameId: number }) => `${d.tabId}:${d.frameId}`;
  chrome.webNavigation.onBeforeNavigate.addListener((d) => docIps.beforeNavigate(frameKey(d)));
  chrome.webRequest.onResponseStarted.addListener((d) => {
    const filed = docIps.response(frameKey(d), d.url, d.statusCode, d.ip);
    if (filed) updateFrameIps((m) => ({ ...m, [filed.doc]: filed.ip }));
  }, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame'] });
  chrome.webNavigation.onCommitted.addListener((d) => {
    const doc = `${d.tabId}:${d.documentId}`;
    const ip = docIps.commit(frameKey(d), d.url, doc);
    updateFrameIps((m) => {
      const rest = d.frameId === 0 ? withoutTab(m, d.tabId) : m; // a new page: its old documents are gone
      return ip ? { ...rest, [doc]: ip } : rest;
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => docIps.forgetTab(tabId));
  chrome.tabs.onRemoved.addListener((tabId) => updateFrameIps((m) => withoutTab(m, tabId)));

  // This worker's own requests have no tab. fetchWithIp() lets one request per URL run at a time,
  // so the URL names exactly one of them; from there on the request id does.
  const own = { urls: ['http://*/*', 'https://*/*'], tabId: -1 };
  // Chrome names the worker as the initiator; Firefox gives the URL of its background page instead.
  const fromHere = (d: { initiator?: string; originUrl?: string }) => (__FIREFOX__
    ? (d.originUrl ?? '').startsWith(`${location.origin}/`) : d.initiator === location.origin);
  chrome.webRequest.onBeforeRequest.addListener((d) => {
    const p = fromHere(d) ? pendingByUrl.get(d.url) : undefined;
    // Not a redirect hop of a request that is already matched: it would claim another fetch.
    if (p && !p.id && !pendingById.has(d.requestId)) { p.id = d.requestId; pendingById.set(d.requestId, p); }
  }, own);
  // Firefox reports a redirect that fetch() does not follow (redirect: 'manual') here, as a response
  // with a Location header, and never calls onBeforeRedirect for it.
  chrome.webRequest.onResponseStarted.addListener((d) => {
    const p = pendingById.get(d.requestId);
    if (!p) return;
    const target = __FIREFOX__ && d.statusCode >= 300 && d.statusCode < 400
      ? d.responseHeaders?.find((h) => h.name.toLowerCase() === 'location')?.value : undefined;
    let next: string | undefined;
    try { next = target ? new URL(target, d.url).href : undefined; } catch { /* not a URL: no next hop */ }
    p.settle({ ip: d.ip ?? null, next });
  }, own, __FIREFOX__ ? ['responseHeaders'] : undefined);
  // Redirects are not followed by fetch() (redirect: 'manual'); in Chrome this says where one points.
  // A redirect with no address is the browser's own (HSTS upgrade): fetch() follows it, and the
  // response that comes after has the address.
  chrome.webRequest.onBeforeRedirect.addListener((d) => { if (d.ip) pendingById.get(d.requestId)?.settle({ ip: d.ip, next: d.redirectUrl }); }, own);
}

/**
 * One request, redirects not followed, plus what webRequest saw of it: the address that answered
 * (null if the browser did not report one) and, for a redirect, where it points.
 */
async function fetchHop(u: URL, signal: AbortSignal): Promise<{ res: Response } & Hop> {
  const key = u.href;
  for (let busy = pendingByUrl.get(key); busy; busy = pendingByUrl.get(key)) await busy.done;
  let settle!: (hop: Hop) => void;
  let release!: () => void;
  const hop = new Promise<Hop>((ok) => { settle = ok; });
  const p: PendingFetch = { settle, done: new Promise<void>((ok) => { release = ok; }) };
  pendingByUrl.set(key, p);
  try {
    // no-store: a response from the cache has no address.
    const res = await fetch(u, { cache: 'no-store', credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer', signal });
    return { res, ...await Promise.race([hop, new Promise<Hop>((ok) => setTimeout(() => ok({ ip: null }), IP_WAIT_MS))]) };
  } finally {
    pendingByUrl.delete(key);
    if (p.id) pendingById.delete(p.id);
    release();
  }
}

/**
 * Manga mode: page images usually come from another host, and the page's CORS rules stop the
 * content script from reading their pixels. The service worker can fetch them under the
 * extension's existing all-sites access. Only http(s) images, size-capped, with a timeout, and
 * never from a private or local address unless the asking frame itself is on one (self-hosted
 * readers). Cloud metadata and link-local addresses are refused for everyone. Both the name and
 * the address that answered are checked, for the image and for every redirect on the way; a
 * redirect to a local name is refused before it is requested.
 */
async function fetchImage(url: string, pageUrl: string, frame: string): Promise<{ dataUrl: string } | { error: string }> {
  const pageHost = hostOf(pageUrl);
  const pagePrivate = pageHost !== '' && isPrivateHost(pageHost);
  const blocked = (host: string) => isMetadataHost(host) || (!pagePrivate && isPrivateHost(host));
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); // for the image and its redirects together
  let res: Response;
  for (let target = url, redirects = 0; ; redirects++) {
    const u = new URL(target);
    u.hash = ''; // as it goes on the wire, so webRequest reports the same URL
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only http(s) images.' };
    if (blocked(u.hostname)) return { error: redirects ? 'Redirected to a local address.' : 'Local addresses are not fetched.' };
    // As the browser does for images on a secure page: never fetch them in clear text.
    if (pageUrl.startsWith('https:') && u.protocol === 'http:') u.protocol = 'https:';
    const hop = await fetchHop(u, signal);
    res = hop.res;
    if (addressBlocked(hop.ip, pagePrivate, (await loadFrameIps())[frame])) {
      void res.body?.cancel();
      return { error: hop.ip ? 'The image host resolves to a local address.' : 'Could not confirm where the image came from.' };
    }
    if (res.type !== 'opaqueredirect') break;
    if (!hop.next || redirects >= MAX_REDIRECTS) return { error: 'Too many redirects.' };
    target = hop.next;
  }
  if (!res.ok) { void res.body?.cancel(); return { error: `HTTP ${res.status}` }; }
  const type = res.headers.get('content-type') ?? '';
  const mime = IMAGE_TYPE.exec(type.trim())?.[0].toLowerCase();
  if (!mime) return { error: `Not a page image (${type.slice(0, 40) || 'no type'}).` };
  if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) return { error: 'Image too large.' };
  // Read incrementally so an endless or lying response stops at the cap.
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_IMAGE_BYTES) { await reader.cancel(); return { error: 'Image too large.' }; }
    chunks.push(value);
  }
  let bin = '';
  for (const c of chunks) for (let i = 0; i < c.length; i += 0x8000) bin += String.fromCharCode(...c.subarray(i, i + 0x8000));
  return { dataUrl: `data:${mime};base64,${btoa(bin)}` };
}

// Service worker.
//
// Content scripts declared in the manifest only reach pages loaded after the extension is
// installed or updated. On install/update, inject into every frame of already-open tabs so the
// user does not have to reload. Frames are injected one at a time: a single allFrames call fails
// as a whole if any one frame (chrome://, the web store, a PDF viewer) refuses scripts.
// The content script guards against running twice.

import { markUpdated, restoreBadge } from './whats-new';
import { RateAction, addWatch, applyAction, markReturning, updateRate } from './rate-prompt';
import type { Message } from './settings';
import { addressBlocked, isMetadataHost, isPrivateHost } from './private-host';

const RATE_ACTIONS: readonly RateAction[] = ['dismiss', 'clicked', 'rated'];

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
  if (details.reason === 'update' && !__FIREFOX__) await markReturning().catch(() => {});
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.allSettled(tabs.map((t) => (t.id ? injectTab(t.id) : Promise.resolve())));
});

chrome.runtime.onStartup.addListener(() => { void restoreBadge().catch(() => {}); });

// Rating card counters (Chrome build only). Only this extension's own pages and content
// scripts can send runtime messages here; values are clamped again in addWatch.
if (!__FIREFOX__) {
  chrome.runtime.onMessage.addListener((msg: Message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (msg?.type === 'a4k-watch') void updateRate((s) => addWatch(s, msg.seconds, msg.episodes)).catch(() => {});
    else if (msg?.type === 'a4k-rate' && RATE_ACTIONS.includes(msg.action)) void updateRate((s) => applyAction(s, msg.action, msg.level)).catch(() => {});
    else if (msg?.type === 'a4k-fetch-image') {
      if (!sender.tab?.url || sender.frameId === undefined) { respond({ error: 'Only page frames may ask.' }); return false; }
      // The asking frame's own origin decides the local-address exemption, not the tab around it.
      const frame = `${sender.tab.id}:${sender.documentId}`;
      limited(sender.tab.id ?? -1, () => fetchImage(msg.url, sender.origin ?? sender.url ?? '', frame)).then(respond, (e: unknown) => respond({ error: e instanceof Error ? e.message : String(e) }));
      return true; // answers asynchronously
    }
    return false;
  });
}

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

// ---- response addresses (Chrome) ---------------------------------------------------------
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

const withoutTab = (m: FrameIps, tabId: number): FrameIps => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith(`${tabId}:`)));

interface Hop { ip: string | null; next?: string }
interface PendingFetch { id?: string; settle: (hop: Hop) => void; done: Promise<void> }
const pendingByUrl = new Map<string, PendingFetch>();
const pendingById = new Map<string, PendingFetch>();

if (!__FIREFOX__) {
  // The address is filed under the document that commits, not under the frame: a navigation that
  // never replaces the document (a 204, a download) must not change what its frame may read.
  const navIps = new Map<string, { url: string; ip?: string }>();
  const sansHash = (url: string) => url.split('#')[0];
  chrome.webRequest.onResponseStarted.addListener((d) => {
    navIps.set(`${d.tabId}:${d.frameId}`, { url: sansHash(d.url), ip: d.ip });
  }, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame'] });
  chrome.webNavigation.onCommitted.addListener((d) => {
    const nav = `${d.tabId}:${d.frameId}`;
    const seen = navIps.get(nav);
    navIps.delete(nav);
    const ip = seen?.url === sansHash(d.url) ? seen.ip : undefined;
    updateFrameIps((m) => {
      const rest = d.frameId === 0 ? withoutTab(m, d.tabId) : m; // a new page: its old documents are gone
      return ip ? { ...rest, [`${d.tabId}:${d.documentId}`]: ip } : rest;
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => updateFrameIps((m) => withoutTab(m, tabId)));

  // This worker's own requests have no tab. fetchWithIp() lets one request per URL run at a time,
  // so the URL names exactly one of them; from there on the request id does.
  const own = { urls: ['http://*/*', 'https://*/*'], tabId: -1 };
  chrome.webRequest.onBeforeRequest.addListener((d) => {
    const p = d.initiator === location.origin ? pendingByUrl.get(d.url) : undefined;
    // Not a redirect hop of a request that is already matched: it would claim another fetch.
    if (p && !p.id && !pendingById.has(d.requestId)) { p.id = d.requestId; pendingById.set(d.requestId, p); }
  }, own);
  chrome.webRequest.onResponseStarted.addListener((d) => { pendingById.get(d.requestId)?.settle({ ip: d.ip ?? null }); }, own);
  // Redirects are not followed by fetch() (redirect: 'manual'); this says where one points.
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

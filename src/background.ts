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
      limited(() => fetchImage(msg.url, sender.origin ?? sender.url ?? '', frame)).then(respond, (e: unknown) => respond({ error: e instanceof Error ? e.message : String(e) }));
      return true; // answers asynchronously
    }
    return false;
  });
}

/** Largest manga page image the background will fetch for a content script. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 20000;
/** Image fetches running at once across all tabs, and how many more may wait. */
const MAX_FETCHES = 3;
const MAX_WAITING = 32;
const IMAGE_TYPE = /^image\/(?:jpeg|png|webp|gif|avif|bmp)(?=\s*(?:;|$))/i;

let fetching = 0;
const waiting: (() => void)[] = [];

/** Runs at most MAX_FETCHES jobs at once, so many frames cannot make the worker hold many images. */
async function limited<T>(job: () => Promise<T>): Promise<T> {
  if (fetching >= MAX_FETCHES) {
    if (waiting.length >= MAX_WAITING) throw new Error('Too many image requests.');
    await new Promise<void>((go) => waiting.push(go)); // the finishing job hands over its slot
  } else fetching++;
  try { return await job(); } finally {
    const next = waiting.shift();
    if (next) next(); else fetching--;
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

interface PendingFetch { id?: string; settle: (ip: string | null) => void; done: Promise<void> }
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
  chrome.webRequest.onResponseStarted.addListener((d) => { pendingById.get(d.requestId)?.settle(d.ip ?? null); }, own);
}

/** fetch(), plus the address the final response came from (null if the browser did not report one). */
async function fetchWithIp(u: URL): Promise<{ res: Response; ip: string | null }> {
  const key = u.href;
  for (let busy = pendingByUrl.get(key); busy; busy = pendingByUrl.get(key)) await busy.done;
  let settle!: (ip: string | null) => void;
  let release!: () => void;
  const ip = new Promise<string | null>((ok) => { settle = ok; });
  const p: PendingFetch = { settle, done: new Promise<void>((ok) => { release = ok; }) };
  pendingByUrl.set(key, p);
  try {
    // no-store: a response from the cache has no address.
    const res = await fetch(u, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return { res, ip: await Promise.race([ip, new Promise<null>((ok) => setTimeout(() => ok(null), IP_WAIT_MS))]) };
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
 * the address that answered are checked. A redirect to a local name is still requested once
 * before it is refused; nothing of its response is passed on.
 */
async function fetchImage(url: string, pageUrl: string, frame: string): Promise<{ dataUrl: string } | { error: string }> {
  const u = new URL(url);
  u.hash = ''; // as it goes on the wire, so webRequest reports the same URL
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'Only http(s) images.' };
  const pageHost = hostOf(pageUrl);
  const pagePrivate = pageHost !== '' && isPrivateHost(pageHost);
  const blocked = (host: string) => isMetadataHost(host) || (!pagePrivate && isPrivateHost(host));
  if (blocked(u.hostname)) return { error: 'Local addresses are not fetched.' };
  // As the browser does for images on a secure page: never fetch them in clear text.
  if (pageUrl.startsWith('https:') && u.protocol === 'http:') u.protocol = 'https:';
  const { res, ip } = await fetchWithIp(u);
  if (blocked(new URL(res.url).hostname)) { void res.body?.cancel(); return { error: 'Redirected to a local address.' }; }
  if (addressBlocked(ip, pagePrivate, (await loadFrameIps())[frame])) {
    void res.body?.cancel();
    return { error: ip ? 'The image host resolves to a local address.' : 'Could not confirm where the image came from.' };
  }
  if (!res.ok) return { error: `HTTP ${res.status}` };
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

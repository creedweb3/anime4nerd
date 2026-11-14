// Manga mode (local prototype, Chrome build).
//
// Detection: when the popup asks, or every few seconds on a site the user switched on, the page's
// images are measured and classifyPage (manga-detect.ts) decides whether this is a manga reader.
// Ordinary pages never qualify, and nothing is upscaled unless they do: a safety stop that holds
// even on a switched-on site. Series and chapter come from manga-meta.ts.
//
// Upscaling: every page of the chapter, nearest to the viewport first, goes once through the
// Anime4K chain at 2x with the popup's preset, and the result replaces the <img> source. A page is
// redone only when the preset changes. Black-and-white pages are kept grey (the shaders add a
// slight colour cast to grey input). Alt+M flips back to the originals.

import { chainKey, type Settings } from './settings';
import type { RenderSource } from './gpu';
import { MANGA_PROTOCOL, loadMangaSites, onMangaSitesChanged } from './manga-sites';
import {
  Detection, PageImage, PageSlot, ReaderUi, classifyPage, isChapterNavText, looksLikeChapterList, parsePageCounter,
} from './manga-detect';
import { MangaMeta, parseMangaMeta } from './manga-meta';

type GpuModule = typeof import('./gpu');

/** Pages this far outside the viewport are processed ahead of scrolling. */
const LOOKAHEAD = '2500px 0px';
const SCAN_MS = 1500;
/** Measuring stops after this many images or canvases: no reader has more, and huge pages stay cheap. */
const MAX_IMAGES = 600;
const MAX_CANVASES = 50;
/** Reader-control scan limits: links/buttons, selects, and text nodes looked at for a "62 / 73" counter. */
const MAX_CONTROLS = 500;
const MAX_SELECTS = 20;
const MAX_TEXT_NODES = 4000;
const CHAPTER_HREF = /chapter|\bch[-_.]?\d|episode|\bep[-_.]?\d/i;
const CHAPTER_IN_OPTION = /(?:chapter|chap|ch|episode|ep)\.?\s*#?(\d+(?:\.\d+)?)|#\s?(\d+(?:\.\d+)?)/i;
/** A page counts as black-and-white when fewer than this share of sampled pixels carry colour. */
const COLOUR_SHARE = 0.005;
const COLOUR_SPREAD = 14; // max-min channel difference that counts as "colour"

type PageMark = 'done' | 'fail' | 'todo';

/** Everything the popup shows about manga on this frame. */
export interface MangaStatus {
  on: boolean; // switched on for this site
  kind: Detection['kind']; // 'images': a supported reader; 'canvas': a reader we cannot read; null: not manga
  meta: MangaMeta;
  marks: PageMark[]; // one per loaded page, top to bottom
  total: number; // pages in the chapter (page counter, or loaded + still loading)
  reasons: string[]; // why the page counts as manga
  current: number | null; // index of the page in the middle of the screen
  done: number;
  failed: number;
  lastError: string | null;
  grey: boolean | null; // null until a page has been looked at
  size: { w: number; h: number } | null; // natural size of the first page
  perPageMs: number | null; // GPU time per page
  pageMs: number | null; // whole page: read or download, GPU, encode, swap
  imageHost: string | null;
  protocol: number; // MANGA_PROTOCOL of the page script that answered
  host: string; // this frame's host: the popup switches it on together with the address-bar host
  renders: number; // GPU renders since load: equals the page count once a chapter is done (no double work)
}

/** Detection must miss this many scans in a row before pages are restored (a page briefly loading is not a miss). */
const MISSES_TO_STOP = 3;
/** Upscaled pages are stored as WebP: far smaller and faster to encode than PNG at no visible cost. */
const OUTPUT_TYPE = 'image/webp';
const OUTPUT_QUALITY = 0.95;
/** After a page loads, rescan this soon instead of waiting for the next periodic scan. */
const LOAD_RESCAN_MS = 100;
/** The renderer is kept between pages (shaders compile once); it is freed after this long idle. */
const RENDERER_IDLE_MS = 15000;
/** Encodes in flight at once (each holds one 2x page in memory, ~30 MB). */
const MAX_ENCODES = 4;
/** Pages downloaded ahead of the GPU, when they cannot be read from the screen. */
const PREFETCH = 2;
/** Largest page (in pixels) that is decoded and upscaled; the 2x result takes 16 bytes per pixel. */
const MAX_PAGE_PX = 16_000_000;
const TOO_LARGE = 'Page too large to upscale.';

interface PageState {
  src: string; // the page's own image URL
  srcset: string;
  dims: { w: number; h: number }; // the original's natural size (an upscaled page reports twice this)
  gen: number; // bumped when the state is replaced, so a render that finishes late is dropped
  blob: Blob | null; // the original image bytes while a render needs them
  keep: boolean; // blob came from the page itself and cannot be fetched again: keep it
  own: string | null; // object URL of our copy of the original, when the site's own URL is already dead
  grey: boolean | null;
  outUrl: string | null; // object URL of the upscaled page
  renderedWith: string; // settings the current output was made with
  fixedWidth: boolean; // we pinned the width so the 2x image does not change the layout
  error: string | null; // why the last attempt failed
  pending: string | null; // settings of a render still encoding (not queued again meanwhile)
}

export interface MangaMode { refresh(): void; stop(): void; status(): MangaStatus }

function textOf(sel: string): string {
  const el = document.querySelector(sel);
  return (el instanceof HTMLMetaElement ? el.content : el?.textContent ?? '').trim();
}

export function startManga(getSettings: () => Settings, loadGpu: () => Promise<GpuModule>): MangaMode {
  const states = new Map<HTMLImageElement, PageState>();
  const queue = new Set<HTMLImageElement>();
  let detected: { kind: Detection['kind']; pages: HTMLImageElement[]; meta: MangaMeta; total: number; reasons: string[]; slots: HTMLImageElement[] } = {
    kind: null, pages: [], meta: { series: null, volume: null, chapter: null, chapterTitle: null }, total: 0, reasons: [], slots: [],
  };
  let enabled = false;
  let showOriginal = false;
  let working = false;
  let stopped = false;
  let scanTimer: number | null = null;
  let misses = 0;
  let nextGen = 1;
  const gpuTimes: number[] = []; // GPU pass per page
  const pageTimes: number[] = []; // start to upscaled page shown, per page
  let renders = 0;
  let rendering: HTMLImageElement | null = null; // the page drain() is working on
  // One renderer reused for every page of the same size and settings: building one compiles every
  // shader pass, which was most of each page's time.
  type Renderer = Awaited<ReturnType<GpuModule['createAnime4kRenderer']>>;
  let cached: { key: string; r: Renderer; out: HTMLCanvasElement } | null = null;
  let idleTimer: number | null = null;
  let rescanTimer: number | null = null;
  const dropRenderer = () => { cached?.r.destroy(); cached = null; };
  const onImageLoad = (e: Event) => {
    if (!(e.target instanceof HTMLImageElement) || rescanTimer !== null) return;
    rescanTimer = window.setTimeout(() => { rescanTimer = null; scan(); }, LOAD_RESCAN_MS);
  };

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const img = e.target as HTMLImageElement;
      if (e.isIntersecting) enqueue(img);
    }
  }, { rootMargin: LOOKAHEAD });

  const settingsTag = () => chainKey(getSettings());

  // ---- detection -------------------------------------------------------------------------

  function detect() {
    const meta = parseMangaMeta({
      titles: [textOf('meta[property="og:title"]'), document.title, textOf('h1')],
      url: location.href,
      site: textOf('meta[property="og:site_name"]'),
    });
    const ui = readerUi();
    if (!meta.chapter && ui.selectedChapter) meta.chapter = ui.selectedChapter; // e.g. a "#001" chapter picker
    const els = new Map<PageImage, HTMLImageElement>();
    const images: PageImage[] = [];
    const placeholders: PageSlot[] = [];
    const slotEls: HTMLImageElement[] = [];
    for (const img of Array.from(document.images).slice(0, MAX_IMAGES)) {
      const st = states.get(img);
      const r = img.getBoundingClientRect();
      if (!r.width) continue;
      // Not loaded yet (lazy loading): counted as a slot, not as a page. A tracked page keeps
      // counting while its swapped source loads, at its original size.
      if (!st && (!img.complete || !img.naturalWidth)) {
        placeholders.push({ renderedWidth: r.width, left: r.left + scrollX, top: r.top + scrollY });
        slotEls.push(img);
        continue;
      }
      const w = st ? st.dims.w : img.naturalWidth;
      const h = st ? st.dims.h : img.naturalHeight;
      const p: PageImage = { naturalWidth: w, naturalHeight: h, renderedWidth: r.width, left: r.left + scrollX, top: r.top + scrollY, src: img.currentSrc };
      images.push(p); els.set(p, img);
    }
    const canvases = Array.from(document.querySelectorAll('canvas')).slice(0, MAX_CANVASES)
      .map((c) => ({ width: c.width, height: c.height, renderedWidth: c.getBoundingClientRect().width }));
    const d = classifyPage({
      images, canvases, viewport: { width: innerWidth, height: innerHeight }, url: location.href,
      hasChapter: meta.chapter !== null, ui, placeholders,
    });
    const pages = d.pages.map((p) => els.get(p)!);
    // Slots in the pages' column: the rest of the chapter, still loading.
    const ref = d.pages[0];
    const slots = ref ? slotEls.filter((_, i) => Math.abs(placeholders[i].renderedWidth - ref.renderedWidth) <= ref.renderedWidth * 0.08
      && Math.abs(placeholders[i].left - ref.left) <= ref.renderedWidth * 0.08) : [];
    detected = { kind: d.kind, pages, meta, total: d.total, reasons: d.reasons, slots };
    return detected;
  }

  /** Reader controls: next/previous chapter, a chapter or page list, a "62 / 73" counter. */
  function readerUi(): ReaderUi & { selectedChapter: string | null } {
    let chapterNav = false;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('a, button, [role="button"]')).slice(0, MAX_CONTROLS)) {
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').slice(0, 60);
      const rel = el.getAttribute('rel') ?? '';
      if (isChapterNavText(label) || (/\b(next|prev)\b/.test(rel) && CHAPTER_HREF.test(el.getAttribute('href') ?? ''))) { chapterNav = true; break; }
    }
    let chapterList = false;
    let selectedChapter: string | null = null;
    for (const sel of Array.from(document.querySelectorAll('select')).slice(0, MAX_SELECTS)) {
      const opts = Array.from(sel.options).slice(0, 2000).map((o) => o.text.trim());
      if (!looksLikeChapterList(opts)) continue;
      chapterList = true;
      const m = CHAPTER_IN_OPTION.exec(sel.options[sel.selectedIndex]?.text ?? '');
      if (m) selectedChapter = (m[1] ?? m[2]).replace(/^0+(?=\d)/, '');
    }
    let counter: ReaderUi['counter'] = null;
    if (document.body) {
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let i = 0, n = walk.nextNode(); n && i < MAX_TEXT_NODES; i++, n = walk.nextNode()) {
        const t = (n as Text).data;
        if (t.length > 24 || !/\d/.test(t)) continue;
        const c = parsePageCounter(t);
        if (c && (!counter || c.total > counter.total)) counter = c;
      }
    }
    return { chapterNav, chapterList, counter, selectedChapter };
  }

  /** On a switched-on site: track detected pages; if the page stops looking like manga, undo everything. */
  function scan() {
    const { kind, pages } = detect();
    if (kind !== 'images') {
      if (++misses >= MISSES_TO_STOP) for (const img of [...states.keys()]) forget(img, true);
      return;
    }
    misses = 0;
    // Built-in lazy loading: ask for the rest of the chapter now (sites with their own loaders are left alone).
    for (const img of detected.slots) if (img.loading === 'lazy') img.loading = 'eager';
    const live = new Set(pages);
    for (const img of [...states.keys()]) if (!live.has(img) && !img.isConnected) forget(img, false);
    for (const img of pages) {
      const st = states.get(img);
      if (st && isOurs(img, st)) continue;
      if (st) forget(img, false); // the site swapped the image (lazy loader, next chapter)
      states.set(img, { src: img.currentSrc, srcset: img.srcset, dims: { w: img.naturalWidth, h: img.naturalHeight }, gen: nextGen++, blob: null, keep: false, own: null, grey: null, outUrl: null, renderedWith: '', fixedWidth: false, error: null, pending: null });
      io.observe(img);
    }
    // The whole chapter is upscaled; nearestQueued() still takes the pages on screen first.
    for (const img of pages) enqueue(img);
  }

  // ---- upscaling -------------------------------------------------------------------------

  const encoding = new Set<Promise<void>>(); // pages whose upscaled result is still being encoded
  const prefetched = new Map<HTMLImageElement, Promise<Blob>>(); // downloads started ahead of the GPU
  const probe = document.createElement('canvas'); // 1x1, to test whether a page's pixels are readable
  probe.width = 1; probe.height = 1;

  function enqueue(img: HTMLImageElement) {
    const st = states.get(img);
    // Not while it renders or encodes with these settings; a failed page is not retried every scroll.
    const tag = settingsTag();
    if (!st || img === rendering || st.error || st.renderedWith === tag || st.pending === tag) return;
    queue.add(img);
    void drain();
  }

  /**
   * One GPU pass at a time, but encoding runs in the browser's own threads, so up to MAX_ENCODES
   * pages encode at once while the next page renders. Measured: 4 pages encode in about a third of
   * the time when overlapped, and the GPU pass itself is ~30-45 ms.
   */
  async function drain() {
    if (working) return;
    working = true;
    try {
      while (enabled && !stopped && queue.size) {
        if (encoding.size >= MAX_ENCODES) { await Promise.race(encoding); continue; }
        const img = nearestQueued();
        queue.delete(img);
        const st = states.get(img);
        if (!st || !img.isConnected) continue;
        prefetchNext();
        rendering = img;
        try { await renderPage(img, st); } catch (e) { st.pending = null; st.error = e instanceof Error ? e.message : String(e); }
        rendering = null;
      }
    } finally {
      working = false; rendering = null;
      if (idleTimer !== null) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => { idleTimer = null; if (!working) dropRenderer(); }, RENDERER_IDLE_MS);
    }
  }

  const distance = (img: HTMLImageElement) => {
    const r = img.getBoundingClientRect();
    return Math.abs((r.top + r.bottom) / 2 - innerHeight / 2);
  };

  /** The queued page closest to the middle of the screen: what the reader looks at goes first. */
  function nearestQueued(): HTMLImageElement {
    let best: HTMLImageElement | null = null;
    let bestD = Infinity;
    for (const img of queue) { const d = distance(img); if (d < bestD) { bestD = d; best = img; } }
    return best!;
  }

  /** Download the next pages that cannot be read from the screen while the GPU works on this one. */
  function prefetchNext() {
    const next = [...queue].sort((a, b) => distance(a) - distance(b)).slice(0, PREFETCH);
    for (const img of next) {
      const st = states.get(img);
      if (!st || st.blob || prefetched.has(img) || img.currentSrc !== st.src || st.dims.w * st.dims.h > MAX_PAGE_PX || canRead(img)) continue;
      const p = loadBytes(st.src);
      p.catch(() => {}); // a failure is reported when the page itself renders
      prefetched.set(img, p);
    }
  }

  /** Whether the browser lets us read this image's pixels (same-origin, blob:, data:, CORS). */
  function canRead(img: HTMLImageElement): boolean {
    try {
      const g = probe.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0, 1, 1);
      g.getImageData(0, 0, 1, 1); // throws if the image is cross-origin without CORS
      return true;
    } catch { return false; }
  }

  /**
   * Readers like MANGA Plus show pages from blob: URLs they revoke right after loading, so Alt+M
   * needs our own copy of the original. Encoded in the background, off the page's critical path.
   */
  function keepCopy(st: PageState, bitmap: ImageBitmap) {
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
    c.getContext('2d')!.drawImage(bitmap, 0, 0);
    c.toBlob((b) => {
      if (!b || st.blob) return;
      st.blob = b;
      st.keep = true;
      st.own = URL.createObjectURL(b);
    }, 'image/png');
  }

  /** Pixel count of an image file from its header, without decoding it; 0 if it cannot be read. */
  async function pixelsOf(blob: Blob): Promise<number> {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    await new Promise((ok) => { im.onload = im.onerror = ok; im.src = url; });
    URL.revokeObjectURL(url);
    return im.naturalWidth * im.naturalHeight;
  }

  async function renderPage(img: HTMLImageElement, st: PageState) {
    // The site may swap the image, or the switch may flip, while this awaits: then drop the result.
    const gen = st.gen;
    const current = () => enabled && !stopped && states.get(img) === st && st.gen === gen && isOurs(img, st);
    const tag = settingsTag();
    const t0 = performance.now();
    if (st.dims.w * st.dims.h > MAX_PAGE_PX) throw new Error(TOO_LARGE); // before any download or decode
    let bitmap: ImageBitmap | null = null;
    if (!st.blob && img.currentSrc === st.src && canRead(img)) {
      // Pixels already on screen: no download, no re-encode. Fails if the site just removed or
      // swapped the image; then fall through to fetching it.
      bitmap = await createImageBitmap(img).catch(() => null);
      if (bitmap && !/^https?:/.test(st.src)) keepCopy(st, bitmap);
    }
    if (!bitmap) {
      st.blob ??= await (prefetched.get(img) ?? loadBytes(st.src));
      // The downloaded bytes can differ from the image on screen: check their size before decoding.
      if (await pixelsOf(st.blob) > MAX_PAGE_PX) { st.blob = null; throw new Error(TOO_LARGE); }
      bitmap = await createImageBitmap(st.blob);
    }
    prefetched.delete(img);
    const copy = document.createElement('canvas');
    try {
      // Again after decoding, in case the size could not be read first.
      if (bitmap.width * bitmap.height > MAX_PAGE_PX) { st.blob = null; throw new Error(TOO_LARGE); }
      if (!current()) return;
      st.grey = isGrey(bitmap);
      const gpu = await loadGpu();
      if (!current()) return;
      const tGpu = performance.now();
      const key = `${bitmap.width}x${bitmap.height}|${tag}`;
      if (cached?.key !== key) {
        dropRenderer();
        const out = document.createElement('canvas');
        try {
          cached = { key, out, r: await gpu.createAnime4kRenderer(bitmap as RenderSource, out, { ...getSettings(), upscale: '2x' }, () => {}, 2) };
        } catch (e) {
          out.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext(); // do not hold a context per failed page
          throw e;
        }
      }
      const { r, out } = cached!;
      copy.width = out.width; copy.height = out.height;
      try {
        r.render(bitmap);
        const g = copy.getContext('2d')!;
        if (st.grey) g.filter = 'grayscale(1)';
        g.drawImage(out, 0, 0); // copy right after render: the WebGL buffer is not preserved
      } catch (e) { dropRenderer(); throw e; }
      renders++;
      gpuTimes.push(performance.now() - tGpu);
      if (gpuTimes.length > 20) gpuTimes.shift();
    } finally { bitmap.close(); }

    // Encode without waiting: the next page renders meanwhile.
    st.pending = tag;
    const job: Promise<void> = new Promise<Blob | null>((ok) => copy.toBlob(ok, OUTPUT_TYPE, OUTPUT_QUALITY))
      .then((blob) => {
        st.pending = null;
        if (!blob || !current()) return;
        if (!st.keep) st.blob = null; // re-fetched if the preset changes; holding every original adds up over a chapter
        if (st.outUrl) URL.revokeObjectURL(st.outUrl);
        st.outUrl = URL.createObjectURL(blob);
        st.renderedWith = tag;
        st.error = null;
        if (!showOriginal) showUpscaled(img, st);
        pageTimes.push(performance.now() - t0);
        if (pageTimes.length > 20) pageTimes.shift();
        enqueue(img); // queues again only if the preset changed while it encoded
      }, (e: unknown) => { st.pending = null; st.error = e instanceof Error ? e.message : String(e); })
      .finally(() => { encoding.delete(job); });
    encoding.add(job);
  }

  /** The <img> shows this page's original, our copy of it, or our upscaled version (not something the site put there since). */
  function isOurs(img: HTMLImageElement, st: PageState): boolean {
    return img.currentSrc === st.src || img.currentSrc === st.outUrl || (!!st.own && img.currentSrc === st.own);
  }

  /** The page's pixels: direct fetch when CORS allows it (keeps the page's referrer), else via the background. */
  async function loadBytes(src: string): Promise<Blob> {
    if (src.startsWith('data:') || src.startsWith('blob:')) return (await fetch(src)).blob();
    try {
      const res = await fetch(src, { mode: 'cors', credentials: 'same-origin' });
      if (res.ok) return await res.blob();
    } catch { /* CORS refused: fall through */ }
    const reply = await chrome.runtime.sendMessage({ type: 'a4k-fetch-image', url: src }) as { dataUrl?: string; error?: string };
    if (!reply?.dataUrl) throw new Error(reply?.error ?? 'Image fetch failed.');
    return (await fetch(reply.dataUrl)).blob();
  }

  function isGrey(bitmap: ImageBitmap): boolean {
    const c = document.createElement('canvas'); c.width = 96; c.height = 96;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bitmap, 0, 0, 96, 96);
    const d = g.getImageData(0, 0, 96, 96).data;
    let coloured = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > COLOUR_SPREAD) coloured++;
    }
    return coloured / (d.length / 4) < COLOUR_SHARE;
  }

  function showUpscaled(img: HTMLImageElement, st: PageState) {
    if (!st.outUrl || img.currentSrc === st.outUrl) return;
    const before = img.getBoundingClientRect().width;
    img.addEventListener('load', () => {
      // An <img> without CSS sizing would now show at twice the size; pin it to what it was.
      if (before && Math.abs(img.getBoundingClientRect().width - before) > 1) { img.style.width = `${before}px`; st.fixedWidth = true; }
    }, { once: true });
    img.srcset = '';
    img.src = st.outUrl;
  }

  function showOriginalPage(img: HTMLImageElement, st: PageState) {
    const original = st.own ?? st.src;
    if (img.currentSrc === original) return;
    img.src = original;
    img.srcset = st.srcset;
    if (st.fixedWidth) { img.style.width = ''; st.fixedWidth = false; }
  }

  /**
   * Our copies of originals that restored pages still show. Each is freed once its image is
   * removed or given another source, so a long session does not hold one per page read.
   */
  const shownCopies = new Map<HTMLImageElement, string>();
  const copyWatcher = new MutationObserver(() => {
    for (const [img, url] of shownCopies) {
      if (states.get(img)?.src === url) continue; // switched on again: still the original to go back to
      if (img.isConnected && img.getAttribute('src') === url) continue;
      URL.revokeObjectURL(url);
      shownCopies.delete(img);
    }
    if (!shownCopies.size) copyWatcher.disconnect();
  });

  function freeWhenReplaced(img: HTMLImageElement, url: string) {
    if (!shownCopies.size) copyWatcher.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
    const old = shownCopies.get(img);
    if (old && old !== url) URL.revokeObjectURL(old);
    shownCopies.set(img, url);
  }

  function forget(img: HTMLImageElement, restore: boolean) {
    const st = states.get(img);
    if (!st) return;
    if (restore) showOriginalPage(img, st);
    if (st.outUrl) URL.revokeObjectURL(st.outUrl);
    if (st.own && restore) freeWhenReplaced(img, st.own); // the page is showing it
    else if (st.own) URL.revokeObjectURL(st.own);
    io.unobserve(img);
    queue.delete(img);
    states.delete(img);
  }

  // ---- switch, keys, status --------------------------------------------------------------

  function onKey(e: KeyboardEvent) {
    if (!e.isTrusted || !e.altKey || e.code !== 'KeyM' || e.ctrlKey || e.metaKey || detected.kind !== 'images') return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return; // typing, e.g. Option+M on macOS
    e.preventDefault();
    showOriginal = !showOriginal;
    for (const [img, st] of states) (showOriginal ? showOriginalPage : showUpscaled)(img, st);
  }

  function setEnabled(on: boolean) {
    if (on === enabled || stopped) return;
    enabled = on;
    if (on) {
      showOriginal = false;
      window.addEventListener('keydown', onKey, true);
      document.addEventListener('load', onImageLoad, true); // image load events do not bubble; capture sees them
      scan();
      scanTimer = window.setInterval(scan, SCAN_MS);
    } else {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('load', onImageLoad, true);
      if (scanTimer !== null) window.clearInterval(scanTimer);
      scanTimer = null;
      if (rescanTimer !== null) window.clearTimeout(rescanTimer);
      rescanTimer = null;
      dropRenderer();
      for (const img of [...states.keys()]) forget(img, true);
    }
  }

  function status(): MangaStatus {
    const { kind, pages, meta, total, reasons } = enabled ? detected : detect(); // when on, scan() keeps it fresh
    const mid = innerHeight / 2;
    let current: number | null = null;
    const marks = pages.map((img, i) => {
      const r = img.getBoundingClientRect();
      if (current === null && r.top <= mid && r.bottom >= mid) current = i;
      const st = states.get(img);
      return st?.error ? 'fail' : st?.outUrl ? 'done' : 'todo';
    });
    const p0 = pages[0];
    const first = p0 ? states.get(p0) : undefined;
    const lastErr = [...states.values()].reverse().find((s) => s.error)?.error ?? null;
    const greyKnown = [...states.values()].find((s) => s.grey !== null)?.grey ?? null;
    let imageHost: string | null = null;
    try { imageHost = p0 ? new URL(first?.src ?? p0.currentSrc).hostname || null : null; } catch { /* blob or data URL */ }
    return {
      on: enabled,
      kind,
      meta,
      marks,
      total: Math.max(total, marks.length),
      reasons,
      current,
      done: marks.filter((m) => m === 'done').length,
      failed: marks.filter((m) => m === 'fail').length,
      lastError: lastErr,
      grey: greyKnown,
      size: first ? first.dims : p0 ? { w: p0.naturalWidth, h: p0.naturalHeight } : null,
      perPageMs: gpuTimes.length ? gpuTimes.reduce((a, b) => a + b, 0) / gpuTimes.length : null,
      pageMs: pageTimes.length ? pageTimes.reduce((a, b) => a + b, 0) / pageTimes.length : null,
      imageHost,
      protocol: MANGA_PROTOCOL,
      host: location.hostname,
      renders,
    };
  }

  // Each frame runs only if its own host is switched on. A reader inside an iframe from another
  // host is switched on by the popup together with the address-bar site, so a third-party frame
  // (an ad) on a switched-on site never gets the background image fetch.
  void loadMangaSites().then((s) => setEnabled(s[location.hostname] === true));
  onMangaSitesChanged((s) => setEnabled(s[location.hostname] === true));

  return {
    /** Settings changed: re-render pages made with older settings, and retry failed ones. */
    refresh() {
      if (!enabled) return;
      for (const [img, st] of states) {
        if (st.error) st.error = null;
        else if (!st.renderedWith || st.renderedWith === settingsTag()) continue;
        enqueue(img);
      }
    },
    stop() { setEnabled(false); stopped = true; io.disconnect(); },
    status,
  };
}

// Content script: finds <video> elements (including inside shadow roots), reports
// them to the popup as "sources", and for sources the user switched on lays a
// canvas over the video and drives the Anime4K renderer per video frame.
// Lifecycle: suspend in PiP / hidden tab,
// rebuild on resize, fall back to plain video on any GPU error.

import {
  Message, Settings, Sources, Status, VideoInfo,
  loadSettings, loadSources, onSettingsChanged, onSourcesChanged, requestedScale, sourceKey,
} from './settings';
import type { Anime4kRenderer } from './gpu';
import { collectPageMeta, mediaSessionMeta } from './media-meta';
import { uploadSize } from './video-size';
import { FullscreenMenu } from './fullscreen-menu';

type GpuModule = typeof import('./gpu');
let gpuModule: Promise<GpuModule> | null = null;
function loadGpu(): Promise<GpuModule> {
  gpuModule ??= import(/* @vite-ignore */ chrome.runtime.getURL('gpu.js')) as Promise<GpuModule>;
  return gpuModule;
}

const MIN_VIDEO_PX = 200; // ignore thumbnails / preview videos
// Each renderer holds a WebGL context, compiled shaders and large float textures; browsers
// cap live contexts (~16) and evict the oldest, so a page full of videos must not get one each.
const MAX_ACTIVE_RENDERERS = 2;

declare global { interface Window { __a4kLoaded?: boolean } }
let nextId = 1;

class VideoUpscaler {
  readonly video: HTMLVideoElement;

  readonly id = `${location.host}#${nextId++}`;

  private canvas: HTMLCanvasElement | null = null;

  private renderer: Anime4kRenderer | null = null;

  private generation = 0;

  private frameHandle: number | null = null;

  private usesVfc = false;

  private rendering = false;

  private rerender = false;

  private failed = false;

  private starting = false;

  private width = 0;

  private height = 0;

  // Upscale factor the current renderer was built for (see wantedScale()).
  private scale = 2;

  // Source frame-rate estimate from requestVideoFrameCallback metadata.
  private vfcSamples: { t: number; presented: number }[] = [];

  private sourceFps: number | null = null;

  // When switched off we keep the compiled renderer for a while so switching back on is instant.
  private idleTimer: number | null = null;

  private fpsProbe: number | null = null; // rVFC handle used only to measure fps while off

  private static readonly KEEP_WARM_MS = 60000;

  status: Status = 'Off';

  message = '';

  enabled = false;

  private settings: Settings;

  private readonly onUpdate: () => void;

  private readonly listeners: [string, EventListener][];

  private resizeObs: ResizeObserver;

  private readonly docSync: () => void;

  // Set by destroy(); a dead upscaler must never start a renderer again.
  private dead = false;

  // Over the per-frame renderer cap: enabled, but not drawing.
  private throttled = false;

  // Times of recent rebuilds caused by the source changing size (see frame()).
  private sizeRebuilds: number[] = [];

  private static readonly MAX_SIZE_REBUILDS = 3;

  private static readonly SIZE_REBUILD_WINDOW_MS = 30000;

  constructor(video: HTMLVideoElement, settings: Settings, enabled: boolean, onUpdate: () => void) {
    this.video = video;
    this.settings = settings;
    this.enabled = enabled;
    this.onUpdate = onUpdate;
    const sync = () => this.sync();
    const reset = () => { this.teardown(); this.sync(); };
    const seeking = () => { this.stopLoop(); if (this.canvas) this.canvas.hidden = true; };
    const report = () => { this.sync(); this.onUpdate(); };
    this.listeners = [
      ['loadeddata', report], ['playing', report], ['pause', report], ['seeked', sync], ['seeking', seeking],
      ['resize', reset], ['emptied', reset], ['loadstart', reset], ['error', reset],
      ['enterpictureinpicture', sync], ['leavepictureinpicture', sync],
    ];
    for (const [n, f] of this.listeners) video.addEventListener(n, f);
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(video);
    this.docSync = sync;
    document.addEventListener('visibilitychange', sync);
    document.addEventListener('fullscreenchange', sync);
    this.sync();
  }

  /** Stable identity of this video's stream for the on/off map. */
  get key(): string {
    return sourceKey(location.host, this.video.currentSrc || this.video.src || (this.video.srcObject ? 'mediastream:' : ''));
  }

  info(): VideoInfo {
    const key = this.key;
    return {
      id: this.id,
      key,
      frameHost: location.host,
      mediaHost: key.split('::')[1],
      width: this.video.videoWidth,
      height: this.video.videoHeight,
      playing: !this.video.paused && !this.video.ended,
      sourceFps: this.sourceFps,
      enabled: this.enabled,
      status: this.status,
      message: this.message.slice(0, 200),
      stats: this.renderer && this.status === 'Active' ? { ...this.renderer.stats(), sourceFps: this.sourceFps } : null,
      media: mediaSessionMeta(),
    };
  }

  setEnabled(on: boolean) {
    if (on === this.enabled) return;
    this.enabled = on;
    if (this.idleTimer !== null) { window.clearTimeout(this.idleTimer); this.idleTimer = null; }
    if (!on) {
      // Stop drawing and hide the overlay, but keep the renderer compiled (only one warm at a time).
      for (const other of upscalers.values()) if (other !== this && !other.enabled) other.teardown();
      this.stopLoop();
      if (this.canvas) this.canvas.hidden = true;
      this.failed = false;
      this.idleTimer = window.setTimeout(() => { this.idleTimer = null; if (!this.enabled) this.teardown(); }, VideoUpscaler.KEEP_WARM_MS);
    }
    this.sync();
  }

  configure(s: Settings) {
    const chainChanged = s.preset !== this.settings.preset
      || s.darkenLines !== this.settings.darkenLines || s.thinLines !== this.settings.thinLines
      || s.upscale !== this.settings.upscale;
    this.settings = s;
    if (chainChanged) this.teardown();
    this.sync();
  }

  highlight(on: boolean) {
    this.video.style.outline = on ? '3px solid #7c5cff' : '';
    this.video.style.outlineOffset = on ? '-3px' : '';
  }

  destroy() {
    this.dead = true;
    this.video.removeAttribute('data-a4k-on');
    document.removeEventListener('visibilitychange', this.docSync);
    document.removeEventListener('fullscreenchange', this.docSync);
    this.stopProbe();
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.teardown();
    this.highlight(false);
    for (const [n, f] of this.listeners) this.video.removeEventListener(n, f);
    this.resizeObs.disconnect();
  }

  private setStatus(status: Status, message = '') {
    if (this.status === status && this.message === message) return;
    this.status = status;
    this.message = message;
    this.onUpdate();
  }

  private suspended(): boolean {
    const v = this.video;
    // Inside a shadow root, document.* is retargeted to the host, so ask the video's own root.
    const root = v.getRootNode() as Document | ShadowRoot;
    return document.hidden
      || root.pictureInPictureElement === v
      || root.fullscreenElement === v; // native fullscreen on the video itself: canvas can't overlay it
  }

  /** Renderers beyond MAX_ACTIVE_RENDERERS per frame are parked; see applyRendererCap(). */
  setThrottled(on: boolean) {
    if (on === this.throttled) return;
    this.throttled = on;
    if (on) this.teardown();
    this.sync();
  }

  /** Higher runs first: playing videos, then larger ones. */
  priority(): number {
    const r = this.video.getBoundingClientRect();
    return (this.video.paused ? 0 : 1e9) + r.width * r.height;
  }

  private sync() {
    if (this.dead) return;
    // Tells src/fullscreen-redirect.ts (page world) to fullscreen this video's container instead.
    this.video.toggleAttribute('data-a4k-on', this.enabled);
    if (!this.enabled) { this.stopLoop(); if (this.canvas) this.canvas.hidden = true; this.setStatus('Off'); this.probeFps(); return; }
    this.stopProbe();
    if (this.throttled) {
      this.setStatus('Waiting', `Anime4K runs on at most ${MAX_ACTIVE_RENDERERS} videos per page at once. Play this video to give it priority.`);
      return;
    }
    if (this.failed) return;
    const v = this.video;
    if (this.suspended()) {
      this.stopLoop();
      if (this.canvas) this.canvas.hidden = true;
      this.setStatus('Suspended', 'Normal video is used in picture-in-picture, native fullscreen and hidden tabs.');
      return;
    }
    if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) {
      this.stopLoop();
      if (this.canvas) this.canvas.hidden = true;
      this.setStatus('Waiting', 'Waiting for video.');
      return;
    }
    if (v.seeking) return;
    if (this.renderer) this.frame();
    else if (!this.starting) this.start();
  }

  private async start() {
    const v = this.video;
    const src = uploadSize(v);
    if (src.h > 1600 || src.w > 2880) {
      this.fail(`Source is ${src.h}p; up to 1440p is supported (2× output would need too much GPU memory).`);
      return;
    }
    this.starting = true;
    this.width = v.videoWidth;
    this.height = v.videoHeight;
    this.scale = this.wantedScale();
    const gen = this.generation;

    const canvas = document.createElement('canvas');
    canvas.className = 'a4k-canvas';
    canvas.hidden = true;
    canvas.setAttribute('aria-hidden', 'true');
    this.canvas = canvas;
    this.mountCanvas(canvas);
    this.setStatus('Loading', 'Preparing Anime4K (first start compiles shaders, 5–10 s).');

    const timeout = window.setTimeout(() => {
      if (gen === this.generation) this.fail('Anime4K initialization timed out.');
    }, 30000);
    try {
      const { createAnime4kRenderer } = await loadGpu();
      if (gen !== this.generation) return;
      const r = await createAnime4kRenderer(v, canvas, this.settings, (msg) => {
        if (gen === this.generation) this.fail(msg);
      }, this.scale);
      if (gen !== this.generation) { r.destroy(); return; }
      this.renderer = r;
      this.starting = false;
      this.layout();
      this.sync();
    } catch (e) {
      if (gen === this.generation) this.fail(e instanceof Error ? e.message : 'Anime4K could not start.');
    } finally {
      window.clearTimeout(timeout);
    }
  }

  /** Rebuild after the decoded frame size changed; give up if a stream keeps flapping. */
  private rebuildForNewSize() {
    const now = performance.now();
    this.sizeRebuilds = [...this.sizeRebuilds.filter((t) => now - t < VideoUpscaler.SIZE_REBUILD_WINDOW_MS), now];
    if (this.sizeRebuilds.length > VideoUpscaler.MAX_SIZE_REBUILDS) {
      this.fail('The video keeps changing size, so Anime4K stopped. Turn it off and on to retry.');
      return;
    }
    this.teardown();
    this.sync();
  }

  private fail(msg: string) {
    this.teardown();
    this.failed = true;
    this.setStatus('Unavailable', msg);
  }

  private frame() {
    this.stopLoop();
    if (this.rendering) { this.rerender = true; return; }
    const v = this.video;
    const r = this.renderer;
    if (!v || !r || v.seeking || v.readyState < 2 || this.suspended()) return;
    if (v.videoWidth !== this.width || v.videoHeight !== this.height) { this.teardown(); this.sync(); return; }
    const gen = this.generation;
    this.rendering = true;
    try {
      r.render();
      if (gen !== this.generation) return;
      if (this.canvas) this.canvas.hidden = false;
      this.setStatus('Active');
    } catch (e) {
      if (gen === this.generation) {
        // gpu.js is a separate bundle, so match the error by name rather than instanceof.
        if (e instanceof Error && e.name === 'SourceSizeChanged') { this.rebuildForNewSize(); return; }
        const cors = e instanceof DOMException && e.name === 'SecurityError';
        this.fail(cors
          ? 'This video source does not allow browser upscaling (cross-origin without CORS). Normal playback is available.'
          : `Anime4K could not render this video${e instanceof Error ? `: ${e.message}` : '.'} Try another preset or turn it off and on.`);
      }
    } finally {
      if (gen === this.generation) {
        this.rendering = false;
        if (this.rerender) { this.rerender = false; this.sync(); } else if (!v.paused && !v.ended && !v.seeking && !this.suspended()) {
          // Firefox fires requestVideoFrameCallback for only ~25 frames a second even on 60 fps
          // video, so it polls instead (see nextDecodedFrame).
          this.usesVfc = !__FIREFOX__ && typeof v.requestVideoFrameCallback === 'function';
          this.frameHandle = this.usesVfc
            ? v.requestVideoFrameCallback((_now, meta) => { this.frameHandle = null; this.noteSourceFrame(meta); this.frame(); })
            : this.nextDecodedFrame();
        }
      }
    }
  }

  /** Keep measuring the video's frame rate while Anime4K is off (one callback per frame, no drawing). */
  private probeFps() {
    if (this.fpsProbe !== null || this.enabled || typeof this.video.requestVideoFrameCallback !== 'function') return;
    const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
      this.fpsProbe = null;
      if (this.enabled) return;
      this.noteSourceFrame(meta);
      if (!this.video.paused && !this.video.ended) this.fpsProbe = this.video.requestVideoFrameCallback(tick);
    };
    this.fpsProbe = this.video.requestVideoFrameCallback(tick);
  }

  private stopProbe() {
    if (this.fpsProbe !== null) { this.video.cancelVideoFrameCallback(this.fpsProbe); this.fpsProbe = null; }
  }

  private noteSourceFrame(meta: VideoFrameCallbackMetadata) {
    const now = performance.now();
    this.vfcSamples.push({ t: now, presented: meta.presentedFrames });
    while (this.vfcSamples.length && now - this.vfcSamples[0].t > 2000) this.vfcSamples.shift();
    const a = this.vfcSamples[0];
    const b = this.vfcSamples[this.vfcSamples.length - 1];
    if (a && b && b.t - a.t > 500 && b.presented > a.presented) {
      this.sourceFps = ((b.presented - a.presented) * 1000) / (b.t - a.t);
    }
  }

  /** Render on the first animation frame after the decoder has produced a new frame. */
  private nextDecodedFrame(): number {
    const decoded = () => this.video.getVideoPlaybackQuality().totalVideoFrames;
    const last = decoded();
    const tick = () => {
      if (decoded() === last) { this.frameHandle = requestAnimationFrame(tick); return; }
      this.frameHandle = null;
      this.frame();
    };
    return requestAnimationFrame(tick);
  }

  private stopLoop() {
    if (this.frameHandle === null) return;
    if (this.usesVfc) this.video.cancelVideoFrameCallback(this.frameHandle);
    else cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private teardown() {
    this.generation += 1;
    this.stopLoop();
    this.renderer?.destroy();
    this.renderer = null;
    this.canvas?.remove();
    this.canvas = null;
    this.starting = false;
    this.rendering = false;
    this.rerender = false;
    this.failed = false;
  }

  // --- layout: keep the canvas exactly over the video's painted area --------
  private mountCanvas(canvas: HTMLCanvasElement) {
    const parent = this.video.parentElement;
    if (!parent) return;
    if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
    this.video.insertAdjacentElement('afterend', canvas);
    this.layout();
  }

  /** Re-check placement; called on every scan because players move or restyle the video without resizing it. */
  relayout() { this.layout(); }

  /** Manual 2x-32x, or in auto 4x (a second x2 pass) only when the picture is drawn at more than 2x the source in device pixels. */
  private wantedScale(): number {
    const manual = requestedScale(this.settings.upscale);
    if (manual !== null) return manual;
    const v = this.video;
    const r = v.getBoundingClientRect();
    const { w, h } = paintedSize(getComputedStyle(v).objectFit, r.width, r.height, v.videoWidth, v.videoHeight);
    const src = uploadSize(v);
    const dpr = window.devicePixelRatio || 1;
    return w * dpr > src.w * 2 || h * dpr > src.h * 2 ? 4 : 2;
  }

  private layout() {
    const c = this.canvas;
    const v = this.video;
    const parent = v.parentElement;
    if (!c || !parent) return;
    // Display size crossed the 2x line (fullscreen, theater mode, zoom): rebuild at the other scale.
    if ((this.renderer || this.starting) && this.wantedScale() !== this.scale) { this.teardown(); this.sync(); return; }
    // Players move the <video> between containers (theater/fullscreen layouts): follow it.
    if (c.previousElementSibling !== v) { this.mountCanvas(c); return; }
    const vr = v.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    const cs = getComputedStyle(v);
    const px = (s: string) => parseFloat(s) || 0;
    // object-fit applies to the content box, inside the video's own border and padding.
    const boxL = px(cs.borderLeftWidth) + px(cs.paddingLeft);
    const boxT = px(cs.borderTopWidth) + px(cs.paddingTop);
    const bw = vr.width - boxL - px(cs.borderRightWidth) - px(cs.paddingRight);
    const bh = vr.height - boxT - px(cs.borderBottomWidth) - px(cs.paddingBottom);
    const { w: pw, h: ph } = paintedSize(cs.objectFit, bw, bh, v.videoWidth, v.videoHeight);
    const [posX, posY] = cs.objectPosition.split(' ');
    const ox = objectOffset(posX, bw - pw);
    const oy = objectOffset(posY, bh - ph);
    // An absolutely positioned child is placed from the parent's padding box and scrolls with it.
    c.style.left = `${vr.left - pr.left - parent.clientLeft + parent.scrollLeft + boxL + ox}px`;
    c.style.top = `${vr.top - pr.top - parent.clientTop + parent.scrollTop + boxT + oy}px`;
    c.style.width = `${pw}px`;
    c.style.height = `${ph}px`;
    // object-fit: cover (or none) paints past the content box; clip the canvas to it like the video.
    // inset() order: top right bottom left.
    const clip = [-oy, ox + pw - bw, oy + ph - bh, -ox].map((n) => Math.max(0, n));
    c.style.clipPath = clip.some((n) => n > 0) ? `inset(${clip.map((n) => `${n}px`).join(' ')})` : '';
    const z = cs.zIndex;
    c.style.zIndex = z && z !== 'auto' ? String(Number(z) + 1) : '1';
  }
}

/** CSS size of the picture inside a bw x bh content box for the given object-fit. */
function paintedSize(fit: string, bw: number, bh: number, vw: number, vh: number): { w: number; h: number } {
  if (!vw || !vh || fit === 'fill') return { w: bw, h: bh };
  const contain = Math.min(bw / vw, bh / vh);
  const scale = fit === 'cover' ? Math.max(bw / vw, bh / vh)
    : fit === 'none' ? 1
      : fit === 'scale-down' ? Math.min(1, contain)
        : contain; // contain, and the default
  return { w: vw * scale, h: vh * scale };
}

/** Offset for one object-position component; `free` is box size minus picture size (may be negative). */
function objectOffset(component: string | undefined, free: number): number {
  if (!component) return free / 2;
  if (component.endsWith('%')) return (free * (parseFloat(component) || 0)) / 100;
  if (component.endsWith('px')) return parseFloat(component) || 0;
  return free / 2; // calc() and other forms: assume centered
}

// --- discovery ---------------------------------------------------------------
const upscalers = new Map<HTMLVideoElement, VideoUpscaler>();
let settings: Settings;
let sources: Sources = {};

function collectVideos(root: Document | ShadowRoot | Element, out: HTMLVideoElement[]) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let n = walker.currentNode as Element | null;
  while (n) {
    if (n instanceof HTMLVideoElement) out.push(n);
    if ((n as Element).shadowRoot) collectVideos((n as Element).shadowRoot!, out);
    n = walker.nextNode() as Element | null;
  }
}

function eligible(v: HTMLVideoElement): boolean {
  const r = v.getBoundingClientRect();
  return r.width >= MIN_VIDEO_PX && r.height >= MIN_VIDEO_PX / 2;
}

let scanQueued = false;
let lastScan = 0;
function scan() {
  scanQueued = false;
  if (stopped) return;
  if (!contextAlive()) { shutdown(); return; }
  lastScan = performance.now();
  const found: HTMLVideoElement[] = [];
  collectVideos(document, found);
  const set = new Set(found.filter(eligible));
  let changed = false;
  for (const [v, u] of upscalers) {
    if (!set.has(v) || !v.isConnected) { u.destroy(); upscalers.delete(v); changed = true; }
  }
  for (const v of set) {
    if (!upscalers.has(v)) {
      const u = new VideoUpscaler(v, settings, false, notify);
      u.setEnabled(sources[u.key] === true);
      upscalers.set(v, u);
      changed = true;
    }
  }
  // The media URL can change after creation (HLS attaches later); re-evaluate enabled state.
  for (const u of upscalers.values()) u.setEnabled(sources[u.key] === true);
  applyRendererCap();
  for (const u of upscalers.values()) u.relayout();
  if (changed) notify();
}
function queueScan() {
  if (scanQueued) return;
  scanQueued = true;
  const wait = Math.max(0, 300 - (performance.now() - lastScan));
  setTimeout(scan, wait);
}

function applyRendererCap() {
  const ranked = [...upscalers.values()].filter((u) => u.enabled).sort((a, b) => b.priority() - a.priority());
  ranked.forEach((u, i) => u.setThrottled(i >= MAX_ACTIVE_RENDERERS));
}

function list(): VideoInfo[] {
  return [...upscalers.values()].map((u) => u.info());
}
function notify() {
  // sendMessage throws synchronously once the context is gone, even when runtime.id still reads.
  try {
    if (!contextAlive()) throw new Error('context gone');
    chrome.runtime.sendMessage({ type: 'a4k-changed' } satisfies Message).catch(() => {});
  } catch {
    shutdown();
    return;
  }
  syncMenu();
}

// --- orphan handling -------------------------------------------------------------
// When the extension reloads or updates, this copy keeps running but every chrome.* call
// throws "Extension context invalidated", while a fresh copy is injected next to it.
// The old copy must remove its canvases and menu and stop, or both draw over the video.
const TAKEOVER_EVENT = 'a4k-takeover';
let observer: MutationObserver | null = null;
let scanTimer: number | null = null;
let stopped = false;

function contextAlive(): boolean {
  try { return !!chrome.runtime?.id; } catch { return false; }
}

/** The page can dispatch this event too, so only a copy whose extension context is already dead obeys it. */
function onTakeover() {
  if (!contextAlive()) shutdown();
}

function shutdown() {
  if (stopped) return;
  stopped = true;
  window.__a4kLoaded = false;
  document.removeEventListener(TAKEOVER_EVENT, onTakeover);
  observer?.disconnect();
  if (scanTimer !== null) window.clearInterval(scanTimer);
  for (const u of upscalers.values()) u.destroy();
  upscalers.clear();
  menu.mount(null);
}

// --- fullscreen menu -------------------------------------------------------------
/** True if `node` is `outer` or inside it, crossing shadow-root boundaries. */
function composedContains(outer: Element, node: Node): boolean {
  for (let n: Node | null = node; n; n = n.parentNode ?? (n as ShadowRoot).host ?? null) if (n === outer) return true;
  return false;
}

/** Share of the viewport a video must cover to count as "the" video when the whole frame is fullscreen. */
const FILLS_VIEWPORT = 0.8;

/** True when this frame's viewport is the whole screen: the outer page fullscreened our iframe, or F11. */
function frameFillsScreen(): boolean {
  return innerWidth >= screen.width - 2 && innerHeight >= screen.height - 2;
}

/**
 * Where the menu goes: the fullscreen element, or its open shadow root when the video lives inside
 * it (children added from outside a shadow root without a slot are never drawn).
 */
function mountPoint(fs: Element, video: HTMLVideoElement): Element | ShadowRoot {
  for (let r = video.getRootNode(); r instanceof ShadowRoot; r = r.host.getRootNode()) {
    if (r === fs.shadowRoot) return r;
  }
  return fs;
}

/** The video the fullscreen menu belongs to and where to mount it, or null when nothing is fullscreen. */
function fullscreenTarget(): { u: VideoUpscaler; container: Element | ShadowRoot } | null {
  const ranked = [...upscalers.values()].sort((a, b) => b.priority() - a.priority());
  for (const u of ranked) {
    const root = u.video.getRootNode() as Document | ShadowRoot;
    const fs = root.fullscreenElement ?? document.fullscreenElement;
    // A player container is fullscreen (not the bare video, which nothing can draw over).
    if (fs && fs !== u.video && composedContains(fs, u.video)) return { u, container: mountPoint(fs, u.video) };
  }
  if (document.fullscreenElement || !frameFillsScreen() || !document.body) return null;
  const big = ranked.find((u) => {
    const r = u.video.getBoundingClientRect();
    return r.width >= innerWidth * FILLS_VIEWPORT || r.height >= innerHeight * FILLS_VIEWPORT;
  });
  return big ? { u: big, container: document.body } : null;
}

const menu = new FullscreenMenu(() => fullscreenTarget()?.u.info() ?? null, () => settings);
function syncMenu() { if (!stopped) menu.mount(fullscreenTarget()?.container ?? null); }

chrome.runtime.onMessage.addListener((msg: Message, _sender, respond) => {
  if (stopped) return false; // a stopped copy must not answer for the live one
  if (msg?.type === 'a4k-list') { respond(list()); return true; }
  if (msg?.type === 'a4k-page-meta') {
    // Only the top document knows the page title / JSON-LD; iframes answer null.
    try { respond(window.top === window ? collectPageMeta() : null); } catch { respond(null); }
    return true;
  }
  if (msg?.type === 'a4k-highlight') {
    for (const u of upscalers.values()) u.highlight(u.id === msg.id);
    respond(true);
    return true;
  }
  return false;
});

// Tell any older copy (e.g. orphaned by an extension reload) to step aside. DOM events reach
// every isolated world, and dispatch is synchronous, so it has cleared the flag below by now.
document.dispatchEvent(new CustomEvent(TAKEOVER_EVENT));
if (!window.__a4kLoaded) {
  window.__a4kLoaded = true;
  document.addEventListener(TAKEOVER_EVENT, onTakeover);
  (async () => {
  [settings, sources] = await Promise.all([loadSettings(), loadSources()]);
  if (stopped) return;
  onSettingsChanged((s) => { if (stopped) return; settings = s; for (const u of upscalers.values()) u.configure(s); notify(); });
  onSourcesChanged((s) => {
    if (stopped) return;
    sources = s;
    for (const u of upscalers.values()) u.setEnabled(sources[u.key] === true);
    applyRendererCap();
    notify();
  });
  document.addEventListener('fullscreenchange', syncMenu);
  // An iframe whose outer page goes fullscreen, and F11, only show up as a resize.
  window.addEventListener('resize', syncMenu);
  document.addEventListener('mousemove', () => menu.wake(), { passive: true });
  observer = new MutationObserver(queueScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
  // Videos that become visible later (lazy players) are picked up by periodic rescans.
  scanTimer = window.setInterval(queueScan, 2000);
  })();
}

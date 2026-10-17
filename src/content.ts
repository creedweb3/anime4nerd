// Content script: finds <video> elements (including inside shadow roots), reports
// them to the popup as "sources", and for sources the user switched on lays a
// canvas over the video and drives the Anime4K renderer per video frame.
// Lifecycle: suspend in PiP / hidden tab,
// rebuild on resize, fall back to plain video on any GPU error.

import {
  Message, Settings, Sources, Status, VideoInfo,
  loadSettings, loadSources, onSettingsChanged, onSourcesChanged, sourceKey,
} from './settings';
import type { Anime4kRenderer } from './gpu';
import { collectPageMeta, mediaSessionMeta } from './media-meta';

type GpuModule = typeof import('./gpu');
let gpuModule: Promise<GpuModule> | null = null;
function loadGpu(): Promise<GpuModule> {
  gpuModule ??= import(/* @vite-ignore */ chrome.runtime.getURL('gpu.js')) as Promise<GpuModule>;
  return gpuModule;
}

const MIN_VIDEO_PX = 200; // ignore thumbnails / preview videos

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
      || s.darkenLines !== this.settings.darkenLines || s.thinLines !== this.settings.thinLines;
    this.settings = s;
    if (chainChanged) this.teardown();
    this.sync();
  }

  highlight(on: boolean) {
    this.video.style.outline = on ? '3px solid #7c5cff' : '';
    this.video.style.outlineOffset = on ? '-3px' : '';
  }

  destroy() {
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
    return document.hidden
      || document.pictureInPictureElement === v
      || document.fullscreenElement === v; // native fullscreen on the video itself: canvas can't overlay it
  }

  private sync() {
    if (!this.enabled) { this.stopLoop(); if (this.canvas) this.canvas.hidden = true; this.setStatus('Off'); this.probeFps(); return; }
    this.stopProbe();
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
    if (v.videoHeight > 1600 || v.videoWidth > 2880) {
      this.fail(`Source is ${v.videoHeight}p; up to 1440p is supported (2× output would need too much GPU memory).`);
      return;
    }
    this.starting = true;
    this.width = v.videoWidth;
    this.height = v.videoHeight;
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
      });
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
        const cors = e instanceof DOMException && e.name === 'SecurityError';
        this.fail(cors
          ? 'This video source does not allow browser upscaling (cross-origin without CORS). Normal playback is available.'
          : 'Anime4K could not render this video. Try another preset or turn it off and on.');
      }
    } finally {
      if (gen === this.generation) {
        this.rendering = false;
        if (this.rerender) { this.rerender = false; this.sync(); } else if (!v.paused && !v.ended && !v.seeking && !this.suspended()) {
          this.usesVfc = typeof v.requestVideoFrameCallback === 'function';
          this.frameHandle = this.usesVfc
            ? v.requestVideoFrameCallback((_now, meta) => { this.frameHandle = null; this.noteSourceFrame(meta); this.frame(); })
            : requestAnimationFrame(() => { this.frameHandle = null; this.frame(); });
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

  private layout() {
    const c = this.canvas;
    const v = this.video;
    const parent = v.parentElement;
    if (!c || !parent) return;
    const vr = v.getBoundingClientRect();
    const pr = parent.getBoundingClientRect();
    // Painted area inside the element box, honouring object-fit (contain default).
    const fit = getComputedStyle(v).objectFit || 'contain';
    let { width: bw, height: bh } = vr;
    let ox = 0; let oy = 0;
    if (v.videoWidth && v.videoHeight && fit !== 'fill') {
      const va = v.videoWidth / v.videoHeight;
      const ba = bw / bh;
      const contain = fit === 'cover' ? va < ba : va > ba;
      if (contain) { const nh = bw / va; oy = (bh - nh) / 2; bh = nh; } else { const nw = bh * va; ox = (bw - nw) / 2; bw = nw; }
    }
    c.style.left = `${vr.left - pr.left + ox}px`;
    c.style.top = `${vr.top - pr.top + oy}px`;
    c.style.width = `${bw}px`;
    c.style.height = `${bh}px`;
    const z = getComputedStyle(v).zIndex;
    c.style.zIndex = z && z !== 'auto' ? String(Number(z) + 1) : '1';
  }
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
  if (changed) notify();
}
function queueScan() {
  if (scanQueued) return;
  scanQueued = true;
  const wait = Math.max(0, 300 - (performance.now() - lastScan));
  setTimeout(scan, wait);
}

function list(): VideoInfo[] {
  return [...upscalers.values()].map((u) => u.info());
}
function notify() {
  chrome.runtime.sendMessage({ type: 'a4k-changed' } satisfies Message).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, respond) => {
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

if (!window.__a4kLoaded) {
  window.__a4kLoaded = true;
  (async () => {
  [settings, sources] = await Promise.all([loadSettings(), loadSources()]);
  onSettingsChanged((s) => { settings = s; for (const u of upscalers.values()) u.configure(s); notify(); });
  onSourcesChanged((s) => { sources = s; for (const u of upscalers.values()) u.setEnabled(sources[u.key] === true); notify(); });
  new MutationObserver(queueScan).observe(document.documentElement, { childList: true, subtree: true });
  scan();
  // Videos that become visible later (lazy players) are picked up by periodic rescans.
  setInterval(queueScan, 2000);
  })();
}

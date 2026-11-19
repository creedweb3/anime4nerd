// Content script: finds <video> elements (including inside shadow roots), reports
// them to the popup as "sources", and for sources the user switched on lays a
// canvas over the video and drives the Anime4K renderer per video frame.
// Lifecycle: suspend in PiP / hidden tab,
// rebuild on resize, fall back to plain video on any GPU error.

import {
  Message, Settings, Sources, Status, Suggest, VideoInfo, chainKey,
  loadSettings, loadSources, onSettingsChanged, onSourcesChanged, requestedScale, sourceKey,
} from './settings';
import type { Anime4kRenderer } from './gpu';
import { collectPageMeta, mediaSessionMeta } from './media-meta';
import { uploadSize } from './video-size';
import { FullscreenMenu } from './fullscreen-menu';
import { EPISODE_SECONDS } from './rate-prompt';
import { MangaMode, startManga } from './manga';
import { CostOf, Measured, OVERLOAD_AFTER_MS, allowedScale, median, overloaded, pixelCost, stepDownTo } from './load-cap';

type GpuModule = typeof import('./gpu');
let gpuModule: Promise<GpuModule> | null = null;
let loadedGpu: GpuModule | null = null; // gpu.js once loaded: the load cap's cost model reads it synchronously
function loadGpu(): Promise<GpuModule> {
  gpuModule ??= (import(/* @vite-ignore */ chrome.runtime.getURL('gpu.js')) as Promise<GpuModule>).then((m) => (loadedGpu = m));
  return gpuModule;
}

const MIN_VIDEO_PX = 200; // ignore thumbnails / preview videos
const BUSY_RETRY_MS = 8; // wait before retrying a frame skipped because the GPU was still busy
// Each renderer holds a WebGL context, compiled shaders and large float textures; browsers
// cap live contexts (~16) and evict the oldest, so a page full of videos must not get one each.
const MAX_ACTIVE_RENDERERS = 2;
const STACK_CHECK_MS = 1000; // how often to check that the player's overlays still paint over the canvas
const LOAD_CHECK_MS = 500; // how often the GPU load is checked while playing (see watchLoad)
const MIN_LOAD_SAMPLES = 5; // frames needed before a GPU time counts as measured
// Redrawn subtitles (paintCues), sized like Chrome's own captions: font 5% of the video height,
// rows touching, the last row almost on the bottom edge. Pages' ::cue rules can change the size.
const CUE_FONT_SHARE = 0.05;
const CUE_LINE_HEIGHT = 1.2; // em per text row; must match line-height in content.css
const CUE_MIN_PX = 12;
const CUE_EDGE_PCT = 0.5; // gap between the picture edge and the first/last row
const CUE_MAX_LINES = 12; // a line setting further out than this would land off the picture
const CUE_MIN_SIZE_PCT = 20;
const CUE_LIFT_RECHECK_MS = [150, 1200, 3500]; // after a pointer move: shown, then faded control bars

declare global { interface Window { __a4kLoaded?: boolean } }
let nextId = 1;

class VideoUpscaler {
  readonly video: HTMLVideoElement;

  readonly id = `${location.host}#${nextId++}`;

  private canvas: HTMLCanvasElement | null = null;

  private renderer: Anime4kRenderer | null = null;

  private generation = 0;

  private frameHandle: number | null = null;

  // Retry of a frame skipped because the GPU was still busy (see frame()).
  private busyTimer: number | null = null;

  private usesVfc = false;

  private rendering = false;

  private rerender = false;

  private failed = false;

  /** Set when the canvas had to move to the start of this container (see coversOverlay). */
  private lowered: Element | null = null;

  private lastStackCheck = 0;

  /** Our copy of the browser's own subtitles (see paintCues). */
  private cues: HTMLDivElement | null = null;

  private readonly cueTracks = new WeakSet<TextTrack>();

  private cueListWatched = false;

  private starting = false;

  private width = 0;

  private height = 0;

  // Upscale factor the current renderer was built for (see wantedScale()).
  private scale = 2;

  // GPU-load cap (load-cap.ts): the highest scale this video may use after it ran too slow, the
  // median GPU time at each scale it ran at, when the renderer was built, and the last check.
  private loadCap: number | null = null;
  private measured: Measured = new Map();
  private builtAt = 0;
  private loadCheckAt = 0;
  private framesDrawn = 0; // frames rendered by this video's renderers
  private drawWindow: { t: number; drawn: number; decoded: number }[] = []; // see watchLoad

  // Source frame-rate estimate from requestVideoFrameCallback metadata.
  private fpsSamples: { t: number; frames: number; media: number }[] = [];

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

  // Scrolled out of view (or zero size): nothing would be seen, so nothing is drawn.
  private offscreen = false;

  private readonly viewObs: IntersectionObserver;

  private readonly docSync: () => void;

  // Set by destroy(); a dead upscaler must never start a renderer again.
  private dead = false;

  // Over the per-frame renderer cap: enabled, but not drawing.
  private throttled = false;

  // Times of recent rebuilds caused by the source changing size (see frame()).
  private sizeRebuilds: number[] = [];

  private static readonly MAX_SIZE_REBUILDS = 3;

  private static readonly SIZE_REBUILD_WINDOW_MS = 30000;

  // Watch counting for the rating card (see rate-prompt.ts): upscaled time on the current
  // stream, and whether it already counted as an episode.
  private lastFrameAt: number | null = null;

  private watchSrc = '';

  private watchSeconds = 0;

  private episodeCounted = false;

  private lastMediaTime = 0;

  private static readonly RESTART_SECONDS = 60;

  constructor(video: HTMLVideoElement, settings: Settings, enabled: boolean, onUpdate: () => void) {
    this.video = video;
    this.settings = settings;
    this.enabled = enabled;
    this.onUpdate = onUpdate;
    const sync = () => this.sync();
    // A new source or size: the load cap and the measured GPU time were for the old one.
    const reset = () => { this.loadCap = null; this.measured = new Map(); this.teardown(); this.sync(); };
    // A seek decodes frames nobody draws (from the keyframe to the target): not dropped frames.
    const seeking = () => { this.stopLoop(); this.drawWindow = []; if (this.canvas) this.canvas.hidden = true; };
    const report = () => { this.sync(); this.onUpdate(); };
    this.listeners = [
      ['loadeddata', report], ['playing', report], ['pause', () => { this.freezeSamples(); report(); }], ['seeked', sync], ['seeking', seeking],
      ['resize', reset], ['emptied', reset], ['loadstart', reset], ['error', reset],
      ['enterpictureinpicture', sync], ['leavepictureinpicture', sync],
    ];
    for (const [n, f] of this.listeners) video.addEventListener(n, f);
    this.resizeObs = new ResizeObserver(() => this.layout());
    this.resizeObs.observe(video);
    this.viewObs = new IntersectionObserver((entries) => {
      const off = !entries[entries.length - 1].isIntersecting;
      if (off === this.offscreen) return;
      this.offscreen = off;
      this.sync();
    });
    this.viewObs.observe(video);
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
      stats: this.currentStats(),
      loadCapped: !!this.renderer && this.scale < this.rawScale(),
      media: mediaSessionMeta(),
    };
  }

  /** Frame times of the last 2 s of playback, kept while paused (they would age out one by one). */
  private frozenSamples: number[] = [];

  private freezeSamples() {
    const s = this.renderer && this.status === 'Active' ? this.renderer.stats().samples : [];
    if (s.length) this.frozenSamples = s;
  }

  /** Renderer stats; while paused, the graph is the one from the moment playback stopped. */
  private currentStats() {
    if (!this.renderer || this.status !== 'Active') { this.frozenSamples = []; return null; }
    const s = this.renderer.stats();
    const playing = !this.video.paused && !this.video.ended;
    return { ...s, samples: playing ? s.samples : this.frozenSamples, sourceFps: this.sourceFps };
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
    const chainChanged = chainKey(s) !== chainKey(this.settings) || s.upscale !== this.settings.upscale;
    // A settings change lifts the load cap; a different chain also costs differently, so its
    // measured time no longer predicts anything (a new upscale choice keeps it).
    if (chainChanged) this.loadCap = null;
    if (chainKey(s) !== chainKey(this.settings)) this.measured = new Map();
    this.settings = s;
    if (chainChanged || this.mangaOnly()) this.teardown();
    this.sync();
  }

  /** Mode 'manga': videos are left alone. The Firefox build has no manga mode. */
  private mangaOnly(): boolean {
    return !__FIREFOX__ && this.settings.mode === 'manga';
  }

  highlight(on: boolean) {
    this.video.style.outline = on ? '3px solid #fff' : '';
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
    this.viewObs.disconnect();
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
      || this.offscreen
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
    this.video.toggleAttribute('data-a4k-on', this.enabled && !this.mangaOnly());
    if (!this.enabled) { this.stopLoop(); if (this.canvas) this.canvas.hidden = true; this.setStatus('Off'); this.probeFps(); return; }
    this.stopProbe();
    // configure() has already dropped the renderer and its canvas; nothing is built while this holds.
    if (this.mangaOnly()) { this.stopLoop(); this.setStatus('Suspended', 'Paused: manga mode.'); return; }
    if (this.throttled) {
      this.setStatus('Waiting', `Anime4K runs on at most ${MAX_ACTIVE_RENDERERS} videos per page at once. Play this video to give it priority.`);
      return;
    }
    if (this.failed) return;
    const v = this.video;
    if (this.suspended()) {
      this.stopLoop();
      if (this.canvas) this.canvas.hidden = true;
      this.setStatus('Suspended', this.offscreen && !document.hidden
        ? 'Paused while the video is out of view; it resumes when you scroll back.'
        : 'Normal video is used in picture-in-picture, native fullscreen and hidden tabs.');
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
    this.watchCues();
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
      this.builtAt = performance.now();
      this.drawWindow = []; // frames skipped while the new renderer compiled are not its drops
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
    if (r.busy()) {
      // The GPU is still on the last frame: queueing another only adds lag and load. Draw
      // whatever frame is current once it is done (skipping frames it had no time for). A
      // timer, not an animation frame: those stop while the window is covered, which would
      // leave a paused video without its picture.
      this.busyTimer = window.setTimeout(() => { this.busyTimer = null; this.frame(); }, BUSY_RETRY_MS);
      return;
    }
    const gen = this.generation;
    this.rendering = true;
    try {
      r.render();
      this.framesDrawn += 1;
      if (gen !== this.generation) return;
      // Shown again (scrolled back, tab back, seek done): the redrawn subtitles must come back with it.
      if (this.canvas?.hidden) { this.canvas.hidden = false; this.paintCues(); }
      this.setStatus('Active');
      this.countWatch();
      this.watchLoad(r);
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
            ? v.requestVideoFrameCallback(() => { this.frameHandle = null; this.noteSourceFrame(); this.frame(); })
            : this.nextDecodedFrame();
        }
      }
    }
  }

  /**
   * Credit the time since the previous drawn frame. Gaps of a second or more (paused, seeking,
   * hidden, switched off) are not counted, so only time spent actually upscaling adds up.
   */
  private countWatch() {
    const now = performance.now();
    const gap = this.lastFrameAt === null ? 0 : (now - this.lastFrameAt) / 1000;
    this.lastFrameAt = now;
    if (gap <= 0 || gap >= 1) return;
    const src = this.video.currentSrc || this.video.src;
    const t = this.video.currentTime;
    // A new stream, or a jump back to the start of the same one (players that reuse one
    // MediaSource for the next episode), starts a new episode.
    const restarted = t < VideoUpscaler.RESTART_SECONDS && this.lastMediaTime - t > VideoUpscaler.RESTART_SECONDS;
    this.lastMediaTime = t;
    if (src !== this.watchSrc || restarted) { this.watchSrc = src; this.watchSeconds = 0; this.episodeCounted = false; }
    this.watchSeconds += gap;
    watchReport.seconds += gap;
    if (!this.episodeCounted && this.watchSeconds >= EPISODE_SECONDS) { this.episodeCounted = true; watchReport.episodes += 1; }
  }

  /** Keep measuring the video's frame rate while Anime4K is off (one callback per frame, no drawing). */
  private probeFps() {
    if (this.fpsProbe !== null || this.enabled || typeof this.video.requestVideoFrameCallback !== 'function') return;
    const tick = () => {
      this.fpsProbe = null;
      if (this.enabled) return;
      this.noteSourceFrame();
      if (!this.video.paused && !this.video.ended) this.fpsProbe = this.video.requestVideoFrameCallback(tick);
    };
    this.fpsProbe = this.video.requestVideoFrameCallback(tick);
  }

  private stopProbe() {
    if (this.fpsProbe !== null) { this.video.cancelVideoFrameCallback(this.fpsProbe); this.fpsProbe = null; }
  }

  /**
   * The video's own frame rate: frames the decoder produced (shown or dropped) per second of video
   * time, over the last 2 s. Frames we skip, a slow page, or the playback speed do not change it,
   * and Chrome and Firefox both report these counters.
   */
  private noteSourceFrame() {
    const now = performance.now();
    const frames = this.video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    const media = this.video.currentTime;
    const last = this.fpsSamples.at(-1);
    // A seek, a loop or a new source jumps the video time or the counter: start over.
    if (last && (media < last.media || frames < last.frames || media - last.media > ((now - last.t) / 1000) * 4 + 0.5)) this.fpsSamples = [];
    this.fpsSamples.push({ t: now, frames, media });
    while (this.fpsSamples.length && now - this.fpsSamples[0].t > 2000) this.fpsSamples.shift();
    const a = this.fpsSamples[0];
    const b = this.fpsSamples[this.fpsSamples.length - 1];
    if (a && b && b.media - a.media > 0.5 && b.frames > a.frames) this.sourceFps = (b.frames - a.frames) / (b.media - a.media);
  }

  /** Render on the first animation frame after the decoder has produced a new frame. */
  private nextDecodedFrame(): number {
    const decoded = () => this.video.getVideoPlaybackQuality().totalVideoFrames;
    const last = decoded();
    const tick = () => {
      const now = decoded();
      if (now === last) { this.frameHandle = requestAnimationFrame(tick); return; }
      this.frameHandle = null;
      this.noteSourceFrame();
      this.frame();
    };
    return requestAnimationFrame(tick);
  }

  private stopLoop() {
    if (this.busyTimer !== null) { window.clearTimeout(this.busyTimer); this.busyTimer = null; }
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
    this.cues?.remove();
    this.cues = null;
    this.starting = false;
    this.rendering = false;
    this.rerender = false;
    this.failed = false;
  }

  // --- layout: keep the canvas exactly over the video's painted area --------
  private mountCanvas(canvas: HTMLCanvasElement) {
    const parent = this.video.parentElement;
    if (!parent) return;
    if (this.lowered && this.lowered.contains(this.video)) {
      // See coversOverlay: first in the player container, so all of the player's overlays paint over it.
      this.lowered.prepend(canvas);
    } else {
      this.lowered = null;
      if (!pageLevel(parent) && getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      this.video.insertAdjacentElement('afterend', canvas);
    }
    this.layout();
  }

  /** Repaint our subtitle copy whenever a track's cues or modes change. */
  private watchCues() {
    const tracks = this.video.textTracks;
    const hook = () => {
      for (const t of tracks) {
        if (this.cueTracks.has(t)) continue;
        this.cueTracks.add(t);
        t.addEventListener('cuechange', () => this.paintCues());
      }
      this.paintCues();
    };
    if (!this.cueListWatched) {
      this.cueListWatched = true;
      tracks.addEventListener('addtrack', hook);
      tracks.addEventListener('change', hook);
      // Players show their control bar on pointer movement and fade it a few seconds later:
      // re-check the subtitle lift shortly after a move and again once a fade has finished.
      let timers: number[] = [];
      document.addEventListener('pointermove', () => {
        if (!this.cues || this.cues.hidden) return;
        for (const t of timers) clearTimeout(t);
        timers = CUE_LIFT_RECHECK_MS.map((ms) => window.setTimeout(() => this.paintCues(), ms));
      }, { passive: true, capture: true });
    }
    hook();
  }

  /**
   * The browser draws a <video>'s own subtitle tracks (<track>, WebVTT) inside the video picture, so
   * the canvas covers them. Show the active cues again in a layer just above the canvas, over the
   * same picture area, styled like the browser's default captions.
   */
  private paintCues() {
    const c = this.canvas;
    const active = c && !c.hidden
      ? [...this.video.textTracks].filter((t) => t.mode === 'showing').flatMap((t) => [...(t.activeCues ?? [])])
      : [];
    if (!c || !active.length) { if (this.cues) this.cues.hidden = true; return; }
    let box = this.cues;
    if (!box) {
      box = document.createElement('div');
      box.className = 'a4k-cues';
      box.setAttribute('aria-hidden', 'true'); // screen readers already get the real track
      this.cues = box;
    }
    if (box.previousElementSibling !== c) c.insertAdjacentElement('afterend', box);
    for (const k of ['left', 'top', 'width', 'height', 'clipPath', 'zIndex'] as const) box.style[k] = c.style[k];
    box.style.fontSize = `${Math.max(CUE_MIN_PX, parseFloat(c.style.height) * CUE_FONT_SHARE)}px`;
    // Cues with their own placement go where they ask; the rest stack at the bottom centre.
    const stack = document.createElement('div');
    stack.className = 'a4k-stack';
    const placed: HTMLElement[] = [];
    for (const cue of active) {
      const el = document.createElement('div');
      el.className = 'a4k-cue';
      const text = document.createElement('span');
      // getCueAsHTML keeps WebVTT's own <i>/<b>/<u> markup; it builds nodes, never runs page markup.
      if ('getCueAsHTML' in cue) text.append((cue as VTTCue).getCueAsHTML());
      else text.textContent = (cue as { text?: string }).text ?? '';
      el.append(text);
      applyCueRules(text, this.video);
      // A ::cue font size or line height sizes the whole cue box, rows included: move them from the
      // text to the box, or rows keep the default height around smaller text and drift apart.
      for (const k of ['fontSize', 'lineHeight'] as const) {
        if (text.style[k]) { el.style[k] = text.style[k]; text.style[k] = ''; }
      }
      const at = cuePlacement(cue);
      if (at) { Object.assign(el.style, at); placed.push(el); } else stack.append(el);
    }
    // Bottom-anchored cues move up above the player's control bar while it is showing.
    const lift = this.controlBarLift(c);
    if (lift) {
      stack.style.bottom = `calc(${CUE_EDGE_PCT}% + ${lift}px)`;
      for (const el of placed) if (el.style.bottom) el.style.bottom = `calc(${el.style.bottom} + ${lift}px)`;
    }
    box.replaceChildren(stack, ...placed);
    box.hidden = false;
  }

  /**
   * Height in px of the player's control bar over the bottom of the picture, while it is visible;
   * 0 when hidden or absent. A control bar here is something drawn over the video along the bottom
   * edge, at least 40% of the picture wide and at most 35% tall (so full-size click layers don't count).
   */
  private controlBarLift(c: HTMLCanvasElement): number {
    const v = this.video;
    if (!v.isConnected) return 0; // a removed video's root is itself: no elementsFromPoint
    const root = v.getRootNode() as Document | ShadowRoot;
    const r = c.getBoundingClientRect();
    if (r.height < 50) return 0;
    let top = r.bottom;
    for (const fx of [0.2, 0.5, 0.8]) {
      const x = r.left + r.width * fx;
      const y = r.bottom - Math.min(8, r.height * 0.02);
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hits = root.elementsFromPoint(x, y);
      const vi = hits.indexOf(v);
      for (const e of vi < 0 ? hits : hits.slice(0, vi)) {
        if (e === c || e.contains(v) || this.cues?.contains(e)) continue;
        const b = e.getBoundingClientRect();
        if (b.height > r.height * 0.35 || b.width < r.width * 0.4 || b.bottom < r.bottom - r.height * 0.05) continue;
        if (!isShown(e)) continue;
        top = Math.min(top, b.top);
      }
    }
    return Math.round(Math.min(r.height * 0.35, Math.max(0, r.bottom - top)));
  }

  /**
   * True when something the page draws over the video (controls, menus, subtitles) ends up under the
   * canvas. Right after the video is the right place for almost every player, but a player that puts
   * its controls before an unpositioned <video> would have them painted under the canvas. Checked by
   * hit-testing a grid over the picture with and without the canvas.
   */
  private coversOverlay(c: HTMLCanvasElement): boolean {
    const v = this.video;
    if (!v.isConnected) return false; // a removed video's root is itself: no elementsFromPoint
    const root = v.getRootNode() as Document | ShadowRoot;
    const r = c.getBoundingClientRect();
    // Rows reach close to the edges: control bars and subtitles sit in the bottom tenth.
    const rows = [0.04, 0.25, 0.5, 0.75, 0.88, 0.96];
    const cols = [0.06, 0.3, 0.5, 0.7, 0.94];
    for (const fy of rows) {
      for (const fx of cols) {
        const x = r.left + r.width * fx;
        const y = r.top + r.height * fy;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const under = root.elementsFromPoint(x, y); // the canvas is pointer-events: none, so not listed
        const vi = under.indexOf(v);
        if (vi <= 0) continue;
        const above = under.slice(0, vi).filter((e) => !e.contains(v));
        if (!above.length) continue;
        c.style.pointerEvents = 'auto';
        const over = root.elementsFromPoint(x, y);
        c.style.pointerEvents = '';
        const ci = over.indexOf(c);
        if (ci >= 0 && above.some((e) => over.indexOf(e) > ci)) return true;
      }
    }
    return false;
  }

  /** Re-check placement; called on every scan because players move or restyle the video without resizing it. */
  relayout() { this.layout(); }

  /**
   * While playing, at most every LOAD_CHECK_MS: note the median GPU time at this scale (it
   * predicts the cost of any other), and above 2x, once a renderer has run for OVERLOAD_AFTER_MS,
   * step down when the last 2 s dropped frames because of the GPU: straight to the highest scale
   * predicted to fit. The cap holds for this video until a setting or the source changes, so the
   * scale does not bounce.
   */
  private watchLoad(r: Anime4kRenderer) {
    const now = performance.now();
    if (now - this.loadCheckAt < LOAD_CHECK_MS || this.video.paused) return;
    this.loadCheckAt = now;
    const s = r.stats();
    // GPU time per frame: timer queries, or without them (Firefox) fence timing.
    const gpu = s.timerSupported ? s.samples : s.busySamples;
    if (gpu.length >= MIN_LOAD_SAMPLES) this.measured = new Map(this.measured).set(this.scale, median(gpu));
    // Frames drawn against frames the decoder produced, over the last 2 s of playback.
    const decoded = this.video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    this.drawWindow.push({ t: now, drawn: this.framesDrawn, decoded });
    while (this.drawWindow.length && now - this.drawWindow[0].t > 2000 + LOAD_CHECK_MS) this.drawWindow.shift();
    const a = this.drawWindow[0];
    const dDecoded = decoded - a.decoded;
    const drawn = now - a.t >= 1500 && dDecoded >= MIN_LOAD_SAMPLES ? Math.min(1, (this.framesDrawn - a.drawn) / dDecoded) : null;
    const budget = this.frameBudget();
    if (this.scale <= 2 || now - this.builtAt < OVERLOAD_AFTER_MS || !overloaded({ drawn, gpuMs: gpu, budgetMs: budget })) return;
    this.loadCap = stepDownTo(this.scale, this.measured, budget, this.costOf());
    // Rebuilt after this frame finishes, not inside it.
    window.setTimeout(() => { if (this.renderer === r) { this.teardown(); this.sync(); } }, 0);
  }

  /** Time per source frame at the current playback speed; null while the frame rate is unknown. */
  private frameBudget(): number | null {
    return this.sourceFps ? 1000 / (this.sourceFps * (this.video.playbackRate || 1)) : null;
  }

  /** Relative GPU cost of this video's chain at a scale (chain.ts chainCost, once gpu.js is loaded). */
  private costOf(): CostOf {
    const gpu = loadedGpu;
    if (!gpu) return pixelCost;
    const { w, h } = uploadSize(this.video);
    return (scale) => gpu.chainCost(this.settings, w, h, scale);
  }

  /** The scale to run: the wanted one, held down by the GPU-load cap (load-cap.ts). */
  private wantedScale(): number {
    // Judged against the scale running now (or last run): only a step up is predicted.
    return allowedScale(this.rawScale(), this.scale, this.measured, this.frameBudget(), this.loadCap, this.costOf());
  }

  /** Manual 2x-8x, or in auto 4x (a second x2 pass) only when the picture is drawn at more than 2x the source in device pixels. */
  private rawScale(): number {
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
    const host = this.lowered;
    const misplaced = host
      ? c.parentElement !== host || host.firstElementChild !== c || !host.contains(v)
      : c.previousElementSibling !== v;
    if (misplaced) { this.mountCanvas(c); return; }
    const box = host ?? parent; // the canvas's containing block
    const vr = v.getBoundingClientRect();
    const pr = box.getBoundingClientRect();
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
    if (!host && pageLevel(parent) && getComputedStyle(parent).position === 'static') {
      // No positioned parent (see mountCanvas): the canvas is placed in page coordinates.
      c.style.left = `${vr.left + window.scrollX + boxL + ox}px`;
      c.style.top = `${vr.top + window.scrollY + boxT + oy}px`;
    } else {
      // An absolutely positioned child is placed from its container's padding box and scrolls with it.
      c.style.left = `${vr.left - pr.left - box.clientLeft + box.scrollLeft + boxL + ox}px`;
      c.style.top = `${vr.top - pr.top - box.clientTop + box.scrollTop + boxT + oy}px`;
    }
    c.style.width = `${pw}px`;
    c.style.height = `${ph}px`;
    // object-fit: cover (or none) paints past the content box; clip the canvas to it like the video.
    // inset() order: top right bottom left.
    const clip = [-oy, ox + pw - bw, oy + ph - bh, -ox].map((n) => Math.max(0, n));
    c.style.clipPath = clip.some((n) => n > 0) ? `inset(${clip.map((n) => `${n}px`).join(' ')})` : '';
    // Same stacking level as the video: the canvas sits right after it in the DOM, so it paints over
    // the video but under anything the player draws on top (controls, menus, subtitles).
    const z = cs.zIndex;
    c.style.zIndex = !host && z && z !== 'auto' ? z : '';
    // Once a second while drawing: if the player's own overlays end up under the canvas, move it to
    // the start of the player's positioned container (see coversOverlay).
    const now = performance.now();
    if (!host && !c.hidden && now - this.lastStackCheck > STACK_CHECK_MS) {
      this.lastStackCheck = now;
      const container = positionedAncestor(v);
      if (container && this.coversOverlay(c)) { this.lowered = container; this.mountCanvas(c); return; }
    }
    this.paintCues(); // follow size and position changes
  }
}

/**
 * Where a cue asks to be drawn, from its WebVTT settings (line, position, size, align), as styles
 * for an absolutely placed box in the picture area. Null means "use the default": bottom centre.
 * Settings that would put the text off the picture, or that we don't draw (vertical text), fall
 * back to the default rather than being followed.
 */
function cuePlacement(cue: TextTrackCue): Partial<CSSStyleDeclaration> | null {
  if (typeof VTTCue === 'undefined' || !(cue instanceof VTTCue) || cue.vertical) return null;
  const { line } = cue;
  if (line === 'auto' && cue.position === 'auto' && cue.size >= 100 && cue.align === 'center') return null;
  const s: Partial<CSSStyleDeclaration> = {};
  // Vertical: a line number counts text rows from the top (0, 1, …) or bottom (-1, -2, …);
  // a percentage is a point on the picture's height.
  if (line === 'auto') {
    s.bottom = `${CUE_EDGE_PCT}%`;
  } else if (cue.snapToLines) {
    if (Math.abs(line) > CUE_MAX_LINES) return null;
    if (line >= 0) s.top = `calc(${line * CUE_LINE_HEIGHT}em + ${CUE_EDGE_PCT}%)`;
    else s.bottom = `calc(${(-line - 1) * CUE_LINE_HEIGHT}em + ${CUE_EDGE_PCT}%)`;
  } else {
    if (line < 0 || line > 100) return null;
    if (cue.lineAlign === 'end') s.bottom = `${100 - line}%`;
    else {
      s.top = `${line}%`;
      if (cue.lineAlign === 'center') s.transform = 'translateY(-50%)';
    }
  }
  // Horizontal: a box `size`% wide, anchored at `position`% by positionAlign; text aligned by align.
  const align = cue.align === 'left' || cue.align === 'start' ? 'start' : cue.align === 'right' || cue.align === 'end' ? 'end' : 'center';
  const size = Math.min(100, Math.max(CUE_MIN_SIZE_PCT, cue.size)); // too narrow: widen instead of one word per row
  let pos = cue.position === 'auto' ? { start: 0, center: 50, end: 100 }[align] : cue.position;
  if (pos < 0 || pos > 100) pos = 50;
  // Chrome's VTTCue has no positionAlign/lineAlign properties at all: treat missing as 'auto'/'start'.
  const anchor = !cue.positionAlign || cue.positionAlign === 'auto'
    ? { start: 'line-left', center: 'center', end: 'line-right' }[align]
    : cue.positionAlign;
  const left = anchor === 'line-left' ? pos : anchor === 'line-right' ? pos - size : pos - size / 2;
  s.left = `${Math.min(100 - size, Math.max(0, left))}%`;
  s.width = `${size}%`;
  s.textAlign = { start: 'left', center: 'center', end: 'right' }[align];
  return s;
}

// --- the page's own ::cue styles, applied to our subtitle copy --------------
// Only the properties browsers let ::cue change (CSS Pseudo-Elements, WebVTT spec), so the copy
// looks the way the browser would have drawn it with the page's styles.
const CUE_PROPS = /^(color|opacity|visibility|text-decoration(-.+)?|text-shadow|background(-.+)?|outline(-.+)?|font(-.+)?|line-height|white-space|text-combine-upright|ruby-position)$/;
const CUE_RULES_MS = 2000; // re-read the page's stylesheets at most this often
interface CueRule { prefix: string; inner: string | null; decls: [string, string, string][] }
let cueRules: { at: number; root: Document | ShadowRoot; rules: CueRule[] } | null = null;

/** Split a selector list on top-level commas (not the ones inside ::cue(a, b) or :is(...)). */
function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out.map((s) => s.trim());
}

function readCueRules(root: Document | ShadowRoot): CueRule[] {
  const rules: CueRule[] = [];
  const walk = (list: CSSRuleList) => {
    for (const r of list) {
      if (r instanceof CSSMediaRule && !matchMedia(r.media.mediaText).matches) continue;
      if (r instanceof CSSStyleRule && r.selectorText.includes('::cue')) {
        const decls: [string, string, string][] = [];
        for (const name of r.style) {
          if (CUE_PROPS.test(name)) decls.push([name, r.style.getPropertyValue(name), r.style.getPropertyPriority(name)]);
        }
        if (!decls.length) continue;
        for (const sel of splitSelectors(r.selectorText)) {
          const m = sel.match(/^(.*?)::cue(?:\((.*)\))?$/);
          if (m) rules.push({ prefix: m[1].trim(), inner: m[2]?.trim() || null, decls });
        }
      } else if ('cssRules' in r && (r as CSSGroupingRule).cssRules) {
        walk((r as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of [...root.styleSheets, ...(root.adoptedStyleSheets ?? [])]) {
    try { walk(sheet.cssRules); } catch { /* cross-origin sheet: unreadable, as for any page script */ }
  }
  return rules;
}

/** Style one cue's text (and its <i>, <b>, <c.class> parts) with the page's ::cue rules. */
function applyCueRules(text: HTMLElement, video: HTMLVideoElement) {
  const root = video.getRootNode() as Document | ShadowRoot;
  const now = performance.now();
  if (!cueRules || cueRules.root !== root || now - cueRules.at > CUE_RULES_MS) cueRules = { at: now, root, rules: readCueRules(root) };
  if (!cueRules.rules.length) return;
  // Normal declarations first, then !important ones, each in stylesheet order: later rules win,
  // !important beats normal, as in the cascade.
  for (const important of [false, true]) {
    for (const rule of cueRules.rules) {
      try {
        if (rule.prefix && !video.matches(rule.prefix)) continue;
        const targets = rule.inner ? [...text.querySelectorAll<HTMLElement>(rule.inner)] : [text];
        for (const el of targets) {
          for (const [name, value, prio] of rule.decls) if ((prio === 'important') === important) el.style.setProperty(name, value);
        }
      } catch { /* a selector the browser can't match from here (e.g. VTT-only syntax): skip it */ }
    }
  }
}

/** Painted at all: not display:none or visibility:hidden, and not faded out (opacity along the ancestors). */
function isShown(el: Element): boolean {
  let opacity = 1;
  for (let n: Element | null = el; n; n = n.parentElement) {
    const s = getComputedStyle(n);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    opacity *= Number(s.opacity);
    if (opacity < 0.1) return false;
  }
  return true;
}

/** Nearest positioned ancestor below <body>, or null. */
function positionedAncestor(el: Element): Element | null {
  for (let p = el.parentElement; p && !pageLevel(p); p = p.parentElement) {
    if (getComputedStyle(p).position !== 'static') return p;
  }
  return null;
}

/**
 * <body>/<html> are never made position: relative. Firefox's page for a bare video file centers the
 * video absolutely inside a zero-height <body>, so a relative <body> would collapse it to 0x0.
 */
function pageLevel(el: Element): boolean {
  return el === document.body || el === document.documentElement;
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

// --- watch counting for the rating card -----------------------------------------
// Totals since the last report; sent to the background about once a minute and on page hide.
const watchReport = { seconds: 0, episodes: 0 };
const WATCH_REPORT_MS = 60000;
let watchTimer: number | null = null;

function reportWatch() {
  if (watchReport.seconds < 1 && !watchReport.episodes) return;
  const msg: Message = { type: 'a4k-watch', seconds: watchReport.seconds, episodes: watchReport.episodes };
  watchReport.seconds = 0;
  watchReport.episodes = 0;
  // A failed send puts the numbers back for the next report.
  const restore = () => { watchReport.seconds += msg.seconds; watchReport.episodes += msg.episodes; };
  try {
    if (contextAlive()) chrome.runtime.sendMessage(msg).catch(restore);
  } catch { /* context gone: nothing left to report to */ }
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
  if (watchTimer !== null) window.clearInterval(watchTimer);
  if (suggestTimer !== null) window.clearInterval(suggestTimer);
  document.removeEventListener('visibilitychange', checkSuggestion);
  window.removeEventListener('pageshow', onPageShow);
  window.removeEventListener('pagehide', reportWatch);
  for (const u of upscalers.values()) u.destroy();
  upscalers.clear();
  menu.mount(null);
  manga?.stop();
}

/** Manga mode (local prototype, Chrome build only). */
let manga: MangaMode | null = null;

// --- mode suggestion (Chrome build only) -----------------------------------------
// The background badges the toolbar icon while the mode leaves this frame's content alone: a
// manga reader in mode 'anime', a video in mode 'manga'. In mode 'anime' this is the only manga
// work done: the page is measured (detection), nothing is fetched, drawn or changed.
const SUGGEST_FIRST_MS = 1000;
const SUGGEST_MS = 5000;
let suggestTimer: number | null = null;
let suggested: Suggest | 'reader' | null = null;

function checkSuggestion() {
  if (stopped || !settings) return;
  let kind: Suggest | 'reader' | null = null;
  if (settings.mode === 'anime') {
    if (document.hidden) return; // measured again when the tab is shown
    if (manga?.isReader()) kind = 'manga';
  } else if (settings.mode === 'manga') {
    // A reader is what mode 'manga' is for. It is reported too: the popup offers anime mode only
    // when no frame of the tab has a reader, and the badge must follow the same rule.
    if (manga?.isReader()) kind = 'reader';
    else if (upscalers.size) kind = 'anime';
  }
  if (kind === suggested) return;
  suggested = kind;
  try {
    if (contextAlive()) chrome.runtime.sendMessage({ type: 'a4k-suggest', kind } satisfies Message).catch(() => {});
  } catch { /* context gone: the next scan shuts this copy down */ }
}
/**
 * The page removed an iframe: its script is gone without a word and no navigation event reports
 * it, so the background is told to forget the frames that no longer exist.
 */
function onMutations(records: MutationRecord[]) {
  queueScan();
  if (__FIREFOX__) return;
  const frameGone = records.some((r) => [...r.removedNodes].some((n) => n instanceof Element && (n.matches('iframe, frame') || !!n.querySelector('iframe, frame'))));
  if (!frameGone) return;
  try {
    if (contextAlive()) chrome.runtime.sendMessage({ type: 'a4k-frames-gone' } satisfies Message).catch(() => {});
  } catch { /* context gone: the next scan shuts this copy down */ }
}
/** A page restored from the back/forward cache: the background forgot it when the tab navigated. */
function onPageShow(e: PageTransitionEvent) {
  if (!e.persisted) return;
  suggested = null;
  checkSuggestion();
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
// Not offered in mode 'manga': its switch and presets would do nothing to a video there.
function syncMenu() {
  if (stopped) return;
  const videosOff = !__FIREFOX__ && settings?.mode === 'manga';
  menu.mount(videosOff ? null : fullscreenTarget()?.container ?? null);
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, respond) => {
  if (stopped) return false; // a stopped copy must not answer for the live one
  if (msg?.type === 'a4k-list') { respond(list()); return true; }
  if (msg?.type === 'a4k-page-meta') {
    // Only the top document knows the page title / JSON-LD; iframes answer null.
    try { respond(window.top === window ? collectPageMeta() : null); } catch { respond(null); }
    return true;
  }
  if (msg?.type === 'a4k-manga-status') { respond(manga?.status() ?? null); return true; }
  if (msg?.type === 'a4k-manga-goto') { manga?.goto(msg.index); return false; }
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
  onSettingsChanged((s) => { if (stopped) return; settings = s; for (const u of upscalers.values()) u.configure(s); manga?.refresh(); syncMenu(); notify(); if (!__FIREFOX__) checkSuggestion(); });
  if (!__FIREFOX__) {
    manga = startManga(() => settings, loadGpu);
    window.setTimeout(checkSuggestion, SUGGEST_FIRST_MS);
    suggestTimer = window.setInterval(checkSuggestion, SUGGEST_MS);
    document.addEventListener('visibilitychange', checkSuggestion);
    window.addEventListener('pageshow', onPageShow);
  }
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
  observer = new MutationObserver(onMutations);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scan();
  // Videos that become visible later (lazy players) are picked up by periodic rescans.
  scanTimer = window.setInterval(queueScan, 2000);
  watchTimer = window.setInterval(reportWatch, WATCH_REPORT_MS);
  window.addEventListener('pagehide', reportWatch);
  })();
}

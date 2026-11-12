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
import { EPISODE_SECONDS } from './rate-prompt';

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
const STACK_CHECK_MS = 1000; // how often to check that the player's overlays still paint over the canvas
// Redrawn subtitles (paintCues): the browser's default caption size is about 2.8% of the picture
// height per text row (Chrome, 1080p fullscreen: rows 37 px apart).
const CUE_FONT_SHARE = 0.0275;
const CUE_LINE_HEIGHT = 1.25; // em per text row
const CUE_MIN_PX = 12;
const CUE_EDGE_PCT = 4; // gap between the picture edge and the first/last row
const CUE_MAX_LINES = 12; // a line setting further out than this would land off the picture
const CUE_MIN_SIZE_PCT = 20;

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
      if (!__FIREFOX__) this.countWatch();
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
            ? v.requestVideoFrameCallback((_now, meta) => { this.frameHandle = null; this.noteSourceFrame(meta.presentedFrames); this.frame(); })
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
    const tick = (_now: number, meta: VideoFrameCallbackMetadata) => {
      this.fpsProbe = null;
      if (this.enabled) return;
      this.noteSourceFrame(meta.presentedFrames);
      if (!this.video.paused && !this.video.ended) this.fpsProbe = this.video.requestVideoFrameCallback(tick);
    };
    this.fpsProbe = this.video.requestVideoFrameCallback(tick);
  }

  private stopProbe() {
    if (this.fpsProbe !== null) { this.video.cancelVideoFrameCallback(this.fpsProbe); this.fpsProbe = null; }
  }

  /** `frames`: any counter that rises by one per source frame (rVFC presentedFrames, decoded frames). */
  private noteSourceFrame(frames: number) {
    const now = performance.now();
    this.vfcSamples.push({ t: now, presented: frames });
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
      const now = decoded();
      if (now === last) { this.frameHandle = requestAnimationFrame(tick); return; }
      this.frameHandle = null;
      this.noteSourceFrame(now);
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
      const at = cuePlacement(cue);
      if (at) { Object.assign(el.style, at); placed.push(el); } else stack.append(el);
    }
    box.replaceChildren(stack, ...placed);
    box.hidden = false;
  }

  /**
   * True when something the page draws over the video (controls, menus, subtitles) ends up under the
   * canvas. Right after the video is the right place for almost every player, but a player that puts
   * its controls before an unpositioned <video> would have them painted under the canvas. Checked by
   * hit-testing a grid over the picture with and without the canvas.
   */
  private coversOverlay(c: HTMLCanvasElement): boolean {
    const v = this.video;
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

// --- watch counting for the rating card (Chrome only) -------------------------------
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
  window.removeEventListener('pagehide', reportWatch);
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
  if (!__FIREFOX__) {
    watchTimer = window.setInterval(reportWatch, WATCH_REPORT_MS);
    window.addEventListener('pagehide', reportWatch);
  }
  })();
}

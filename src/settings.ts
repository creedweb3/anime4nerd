import type { RateAction } from './rate-prompt';

export type Preset = 'A' | 'B' | 'C' | 'AA' | 'BB' | 'CA';

/** 'auto' picks 4x only when the video is drawn at more than 2x its source size. */
export type Upscale = 'auto' | '2x' | '4x' | '8x';
const UPSCALES: Upscale[] = ['auto', '2x', '4x', '8x'];

/** The factor a manual choice asks for; null for auto. */
export function requestedScale(u: Upscale): number | null {
  return u === 'auto' ? null : parseInt(u, 10);
}

export type FrameVerdict = 'ok' | 'warn' | 'bad';
export const VERDICT_TEXT: Record<FrameVerdict, string> = { ok: 'keeping up', warn: 'near limit', bad: 'dropping frames' };

/**
 * Verdict without GPU timing (Firefox), from frames drawn vs the video's own frame rate:
 * 'ok' at 97% or more, 'warn' from 90%, else 'bad'. null while the video's frame rate is unknown.
 */
export function frameVerdict(renderedFps: number, sourceFps: number | null): FrameVerdict | null {
  if (!sourceFps) return null;
  const kept = renderedFps / sourceFps;
  return kept >= 0.97 ? 'ok' : kept >= 0.9 ? 'warn' : 'bad';
}

/**
 * " · 8× capped: GPU load" when the renderer ran below the manual choice because the GPU could not
 * keep up (load-cap.ts), " · 8× capped: GPU limit" when the output did not fit its texture limit, else ''.
 */
export function capNote(u: Upscale, actualScale: number, byLoad = false): string {
  const want = requestedScale(u);
  return want !== null && actualScale < want ? ` · ${want}× capped: ${byLoad ? 'GPU load' : 'GPU limit'}` : '';
}

/**
 * What the extension works on: 'auto' is videos and detected manga readers, 'anime' is videos
 * only, 'manga' is manga readers only. The Firefox build has no manga mode and reads it as 'auto'.
 */
export type Mode = 'auto' | 'anime' | 'manga';
/**
 * The mode a suggestion offers (Chrome build): the mode leaves this page's content alone (mode
 * 'anime' on a manga reader, mode 'manga' on a page with a video), so the popup offers to switch
 * and the toolbar icon gets a small per-tab badge.
 */
export type Suggest = 'manga' | 'anime';
export const MODES: Mode[] = ['auto', 'anime', 'manga'];

/** Global rendering settings (apply to every enabled source). */
export interface Settings {
  mode: Mode;
  preset: Preset;
  darkenLines: boolean;
  thinLines: boolean;
  upscale: Upscale;
}

/** Everything that changes the shader chain; a renderer is rebuilt when this changes. */
export function chainKey(s: Settings): string {
  return `${s.preset}|${s.darkenLines}|${s.thinLines}`;
}

export const PRESETS: { value: Preset; label: string; description: string }[] = [
  { value: 'A', label: 'Mode A', description: 'Most 1080p' },
  { value: 'B', label: 'Mode B', description: 'Soft restore' },
  { value: 'C', label: 'Mode C', description: 'Denoise' },
  { value: 'AA', label: 'A+A', description: 'Stronger restore' },
  { value: 'BB', label: 'B+B', description: 'Double soft' },
  { value: 'CA', label: 'C+A', description: 'Denoise+A' },
];

const SETTINGS_KEY = 'anime4k';
const SOURCES_KEY = 'anime4k-sources';

export function normalize(raw: unknown): Settings {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  return {
    mode: MODES.includes(t.mode as Mode) ? (t.mode as Mode) : 'auto',
    preset: PRESETS.some((p) => p.value === t.preset) ? (t.preset as Preset) : 'A',
    darkenLines: t.darkenLines === true,
    thinLines: t.thinLines === true,
    // 16x and 32x were removed (impractical): an old choice of either becomes the largest left.
    upscale: UPSCALES.includes(t.upscale as Upscale) ? (t.upscale as Upscale) : ['16x', '32x'].includes(t.upscale as string) ? '8x' : 'auto',
  };
}

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalize(r[SETTINGS_KEY]);
}

let settingsChain: Promise<unknown> = Promise.resolve();

/**
 * Apply a patch (or a function of the current settings, for toggles) on top of the
 * stored settings. Writes are queued so two quick clicks can't both read the same
 * old value and drop each other's change.
 */
export function saveSettings(patch: Partial<Settings> | ((cur: Settings) => Partial<Settings>)): Promise<Settings> {
  const run = settingsChain.then(async () => {
    const cur = await loadSettings();
    const next = normalize({ ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) });
    await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
    return next;
  });
  settingsChain = run.catch(() => {});
  return run;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes[SETTINGS_KEY]) cb(normalize(changes[SETTINGS_KEY].newValue));
  });
}

// --- per-source on/off --------------------------------------------------------
// A "source" is identified by the page (frame) host plus the host the media is
// streamed from. That survives quality switches and episode changes on the same
// site, so turning a site's player on once keeps it on.
export type Sources = Record<string, boolean>;

export function sourceKey(frameHost: string, mediaUrl: string): string {
  let mediaHost = 'same-origin';
  if (/^(data|blob|mediastream):/i.test(mediaUrl)) return `${frameHost}::${mediaUrl.slice(0, mediaUrl.indexOf(':') + 1)}`;
  try {
    const u = new URL(mediaUrl.slice(0, 2048));
    mediaHost = u.protocol === 'blob:' || u.protocol === 'data:' || u.protocol === 'mediastream:'
      ? `${u.protocol}` : u.host;
  } catch { /* relative or empty url */ }
  return `${frameHost}::${mediaHost}`;
}

export async function loadSources(): Promise<Sources> {
  const r = await chrome.storage.local.get(SOURCES_KEY);
  const v = r[SOURCES_KEY];
  return v && typeof v === 'object' ? (v as Sources) : {};
}

let sourcesCache: Sources | null = null;
let writeChain: Promise<void> = Promise.resolve();

/** Toggle one source. Writes are queued so rapid flips apply in order and the last one wins. */
export function setSource(key: string, enabled: boolean): Promise<void> {
  writeChain = writeChain.then(async () => {
    sourcesCache ??= await loadSources();
    if (enabled) sourcesCache[key] = true; else delete sourcesCache[key];
    await chrome.storage.local.set({ [SOURCES_KEY]: { ...sourcesCache } });
  }).catch(() => {});
  return writeChain;
}

export function onSourcesChanged(cb: (s: Sources) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SOURCES_KEY]) {
      sourcesCache = { ...((changes[SOURCES_KEY].newValue as Sources) ?? {}) };
      cb(sourcesCache);
    }
  });
}

// --- popup <-> content messages -------------------------------------------------
export type Status = 'Off' | 'Unavailable' | 'Waiting' | 'Loading' | 'Active' | 'Suspended';

export interface VideoInfo {
  id: string; // unique within the frame
  key: string; // source key (see sourceKey)
  frameHost: string;
  mediaHost: string;
  width: number; // videoWidth
  height: number;
  playing: boolean;
  sourceFps: number | null; // measured from requestVideoFrameCallback, also while off
  enabled: boolean;
  status: Status;
  message: string;
  loadCapped?: boolean; // running below the wanted scale because the GPU could not keep up (load-cap.ts)
  stats: {
    gpuMs: number | null; samples: number[]; cpuMs: number; fps: number; passes: number;
    textureBytes: number; outputWidth: number; outputHeight: number; timerSupported: boolean;
    sourceFps: number | null; // the video's own frame rate, from requestVideoFrameCallback metadata
  } | null;
  /** Media Session metadata set by the player in this video's frame, if any. */
  media: { title: string | null; artist: string | null; album: string | null } | null;
}

export type Message =
  | { type: 'a4k-list' }
  | { type: 'a4k-page-meta' }
  | { type: 'a4k-highlight'; id: string | null }
  | { type: 'a4k-changed' }
  // content -> background: upscaled time and finished episodes since the last report (rate-prompt.ts)
  | { type: 'a4k-watch'; seconds: number; episodes: number }
  // popup -> background: answer to the rating card
  | { type: 'a4k-rate'; action: RateAction; level: number }
  // content -> background (manga mode): fetch an image the page will not let us read
  | { type: 'a4k-fetch-image'; url: string }
  // content -> background: this frame has a manga reader in mode 'anime' ('manga'), a video in
  // mode 'manga' ('anime'), a reader in mode 'manga' ('reader': the mode fits the tab, so a video
  // in another frame is not offered), or none of these any more (null); see Suggest
  | { type: 'a4k-suggest'; kind: Suggest | 'reader' | null }
  | { type: 'a4k-frames-gone' }
  // popup -> content (manga mode): pages found / upscaled / failed in this frame
  | { type: 'a4k-manga-status' }
  // popup -> content (manga mode): scroll the reader to a page, counted from 0
  | { type: 'a4k-manga-goto'; index: number };

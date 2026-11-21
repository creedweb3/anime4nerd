// Color controls: the ten values, their ranges, the built-in profiles, and the stored state
// (chrome.storage.local). Used by the popup (sliders, profiles), the content script (what to
// apply) and the renderer (gpu.ts turns the values into shader uniforms).
//
// Values are kept in VLC's own units where VLC has the control (Video Effects > Essential:
// hue, brightness, contrast, saturation, gamma, film grain); vibrance, temperature, tint and
// deband are our own. The color math itself is in the present shader in gpu.ts.

export const COLOR_KEYS = [
  'hue', 'brightness', 'contrast', 'saturation', 'gamma',
  'vibrance', 'temperature', 'tint', 'deband', 'grain',
] as const;
export type ColorKey = typeof COLOR_KEYS[number];
export type ColorValues = Record<ColorKey, number>;

/** Allowed range of each value. */
export const COLOR_RANGE: Record<ColorKey, readonly [number, number]> = {
  hue: [-180, 180], // degrees
  brightness: [0, 2], // VLC: luma offset brightness - 1
  contrast: [0, 2], // VLC: gain around mid-grey
  saturation: [0, 3], // VLC
  gamma: [0.01, 10], // VLC: out = in ^ (1 / gamma)
  vibrance: [0, 2], // saturation that spares already-colorful pixels
  temperature: [-100, 100], // cool .. warm
  tint: [-100, 100], // green .. magenta
  deband: [0, 100], // strength; equal to mpv's deband-threshold
  grain: [0, 10], // VLC film-grain variance
};

/** One step of each value: slider keys, the wheel and stored values all use it. */
export const COLOR_UNIT: Record<ColorKey, number> = {
  hue: 1, brightness: 0.01, contrast: 0.01, saturation: 0.01, gamma: 0.01,
  vibrance: 0.01, temperature: 1, tint: 1, deband: 1, grain: 0.01,
};

export const NEUTRAL_COLOR: ColorValues = {
  hue: 0, brightness: 1, contrast: 1, saturation: 1, gamma: 1,
  vibrance: 1, temperature: 0, tint: 0, deband: 0, grain: 0,
};

/** Rounds to the value's step and clamps to its range; anything not a number becomes neutral. */
export function snapColor(k: ColorKey, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return NEUTRAL_COLOR[k];
  const [lo, hi] = COLOR_RANGE[k];
  const unit = COLOR_UNIT[k];
  const n = Math.round(Math.min(hi, Math.max(lo, v)) / unit) * unit;
  return Number(n.toFixed(2)); // 0.98, not 0.9800000000000001
}

/** All ten values, each snapped; missing ones neutral. */
export function normalizeValues(raw: unknown): ColorValues {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<ColorKey, unknown>>;
  return Object.fromEntries(COLOR_KEYS.map((k) => [k, snapColor(k, t[k])])) as ColorValues;
}

export const isNeutral = (v: ColorValues): boolean => COLOR_KEYS.every((k) => v[k] === NEUTRAL_COLOR[k]);
export const sameValues = (a: ColorValues, b: ColorValues): boolean => COLOR_KEYS.every((k) => a[k] === b[k]);

// --- slider positions --------------------------------------------------------
// A slider position t runs -1..1 with 0 at neutral (0..1 for deband and grain). The mapping
// is piecewise so neutral sits in the middle of every slider whatever its range.

export const UNIPOLAR: ReadonlySet<ColorKey> = new Set(['deband', 'grain']);

export function toValue(k: ColorKey, t: number): number {
  switch (k) {
    case 'hue': return t * 180;
    case 'brightness': case 'contrast': case 'vibrance': return 1 + t;
    case 'saturation': return t < 0 ? 1 + t : 1 + 2 * t;
    case 'gamma': return t < 0 ? 10 ** (2 * t) : 10 ** t;
    case 'temperature': case 'tint': case 'deband': return 100 * t;
    case 'grain': return 10 * t;
  }
}

export function toPosition(k: ColorKey, v: number): number {
  switch (k) {
    case 'hue': return v / 180;
    case 'brightness': case 'contrast': case 'vibrance': return v - 1;
    case 'saturation': return v < 1 ? v - 1 : (v - 1) / 2;
    case 'gamma': return v < 1 ? Math.log10(v) / 2 : Math.log10(v);
    case 'temperature': case 'tint': case 'deband': return v / 100;
    case 'grain': return v / 10;
  }
}

/**
 * The number next to a slider. Brightness, contrast, saturation and vibrance as a percent of
 * the original (VLC's 1.25 is 125%); hue in signed degrees; gamma as VLC writes it; temperature
 * and tint signed; deband and grain "off" at zero.
 */
export function formatColor(k: ColorKey, v: number): string {
  const signed = (n: number, unit = '') => (n > 0 ? `+${n}${unit}` : n < 0 ? `−${-n}${unit}` : `0${unit}`);
  switch (k) {
    case 'hue': return signed(Math.round(v), '°');
    case 'brightness': case 'contrast': case 'saturation': case 'vibrance': return `${Math.round(v * 100)}%`;
    case 'gamma': return v.toFixed(2);
    case 'temperature': case 'tint': return signed(Math.round(v));
    case 'deband': return v < 0.5 ? 'off' : String(Math.round(v));
    case 'grain': return v < 0.005 ? 'off' : v.toFixed(2);
  }
}

/** The four values typed and shown as a percent. */
export const PERCENT_KEYS: ReadonlySet<ColorKey> = new Set(['brightness', 'contrast', 'saturation', 'vibrance']);

// --- profiles ----------------------------------------------------------------

export interface ColorProfile {
  id: string;
  name: string;
  v: ColorValues;
  builtIn?: boolean; // "neutral" only: cannot be renamed, changed or deleted
}

export const PROFILE_NAME_MAX = 14;
/**
 * Saved profiles kept at most, "neutral" included: few enough that the popup's two-column list
 * fits under the color tab without scrolling. At the limit the popup shows "16 max" instead of "save new".
 */
export const MAX_PROFILES = 16;

/*
 * The included profiles (2026-11-19). Each takes the color grade of a published ReShade preset
 * for anime-style games, converted to these controls from the shaders' source, plus deband and
 * grain from the Kokomins mpv anime guide ("2:35:20:5 ... recommended for general use"):
 *   slice of life: Genshin Stella Mod's shipped default preset (+ contrast/gamma for stream softness)
 *   sunlit:        "Immersive Anime - Day" (Genshin, qUINT Lightroom stage)
 *   shonen:        "Sakurabane" (PSO2 GShade)
 *   moody:         "Filmic Fantasy Day" (Genshin)
 *   vintage:       ReShade Technicolor2 at its defaults
 */
export const BUILT_IN_PROFILES: readonly ColorProfile[] = [
  { id: 'neutral', name: 'neutral', v: { ...NEUTRAL_COLOR }, builtIn: true },
  { id: 'p-slice', name: 'slice of life', v: normalizeValues({ contrast: 1.03, saturation: 1.02, gamma: 1.02, vibrance: 1.29, temperature: 4, deband: 35, grain: 0.01 }) },
  { id: 'p-sunlit', name: 'sunlit', v: normalizeValues({ brightness: 0.97, contrast: 0.92, saturation: 1.03, gamma: 1.04, vibrance: 1.25, temperature: 14, deband: 35, grain: 0.01 }) },
  { id: 'p-shonen', name: 'shonen', v: normalizeValues({ brightness: 0.99, contrast: 1.03, saturation: 1.23, gamma: 1.14, vibrance: 1.57, deband: 35, grain: 0.01 }) },
  { id: 'p-moody', name: 'moody', v: normalizeValues({ brightness: 0.98, contrast: 0.92, saturation: 0.74, gamma: 1.1, vibrance: 1.07, temperature: -12, tint: 11, deband: 20, grain: 0.04 }) },
  { id: 'p-vintage', name: 'vintage', v: normalizeValues({ saturation: 1.45, gamma: 1.22, temperature: -5, tint: 5, deband: 25 }) },
];

// --- stored state --------------------------------------------------------------

/**
 * on:       colors on/off (the switch in the color head); off means no colors anywhere.
 * always:   also use colors on videos that are not upscaled.
 * values:   what is applied now.
 * profile:  the selected profile's id, or 'custom' (unsaved values started from neutral).
 * profiles: saved profiles, "neutral" first.
 * custom:   the values of "custom".
 */
export interface ColorState {
  on: boolean;
  always: boolean;
  values: ColorValues;
  profile: string;
  profiles: ColorProfile[];
  custom: ColorValues;
}

// Built from a string, not a regex literal: esbuild writes a literal's characters raw, and the
// bundle should stay plain ASCII for any loader.
const INVISIBLE = new RegExp('[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]', 'g');

/** A profile name as stored: trimmed, one line, at most PROFILE_NAME_MAX characters. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(INVISIBLE, '') // zero-width and bidi controls: a name must read as it is
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, PROFILE_NAME_MAX);
}

/** Storage is user data: anything malformed falls back to defaults rather than breaking the popup. */
export function normalizeColor(raw: unknown): ColorState {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof ColorState, unknown>>;
  const seen = new Set<string>(['neutral']);
  const profiles: ColorProfile[] = [{ ...BUILT_IN_PROFILES[0], v: { ...NEUTRAL_COLOR } }];
  if (Array.isArray(t.profiles)) {
    for (const p of t.profiles as unknown[]) {
      if (profiles.length >= MAX_PROFILES) break;
      const q = (p && typeof p === 'object' ? p : {}) as Partial<Record<keyof ColorProfile, unknown>>;
      const id = typeof q.id === 'string' ? q.id.slice(0, 40) : '';
      const name = cleanName(q.name);
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      profiles.push({ id, name, v: normalizeValues(q.v) });
    }
  } else {
    // First run: the included profiles.
    for (const p of BUILT_IN_PROFILES.slice(1)) { seen.add(p.id); profiles.push({ ...p, v: { ...p.v } }); }
  }
  const profile = typeof t.profile === 'string' && (t.profile === 'custom' || seen.has(t.profile)) ? t.profile : 'neutral';
  return {
    on: t.on !== false,
    always: t.always === true,
    values: normalizeValues(t.values),
    profile,
    profiles,
    custom: normalizeValues(t.custom),
  };
}

export const DEFAULT_COLOR: ColorState = normalizeColor(undefined);

/** What the renderer applies: null when colors are off or every value is neutral. */
export function appliedColor(s: ColorState): ColorValues | null {
  return s.on && !isNeutral(s.values) ? s.values : null;
}

const COLOR_STORE_KEY = 'anime4k-color';

export async function loadColor(): Promise<ColorState> {
  const r = await chrome.storage.local.get(COLOR_STORE_KEY);
  return normalizeColor(r[COLOR_STORE_KEY]);
}

let colorChain: Promise<unknown> = Promise.resolve();

/** Applies a patch (or a function of the current state) on top of the stored state; writes are queued. */
export function saveColor(patch: Partial<ColorState> | ((cur: ColorState) => Partial<ColorState>)): Promise<ColorState> {
  const run = colorChain.then(async () => {
    const cur = await loadColor();
    const next = normalizeColor({ ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) });
    await chrome.storage.local.set({ [COLOR_STORE_KEY]: next });
    return next;
  });
  colorChain = run.catch(() => {});
  return run;
}

export function onColorChanged(cb: (s: ColorState) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[COLOR_STORE_KEY]) cb(normalizeColor(changes[COLOR_STORE_KEY].newValue));
  });
}

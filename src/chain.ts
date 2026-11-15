// Backend-neutral shader chains: which mpv shader files an engine runs, loading them, and
// laying the passes out (sizes, reads, shared textures) for a given source. Both renderers,
// WebGL2 (gpu.ts) and WebGPU (gpu-webgpu.ts), build from the same plan.

import clampHighlights from './shaders/Anime4K_Clamp_Highlights.glsl';
import restoreVL from './shaders/Anime4K_Restore_CNN_VL.glsl';
import restoreSoftVL from './shaders/Anime4K_Restore_CNN_Soft_VL.glsl';
import restoreM from './shaders/Anime4K_Restore_CNN_M.glsl';
import restoreSoftM from './shaders/Anime4K_Restore_CNN_Soft_M.glsl';
import upscaleVL from './shaders/Anime4K_Upscale_CNN_x2_VL.glsl';
import upscaleDenoiseVL from './shaders/Anime4K_Upscale_Denoise_CNN_x2_VL.glsl';
import upscaleM from './shaders/Anime4K_Upscale_CNN_x2_M.glsl';
import darkenHQ from './shaders/Anime4K_Darken_HQ.glsl';
import thinHQ from './shaders/Anime4K_Thin_HQ.glsl';
import {
  HookPass, ShaderFile, UserTexture, evalRpn, parseShaderFile,
} from './mpv-hooks';
import {
  Plane, ShaderRef, applyDefines, engineChain,
} from './engines';
import { engineVariant, type Preset, type Settings } from './settings';

export interface RenderStats {
  gpuMs: number | null; // GPU time of the last completed frame; null if timer queries are unsupported
  samples: number[]; // GPU ms of frames completed in the last 2 s, oldest first
  cpuMs: number; // JS time spent issuing the frame
  fps: number; // rendered frames per second (rolling)
  passes: number;
  textureBytes: number; // GPU memory held by this renderer's textures
  outputWidth: number;
  outputHeight: number;
  timerSupported: boolean;
  backend: Backend; // which GPU API is drawing
}

/** GPU API a renderer runs on. */
export type Backend = 'webgl2' | 'webgpu';

export interface Anime4kRenderer {
  /** Draws the source's current frame, or `frame` instead: a still of the same size (manga pages reuse one renderer). */
  render(frame?: RenderSource): void;
  destroy(): void;
  stats(): RenderStats;
}

/** Thrown by render() when the decoded frame size no longer matches the textures; rebuild, don't fail. */
export class SourceSizeChanged extends Error {
  constructor() { super('Source frame size changed.'); this.name = 'SourceSizeChanged'; }
}

/** Largest final output, in pixels (8K UHD); bigger frames risk exhausting GPU memory. */
export const MAX_OUTPUT_PX = 7680 * 4320;

/** The Anime4K shaders bundled into gpu.js, by file name. */
export const ANIME4K_SHADERS: Record<string, string> = {
  'Anime4K_Clamp_Highlights.glsl': clampHighlights,
  'Anime4K_Restore_CNN_VL.glsl': restoreVL,
  'Anime4K_Restore_CNN_Soft_VL.glsl': restoreSoftVL,
  'Anime4K_Restore_CNN_M.glsl': restoreM,
  'Anime4K_Restore_CNN_Soft_M.glsl': restoreSoftM,
  'Anime4K_Upscale_CNN_x2_VL.glsl': upscaleVL,
  'Anime4K_Upscale_Denoise_CNN_x2_VL.glsl': upscaleDenoiseVL,
  'Anime4K_Upscale_CNN_x2_M.glsl': upscaleM,
  'Anime4K_Darken_HQ.glsl': darkenHQ,
  'Anime4K_Thin_HQ.glsl': thinHQ,
};

/** Standard Anime4K mpv preset chains (file names): one x2 step, plus an extra (M) x2 step per doubling beyond 2x. */
export function anime4kFiles(s: Settings, scale: number): string[] {
  const p: Preset = s.preset;
  const files = ['Anime4K_Clamp_Highlights.glsl'];
  if (p === 'A' || p === 'AA') files.push('Anime4K_Restore_CNN_VL.glsl');
  if (p === 'B' || p === 'BB') files.push('Anime4K_Restore_CNN_Soft_VL.glsl');
  files.push(p === 'C' || p === 'CA' ? 'Anime4K_Upscale_Denoise_CNN_x2_VL.glsl' : 'Anime4K_Upscale_CNN_x2_VL.glsl');
  if (p === 'AA' || p === 'CA') files.push('Anime4K_Restore_CNN_M.glsl');
  if (p === 'BB') files.push('Anime4K_Restore_CNN_Soft_M.glsl');
  for (let k = scale; k > 2; k /= 2) files.push('Anime4K_Upscale_CNN_x2_M.glsl');
  if (s.darkenLines) files.push('Anime4K_Darken_HQ.glsl');
  if (s.thinLines) files.push('Anime4K_Thin_HQ.glsl');
  return files;
}

/** GPU memory budget for one renderer's textures; above it the scale halves (never below 2x). */
export const MAX_TEXTURE_BYTES = 2 * 1024 ** 3;

/** The texture name each plane's passes hook. */
export const HOOK_OF: Record<Plane, string> = { rgb: 'MAIN', luma: 'LUMA', ycbcr: 'NATIVE' };

// --- shader files ---------------------------------------------------------------
// Engines other than Anime4K ship as files under shaders/ and are fetched on first use.

let shaderBase: string | null = null;
/** Where shader files are fetched from (the test pages serve them without an extension). */
export function setShaderBase(url: string): void { shaderBase = url; }

const sourceCache = new Map<string, Promise<string>>();
function fetchShader(file: string): Promise<string> {
  let p = sourceCache.get(file);
  if (!p) {
    const url = (shaderBase ?? chrome.runtime.getURL('shaders/')) + file;
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Could not load shader ${file} (${r.status}).`);
      return r.text();
    });
    p.catch(() => sourceCache.delete(file)); // retry on the next build
    sourceCache.set(file, p);
  }
  return p;
}

// --- WGSL (WebGPU) ----------------------------------------------------------------
// The build translates every pass to WGSL (tools/wgsl-gen.ts) and writes one JSON per shader
// file (and #define variant) next to it: an array, in pass order, of { code, textures }.

/** A pass translated to WGSL; `textures` are its bound textures in binding order (3, 4, ...). */
export interface WgslPass { code: string; textures: string[] }

/** File name of a shader's translated passes. */
export function wgslFileName(ref: ShaderRef): string {
  const base = 'inline' in ref
    ? `inline-${ref.name}`
    : ref.file + Object.entries(ref.defines ?? {}).map(([k, v]) => `.${k}-${v}`).join('');
  return `${base.replace(/[^\w.-]+/g, '-')}.wgsl.json`;
}

const wgslOf = new WeakMap<HookPass, WgslPass>();
/** The WGSL of a pass, once loadChain(..., { wgsl: true }) has fetched it. */
export function passWgsl(p: HookPass): WgslPass | undefined { return wgslOf.get(p); }

const wgslCache = new Map<string, Promise<WgslPass[]>>();
function fetchWgsl(name: string): Promise<WgslPass[]> {
  let p = wgslCache.get(name);
  if (!p) {
    p = fetchShader(name).then((t) => JSON.parse(t) as WgslPass[]);
    p.catch(() => wgslCache.delete(name));
    wgslCache.set(name, p);
  }
  return p;
}

/** Attach a file's WGSL to its parsed passes (same order as in the file). */
function attachWgsl(file: ShaderFile, wgsl: WgslPass[], name: string) {
  if (wgsl.length !== file.passes.length) throw new Error(`${name} has ${wgsl.length} WGSL passes for ${file.passes.length} GLSL passes.`);
  file.passes.forEach((p, i) => wgslOf.set(p, wgsl[i]));
}

const parsedCache = new Map<string, ShaderFile>();
function parseCached(key: string, source: () => string): ShaderFile {
  let f = parsedCache.get(key);
  if (!f) { f = parseShaderFile(source()); parsedCache.set(key, f); }
  return f;
}

/** A chain whose files are loaded: give it a scale and it lists the shader files to run. */
export interface LoadedChain {
  plane: Plane;
  files(scale: number): ShaderFile[];
}

/** Loads a chain's shader files; with `wgsl`, also each pass's WGSL translation (WebGPU). */
export async function loadChain(s: Settings, opts: { wgsl?: boolean } = {}): Promise<LoadedChain> {
  if (s.engine === 'anime4k') {
    const parseA4k = (name: string) => parseCached(name, () => ANIME4K_SHADERS[name]);
    if (opts.wgsl) {
      const names = [...new Set(anime4kFiles({ ...s, darkenLines: true, thinLines: true }, 32))];
      await Promise.all(names.map(async (n) => attachWgsl(parseA4k(n), await fetchWgsl(wgslFileName({ file: n })), n)));
    }
    return { plane: 'rgb', files: (scale) => anime4kFiles(s, scale).map(parseA4k) };
  }
  const ec = engineChain(s.engine, engineVariant(s));
  const last = ec.last ?? ec.step;
  const refs = [...ec.pre, ...ec.step, ...last];
  const texts = new Map<string, string>();
  await Promise.all(refs.map(async (r) => { if ('file' in r) texts.set(r.file, await fetchShader(r.file)); }));
  const parseWhole = (r: ShaderRef): ShaderFile => ('inline' in r
    ? parseCached(`inline|${r.name}`, () => r.inline)
    : parseCached(`${r.file}|${JSON.stringify(r.defines ?? {})}`, () => applyDefines(texts.get(r.file)!, r.defines)));
  if (opts.wgsl) {
    await Promise.all(refs.map(async (r) => attachWgsl(parseWhole(r), await fetchWgsl(wgslFileName(r)), wgslFileName(r))));
  }
  const parse = (r: ShaderRef): ShaderFile => {
    const f = parseWhole(r);
    return 'file' in r && r.only ? { ...f, passes: f.passes.filter((p) => p.desc.includes(r.only!)) } : f;
  };
  return {
    plane: ec.plane,
    files: (scale) => {
      const out = ec.pre.map(parse);
      for (let k = scale; k > 2; k /= 2) out.push(...ec.step.map(parse));
      out.push(...last.map(parse));
      return out;
    },
  };
}

/** The chain's hook passes in run order, plus the lookup tables they use. */
export function orderedPasses(chain: LoadedChain, scale: number): { passes: HookPass[]; textures: UserTexture[] } {
  const hook = HOOK_OF[chain.plane];
  const passes: HookPass[] = [];
  const deferred: HookPass[] = []; // PREKERNEL hooks run after all MAIN hooks (as in mpv)
  const textures = new Map<string, UserTexture>();
  for (const file of chain.files(scale)) {
    for (const t of file.textures) textures.set(t.name, t);
    for (const p of file.passes) {
      if (p.compute) throw new Error(`Pass "${p.desc}" needs compute shaders, which WebGL2 lacks.`);
      if (p.hook === hook) passes.push(p);
      else if (p.hook === 'PREKERNEL' && chain.plane === 'rgb') deferred.push(p);
      // other hook points (CHROMA, OUTPUT...) have no texture in this pipeline
    }
  }
  return { passes: [...passes, ...deferred], textures: [...textures.values()] };
}

export type Size = { w: number; h: number };

/** Resolves mpv size references like "MAIN.w", "HOOKED.h" or "OUTPUT.h" for a w x h source at `scale`. */
export function sizeResolver(get: (name: string) => Size | undefined, hook: string, w: number, h: number, scale: number) {
  return (ref: string): number => {
    const [name, dim] = ref.split('.');
    if (name === 'OUTPUT') return dim === 'w' ? w * scale : h * scale;
    const t = get(name === 'HOOKED' ? hook : name);
    if (t) return dim === 'w' ? t.w : t.h;
    if (name === 'NATIVE' || name === 'MAIN' || name === 'LUMA') return dim === 'w' ? w : h;
    throw new Error(`Unknown texture in size expression: ${ref}`);
  };
}

/**
 * A chain laid out for one source size, before any GL object exists: which passes run, the
 * size of every texture they write, and what each pass reads. Texture 0 is the video frame.
 * Both the memory estimate and the real build use it, so they cannot disagree.
 */
export interface PlanStep {
  kind: 'hook' | 'to-plane';
  pass: HookPass | null; // null for the conversion to the plane
  out: number; // texture id written
  inputs: { name: string; ref: number | string }[]; // ref: texture id, or a lookup table's name
}
export interface Plan {
  sizes: Size[]; // by texture id
  steps: PlanStep[];
  final: number; // texture id the present pass reads
  offset: [number, number]; // accumulated //!OFFSET of the final plane, in its pixels
}

export function planChain(passes: HookPass[], lookupNames: ReadonlySet<string>, plane: Plane, w: number, h: number, scale: number): Plan {
  const hook = HOOK_OF[plane];
  const sizes: Size[] = [{ w, h }];
  const steps: PlanStep[] = [];
  const named = new Map<string, number>();
  const add = (s: Size) => { sizes.push(s); return sizes.length - 1; };
  if (plane === 'rgb') named.set(hook, 0);
  else {
    const out = add({ w, h });
    steps.push({ kind: 'to-plane', pass: null, out, inputs: [{ name: 'SRC', ref: 0 }] });
    named.set(hook, out);
  }
  const sizeOf = sizeResolver((n) => { const id = named.get(n); return id === undefined ? undefined : sizes[id]; }, hook, w, h, scale);
  let offset: [number, number] = [0, 0];
  for (const p of passes) {
    if (p.when && evalRpn(p.when, sizeOf) === 0) continue;
    const hooked = sizes[named.get(hook)!];
    const outW = p.width ? Math.round(evalRpn(p.width, sizeOf)) : hooked.w;
    const outH = p.height ? Math.round(evalRpn(p.height, sizeOf)) : hooked.h;
    const bindNames = Array.from(new Set([...p.binds.map((b) => (b === 'HOOKED' ? hook : b)), hook]));
    const inputs = bindNames.map((n) => {
      if (lookupNames.has(n)) return { name: n, ref: n };
      const id = named.get(n);
      if (id === undefined) throw new Error(`Pass "${p.desc}" binds unknown texture ${n}`);
      return { name: n, ref: id };
    });
    const out = add({ w: outW, h: outH });
    steps.push({ kind: 'hook', pass: p, out, inputs });
    const target = p.save ?? hook;
    if (target === hook) {
      offset = [offset[0] * outW / hooked.w, offset[1] * outH / hooked.h];
      if (p.offset) offset = [offset[0] + p.offset[0], offset[1] + p.offset[1]];
    }
    named.set(target, out);
  }
  return { sizes, steps, final: named.get(hook)!, offset };
}

/**
 * Assigns pass outputs to shared textures: a texture is reused, at the same size, once every
 * pass that reads the previous owner has run. Returns the physical slot of every texture id
 * (0 = the video frame, which is never shared) and the slots' sizes.
 */
export function poolTextures(plan: Plan): { slotOf: number[]; slots: Size[] } {
  const lastRead = plan.sizes.map(() => -1);
  plan.steps.forEach((s, i) => { for (const inp of s.inputs) if (typeof inp.ref === 'number') lastRead[inp.ref] = i; });
  lastRead[plan.final] = plan.steps.length; // read by the present pass
  const slotOf = plan.sizes.map(() => -1);
  const slots: Size[] = [{ ...plan.sizes[0] }];
  slotOf[0] = 0;
  const free: number[] = [];
  const live: number[] = []; // texture ids holding a slot
  plan.steps.forEach((s, i) => {
    // Free outputs no later step reads. Inputs of this step have lastRead >= i, so a pass
    // never writes into a texture it samples.
    for (let k = live.length - 1; k >= 0; k--) {
      if (lastRead[live[k]] < i) { free.push(slotOf[live[k]]); live.splice(k, 1); }
    }
    const size = plan.sizes[s.out];
    const reuse = free.findIndex((sl) => slots[sl].w === size.w && slots[sl].h === size.h);
    if (reuse >= 0) { slotOf[s.out] = free[reuse]; free.splice(reuse, 1); } else { slots.push({ ...size }); slotOf[s.out] = slots.length - 1; }
    live.push(s.out);
  });
  return { slotOf, slots };
}

/** Texture bytes a chain will allocate: the video frame (RGBA8) plus the pooled RGBA16F slots. */
export function estimateBytes(passes: HookPass[], lookups: UserTexture[], plane: Plane, w: number, h: number, scale: number): number {
  const plan = planChain(passes, new Set(lookups.map((t) => t.name)), plane, w, h, scale);
  const { slots } = poolTextures(plan);
  return w * h * 4 + slots.slice(1).reduce((n, s) => n + s.w * s.h * 8, 0) + lookups.reduce((n, t) => n + t.data.byteLength, 0);
}

/** A playing video, or a still image (manga pages) that render() uploads the same way. */
export type RenderSource = HTMLVideoElement | ImageBitmap;

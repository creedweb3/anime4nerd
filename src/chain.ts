// Anime4K shader chains: which mpv shader files a mode runs, and laying their passes out
// (sizes, reads, shared textures) for a given source. The renderer (gpu.ts) and its memory
// estimate build from the same plan.

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
import { HookPass, evalRpn, parseHookPasses } from './mpv-hooks';
import type { Preset, Settings } from './settings';

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
  reach: number | null; // source pixels a change spreads over in the output; null = every frame is drawn in full
}

export interface Anime4kRenderer {
  /** Draws the source's current frame, or `frame` instead: a still of the same size (manga pages reuse one renderer). */
  render(frame?: RenderSource): void;
  /** True while the GPU has not finished the last frame; a live video skips a frame rather than queue one. */
  busy(): boolean;
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
const ANIME4K_SHADERS: Record<string, string> = {
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
function anime4kFiles(s: Settings, scale: number): string[] {
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

/** The texture every pass hooks: the RGB frame. */
export const HOOK = 'MAIN';

const parsedCache = new Map<string, HookPass[]>();
function parseCached(name: string): HookPass[] {
  let passes = parsedCache.get(name);
  if (!passes) { passes = parseHookPasses(ANIME4K_SHADERS[name]); parsedCache.set(name, passes); }
  return passes;
}

/** The hook passes of the chain for these settings at `scale`, in run order. */
export function orderedPasses(s: Settings, scale: number): HookPass[] {
  const passes: HookPass[] = [];
  const deferred: HookPass[] = []; // PREKERNEL hooks run after all MAIN hooks (as in mpv)
  for (const name of anime4kFiles(s, scale)) {
    for (const p of parseCached(name)) {
      if (p.hook === HOOK) passes.push(p);
      else if (p.hook === 'PREKERNEL') deferred.push(p);
      // other hook points (LUMA, CHROMA...) are not used by the Anime4K files we ship
    }
  }
  return [...passes, ...deferred];
}

export type Size = { w: number; h: number };

/** Resolves mpv size references like "MAIN.w", "HOOKED.h" or "OUTPUT.h" for a w x h source at `scale`. */
function sizeResolver(get: (name: string) => Size | undefined, w: number, h: number, scale: number) {
  return (ref: string): number => {
    const [name, dim] = ref.split('.');
    if (name === 'OUTPUT') return dim === 'w' ? w * scale : h * scale;
    const t = get(name === 'HOOKED' ? HOOK : name);
    if (t) return dim === 'w' ? t.w : t.h;
    throw new Error(`Unknown texture in size expression: ${ref}`);
  };
}

/**
 * A chain laid out for one source size, before any GL object exists: which passes run, the
 * size of every texture they write, and what each pass reads. Texture 0 is the video frame.
 * Both the memory estimate and the real build use it, so they cannot disagree.
 */
export interface PlanStep {
  pass: HookPass;
  out: number; // texture id written
  inputs: { name: string; ref: number }[]; // ref: texture id
}
export interface Plan {
  sizes: Size[]; // by texture id
  steps: PlanStep[];
  final: number; // texture id the present pass reads
}

export function planChain(passes: HookPass[], w: number, h: number, scale: number): Plan {
  const sizes: Size[] = [{ w, h }];
  const steps: PlanStep[] = [];
  const named = new Map<string, number>([[HOOK, 0]]);
  const sizeOf = sizeResolver((n) => { const id = named.get(n); return id === undefined ? undefined : sizes[id]; }, w, h, scale);
  for (const p of passes) {
    if (p.when && evalRpn(p.when, sizeOf) === 0) continue;
    const hooked = sizes[named.get(HOOK)!];
    const outW = p.width ? Math.round(evalRpn(p.width, sizeOf)) : hooked.w;
    const outH = p.height ? Math.round(evalRpn(p.height, sizeOf)) : hooked.h;
    const bindNames = Array.from(new Set([...p.binds.map((b) => (b === 'HOOKED' ? HOOK : b)), HOOK]));
    const inputs = bindNames.map((n) => {
      const id = named.get(n);
      if (id === undefined) throw new Error(`Pass "${p.desc}" binds unknown texture ${n}`);
      return { name: n, ref: id };
    });
    sizes.push({ w: outW, h: outH });
    const out = sizes.length - 1;
    steps.push({ pass: p, out, inputs });
    named.set(p.save ?? HOOK, out);
  }
  return { sizes, steps, final: named.get(HOOK)! };
}

/**
 * Assigns pass outputs to shared textures: a texture is reused, at the same size, once every
 * pass that reads the previous owner has run. Returns the physical slot of every texture id
 * (0 = the video frame, which is never shared) and the slots' sizes. With `ownFinal` the
 * final texture shares with nothing, so it still holds the last frame when the next begins.
 */
export function poolTextures(plan: Plan, ownFinal = false): { slotOf: number[]; slots: Size[] } {
  const lastRead = plan.sizes.map(() => -1);
  plan.steps.forEach((s, i) => { for (const inp of s.inputs) lastRead[inp.ref] = i; });
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
    const reuse = ownFinal && s.out === plan.final ? -1 : free.findIndex((sl) => slots[sl].w === size.w && slots[sl].h === size.h);
    if (reuse >= 0) { slotOf[s.out] = free[reuse]; free.splice(reuse, 1); } else { slots.push({ ...size }); slotOf[s.out] = slots.length - 1; }
    live.push(s.out);
  });
  return { slotOf, slots };
}

/**
 * Texture bytes a chain will allocate: the video frame (RGBA8) plus the pooled RGBA16F slots.
 * `reuse`: also what frame reuse adds (gpu-reuse.ts): the previous frame, an unshared final
 * texture, and a stencil buffer per pass size (counted as 4 bytes a pixel, as drivers store it).
 */
export function estimateBytes(passes: HookPass[], w: number, h: number, scale: number, reuse = false): number {
  const { slots } = poolTextures(planChain(passes, w, h, scale), reuse);
  const sizes = new Map(slots.slice(1).map((s) => [`${s.w}x${s.h}`, s.w * s.h * 4]));
  const extra = reuse ? w * h * 4 + [...sizes.values()].reduce((n, b) => n + b, 0) : 0;
  return w * h * 4 + extra + slots.slice(1).reduce((n, s) => n + s.w * s.h * 8, 0);
}

/** A playing video, or a still image (manga pages) that render() uploads the same way. */
export type RenderSource = HTMLVideoElement | ImageBitmap;

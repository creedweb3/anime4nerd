// WebGL2 runner for bloc97's original Anime4K mpv GLSL shaders.
// Loaded lazily by the content script via import(chrome.runtime.getURL('gpu.js')).

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
  HookPass, ShaderFile, UserTexture, buildFragmentSource, evalRpn, parseShaderFile,
} from './mpv-hooks';
import {
  Plane, ShaderRef, applyDefines, engineChain,
} from './engines';
import { engineVariant, type Preset, type Settings } from './settings';
import { decodedSize, uploadSize } from './video-size';

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
}

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

/** How often render() re-checks the frame size and GL error state (each check stalls the GPU briefly). */
const HEALTH_CHECK_MS = 1000;

/** Largest final output, in pixels (8K UHD); bigger frames risk exhausting GPU memory. */
const MAX_OUTPUT_PX = 7680 * 4320;

/** Standard Anime4K mpv preset chains: one x2 step, plus an extra (M) x2 step per doubling beyond 2x. */
function anime4kFiles(s: Settings, scale: number): string[] {
  const p: Preset = s.preset;
  const files = [clampHighlights];
  if (p === 'A' || p === 'AA') files.push(restoreVL);
  if (p === 'B' || p === 'BB') files.push(restoreSoftVL);
  files.push(p === 'C' || p === 'CA' ? upscaleDenoiseVL : upscaleVL);
  if (p === 'AA' || p === 'CA') files.push(restoreM);
  if (p === 'BB') files.push(restoreSoftM);
  for (let k = scale; k > 2; k /= 2) files.push(upscaleM);
  if (s.darkenLines) files.push(darkenHQ);
  if (s.thinLines) files.push(thinHQ);
  return files;
}

/** GPU memory budget for one renderer's textures; above it the scale halves (never below 2x). */
const MAX_TEXTURE_BYTES = 2 * 1024 ** 3;

/** The texture name each plane's passes hook. */
const HOOK_OF: Record<Plane, string> = { rgb: 'MAIN', luma: 'LUMA', ycbcr: 'NATIVE' };

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

const parsedCache = new Map<string, ShaderFile>();
function parseCached(key: string, source: () => string): ShaderFile {
  let f = parsedCache.get(key);
  if (!f) { f = parseShaderFile(source()); parsedCache.set(key, f); }
  return f;
}

/** A chain whose files are loaded: give it a scale and it lists the shader files to run. */
interface LoadedChain {
  plane: Plane;
  files(scale: number): ShaderFile[];
}

export async function loadChain(s: Settings): Promise<LoadedChain> {
  if (s.engine === 'anime4k') {
    return { plane: 'rgb', files: (scale) => anime4kFiles(s, scale).map((src) => parseCached(src, () => src)) };
  }
  const ec = engineChain(s.engine, engineVariant(s));
  const last = ec.last ?? ec.step;
  const refs = [...ec.pre, ...ec.step, ...last];
  const texts = new Map<string, string>();
  await Promise.all(refs.map(async (r) => { if ('file' in r) texts.set(r.file, await fetchShader(r.file)); }));
  const parse = (r: ShaderRef): ShaderFile => {
    if ('inline' in r) return parseCached(`inline|${r.name}`, () => r.inline);
    const f = parseCached(`${r.file}|${JSON.stringify(r.defines ?? {})}`, () => applyDefines(texts.get(r.file)!, r.defines));
    return r.only ? { ...f, passes: f.passes.filter((p) => p.desc.includes(r.only!)) } : f;
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
function orderedPasses(chain: LoadedChain, scale: number): { passes: HookPass[]; textures: UserTexture[] } {
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

type Size = { w: number; h: number };

/** Resolves mpv size references like "MAIN.w", "HOOKED.h" or "OUTPUT.h" for a w x h source at `scale`. */
function sizeResolver(get: (name: string) => Size | undefined, hook: string, w: number, h: number, scale: number) {
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
interface PlanStep {
  kind: 'hook' | 'to-plane';
  pass: HookPass | null; // null for the conversion to the plane
  out: number; // texture id written
  inputs: { name: string; ref: number | string }[]; // ref: texture id, or a lookup table's name
}
interface Plan {
  sizes: Size[]; // by texture id
  steps: PlanStep[];
  final: number; // texture id the present pass reads
  offset: [number, number]; // accumulated //!OFFSET of the final plane, in its pixels
}

function planChain(passes: HookPass[], lookupNames: ReadonlySet<string>, plane: Plane, w: number, h: number, scale: number): Plan {
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
function poolTextures(plan: Plan): { slotOf: number[]; slots: Size[] } {
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
function estimateBytes(passes: HookPass[], lookups: UserTexture[], plane: Plane, w: number, h: number, scale: number): number {
  const plan = planChain(passes, new Set(lookups.map((t) => t.name)), plane, w, h, scale);
  const { slots } = poolTextures(plan);
  return w * h * 4 + slots.slice(1).reduce((n, s) => n + s.w * s.h * 8, 0) + lookups.reduce((n, t) => n + t.data.byteLength, 0);
}

// Full-range BT.709 conversions, for chains that work on Y or YCbCr (chroma centred at 0.5).
const TO_PLANE_FRAG = (plane: Plane) => `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D SRC_raw;
void main() {
  vec3 c = texture(SRC_raw, v_uv).rgb;
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  ${plane === 'luma'
    ? 'fragColor = vec4(y, 0.0, 0.0, 1.0);'
    : 'fragColor = vec4(y, (c.b - y) / 1.8556 + 0.5, (c.r - y) / 1.5748 + 0.5, 1.0);'}
}`;

/**
 * The final draw to the canvas (flipped: textures are stored top row first). For Y / YCbCr
 * chains it also converts back to RGB, so that costs no extra full-size pass.
 */
const PRESENT_FRAG = (plane: Plane) => (plane === 'rgb' ? `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D PLANE_raw;
void main() { fragColor = vec4(texture(PLANE_raw, vec2(v_uv.x, 1.0 - v_uv.y)).rgb, 1.0); }` : `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D PLANE_raw;
uniform vec2 PLANE_size;
uniform sampler2D SRC_raw;
uniform vec2 u_offset; // accumulated pixel shift of the plane (mpv //!OFFSET)
void main() {
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);
  vec4 p = texture(PLANE_raw, uv + u_offset / PLANE_size);
  float y = p.x;
  vec2 cbcr;
  ${plane === 'luma'
    ? `vec3 c = texture(SRC_raw, uv).rgb;
  float sy = dot(c, vec3(0.2126, 0.7152, 0.0722));
  cbcr = vec2((c.b - sy) / 1.8556, (c.r - sy) / 1.5748);`
    : 'cbcr = p.yz - 0.5;'}
  float r = y + 1.5748 * cbcr.y;
  float b = y + 1.8556 * cbcr.x;
  float g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
  fragColor = vec4(clamp(vec3(r, g, b), 0.0, 1.0), 1.0);
}`);

const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  // Fullscreen triangle. uv.y = 0 is texel row 0 for every texture, so a pass that
  // samples at uv and writes at uv keeps all textures aligned (no per-pass flip).
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  v_uv = p * 0.5 + 0.5;
}`;

/** Compile+link without checking status; errors are collected later in `finishPrograms`. */
function startProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fsSrc: string): { prog: WebGLProgram; fs: WebGLShader } {
  const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
  gl.shaderSource(fs, fsSrc);
  gl.compileShader(fs);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  return { prog, fs };
}

/** Wait for all programs to finish compiling (KHR_parallel_shader_compile) then verify. */
async function finishPrograms(
  gl: WebGL2RenderingContext,
  items: { prog: WebGLProgram; fs: WebGLShader; label: string }[],
  aborted: () => boolean,
): Promise<void> {
  const ext = gl.getExtension('KHR_parallel_shader_compile');
  if (ext) {
    let pending = items.slice();
    while (pending.length && !aborted()) {
      pending = pending.filter((it) => !gl.getProgramParameter(it.prog, ext.COMPLETION_STATUS_KHR));
      if (pending.length) await new Promise((r) => { setTimeout(r, 16); });
    }
  }
  for (const it of items) {
    if (!gl.getProgramParameter(it.prog, gl.LINK_STATUS)) {
      const log = gl.getShaderParameter(it.fs, gl.COMPILE_STATUS)
        ? gl.getProgramInfoLog(it.prog)
        : gl.getShaderInfoLog(it.fs);
      throw new Error(`Shader failed (${it.label}): ${log}`);
    }
    gl.deleteShader(it.fs);
  }
}

interface Tex { tex: WebGLTexture; w: number; h: number; }

/** A texture a pass samples: `uniform` is its sampler's name in the shader, `${name}_size` its size. */
interface PassInput { name: string; uniform: string; tex: Tex; }

interface CompiledPass {
  desc: string;
  program: WebGLProgram;
  inputs: (PassInput & { loc: WebGLUniformLocation | null; sizeLoc: WebGLUniformLocation | null })[];
  output: Tex | null; // null: the canvas
  fbo: WebGLFramebuffer | null;
  offset: [number, number] | null; // plane shift to undo (conversion back to RGB only)
  offsetLoc: WebGLUniformLocation | null;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed (${label}): ${log}`);
  }
  return sh;
}

/** A playing video, or a still image (manga pages) that render() uploads the same way. */
export type RenderSource = HTMLVideoElement | ImageBitmap;

export async function createAnime4kRenderer(
  video: RenderSource,
  canvas: HTMLCanvasElement,
  settings: Settings,
  onError: (msg: string) => void,
  wantScale = 2,
): Promise<Anime4kRenderer> {
  const { w, h } = video instanceof ImageBitmap ? { w: video.width, h: video.height } : uploadSize(video);
  if (!w || !h) throw new Error('Waiting for video dimensions.');
  const chain = await loadChain(settings);
  try {
    return await buildRenderer(video, canvas, chain, onError, wantScale, w, h);
  } catch (e) {
    // A build that fails after creating its context must give it back: pages get ~16 contexts,
    // and a leaked one evicts the oldest, which may be another video's working renderer.
    canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
    throw e;
  }
}

async function buildRenderer(
  video: RenderSource,
  canvas: HTMLCanvasElement,
  chain: LoadedChain,
  onError: (msg: string) => void,
  wantScale: number,
  w: number,
  h: number,
): Promise<Anime4kRenderer> {
  // ImageBitmap, not instanceof HTMLVideoElement: a video from another realm (iframe) is still a video.
  const isVideo = !(video instanceof ImageBitmap);

  const gl = canvas.getContext('webgl2', {
    alpha: false, antialias: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false,
    powerPreference: 'high-performance',
  });
  if (!gl) throw new Error('WebGL2 is unavailable in this browser.');
  if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
    throw new Error('This GPU cannot render to half-float textures.');
  }
  gl.getExtension('OES_texture_float_linear');

  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (w * 2 > maxTex || h * 2 > maxTex) throw new Error("The upscaled video exceeds this GPU's texture limit.");
  // Beyond 2x is optional: halve the scale until the output fits the texture limit, the output
  // cap, and the memory budget for every intermediate texture of the chain.
  const hook = HOOK_OF[chain.plane];
  let scale = wantScale;
  let { passes, textures } = orderedPasses(chain, scale);
  const tooBig = () => w * scale > maxTex || h * scale > maxTex || w * h * scale * scale > MAX_OUTPUT_PX
    || estimateBytes(passes, textures, chain.plane, w, h, scale) > MAX_TEXTURE_BYTES;
  while (scale > 2 && tooBig()) { scale /= 2; ({ passes, textures } = orderedPasses(chain, scale)); }

  canvas.width = w * scale;
  canvas.height = h * scale;

  let destroyed = false;
  const onLost = (e: Event) => {
    e.preventDefault();
    if (!destroyed) onError('The GPU connection was lost. Turn Anime4K off and on to retry.');
  };
  canvas.addEventListener('webglcontextlost', onLost);

  // --- textures -------------------------------------------------------------
  const allTex: Tex[] = [];
  let textureBytes = 0;
  function makeTex(tw: number, th: number, half: boolean): Tex {
    const tex = gl!.createTexture()!;
    gl!.bindTexture(gl!.TEXTURE_2D, tex);
    if (half) gl!.texStorage2D(gl!.TEXTURE_2D, 1, gl!.RGBA16F, tw, th);
    else gl!.texStorage2D(gl!.TEXTURE_2D, 1, gl!.RGBA8, tw, th);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    const t = { tex, w: tw, h: th };
    allTex.push(t);
    textureBytes += tw * th * (half ? 8 : 4);
    return t;
  }

  // Lookup tables from //!TEXTURE blocks (RAVU), uploaded once.
  const lookup = new Map<string, Tex>();
  for (const ut of textures) {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const floats32 = ut.data.byteLength === ut.w * ut.h * 16; // mpv's dumps hold float32 even for 16f formats
    if (ut.format === 'rgba16f' && floats32) {
      const texels = new Float32Array(ut.data.buffer, ut.data.byteOffset, ut.data.byteLength >> 2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, ut.w, ut.h, 0, gl.RGBA, gl.FLOAT, texels);
    } else if (ut.format === 'rgba16f') {
      const texels = new Uint16Array(ut.data.buffer, ut.data.byteOffset, ut.data.byteLength >> 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, ut.w, ut.h, 0, gl.RGBA, gl.HALF_FLOAT, texels);
    } else if (ut.format === 'rgba32f') {
      const texels = new Float32Array(ut.data.buffer, ut.data.byteOffset, ut.data.byteLength >> 2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, ut.w, ut.h, 0, gl.RGBA, gl.FLOAT, texels);
    } else {
      throw new Error(`Lookup texture ${ut.name} has unsupported format ${ut.format}.`);
    }
    const filter = ut.linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const t = { tex, w: ut.w, h: ut.h };
    allTex.push(t);
    textureBytes += ut.data.byteLength;
    lookup.set(ut.name, t);
  }
  const lookupNames = new Set(lookup.keys());

  // Video frame texture (RGBA8; the video itself is 8-bit).
  const videoTex = makeTex(w, h, false);

  // --- build pass list ------------------------------------------------------
  // Pass outputs share textures once nothing reads them any more (see poolTextures): a long
  // chain needs a handful of textures per size instead of one per pass.
  const plan = planChain(passes, lookupNames, chain.plane, w, h, scale);
  const { slotOf, slots } = poolTextures(plan);
  const slotTex = slots.map((s, i) => (i === 0 ? videoTex : makeTex(s.w, s.h, true)));
  const texOf = (id: number) => slotTex[slotOf[id]];

  const compiled: CompiledPass[] = [];
  const vs = compile(gl, gl.VERTEX_SHADER, VERT, 'vertex');
  const pendingPrograms: { prog: WebGLProgram; fs: WebGLShader; label: string }[] = [];

  function addPass(desc: string, src: string, inputs: PassInput[], out: Tex | null): CompiledPass {
    const { prog, fs } = startProgram(gl!, vs, src);
    pendingPrograms.push({ prog, fs, label: desc });
    let fbo: WebGLFramebuffer | null = null;
    if (out) {
      fbo = gl!.createFramebuffer()!;
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
      gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, out.tex, 0);
      if (gl!.checkFramebufferStatus(gl!.FRAMEBUFFER) !== gl!.FRAMEBUFFER_COMPLETE) {
        throw new Error('This GPU cannot render to half-float textures.');
      }
    }
    // Uniform locations are resolved after linking completes (see below).
    const c: CompiledPass = {
      desc, program: prog, output: out, fbo, offset: null, offsetLoc: null,
      inputs: inputs.map((i) => ({ ...i, loc: null, sizeLoc: null })),
    };
    compiled.push(c);
    return c;
  }

  for (const s of plan.steps) {
    const inputs = s.inputs.map((inp): PassInput => (typeof inp.ref === 'string'
      ? { name: inp.name, uniform: inp.name, tex: lookup.get(inp.ref)! }
      : { name: inp.name, uniform: `${inp.name}_raw`, tex: texOf(inp.ref) }));
    const src = s.kind === 'to-plane' ? TO_PLANE_FRAG(chain.plane) : buildFragmentSource(s.pass!, hook, lookupNames);
    addPass(s.pass?.desc ?? 'to plane', src, inputs, texOf(s.out));
  }

  const finalSize = plan.sizes[plan.final];
  if (finalSize.w !== w * scale || finalSize.h !== h * scale) {
    // Can happen if an x2 WHEN condition failed; keep canvas in sync anyway.
    canvas.width = finalSize.w;
    canvas.height = finalSize.h;
  }
  // The present pass draws to the canvas; for Y / YCbCr chains it also converts back to RGB.
  const present = addPass('present', PRESENT_FRAG(chain.plane), [
    { name: 'PLANE', uniform: 'PLANE_raw', tex: texOf(plan.final) },
    { name: 'SRC', uniform: 'SRC_raw', tex: videoTex },
  ], null);
  if (chain.plane !== 'rgb') present.offset = plan.offset;

  await finishPrograms(gl, pendingPrograms, () => destroyed);
  gl.deleteShader(vs);
  if (destroyed) throw new DOMException('Canceled', 'AbortError');
  for (const c of compiled) {
    for (const inp of c.inputs) {
      inp.loc = gl.getUniformLocation(c.program, inp.uniform);
      inp.sizeLoc = gl.getUniformLocation(c.program, `${inp.name}_size`);
    }
    if (c.offset) c.offsetLoc = gl.getUniformLocation(c.program, 'u_offset');
  }

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

  const texUnitsAvail = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;
  for (const c of compiled) {
    // Only samplers the shader actually reads take a texture unit (the hooked texture is always
    // declared but often unused, which would push ArtCNN C4F32 one over the usual 16).
    c.inputs = c.inputs.filter((inp) => inp.loc || inp.sizeLoc);
    const units = c.inputs.filter((inp) => inp.loc).length;
    if (units > texUnitsAvail) throw new Error(`Pass "${c.desc}" needs ${units} textures; GPU allows ${texUnitsAvail}.`);
  }

  // --- GPU timing -------------------------------------------------------------
  const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2') as {
    TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number;
    beginQueryEXT?: unknown;
  } | null;
  const pendingQueries: WebGLQuery[] = [];
  let lastGpuMs: number | null = null;
  const recent: { t: number; ms: number }[] = []; // completed GPU timings
  let lastCpuMs = 0;
  const frameTimes: number[] = [];
  let lastHealthCheck = -Infinity;

  function pollQueries() {
    if (!timerExt) return;
    while (pendingQueries.length) {
      const q = pendingQueries[0];
      const available = gl!.getQueryParameter(q, gl!.QUERY_RESULT_AVAILABLE) as boolean;
      if (!available) break;
      const disjoint = gl!.getParameter(timerExt.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) {
        lastGpuMs = (gl!.getQueryParameter(q, gl!.QUERY_RESULT) as number) / 1e6;
        recent.push({ t: performance.now(), ms: lastGpuMs });
      }
      gl!.deleteQuery(q);
      pendingQueries.shift();
    }
  }

  function stats(): RenderStats {
    pollQueries();
    const now = performance.now();
    while (frameTimes.length && now - frameTimes[0] > 2000) frameTimes.shift();
    while (recent.length && now - recent[0].t > 2000) recent.shift();
    return {
      gpuMs: lastGpuMs,
      samples: recent.map((r) => r.ms),
      cpuMs: lastCpuMs,
      fps: frameTimes.length / 2,
      passes: compiled.length,
      textureBytes,
      outputWidth: canvas.width,
      outputHeight: canvas.height,
      timerSupported: !!timerExt,
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const q of pendingQueries) gl!.deleteQuery(q);
    pendingQueries.length = 0;
    canvas.removeEventListener('webglcontextlost', onLost);
    for (const c of compiled) { gl!.deleteProgram(c.program); if (c.fbo) gl!.deleteFramebuffer(c.fbo); }
    for (const t of allTex) gl!.deleteTexture(t.tex);
    gl!.deleteVertexArray(vao);
    const lose = gl!.getExtension('WEBGL_lose_context');
    lose?.loseContext();
  }

  function render(frame?: RenderSource) {
    if (destroyed || gl!.isContextLost()) return;
    const t0 = performance.now();
    pollQueries();
    let query: WebGLQuery | null = null;
    if (timerExt && pendingQueries.length < 4) {
      query = gl!.createQuery();
      if (query) gl!.beginQuery(timerExt.TIME_ELAPSED_EXT, query);
    }
    // Upload current frame. Throws SecurityError for CORS-tainted video.
    // WebGL reports a bad upload only through getError, so a size mismatch would otherwise
    // leave a stale or black canvas while the status says Active. Check on the first frame
    // and then periodically; getError stalls the pipeline, so not every frame.
    const check = t0 - lastHealthCheck >= HEALTH_CHECK_MS;
    if (check) {
      lastHealthCheck = t0;
      while (gl!.getError() !== gl!.NO_ERROR) { /* drain older errors so only the upload is judged */ }
    }
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, videoTex.tex);
    gl!.texSubImage2D(gl!.TEXTURE_2D, 0, 0, 0, w, h, gl!.RGBA, gl!.UNSIGNED_BYTE, frame ?? video);
    if (check) {
      const size = isVideo ? decodedSize(video as HTMLVideoElement) : null; // null = unreadable right now; don't treat as a change
      const err = gl!.getError();
      let problem: Error | null = null;
      if (size && (size.w !== w || size.h !== h)) problem = new SourceSizeChanged();
      else if (err !== gl!.NO_ERROR) problem = new Error(`The GPU rejected this video frame (WebGL error 0x${err.toString(16)}).`);
      if (problem) {
        if (query) { gl!.endQuery(timerExt!.TIME_ELAPSED_EXT); gl!.deleteQuery(query); }
        throw problem;
      }
    }

    for (const c of compiled) {
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, c.fbo);
      gl!.viewport(0, 0, c.output ? c.output.w : canvas.width, c.output ? c.output.h : canvas.height);
      gl!.useProgram(c.program);
      let unit = 0;
      c.inputs.forEach((inp) => {
        if (inp.loc) {
          gl!.activeTexture(gl!.TEXTURE0 + unit);
          gl!.bindTexture(gl!.TEXTURE_2D, inp.tex.tex);
          gl!.uniform1i(inp.loc, unit);
          unit += 1;
        }
        if (inp.sizeLoc) gl!.uniform2f(inp.sizeLoc, inp.tex.w, inp.tex.h);
      });
      if (c.offsetLoc && c.offset) gl!.uniform2f(c.offsetLoc, c.offset[0], c.offset[1]);
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    }

    if (query) { gl!.endQuery(timerExt!.TIME_ELAPSED_EXT); pendingQueries.push(query); }
    lastCpuMs = performance.now() - t0;
    frameTimes.push(t0);
  }

  return { render, destroy, stats };
}

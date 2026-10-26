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
  HookPass, buildFragmentSource, evalRpn, parseHookPasses,
} from './mpv-hooks';
import type { Preset, Settings } from './settings';
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
  render(): void;
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
function chainFor(s: Settings, scale: number): string[] {
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

/** The chain's hook passes in run order. */
function orderedPasses(s: Settings, scale: number): HookPass[] {
  const passes: HookPass[] = [];
  const deferred: HookPass[] = []; // PREKERNEL hooks run after all MAIN hooks (as in mpv)
  for (const file of chainFor(s, scale)) {
    for (const p of parseHookPasses(file)) {
      if (p.hook === 'MAIN') passes.push(p);
      else if (p.hook === 'PREKERNEL') deferred.push(p);
      // other hook points (LUMA, CHROMA, OUTPUT...) do not exist for an RGB video source
    }
  }
  return [...passes, ...deferred];
}

type Size = { w: number; h: number };

/** Resolves mpv size references like "MAIN.w" or "OUTPUT.h" for a w x h source at `scale`. */
function sizeResolver(get: (name: string) => Size | undefined, w: number, h: number, scale: number) {
  return (ref: string): number => {
    const [name, dim] = ref.split('.');
    if (name === 'OUTPUT') return dim === 'w' ? w * scale : h * scale;
    if (name === 'NATIVE') return dim === 'w' ? w : h;
    const t = get(name);
    if (!t) throw new Error(`Unknown texture in size expression: ${ref}`);
    return dim === 'w' ? t.w : t.h;
  };
}

/** Texture bytes a chain will allocate, by the same size rules as the real build below. */
function estimateBytes(passes: HookPass[], w: number, h: number, scale: number): number {
  const sizes = new Map<string, Size>([['MAIN', { w, h }]]);
  const sizeOf = sizeResolver((n) => sizes.get(n), w, h, scale);
  let bytes = w * h * 4; // RGBA8 video frame
  for (const p of passes) {
    if (p.when && evalRpn(p.when, sizeOf) === 0) continue;
    const hooked = sizes.get('MAIN')!;
    const out = {
      w: p.width ? Math.round(evalRpn(p.width, sizeOf)) : hooked.w,
      h: p.height ? Math.round(evalRpn(p.height, sizeOf)) : hooked.h,
    };
    bytes += out.w * out.h * 8; // RGBA16F
    sizes.set(p.save ?? 'MAIN', out);
  }
  return bytes;
}

const VERT = `#version 300 es
out vec2 v_uv;
void main() {
  // Fullscreen triangle. uv.y = 0 is texel row 0 for every texture, so a pass that
  // samples at uv and writes at uv keeps all textures aligned (no per-pass flip).
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  v_uv = p * 0.5 + 0.5;
}`;

const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_tex;
void main() { fragColor = vec4(texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y)).rgb, 1.0); }`;

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

interface CompiledPass {
  desc: string;
  program: WebGLProgram;
  inputs: { name: string; tex: Tex; loc: WebGLUniformLocation | null; sizeLoc: WebGLUniformLocation | null }[];
  output: Tex;
  fbo: WebGLFramebuffer;
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

export async function createAnime4kRenderer(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  settings: Settings,
  onError: (msg: string) => void,
  wantScale = 2,
): Promise<Anime4kRenderer> {
  const { w, h } = uploadSize(video);
  if (!w || !h) throw new Error('Waiting for video dimensions.');

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
  let scale = wantScale;
  let passes = orderedPasses(settings, scale);
  const tooBig = () => w * scale > maxTex || h * scale > maxTex || w * h * scale * scale > MAX_OUTPUT_PX
    || estimateBytes(passes, w, h, scale) > MAX_TEXTURE_BYTES;
  while (scale > 2 && tooBig()) { scale /= 2; passes = orderedPasses(settings, scale); }

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
    return t;
  }

  // Video frame texture (RGBA8; the video itself is 8-bit).
  const videoTex = makeTex(w, h, false);

  // --- build pass list ------------------------------------------------------
  // Named textures visible to later passes. MAIN starts as the video frame.
  const named = new Map<string, Tex>([['MAIN', videoTex]]);
  const sizeOf = sizeResolver((n) => named.get(n), w, h, scale);

  const compiled: CompiledPass[] = [];
  const vs = compile(gl, gl.VERTEX_SHADER, VERT, 'vertex');
  const pendingPrograms: { prog: WebGLProgram; fs: WebGLShader; label: string }[] = [];

  const resolveBinds = (p: HookPass): string[] => p.binds.map((b) => (b === 'HOOKED' ? 'MAIN' : b));

  for (const p of passes) {
    if (p.when && evalRpn(p.when, sizeOf) === 0) continue;
    const hooked = named.get('MAIN')!;
    const outW = p.width ? Math.round(evalRpn(p.width, sizeOf)) : hooked.w;
    const outH = p.height ? Math.round(evalRpn(p.height, sizeOf)) : hooked.h;

    const bindNames = Array.from(new Set([...resolveBinds(p), 'MAIN']));
    const inputTex = bindNames.map((n) => {
      const t = named.get(n);
      if (!t) throw new Error(`Pass "${p.desc}" binds unknown texture ${n}`);
      return t;
    });

    const { prog, fs } = startProgram(gl, vs, buildFragmentSource(p, 'MAIN'));
    pendingPrograms.push({ prog, fs, label: p.desc });
    // Uniform locations are resolved after linking completes (see below).
    const inputs = bindNames.map((n, i) => ({ name: n, tex: inputTex[i], loc: null, sizeLoc: null }));

    // One half-float texture per pass output. (Could be pooled later; a VL chain at 1080p
    // is roughly 40 textures x 8 bytes/px, well under typical GPU memory.)
    const out = makeTex(outW, outH, true);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out.tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('This GPU cannot render to half-float textures.');
    }

    compiled.push({ desc: p.desc, program: prog, inputs, output: out, fbo });
    named.set(p.save ?? 'MAIN', out);
  }

  const finalTex = named.get('MAIN')!;
  if (finalTex.w !== w * scale || finalTex.h !== h * scale) {
    // Can happen if an x2 WHEN condition failed; keep canvas in sync anyway.
    canvas.width = finalTex.w;
    canvas.height = finalTex.h;
  }

  const present = startProgram(gl, vs, PRESENT_FRAG);
  pendingPrograms.push({ ...present, label: 'present' });
  await finishPrograms(gl, pendingPrograms, () => destroyed);
  gl.deleteShader(vs);
  if (destroyed) throw new DOMException('Canceled', 'AbortError');
  const presentProg = present.prog;
  const presentLoc = gl.getUniformLocation(presentProg, 'u_tex');
  for (const c of compiled) {
    for (const inp of c.inputs) {
      inp.loc = gl.getUniformLocation(c.program, `${inp.name}_raw`);
      inp.sizeLoc = gl.getUniformLocation(c.program, `${inp.name}_size`);
    }
  }

  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

  const texUnitsAvail = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) as number;
  for (const c of compiled) {
    if (c.inputs.length > texUnitsAvail) throw new Error(`Pass "${c.desc}" needs ${c.inputs.length} textures; GPU allows ${texUnitsAvail}.`);
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
  const textureBytes = allTex.reduce((n, t) => n + t.w * t.h * (t === videoTex ? 4 : 8), 0);

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
      passes: compiled.length + 1,
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
    for (const c of compiled) { gl!.deleteProgram(c.program); gl!.deleteFramebuffer(c.fbo); }
    gl!.deleteProgram(presentProg);
    for (const t of allTex) gl!.deleteTexture(t.tex);
    gl!.deleteVertexArray(vao);
    const lose = gl!.getExtension('WEBGL_lose_context');
    lose?.loseContext();
  }

  function render() {
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
    gl!.texSubImage2D(gl!.TEXTURE_2D, 0, 0, 0, w, h, gl!.RGBA, gl!.UNSIGNED_BYTE, video);
    if (check) {
      const size = decodedSize(video); // null = unreadable right now; don't treat as a change
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
      gl!.viewport(0, 0, c.output.w, c.output.h);
      gl!.useProgram(c.program);
      c.inputs.forEach((inp, i) => {
        gl!.activeTexture(gl!.TEXTURE0 + i);
        gl!.bindTexture(gl!.TEXTURE_2D, inp.tex.tex);
        if (inp.loc) gl!.uniform1i(inp.loc, i);
        if (inp.sizeLoc) gl!.uniform2f(inp.sizeLoc, inp.tex.w, inp.tex.h);
      });
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    }

    gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    gl!.viewport(0, 0, canvas.width, canvas.height);
    gl!.useProgram(presentProg);
    gl!.activeTexture(gl!.TEXTURE0);
    gl!.bindTexture(gl!.TEXTURE_2D, finalTex.tex);
    gl!.uniform1i(presentLoc, 0);
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);

    if (query) { gl!.endQuery(timerExt!.TIME_ELAPSED_EXT); pendingQueries.push(query); }
    lastCpuMs = performance.now() - t0;
    frameTimes.push(t0);
  }

  return { render, destroy, stats };
}

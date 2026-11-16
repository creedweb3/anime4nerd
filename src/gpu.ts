// WebGL2 runner for Anime4K's mpv-format GLSL shader chains.
// Loaded lazily by the content script via import(chrome.runtime.getURL('gpu.js')).

import { buildFragmentSource } from './mpv-hooks';
import { chainKey, type Settings } from './settings';
import {
  Anime4kRenderer, HOOK, MAX_OUTPUT_PX, MAX_TEXTURE_BYTES, RenderSource, RenderStats, SourceSizeChanged,
  estimateBytes, orderedPasses, planChain, poolTextures,
} from './chain';
import { decodedSize, uploadSize } from './video-size';
import { REDRAW, createFrameReuse, differenceRadius } from './gpu-reuse';

export type { Anime4kRenderer, RenderSource, RenderStats } from './chain';
export { SourceSizeChanged } from './chain';

/** How often render() re-checks the frame size and GL error state (each check stalls the GPU briefly). */
const HEALTH_CHECK_MS = 1000;

/** Frame reuse: half-size (source pixels) of the window read back to measure a chain's reach. */
const REACH_WINDOW = 128;

/** Frame reuse: the measured reach is widened by this factor (plus 2 pixels) before use. */
const REACH_MARGIN = 1.25;

/** Frame reuse: reach already measured for a chain at a size (measuring costs a few full frames). */
const reachCache = new Map<string, number | null>();

/** The final draw to the canvas (flipped: textures are stored top row first). */
const PRESENT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D FRAME_raw;
void main() { fragColor = vec4(texture(FRAME_raw, vec2(v_uv.x, 1.0 - v_uv.y)).rgb, 1.0); }`;

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
      // A lost context never reports completion, so this would otherwise poll forever.
      if (gl.isContextLost()) throw new Error('The GPU connection was lost while compiling shaders.');
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

/** A texture a pass samples: `${name}_raw` is its sampler in the shader, `${name}_size` its size. */
interface PassInput { name: string; tex: Tex; }

interface CompiledPass {
  desc: string;
  program: WebGLProgram;
  inputs: (PassInput & { loc: WebGLUniformLocation | null; sizeLoc: WebGLUniformLocation | null })[];
  output: Tex | null; // null: the canvas
  final: boolean; // writes the texture the canvas is drawn from
  fbo: WebGLFramebuffer | null;
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

let frameReuse = true;
/** Redraw only what changed since the last frame (gpu-reuse.ts); off only to compare (tests). */
export function setFrameReuse(on: boolean): void { frameReuse = on; }

export async function createAnime4kRenderer(
  video: RenderSource,
  canvas: HTMLCanvasElement,
  settings: Settings,
  onError: (msg: string) => void,
  wantScale = 2,
): Promise<Anime4kRenderer> {
  const { w, h } = video instanceof ImageBitmap ? { w: video.width, h: video.height } : uploadSize(video);
  if (!w || !h) throw new Error('Waiting for video dimensions.');
  try {
    return await buildRenderer(video, canvas, settings, onError, wantScale, w, h);
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
  settings: Settings,
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
  const floatRead = !!gl.getExtension('EXT_color_buffer_float'); // half-float textures can be read back as floats
  if (!floatRead && !gl.getExtension('EXT_color_buffer_half_float')) {
    throw new Error('This GPU cannot render to half-float textures.');
  }
  gl.getExtension('OES_texture_float_linear');

  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (w * 2 > maxTex || h * 2 > maxTex) throw new Error("The upscaled video exceeds this GPU's texture limit.");
  // Beyond 2x is optional: halve the scale until the output fits the texture limit, the output
  // cap, and the memory budget for every intermediate texture of the chain.
  let scale = wantScale;
  let passes = orderedPasses(settings, scale);
  const wantReuse = isVideo && frameReuse;
  const tooBig = () => w * scale > maxTex || h * scale > maxTex || w * h * scale * scale > MAX_OUTPUT_PX
    || estimateBytes(passes, w, h, scale, wantReuse) > MAX_TEXTURE_BYTES;
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

  // Video frame texture (RGBA8; the video itself is 8-bit).
  const videoTex = makeTex(w, h, false);
  // Frame reuse (video only): the previous frame is kept to find what changed.
  const reuse = wantReuse ? createFrameReuse(gl, w, h) : null;
  const prevTex = reuse ? makeTex(w, h, false) : null;

  // --- build pass list ------------------------------------------------------
  // Pass outputs share textures once nothing reads them any more (see poolTextures): a long
  // chain needs a handful of textures per size instead of one per pass.
  const plan = planChain(passes, w, h, scale);
  const { slotOf, slots } = poolTextures(plan, !!reuse);
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
      const stencil = reuse?.stencilFor(out.w, out.h);
      fbo = gl!.createFramebuffer()!;
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
      gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, out.tex, 0);
      if (stencil) gl!.framebufferRenderbuffer(gl!.FRAMEBUFFER, gl!.STENCIL_ATTACHMENT, gl!.RENDERBUFFER, stencil);
      if (gl!.checkFramebufferStatus(gl!.FRAMEBUFFER) !== gl!.FRAMEBUFFER_COMPLETE) {
        throw new Error('This GPU cannot render to half-float textures.');
      }
    }
    // Uniform locations are resolved after linking completes (see below).
    const c: CompiledPass = {
      desc, program: prog, output: out, fbo, final: false,
      inputs: inputs.map((i) => ({ ...i, loc: null, sizeLoc: null })),
    };
    compiled.push(c);
    return c;
  }

  for (const s of plan.steps) {
    const inputs = s.inputs.map((inp): PassInput => ({ name: inp.name, tex: texOf(inp.ref) }));
    addPass(s.pass.desc, buildFragmentSource(s.pass, HOOK), inputs, texOf(s.out)).final = s.out === plan.final;
  }

  const finalSize = plan.sizes[plan.final];
  if (finalSize.w !== w * scale || finalSize.h !== h * scale) {
    // Can happen if an x2 WHEN condition failed; keep canvas in sync anyway.
    canvas.width = finalSize.w;
    canvas.height = finalSize.h;
  }
  addPass('present', PRESENT_FRAG, [{ name: 'FRAME', tex: texOf(plan.final) }], null);

  await finishPrograms(gl, pendingPrograms, () => destroyed);
  gl.deleteShader(vs);
  if (destroyed) throw new DOMException('Canceled', 'AbortError');
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
    // Only samplers the shader actually reads take a texture unit (the hooked texture is always
    // declared but often unused).
    c.inputs = c.inputs.filter((inp) => inp.loc || inp.sizeLoc);
    const units = c.inputs.filter((inp) => inp.loc).length;
    if (units > texUnitsAvail) throw new Error(`Pass "${c.desc}" needs ${units} textures; GPU allows ${texUnitsAvail}.`);
  }

  /** Runs every pass; `partial`: only where the stencil buffers are marked (see gpu-reuse.ts). */
  function drawPasses(partial: boolean) {
    if (partial) gl!.enable(gl!.STENCIL_TEST); else gl!.disable(gl!.STENCIL_TEST);
    for (const c of compiled) {
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, c.fbo);
      gl!.viewport(0, 0, c.output ? c.output.w : canvas.width, c.output ? c.output.h : canvas.height);
      gl!.useProgram(c.program);
      if (partial) {
        // The canvas is always drawn in full; it has no stencil buffer.
        if (!c.fbo) gl!.disable(gl!.STENCIL_TEST);
        else if (c.final) gl!.stencilFunc(gl!.EQUAL, REDRAW, 0xff);
        else gl!.stencilFunc(gl!.NOTEQUAL, 0, 0xff);
      }
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
      gl!.drawArrays(gl!.TRIANGLES, 0, 3);
    }
  }

  /**
   * The chain's reach, measured on this very chain and size: draw a noise image, change a 2x2
   * block at its centre, and see how far the final texture differs. It is read as floats, so
   * any influence counts, however small. Null (no frame reuse) when the change spreads past
   * the window read back, e.g. a pass that uses whole-picture statistics.
   */
  function measureReach(): number | null {
    const last = compiled.find((c) => c.final);
    const sx = canvas.width / w;
    const half = Math.min(REACH_WINDOW, Math.floor(Math.min(w, h) / 2) - 1);
    if (!last || !floatRead || half < 8 || !Number.isInteger(sx) || canvas.height !== h * sx) return null;
    const side = 2 * half * sx;
    const px = new Uint8Array(w * h * 4);
    const shots = [new Float32Array(side * side * 4), new Float32Array(side * side * 4)];
    const draw = (into: Float32Array) => {
      gl!.activeTexture(gl!.TEXTURE0);
      gl!.bindTexture(gl!.TEXTURE_2D, videoTex.tex);
      gl!.texSubImage2D(gl!.TEXTURE_2D, 0, 0, 0, w, h, gl!.RGBA, gl!.UNSIGNED_BYTE, px);
      drawPasses(false);
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, last.fbo);
      gl!.readPixels(canvas.width / 2 - half * sx, canvas.height / 2 - half * sx, side, side, gl!.RGBA, gl!.FLOAT, into);
    };
    let worst = 0;
    // Harsh and mild noise: the first drives data-dependent shaders hard, the second avoids
    // clipping that could hide a difference.
    for (const contrast of [255, 96]) {
      for (let i = 0; i < px.length; i++) px[i] = i % 4 === 3 ? 255 : 128 + (Math.random() - 0.5) * contrast;
      draw(shots[0]);
      const cx = Math.floor(w / 2);
      const cy = Math.floor(h / 2);
      for (const [x, y] of [[cx - 1, cy - 1], [cx, cy - 1], [cx - 1, cy], [cx, cy]]) {
        for (let k = 0; k < 3; k++) px[(y * w + x) * 4 + k] = 255 - px[(y * w + x) * 4 + k];
      }
      draw(shots[1]);
      const r = differenceRadius(shots[0], shots[1], side);
      if (r === null || r === 0) return null;
      worst = Math.max(worst, r / sx);
    }
    return Math.ceil(worst * REACH_MARGIN) + 2;
  }
  let reach: number | null = null; // source pixels; null = draw every frame in full
  let prevValid = false; // prevTex holds the frame the final texture was drawn from
  if (reuse?.usable) {
    const key = `${chainKey(settings)}|${w}x${h}|${canvas.width}`;
    if (!reachCache.has(key)) {
      try { reachCache.set(key, measureReach()); } catch { reachCache.set(key, null); }
    }
    reach = reachCache.get(key) ?? null;
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
  let lastFence: WebGLSync | null = null; // signalled when the GPU has finished the last frame

  function busy(): boolean {
    if (!lastFence || destroyed || gl!.isContextLost()) return false;
    if (gl!.getSyncParameter(lastFence, gl!.SYNC_STATUS) !== gl!.SIGNALED) return true;
    gl!.deleteSync(lastFence);
    lastFence = null;
    return false;
  }

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
      reach,
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const q of pendingQueries) gl!.deleteQuery(q);
    pendingQueries.length = 0;
    if (lastFence) gl!.deleteSync(lastFence);
    reuse?.destroy();
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
    // With frame reuse the last frame's texture becomes "previous" and the other one is refilled.
    const canReuse = !!reuse && reach !== null && prevValid && !frame;
    prevValid = false;
    if (prevTex) [videoTex.tex, prevTex.tex] = [prevTex.tex, videoTex.tex];
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

    drawPasses(canReuse && reuse!.mark(videoTex.tex, prevTex!.tex, reach!));
    prevValid = !frame;

    if (query) { gl!.endQuery(timerExt!.TIME_ELAPSED_EXT); pendingQueries.push(query); }
    if (lastFence) gl!.deleteSync(lastFence);
    lastFence = gl!.fenceSync(gl!.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl!.flush();
    lastCpuMs = performance.now() - t0;
    frameTimes.push(t0);
  }

  return { render, busy, destroy, stats };
}

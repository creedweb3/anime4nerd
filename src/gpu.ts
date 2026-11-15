// WebGL2 runner for mpv-format GLSL shader chains (Anime4K and the other engines).
// Loaded lazily by the content script via import(chrome.runtime.getURL('gpu.js')).

import { buildFragmentSource } from './mpv-hooks';
import type { Plane } from './engines';
import type { Settings } from './settings';
import {
  Anime4kRenderer, HOOK_OF, LoadedChain, MAX_OUTPUT_PX, MAX_TEXTURE_BYTES, RenderSource, RenderStats, SourceSizeChanged,
  estimateBytes, loadChain, orderedPasses, planChain, poolTextures,
} from './chain';
import { decodedSize, uploadSize } from './video-size';
import { createWebGpuRenderer, webgpuAvailable } from './gpu-webgpu';
import { engineInfo } from './engines';

export type { Anime4kRenderer, Backend, RenderSource, RenderStats } from './chain';
export { SourceSizeChanged, setShaderBase } from './chain';

/** How often render() re-checks the frame size and GL error state (each check stalls the GPU briefly). */
const HEALTH_CHECK_MS = 1000;

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

/** Why WebGPU failed on this page (auto then stays on WebGL2); null while it has not failed. */
let webgpuFailure: string | null = null;
export function webgpuFailureReason(): string | null { return webgpuFailure; }

export async function createAnime4kRenderer(
  video: RenderSource,
  canvas: HTMLCanvasElement,
  settings: Settings,
  onError: (msg: string) => void,
  wantScale = 2,
): Promise<Anime4kRenderer> {
  const { w, h } = video instanceof ImageBitmap ? { w: video.width, h: video.height } : uploadSize(video);
  if (!w || !h) throw new Error('Waiting for video dimensions.');
  // WebGPU first when asked (or on auto, unless it already failed on this page); on auto any
  // failure falls back to WebGL2 on the same canvas, which WebGPU leaves untouched until it succeeds.
  // Engines built on compute shaders (ArtCNN 1.6) run on WebGPU whatever the setting says.
  const info = engineInfo(settings.engine);
  const mustGpu = settings.backend === 'webgpu' || !!info.webgpuOnly;
  const tryGpu = mustGpu || (settings.backend === 'auto' && webgpuFailure === null && webgpuAvailable());
  if (tryGpu) {
    try {
      return await createWebGpuRenderer(video, canvas, (f16) => loadChain(settings, { wgsl: true, f16 }), onError, wantScale, w, h);
    } catch (e) {
      if (info.webgpuOnly && !(e instanceof DOMException)) {
        throw new Error(`${info.name} needs WebGPU (compute shaders), which is not available here: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (mustGpu || (e instanceof DOMException && e.name === 'SecurityError')) throw e;
      webgpuFailure = e instanceof Error ? e.message : String(e);
    }
  }
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
      backend: 'webgl2',
    };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const q of pendingQueries) gl!.deleteQuery(q);
    pendingQueries.length = 0;
    if (lastFence) gl!.deleteSync(lastFence);
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
    if (lastFence) gl!.deleteSync(lastFence);
    lastFence = gl!.fenceSync(gl!.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl!.flush();
    lastCpuMs = performance.now() - t0;
    frameTimes.push(t0);
  }

  return { render, busy, destroy, stats };
}

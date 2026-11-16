// Frame reuse for the WebGL2 renderer: redraw only what changed since the previous frame.
//
// Anime holds drawings for several video frames and keeps backgrounds still, and a video
// codec decodes such areas to exactly the same pixels. A shader chain is a pure function of
// the pixels within some distance (its "reach") of each output pixel, so where nothing
// within reach changed, last frame's output is already the right answer, bit for bit.
//
// Per frame: compare the new frame with the previous one in TILE x TILE blocks, grow the
// changed blocks by the reach, and write the result into stencil buffers. Passes then run
// with the stencil test on, so the GPU shades only marked pixels:
//   stencil 2 = within reach of a change: the final output must be redrawn here
//   stencil 1 = one more reach out: intermediate passes run here too, because the
//               redrawn output pixels read their results up to one reach away
//   stencil 0 = untouched
//
// When nearly the whole picture changes (a pan, a cut) marking only costs time, so a cheap
// probe reports that and the caller draws such frames in full.

/** Side of a change-detection block, in source pixels. */
export const TILE = 8;

/** Stencil value of pixels whose final output is redrawn. */
export const REDRAW = 2;

/** The probe samples at most this many blocks per side. */
const PROBE_SIDE = 64;

/** A frame with at least this share of the picture marked counts as busy. */
const FULL_DRAW_PERCENT = 85;

/** After this many busy frames in a row, frames are drawn in full (the probe's answer is a frame or two old). */
const BUSY_RUN = 6;

/** While drawing in full, look for a calmer picture only on every n-th frame. */
const BUSY_CHECK_EVERY = 4;

const VERT = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// One texel per block: 1 if any of its source pixels differs from the previous frame.
const DIFF_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_cur;
uniform sampler2D u_prev;
out vec4 o;
void main() {
  ivec2 last = textureSize(u_cur, 0) - 1;
  ivec2 base = ivec2(gl_FragCoord.xy) * ${TILE};
  bool changed = false;
  for (int y = 0; y < ${TILE}; y++) {
    for (int x = 0; x < ${TILE}; x++) {
      ivec2 p = min(base + ivec2(x, y), last);
      if (texelFetch(u_cur, p, 0) != texelFetch(u_prev, p, 0)) changed = true;
    }
  }
  o = vec4(changed ? 1.0 : 0.0);
}`;

// Grows the changed blocks into two masks: r = a change within u_near blocks, g = within
// u_far blocks. A square neighbourhood is a row pass followed by a column pass, which costs
// 2 * (2 * far + 1) reads per block where one pass would cost (2 * far + 1) squared.
// First pass (u_first): reads the changed mask along x. Second: reads the first pass along y.
const GROW_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform ivec2 u_dir;
uniform bool u_first;
uniform int u_near;
uniform int u_far;
out vec4 o;
void main() {
  ivec2 last = textureSize(u_src, 0) - 1;
  ivec2 c = ivec2(gl_FragCoord.xy);
  float near = 0.0;
  float far = 0.0;
  for (int i = -u_far; i <= u_far; i++) {
    ivec2 p = c + u_dir * i;
    if (p.x < 0 || p.y < 0 || p.x > last.x || p.y > last.y) continue;
    vec4 s = texelFetch(u_src, p, 0);
    if ((u_first ? s.r : s.g) > 0.0) far = 1.0;
    if (abs(i) <= u_near && s.r > 0.0) near = 1.0;
  }
  o = vec4(near, far, 0.0, 1.0);
}`;

// Writes the stencil reference wherever the grown mask is set (drawn into a buffer of any size).
const MARK_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_mask;
uniform vec2 u_toBlock; // buffer pixel -> block index
uniform int u_channel;
void main() {
  ivec2 b = min(ivec2(gl_FragCoord.xy * u_toBlock), textureSize(u_mask, 0) - 1);
  vec4 m = texelFetch(u_mask, b, 0);
  if ((u_channel == 0 ? m.r : m.g) == 0.0) discard;
}`;

// Passes its one pixel only if most sampled blocks are marked (see mark()).
const PROBE_FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_mask;
out vec4 o;
void main() {
  ivec2 size = textureSize(u_mask, 0);
  int stride = max(1, (max(size.x, size.y) + ${PROBE_SIDE - 1}) / ${PROBE_SIDE});
  int marked = 0;
  int total = 0;
  for (int y = 0; y < size.y; y += stride) {
    for (int x = 0; x < size.x; x += stride) {
      total++;
      if (texelFetch(u_mask, ivec2(x, y), 0).g > 0.0) marked++;
    }
  }
  if (marked * 100 < total * ${FULL_DRAW_PERCENT}) discard;
  o = vec4(1.0);
}`;

export interface FrameReuse {
  /** False if this GPU cannot do it (no stencil-only framebuffer); then draw every frame in full. */
  readonly usable: boolean;
  /** The stencil buffer for pass outputs of this size; attach it to their framebuffers. */
  stencilFor(w: number, h: number): WebGLRenderbuffer;
  /**
   * Marks what must be redrawn given the new and the previous frame, in every stencil
   * buffer, and returns true: the stencil test is left enabled and read-only, and the caller
   * picks the function. Returns false, with nothing marked, while recent frames changed
   * nearly everywhere: draw this one in full.
   */
  mark(cur: WebGLTexture, prev: WebGLTexture, reach: number): boolean;
  destroy(): void;
}

export function createFrameReuse(gl: WebGL2RenderingContext, w: number, h: number): FrameReuse {
  const bw = Math.ceil(w / TILE);
  const bh = Math.ceil(h / TILE);

  function program(frag: string): WebGLProgram {
    const prog = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, VERT], [gl.FRAGMENT_SHADER, frag]] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      gl.attachShader(prog, sh);
      gl.deleteShader(sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`Frame reuse shader failed: ${gl.getProgramInfoLog(prog)}`);
    return prog;
  }
  const diff = program(DIFF_FRAG);
  const grow = program(GROW_FRAG);
  const markProg = program(MARK_FRAG);
  const probe = program(PROBE_FRAG);
  const loc = (p: WebGLProgram, n: string) => gl.getUniformLocation(p, n);
  const u = {
    cur: loc(diff, 'u_cur'), prev: loc(diff, 'u_prev'),
    src: loc(grow, 'u_src'), dir: loc(grow, 'u_dir'), first: loc(grow, 'u_first'), near: loc(grow, 'u_near'), far: loc(grow, 'u_far'),
    mask: loc(markProg, 'u_mask'), toBlock: loc(markProg, 'u_toBlock'), channel: loc(markProg, 'u_channel'),
    probeMask: loc(probe, 'u_mask'),
  };

  function target(format: number, tw = bw, th = bh): { tex: WebGLTexture; fbo: WebGLFramebuffer } {
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, format, tw, th);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo };
  }
  const changed = target(gl.R8);
  const rows = target(gl.RG8); // the row pass of the growing
  const grown = target(gl.RG8);
  const probed = target(gl.R8, 1, 1);
  // The probe's answer arrives a frame or two later, through an occlusion query.
  let probeQuery: WebGLQuery | null = null;
  let busyRun = 0; // busy frames in a row
  let calls = 0;
  let usable = true;

  // One stencil buffer per output size, with a framebuffer of its own to mark it through.
  const stencils = new Map<string, { rb: WebGLRenderbuffer; fbo: WebGLFramebuffer; w: number; h: number }>();
  function stencilFor(sw: number, sh: number): WebGLRenderbuffer {
    const key = `${sw}x${sh}`;
    let s = stencils.get(key);
    if (!s) {
      const rb = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.STENCIL_INDEX8, sw, sh);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, rb);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) usable = false;
      s = { rb, fbo, w: sw, h: sh };
      stencils.set(key, s);
    }
    return s.rb;
  }

  function mark(cur: WebGLTexture, prev: WebGLTexture, reach: number): boolean {
    if (probeQuery && gl.getQueryParameter(probeQuery, gl.QUERY_RESULT_AVAILABLE)) {
      busyRun = gl.getQueryParameter(probeQuery, gl.QUERY_RESULT) ? busyRun + 1 : 0;
      gl.deleteQuery(probeQuery);
      probeQuery = null;
    }
    calls += 1;
    if (busyRun >= BUSY_RUN && calls % BUSY_CHECK_EVERY) return false;
    gl.disable(gl.STENCIL_TEST);
    gl.viewport(0, 0, bw, bh);
    gl.bindFramebuffer(gl.FRAMEBUFFER, changed.fbo);
    gl.useProgram(diff);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, prev);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, cur);
    gl.uniform1i(u.cur, 0);
    gl.uniform1i(u.prev, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.useProgram(grow);
    gl.uniform1i(u.src, 0);
    // Changes are known per block, so both distances are whole blocks; far - near must still
    // cover a full reach.
    const near = Math.ceil(reach / TILE);
    gl.uniform1i(u.near, near);
    gl.uniform1i(u.far, 2 * near);
    gl.bindFramebuffer(gl.FRAMEBUFFER, rows.fbo);
    gl.bindTexture(gl.TEXTURE_2D, changed.tex);
    gl.uniform2i(u.dir, 1, 0);
    gl.uniform1i(u.first, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, grown.fbo);
    gl.bindTexture(gl.TEXTURE_2D, rows.tex);
    gl.uniform2i(u.dir, 0, 1);
    gl.uniform1i(u.first, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindTexture(gl.TEXTURE_2D, grown.tex);
    if (!probeQuery) {
      probeQuery = gl.createQuery();
      gl.viewport(0, 0, 1, 1);
      gl.bindFramebuffer(gl.FRAMEBUFFER, probed.fbo);
      gl.useProgram(probe);
      gl.uniform1i(u.probeMask, 0);
      gl.beginQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE, probeQuery!);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.endQuery(gl.ANY_SAMPLES_PASSED_CONSERVATIVE);
    }
    if (busyRun >= BUSY_RUN) return false;

    gl.useProgram(markProg);
    gl.uniform1i(u.mask, 0);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilMask(0xff);
    gl.stencilOp(gl.REPLACE, gl.REPLACE, gl.REPLACE);
    gl.clearStencil(0);
    for (const s of stencils.values()) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, s.fbo);
      gl.viewport(0, 0, s.w, s.h);
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.uniform2f(u.toBlock, w / s.w / TILE, h / s.h / TILE);
      gl.uniform1i(u.channel, 1);
      gl.stencilFunc(gl.ALWAYS, 1, 0xff);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.uniform1i(u.channel, 0);
      gl.stencilFunc(gl.ALWAYS, REDRAW, 0xff);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.stencilMask(0);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
    return true;
  }

  function destroy(): void {
    for (const p of [diff, grow, markProg, probe]) gl.deleteProgram(p);
    for (const t of [changed, rows, grown, probed]) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    if (probeQuery) gl.deleteQuery(probeQuery);
    for (const s of stencils.values()) { gl.deleteRenderbuffer(s.rb); gl.deleteFramebuffer(s.fbo); }
    stencils.clear();
  }

  return { get usable() { return usable; }, stencilFor, mark, destroy };
}

/**
 * How far (in pixels) two renders of a square window differ from the window's centre, given
 * their RGBA values: the reach of a change made at the centre. Null if the difference touches
 * the window's edge, where it may extend further than was read.
 */
export function differenceRadius(a: ArrayLike<number>, b: ArrayLike<number>, side: number): number | null {
  let radius = 0;
  const c = side / 2;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const i = (y * side + x) * 4;
      if (a[i] === b[i] && a[i + 1] === b[i + 1] && a[i + 2] === b[i + 2] && a[i + 3] === b[i + 3]) continue;
      if (x === 0 || y === 0 || x === side - 1 || y === side - 1) return null;
      radius = Math.max(radius, Math.abs(x + 0.5 - c), Math.abs(y + 0.5 - c));
    }
  }
  return radius;
}

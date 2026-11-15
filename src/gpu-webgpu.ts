// WebGPU runner for the same shader chains as gpu.ts (WebGL2). The passes are the mpv GLSL
// shaders translated to WGSL at build time (tools/wgsl-gen.ts); the chain is laid out by the
// same planner (chain.ts), so both backends run identical passes on identically sized,
// identically shared textures. What WebGPU adds: the video frame is imported without a CPU-side
// upload (importExternalTexture), and pipelines/bind groups are built once.
//
// Nothing touches the canvas until everything else has succeeded, so on any failure the caller
// can still fall back to WebGL2 on the same canvas.

import {
  Anime4kRenderer, LoadedChain, MAX_OUTPUT_PX, MAX_TEXTURE_BYTES, RenderSource, RenderStats, SourceSizeChanged,
  estimateBytes, orderedPasses, passWgsl, planChain, poolTextures,
} from './chain';
import { COMPUTE_OUT_BINDING, MAX_PASS_TEXTURES } from './mpv-hooks';
import type { Plane } from './engines';
import { decodedSize } from './video-size';

/** How often render() re-checks the decoded frame size. */
const HEALTH_CHECK_MS = 1000;
const FORMAT: GPUTextureFormat = 'rgba16float';
const UNIFORM_BYTES = (MAX_PASS_TEXTURES + 1) * 16; // vec4 u_size[16]; vec4 u_offset

const VERT = /* wgsl */ `
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn main(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2f(f32((i & 1u) << 2u) - 1.0, f32((i & 2u) << 1u) - 1.0);
  var o: VOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); // uv.y = 0 is texel row 0 (top), as in gpu.ts
  return o;
}`;

/** Copies the imported video frame into texture 0 (RGBA8), like gpu.ts's per-frame upload. */
const COPY_FRAG = /* wgsl */ `
@group(0) @binding(1) var s_lin: sampler;
@group(0) @binding(3) var SRC: texture_external;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(textureSampleBaseClampToEdge(SRC, s_lin, uv).rgb, 1.0);
}`;

const UNIFORMS = /* wgsl */ `
struct P { u_size: array<vec4f, ${MAX_PASS_TEXTURES}>, u_offset: vec4f };
@group(0) @binding(0) var<uniform> u: P;
@group(0) @binding(1) var s_lin: sampler;`;

// Full-range BT.709, as gpu.ts.
const TO_PLANE_FRAG = (plane: Plane) => /* wgsl */ `${UNIFORMS}
@group(0) @binding(3) var SRC: texture_2d<f32>;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSample(SRC, s_lin, uv).rgb;
  let y = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  ${plane === 'luma' ? 'return vec4f(y, 0.0, 0.0, 1.0);' : 'return vec4f(y, (c.b - y) / 1.8556 + 0.5, (c.r - y) / 1.5748 + 0.5, 1.0);'}
}`;

/** Final draw to the canvas; for Y / YCbCr chains it also converts back to RGB (no flip needed in WebGPU). */
const PRESENT_FRAG = (plane: Plane) => /* wgsl */ `${UNIFORMS}
@group(0) @binding(3) var PLANE: texture_2d<f32>;
@group(0) @binding(4) var SRC: texture_2d<f32>;
@fragment fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  ${plane === 'rgb' ? 'return vec4f(textureSample(PLANE, s_lin, uv).rgb, 1.0);' : `
  let p = textureSample(PLANE, s_lin, uv + u.u_offset.xy / u.u_size[0].xy);
  let y = p.x;
  var cbcr: vec2f;
  ${plane === 'luma' ? `let c = textureSample(SRC, s_lin, uv).rgb;
  let sy = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  cbcr = vec2f((c.b - sy) / 1.8556, (c.r - sy) / 1.5748);` : 'cbcr = p.yz - 0.5;'}
  let r = y + 1.5748 * cbcr.y;
  let b = y + 1.8556 * cbcr.x;
  let g = (y - 0.2126 * r - 0.0722 * b) / 0.7152;
  return vec4f(clamp(vec3f(r, g, b), vec3f(0.0), vec3f(1.0)), 1.0);`}
}`;

/** Bind group layout entries for the @group(0) bindings a WGSL module declares. */
function layoutEntries(code: string, visibility: number = GPUShaderStage.FRAGMENT): GPUBindGroupLayoutEntry[] {
  const out: GPUBindGroupLayoutEntry[] = [];
  const re = /@group\(0\)\s*@binding\((\d+)\)\s*var(<[^>]*>)?\s+\w+\s*:\s*([^;]+);/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const binding = Number(m[1]);
    const type = m[3].trim();
    if (m[2]?.includes('uniform')) out.push({ binding, visibility, buffer: { type: 'uniform' } });
    else if (type === 'sampler') out.push({ binding, visibility, sampler: { type: 'filtering' } });
    else if (type === 'texture_external') out.push({ binding, visibility, externalTexture: {} });
    else if (type.startsWith('texture_storage_2d')) out.push({ binding, visibility, storageTexture: { access: 'write-only', format: FORMAT } });
    else if (type.startsWith('texture_2d')) out.push({ binding, visibility, texture: { sampleType: 'float' } });
    else throw new Error(`Unsupported WGSL binding ${binding}: ${type}`);
  }
  return out;
}

/** float32 -> IEEE half bits (for lookup tables uploaded as rgba16float). */
function toHalf(f: number): number {
  const x = new Uint32Array(new Float32Array([f]).buffer)[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
  const man = x & 0x7fffff;
  if (exp <= 0) return sign | (exp < -10 ? 0 : (((man | 0x800000) >> (1 - exp)) + 0x1000) >> 13);
  if (exp >= 31) return sign | 0x7c00;
  return sign | (exp << 10) | ((man + 0x1000) >> 13);
}

/** Whether this browser exposes WebGPU at all (an adapter may still be refused). */
export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu;
}

type Pass = {
  kind: 'render';
  pipeline: GPURenderPipeline;
  bindGroup: GPUBindGroup | null; // null: built per frame (the copy pass, which imports the frame)
  target: GPUTextureView | null; // null: the canvas
} | {
  kind: 'compute';
  pipeline: GPUComputePipeline;
  bindGroup: GPUBindGroup;
  groups: [number, number]; // workgroups to dispatch
};

export async function createWebGpuRenderer(
  video: RenderSource,
  canvas: HTMLCanvasElement,
  loadChainFor: (f16: boolean) => Promise<LoadedChain>,
  onError: (msg: string) => void,
  wantScale: number,
  w: number,
  h: number,
): Promise<Anime4kRenderer> {
  if (!webgpuAvailable()) throw new Error('WebGPU is unavailable in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter.');
  const timestamps = adapter.features.has('timestamp-query');
  // Half-precision arithmetic (ArtCNN 1.6's compute passes have an f16 build): about twice the
  // maths rate on most recent GPUs.
  const f16 = adapter.features.has('shader-f16');
  const chain = await loadChainFor(f16);
  const device = await adapter.requestDevice({
    requiredFeatures: [...(timestamps ? ['timestamp-query' as const] : []), ...(f16 ? ['shader-f16' as const] : [])],
    // ArtCNN C4F32's compute passes keep 32 KB of float32 tiles in workgroup memory; the
    // default limit is 16 KB, most desktop GPUs allow 32 KB.
    requiredLimits: { maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize },
  });
  let destroyed = false;
  let ready = false;
  device.lost.then((info) => {
    if (!destroyed && ready && info.reason !== 'destroyed') onError('The GPU connection was lost. Turn Anime4K off and on to retry.');
  });
  try {
    const isVideo = !(video instanceof ImageBitmap);
    const maxTex = device.limits.maxTextureDimension2D;
    if (w * 2 > maxTex || h * 2 > maxTex) throw new Error("The upscaled video exceeds this GPU's texture limit.");
    let scale = wantScale;
    let { passes, textures } = orderedPasses(chain, scale, true);
    const tooBig = () => w * scale > maxTex || h * scale > maxTex || w * h * scale * scale > MAX_OUTPUT_PX
      || estimateBytes(passes, textures, chain.plane, w, h, scale) > MAX_TEXTURE_BYTES;
    while (scale > 2 && tooBig()) { scale /= 2; ({ passes, textures } = orderedPasses(chain, scale, true)); }
    for (const p of passes) if (!passWgsl(p)) throw new Error(`No WGSL for pass "${p.desc}".`);

    device.pushErrorScope('validation');
    device.pushErrorScope('out-of-memory');

    // --- textures (same plan and pooling as gpu.ts) ----------------------------
    const plan = planChain(passes, new Set(textures.map((t) => t.name)), chain.plane, w, h, scale);
    const { slotOf, slots } = poolTextures(plan);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    // Compute passes write their output as a storage image (rgba16float only; texture 0 is never written by one).
    const hasCompute = plan.steps.some((s) => s.pass?.compute);
    const allTex: GPUTexture[] = [];
    let textureBytes = 0;
    const slotTex = slots.map((s, i) => {
      const t = device.createTexture({ size: [s.w, s.h], format: i === 0 ? 'rgba8unorm' : FORMAT,
        usage: usage | (i > 0 && hasCompute ? GPUTextureUsage.STORAGE_BINDING : 0),
      });
      allTex.push(t);
      textureBytes += s.w * s.h * (i === 0 ? 4 : 8);
      return t;
    });
    const texOf = (id: number) => slotTex[slotOf[id]];
    const lookup = new Map<string, GPUTexture>();
    for (const ut of textures) {
      if (ut.format !== 'rgba16f' && ut.format !== 'rgba32f') throw new Error(`Lookup texture ${ut.name} has unsupported format ${ut.format}.`);
      // mpv's dumps hold float32 even for 16f formats; WebGPU wants the exact texel bytes.
      const floats32 = ut.data.byteLength === ut.w * ut.h * 16;
      const half = floats32
        ? Uint16Array.from(new Float32Array(ut.data.buffer, ut.data.byteOffset, ut.data.byteLength >> 2), toHalf)
        : new Uint16Array(ut.data.buffer, ut.data.byteOffset, ut.data.byteLength >> 1);
      const t = device.createTexture({ size: [ut.w, ut.h], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
      device.queue.writeTexture({ texture: t }, half, { bytesPerRow: ut.w * 8 }, [ut.w, ut.h]);
      allTex.push(t);
      textureBytes += ut.w * ut.h * 8;
      lookup.set(ut.name, t);
    }

    const finalSize = plan.sizes[plan.final];
    const sLin = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const sNear = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
    const vertex = device.createShaderModule({ code: VERT });
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    const buffers: GPUBuffer[] = [];

    async function pipelineFor(code: string, format: GPUTextureFormat, label: string) {
      const module = device.createShaderModule({ code, label });
      const layout = device.createBindGroupLayout({ entries: layoutEntries(code) });
      const pipeline = await device.createRenderPipelineAsync({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        vertex: { module: vertex, entryPoint: 'main' },
        fragment: { module, entryPoint: 'main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      return { pipeline, layout };
    }

    async function computePipelineFor(code: string, label: string) {
      const module = device.createShaderModule({ code, label });
      const layout = device.createBindGroupLayout({ entries: layoutEntries(code, GPUShaderStage.COMPUTE) });
      const pipeline = await device.createComputePipelineAsync({
        label,
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'main' },
      });
      return { pipeline, layout };
    }

    /** `offset`: u_offset (x, y = plane shift for present; z, w = output size for compute passes). */
    function bindGroupFor(layout: GPUBindGroupLayout, code: string, texs: GPUTexture[], offset: [number, number, number?, number?], out?: GPUTexture) {
      const u = new Float32Array(UNIFORM_BYTES / 4);
      texs.forEach((t, i) => { u[i * 4] = t.width; u[i * 4 + 1] = t.height; });
      u[MAX_PASS_TEXTURES * 4] = offset[0];
      u[MAX_PASS_TEXTURES * 4 + 1] = offset[1];
      u[MAX_PASS_TEXTURES * 4 + 2] = offset[2] ?? 0;
      u[MAX_PASS_TEXTURES * 4 + 3] = offset[3] ?? 0;
      const buf = device.createBuffer({ size: UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, u);
      buffers.push(buf);
      const entries: GPUBindGroupEntry[] = layoutEntries(code).map((e) => {
        if (e.binding === 0) return { binding: 0, resource: { buffer: buf } };
        if (e.binding === 1) return { binding: 1, resource: sLin };
        if (e.binding === 2) return { binding: 2, resource: sNear };
        if (e.binding === COMPUTE_OUT_BINDING) return { binding: e.binding, resource: out!.createView() };
        return { binding: e.binding, resource: texs[e.binding - 3].createView() };
      });
      return device.createBindGroup({ layout, entries });
    }

    // --- pipelines ------------------------------------------------------------------
    const copy = await pipelineFor(COPY_FRAG, 'rgba8unorm', 'copy video');
    const steps: Pass[] = [{ kind: 'render', pipeline: copy.pipeline, bindGroup: null, target: texOf(0).createView() }];
    const built = await Promise.all(plan.steps.map(async (s) => {
      const code = s.kind === 'to-plane' ? TO_PLANE_FRAG(chain.plane) : passWgsl(s.pass!)!.code;
      const label = s.pass?.desc ?? 'to plane';
      return { pl: s.pass?.compute ? await computePipelineFor(code, label) : await pipelineFor(code, FORMAT, label), code, s };
    }));
    for (const { pl, code, s } of built) {
      // Texture order: what the WGSL binds at 3, 4, ... (the translation's own list).
      const names = s.kind === 'to-plane' ? ['SRC'] : passWgsl(s.pass!)!.textures;
      const texs = names.map((n) => {
        const inp = s.inputs.find((i) => i.name === n);
        if (!inp) throw new Error(`Pass binds ${n}, which the plan does not provide.`);
        return typeof inp.ref === 'string' ? lookup.get(inp.ref)! : texOf(inp.ref);
      });
      const out = texOf(s.out);
      const cs = s.pass?.computeSize;
      if (cs) {
        steps.push({
          kind: 'compute',
          pipeline: pl.pipeline as GPUComputePipeline,
          bindGroup: bindGroupFor(pl.layout, code, texs, [0, 0, out.width, out.height], out),
          groups: [Math.ceil(out.width / cs[0]), Math.ceil(out.height / cs[1])],
        });
      } else {
        steps.push({ kind: 'render', pipeline: pl.pipeline as GPURenderPipeline, bindGroup: bindGroupFor(pl.layout, code, texs, [0, 0]), target: out.createView() });
      }
    }
    const presentCode = PRESENT_FRAG(chain.plane);
    const present = await pipelineFor(presentCode, canvasFormat, 'present');
    steps.push({
      kind: 'render',
      pipeline: present.pipeline,
      bindGroup: bindGroupFor(present.layout, presentCode, [texOf(plan.final), texOf(0)], plan.offset),
      target: null,
    });

    const oom = await device.popErrorScope();
    const invalid = await device.popErrorScope();
    if (oom || invalid) throw new Error(`WebGPU setup failed: ${(oom ?? invalid)!.message}`);

    // --- GPU timing ---------------------------------------------------------------------
    const querySet = timestamps ? device.createQuerySet({ type: 'timestamp', count: 2 }) : null;
    const resolveBuf = querySet ? device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) : null;
    const readBufs: GPUBuffer[] = [];
    let lastGpuMs: number | null = null;
    const recent: { t: number; ms: number }[] = [];
    let lastCpuMs = 0;
    const frameTimes: number[] = [];
    let lastHealthCheck = -Infinity;
    let inFlight = 0; // submitted frames the GPU has not finished

    // Only now take the canvas: past this point a failure can no longer fall back on it.
    canvas.width = finalSize.w;
    canvas.height = finalSize.h;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('This canvas cannot use WebGPU.');
    ctx.configure({ device, format: canvasFormat, alphaMode: 'opaque' });
    ready = true;

    function stats(): RenderStats {
      const now = performance.now();
      while (frameTimes.length && now - frameTimes[0] > 2000) frameTimes.shift();
      while (recent.length && now - recent[0].t > 2000) recent.shift();
      return {
        gpuMs: lastGpuMs,
        samples: recent.map((r) => r.ms),
        cpuMs: lastCpuMs,
        fps: frameTimes.length / 2,
        passes: steps.length,
        textureBytes,
        outputWidth: canvas.width,
        outputHeight: canvas.height,
        timerSupported: timestamps,
        backend: 'webgpu',
      };
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const t of allTex) t.destroy();
      for (const b of [...buffers, ...readBufs]) b.destroy();
      resolveBuf?.destroy();
      querySet?.destroy();
      try { ctx!.unconfigure(); } catch { /* already gone */ }
      device.destroy();
    }

    function render(frame?: RenderSource) {
      if (destroyed) return;
      const t0 = performance.now();
      const src = frame ?? video;
      if (isVideo && t0 - lastHealthCheck >= HEALTH_CHECK_MS) {
        lastHealthCheck = t0;
        const size = decodedSize(video as HTMLVideoElement); // null = unreadable right now; don't treat as a change
        if (size && (size.w !== w || size.h !== h)) throw new SourceSizeChanged();
      }
      // A still (manga page) is wrapped as a VideoFrame so both kinds import the same way.
      const vf = src instanceof ImageBitmap ? new VideoFrame(src, { timestamp: 0 }) : null;
      try {
        // Throws SecurityError for a cross-origin video without CORS, like WebGL's upload.
        const ext = device.importExternalTexture({ source: vf ?? (src as HTMLVideoElement) });
        const copyGroup = device.createBindGroup({
          layout: copy.layout,
          entries: [{ binding: 1, resource: sLin }, { binding: 3, resource: ext }],
        });
        const enc = device.createCommandEncoder();
        const canvasView = ctx!.getCurrentTexture().createView();
        const lastIdx = steps.length - 1;
        steps.forEach((p, i) => {
          if (p.kind === 'compute') {
            const cp = enc.beginComputePass();
            cp.setPipeline(p.pipeline);
            cp.setBindGroup(0, p.bindGroup);
            cp.dispatchWorkgroups(p.groups[0], p.groups[1]);
            cp.end();
            return;
          }
          // The first (copy) and last (present) passes are render passes, so they bracket the timing.
          const tw: GPURenderPassTimestampWrites | undefined = querySet && (i === 0 || i === lastIdx)
            ? { querySet, ...(i === 0 ? { beginningOfPassWriteIndex: 0 } : {}), ...(i === lastIdx ? { endOfPassWriteIndex: 1 } : {}) }
            : undefined;
          const pass = enc.beginRenderPass({
            colorAttachments: [{ view: p.target ?? canvasView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
            ...(tw ? { timestampWrites: tw } : {}),
          });
          pass.setPipeline(p.pipeline);
          pass.setBindGroup(0, p.bindGroup ?? copyGroup);
          pass.draw(3);
          pass.end();
        });
        let readBuf: GPUBuffer | null = null;
        if (querySet && resolveBuf) {
          readBuf = readBufs.pop() ?? device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
          enc.resolveQuerySet(querySet, 0, 2, resolveBuf, 0);
          enc.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, 16);
        }
        device.queue.submit([enc.finish()]);
        inFlight += 1;
        device.queue.onSubmittedWorkDone().then(() => { inFlight -= 1; }, () => { /* device gone */ });
        if (readBuf) {
          const rb = readBuf;
          rb.mapAsync(GPUMapMode.READ).then(() => {
            const [a, b] = new BigInt64Array(rb.getMappedRange());
            rb.unmap();
            if (destroyed) { rb.destroy(); return; }
            const ms = Number(b - a) / 1e6;
            if (ms > 0 && ms < 1000) { lastGpuMs = ms; recent.push({ t: performance.now(), ms }); }
            if (readBufs.length < 4) readBufs.push(rb); else rb.destroy();
          }, () => { /* device gone */ });
        }
      } finally {
        vf?.close();
      }
      lastCpuMs = performance.now() - t0;
      frameTimes.push(t0);
    }

    return { render, busy: () => !destroyed && inFlight > 0, destroy, stats };
  } catch (e) {
    destroyed = true;
    device.destroy();
    throw e;
  }
}

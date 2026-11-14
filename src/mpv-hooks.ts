// Parser for mpv "user shader" GLSL files (the format Anime4K, FSRCNNX, RAVU, NNEDI3 and the
// FidelityFX ports ship in). A file holds several passes, each a run of //! directives
// followed by GLSL that defines `vec4 hook()`, plus optional //!TEXTURE blocks holding lookup
// tables. See mpv's DOCS/man/options.rst "glsl-shaders".

export interface HookPass {
  desc: string;
  hook: string; // texture stage this pass hooks (MAIN, PREKERNEL, LUMA, ...)
  binds: string[]; // textures the body may sample; "HOOKED" means the hooked one
  save: string | null; // texture name to write; null = overwrite the hooked texture
  width: string[] | null; // RPN tokens, null = same as hooked
  height: string[] | null;
  when: string[] | null; // RPN tokens, pass runs only if result != 0
  offset: [number, number] | null; // pixel shift this pass introduces, in its output's pixels
  components: number;
  compute: boolean; // //!COMPUTE passes need compute shaders, which WebGL2 lacks
  body: string;
}

/** A //!TEXTURE block: a lookup table that passes sample by name. */
export interface UserTexture {
  name: string;
  w: number;
  h: number;
  format: string; // mpv format name, e.g. rgba16f
  linear: boolean; // FILTER LINEAR (default NEAREST)
  data: Uint8Array; // raw texel bytes, decoded from the hex dump
}

export interface ShaderFile {
  passes: HookPass[];
  textures: UserTexture[];
}

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function newPass(): HookPass {
  return {
    desc: '', hook: 'MAIN', binds: [], save: null, width: null, height: null, when: null,
    offset: null, components: 4, compute: false, body: '',
  };
}

export function parseShaderFile(source: string): ShaderFile {
  const passes: HookPass[] = [];
  const textures: UserTexture[] = [];
  let cur: HookPass | null = null;
  let tex: (Omit<UserTexture, 'data'> & { hex: string[] }) | null = null;
  const endTexture = () => {
    if (tex) textures.push({ name: tex.name, w: tex.w, h: tex.h, format: tex.format, linear: tex.linear, data: hexBytes(tex.hex.join('')) });
    tex = null;
  };
  for (const line of source.split(/\r?\n/)) {
    const m = /^\/\/!(\w+)\s*(.*)$/.exec(line);
    if (!m) {
      if (tex) { if (line.trim()) tex.hex.push(line.trim()); } else if (cur) cur.body += `${line}\n`;
      continue;
    }
    const [, key, rawVal] = m;
    const val = rawVal.trim();
    if (key === 'TEXTURE') {
      endTexture();
      cur = null;
      tex = { name: val, w: 1, h: 1, format: 'rgba8', linear: false, hex: [] };
      continue;
    }
    if (tex) {
      if (key === 'SIZE') { const [a, b] = val.split(/\s+/).map(Number); tex.w = a; tex.h = b || 1; continue; }
      if (key === 'FORMAT') { tex.format = val; continue; }
      if (key === 'FILTER') { tex.linear = val === 'LINEAR'; continue; }
      if (key === 'BORDER') continue;
      endTexture(); // any other directive starts a pass
    }
    // A pass's directives are contiguous, so a directive after body text starts the next pass.
    if (!cur || cur.body.trim() !== '') { cur = newPass(); passes.push(cur); }
    switch (key) {
      case 'DESC': cur.desc = val; break;
      case 'HOOK': cur.hook = val; break;
      case 'BIND': cur.binds.push(val); break;
      case 'SAVE': cur.save = val; break;
      case 'WIDTH': cur.width = val.split(/\s+/); break;
      case 'HEIGHT': cur.height = val.split(/\s+/); break;
      case 'WHEN': cur.when = val.split(/\s+/); break;
      case 'COMPONENTS': cur.components = parseInt(val, 10) || 4; break;
      case 'COMPUTE': cur.compute = true; break;
      case 'OFFSET': {
        const [x, y] = val.split(/\s+/).map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) cur.offset = [x, y]; // "ALIGN" keeps the alignment: no shift
        break;
      }
      default: break;
    }
  }
  endTexture();
  return { passes, textures };
}

/** The passes of a file, for callers that need no lookup tables. */
export function parseHookPasses(source: string): HookPass[] {
  return parseShaderFile(source).passes;
}

/** Evaluate an mpv RPN size/condition expression. `lookup("NAME.w")` supplies texture sizes. */
export function evalRpn(tokens: string[], lookup: (ref: string) => number): number {
  const st: number[] = [];
  const pop = () => {
    const v = st.pop();
    if (v === undefined) throw new Error(`RPN underflow in "${tokens.join(' ')}"`);
    return v;
  };
  for (const t of tokens) {
    if (/^-?\d/.test(t)) { st.push(parseFloat(t)); continue; }
    if (/^\w+\.[wh]$/.test(t)) { st.push(lookup(t)); continue; }
    switch (t) {
      case '+': { const b = pop(); const a = pop(); st.push(a + b); break; }
      case '-': { const b = pop(); const a = pop(); st.push(a - b); break; }
      case '*': { const b = pop(); const a = pop(); st.push(a * b); break; }
      case '/': { const b = pop(); const a = pop(); st.push(a / b); break; }
      case '>': { const b = pop(); const a = pop(); st.push(a > b ? 1 : 0); break; }
      case '<': { const b = pop(); const a = pop(); st.push(a < b ? 1 : 0); break; }
      case '=': { const b = pop(); const a = pop(); st.push(a === b ? 1 : 0); break; }
      case '!': { const a = pop(); st.push(a === 0 ? 1 : 0); break; }
      default: throw new Error(`Unknown RPN token "${t}"`);
    }
  }
  return pop();
}

/**
 * Wrap a pass body into a complete GLSL ES 3.00 fragment shader, providing the
 * mpv texture macros for every bound texture:
 *   NAME_raw (sampler), NAME_pos, NAME_size, NAME_pt, NAME_mul, NAME_tex(pos), NAME_texOff(off)
 * HOOKED_* aliases the hooked texture. Names in `userTextures` are lookup tables, which mpv
 * binds as a plain sampler under their own name.
 */
export function buildFragmentSource(pass: HookPass, hookedName: string, userTextures: ReadonlySet<string> = new Set()): string {
  const names = new Set<string>();
  for (const b of pass.binds) names.add(b === 'HOOKED' ? hookedName : b);
  // Bodies sometimes reference the hooked texture by its real name without binding it.
  names.add(hookedName);

  let src = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';
  src += 'in vec2 v_uv;\nout vec4 fragColor;\n';
  for (const n of names) {
    if (userTextures.has(n)) {
      src += `uniform sampler2D ${n};\nuniform vec2 ${n}_size;\n#define ${n}_pt (1.0 / ${n}_size)\n`;
      continue;
    }
    src += `uniform sampler2D ${n}_raw;\nuniform vec2 ${n}_size;\n`
      + `#define ${n}_pt (1.0 / ${n}_size)\n`
      + `#define ${n}_pos v_uv\n`
      + `#define ${n}_mul 1.0\n`
      + `#define ${n}_tex(pos) texture(${n}_raw, (pos))\n`
      + `#define ${n}_texOff(off) ${n}_tex(${n}_pos + ${n}_pt * vec2(off))\n`;
  }
  if (hookedName !== 'HOOKED') {
    for (const suf of ['raw', 'size', 'pt', 'pos', 'mul', 'tex', 'texOff']) {
      src += `#define HOOKED_${suf} ${hookedName}_${suf}\n`;
    }
  }
  src += `#line 1\n${pass.body}\nvoid main() { fragColor = hook(); }\n`;
  return src;
}

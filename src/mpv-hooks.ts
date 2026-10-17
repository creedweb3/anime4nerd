// Parser for mpv "user shader" GLSL files (the format bloc97's Anime4K ships in).
// A file holds several passes. Each pass starts with //! directives followed by
// GLSL that defines `vec4 hook()`. See mpv's DOCS/man/options.rst "glsl-shaders".

export interface HookPass {
  desc: string;
  hook: string; // texture stage this pass hooks (MAIN, PREKERNEL, ...)
  binds: string[]; // textures the body may sample; "HOOKED" means the hooked one
  save: string | null; // texture name to write; null = overwrite the hooked texture
  width: string[] | null; // RPN tokens, null = same as hooked
  height: string[] | null;
  when: string[] | null; // RPN tokens, pass runs only if result != 0
  components: number;
  body: string;
}

export function parseHookPasses(source: string): HookPass[] {
  const passes: HookPass[] = [];
  let cur: HookPass | null = null;
  const lines = source.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\/\/!(\w+)\s*(.*)$/.exec(line);
    if (m) {
      const [, key, rawVal] = m;
      const val = rawVal.trim();
      if (key === 'DESC') {
        cur = {
          desc: val, hook: 'MAIN', binds: [], save: null, width: null, height: null, when: null, components: 4, body: '',
        };
        passes.push(cur);
        continue;
      }
      if (!cur) continue;
      switch (key) {
        case 'HOOK': cur.hook = val; break;
        case 'BIND': cur.binds.push(val); break;
        case 'SAVE': cur.save = val; break;
        case 'WIDTH': cur.width = val.split(/\s+/); break;
        case 'HEIGHT': cur.height = val.split(/\s+/); break;
        case 'WHEN': cur.when = val.split(/\s+/); break;
        case 'COMPONENTS': cur.components = parseInt(val, 10) || 4; break;
        default: break; // OFFSET, COMPUTE etc. are not used by the Anime4K files we ship
      }
      continue;
    }
    if (cur) cur.body += `${line}\n`;
  }
  return passes;
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
      case '!': { const a = pop(); st.push(a === 0 ? 1 : 0); break; }
      default: throw new Error(`Unknown RPN token "${t}"`);
    }
  }
  return pop();
}

/**
 * Wrap a pass body into a complete GLSL ES 3.00 fragment shader, providing the
 * mpv texture macros for every bound texture:
 *   NAME_raw (sampler), NAME_pos, NAME_size, NAME_pt, NAME_tex(pos), NAME_texOff(off)
 * HOOKED_* aliases the hooked texture.
 */
export function buildFragmentSource(pass: HookPass, hookedName: string): string {
  const names = new Set<string>();
  for (const b of pass.binds) names.add(b === 'HOOKED' ? hookedName : b);
  // Bodies sometimes reference the hooked texture by its real name without binding it.
  names.add(hookedName);

  let src = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';
  src += 'in vec2 v_uv;\nout vec4 fragColor;\n';
  for (const n of names) {
    src += `uniform sampler2D ${n}_raw;\nuniform vec2 ${n}_size;\n`
      + `#define ${n}_pt (1.0 / ${n}_size)\n`
      + `#define ${n}_pos v_uv\n`
      + `#define ${n}_tex(pos) texture(${n}_raw, (pos))\n`
      + `#define ${n}_texOff(off) ${n}_tex(${n}_pos + ${n}_pt * vec2(off))\n`;
  }
  if (pass.binds.includes('HOOKED')) {
    for (const suf of ['raw', 'size', 'pt', 'pos', 'tex', 'texOff']) {
      src += `#define HOOKED_${suf} ${hookedName}_${suf}\n`;
    }
  }
  src += `#line 1\n${pass.body}\nvoid main() { fragColor = hook(); }\n`;
  return src;
}

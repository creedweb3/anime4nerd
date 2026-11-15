// Build step: translate every shader pass the extension can run to WGSL for the WebGPU backend.
// Writes <outDir>/<file>[.DEFINE-value].wgsl.json (see chain.ts wgslFileName): an array, in pass
// order, of { code, textures }. Runs in Node at build time only; naga-wasm is not shipped.
//
// Each pass is first wrapped as Vulkan-style GLSL (mpv-hooks.ts buildVulkanSource), then naga
// parses, validates and writes WGSL.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseGlsl, validate, writeWgsl } from 'naga-wasm';
import { buildVulkanSource, parseShaderFile } from '../src/mpv-hooks';
import { ENGINES, ShaderRef, applyDefines, engineChain } from '../src/engines';
import { ANIME4K_SHADERS, HOOK_OF, WgslPass, wgslFileName } from '../src/chain';

function translate(source: string, hook: string, label: string): WgslPass[] {
  const file = parseShaderFile(source);
  const lookups = new Map(file.textures.map((t) => [t.name, { linear: t.linear }]));
  return file.passes.map((p) => {
    const { source: glsl, textures } = buildVulkanSource(p, hook, lookups);
    try {
      const module = parseGlsl(glsl, { stage: 'fragment' });
      return { code: writeWgsl(module, validate(module)), textures };
    } catch (e) {
      const msg = (e as { formatted?: string }).formatted ?? String(e);
      throw new Error(`WGSL translation failed for ${label} / ${p.desc}:\n${msg}`);
    }
  });
}

/** Translate everything; returns the number of files written. */
export function generateWgsl(srcDir: string, outDir: string): number {
  const jobs = new Map<string, () => WgslPass[]>();
  for (const name of Object.keys(ANIME4K_SHADERS)) {
    jobs.set(wgslFileName({ file: name }), () => translate(ANIME4K_SHADERS[name], 'MAIN', name));
  }
  for (const e of ENGINES) {
    if (e.id === 'anime4k') continue;
    for (const v of e.variants) {
      const ec = engineChain(e.id, v.value);
      const hook = HOOK_OF[ec.plane];
      for (const r of [...ec.pre, ...ec.step, ...(ec.last ?? [])] as ShaderRef[]) {
        const out = wgslFileName(r);
        if (jobs.has(out)) continue;
        jobs.set(out, () => ('inline' in r
          ? translate(r.inline, hook, r.name)
          : translate(applyDefines(readFileSync(path.join(srcDir, r.file), 'utf8'), r.defines), hook, r.file)));
      }
    }
  }
  for (const [out, run] of jobs) writeFileSync(path.join(outDir, out), JSON.stringify(run()));
  return jobs.size;
}

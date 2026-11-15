// Upscaling engines the user can pick, and the mpv shader chain each one runs.
// Anime4K (CNN) is bundled into gpu.js; the other engines' shaders ship as separate files
// under shaders/ and are fetched only when chosen (see gpu.ts).

export type Engine = 'anime4k' | 'anime4k-gan' | 'artcnn' | 'fsrcnnx' | 'ravu' | 'nnedi3' | 'fsr' | 'cas';

/**
 * Which planes a chain works on:
 * - rgb: hooks MAIN and sees the RGB frame
 * - luma: hooks LUMA; only Y is upscaled, chroma is scaled bilinearly and merged back
 * - ycbcr: hooks NATIVE; the whole frame as full-range BT.709 YCbCr in and out
 */
export type Plane = 'rgb' | 'luma' | 'ycbcr';

export interface EngineVariant {
  value: string;
  label: string;
  description: string;
}

export interface EngineInfo {
  id: Engine;
  name: string;
  group: 'trained on anime' | 'edge-directed' | 'any video';
  blurb: string;
  cost: 1 | 2 | 3 | 4 | 5; // rough GPU cost at 1080p -> 4K, for the picker's meter
  variants: EngineVariant[]; // empty for Anime4K, whose modes are Settings.preset
  defaultVariant: string;
}

export const ENGINES: EngineInfo[] = [
  {
    id: 'anime4k', name: 'Anime4K', group: 'trained on anime', blurb: 'restore + upscale', cost: 2,
    variants: [], defaultVariant: '',
  },
  {
    id: 'anime4k-gan', name: 'Anime4K GAN', group: 'trained on anime', blurb: 'sharper detail, heavier', cost: 4,
    variants: [
      { value: 'S', label: 'GAN S', description: 'light' },
      { value: 'M', label: 'GAN M', description: 'balanced' },
      { value: 'RM', label: 'Restore+M', description: 'GAN restore, heavy' },
    ],
    defaultVariant: 'S',
  },
  {
    id: 'artcnn', name: 'ArtCNN', group: 'trained on anime', blurb: 'clean lines, newer model', cost: 3,
    variants: [
      { value: 'C4F16', label: 'C4F16', description: 'balanced' },
      { value: 'C4F32', label: 'C4F32', description: 'best, heavy' },
      { value: 'C4F16_DS', label: 'C4F16 DS', description: 'denoise+sharpen' },
      { value: 'C4F32_DS', label: 'C4F32 DS', description: 'denoise, heavy' },
    ],
    defaultVariant: 'C4F16',
  },
  {
    id: 'fsrcnnx', name: 'FSRCNNX', group: 'trained on anime', blurb: 'soft, no oil-paint look', cost: 2,
    variants: [
      { value: '8', label: '8-0-4-1', description: 'light' },
      { value: '16', label: '16-0-4-1', description: 'heavy' },
    ],
    defaultVariant: '8',
  },
  {
    id: 'ravu', name: 'RAVU', group: 'edge-directed', blurb: 'light, good on low-end GPUs', cost: 1,
    variants: [
      { value: 'r2', label: 'Lite r2', description: 'fastest' },
      { value: 'r3', label: 'Lite r3', description: 'balanced' },
      { value: 'r4', label: 'Lite r4', description: 'sharpest' },
    ],
    defaultVariant: 'r3',
  },
  {
    id: 'nnedi3', name: 'NNEDI3', group: 'edge-directed', blurb: 'crisp edges, steady cost', cost: 2,
    variants: [
      { value: '16', label: 'nns16', description: 'fast' },
      { value: '32', label: 'nns32', description: 'balanced' },
      { value: '64', label: 'nns64', description: 'sharpest' },
    ],
    defaultVariant: '32',
  },
  {
    id: 'fsr', name: 'FSR 1', group: 'any video', blurb: 'AMD upscale + sharpen', cost: 1,
    variants: [
      { value: 'soft', label: 'Soft', description: 'less sharpening' },
      { value: 'normal', label: 'Normal', description: 'default' },
      { value: 'crisp', label: 'Crisp', description: 'max sharpening' },
    ],
    defaultVariant: 'normal',
  },
  {
    id: 'cas', name: 'CAS', group: 'any video', blurb: 'AMD contrast-adaptive sharpen', cost: 1,
    variants: [
      { value: 'low', label: 'Low', description: 'subtle' },
      { value: 'mid', label: 'Mid', description: 'balanced' },
      { value: 'high', label: 'High', description: 'strong' },
    ],
    defaultVariant: 'mid',
  },
];

export const ENGINE_IDS: Engine[] = ENGINES.map((e) => e.id);

export function engineInfo(id: Engine): EngineInfo {
  return ENGINES.find((e) => e.id === id) ?? ENGINES[0];
}

/**
 * One shader to run: a file under shaders/ (with #define values to override, and optionally only
 * the passes whose DESC contains `only`), or a small built-in pass given inline.
 */
export type ShaderRef =
  | { file: string; defines?: Record<string, string>; only?: string }
  | { inline: string; name: string };

export interface EngineChain {
  plane: Plane;
  /** Run once, before the upscaling steps. */
  pre: ShaderRef[];
  /** One x2 step (or one step toward OUTPUT); repeated per doubling except the last. Passes skip themselves via WHEN once done. */
  step: ShaderRef[];
  /** The final step, when it differs from `step` (sharpeners: sharpen once, at the end). */
  last?: ShaderRef[];
}

// Built-in helper passes for the sharpeners' intermediate steps, so they sharpen only once.
/** FSR: keep EASU's upscale as the plane, without the RCAS sharpening pass. */
const EASU_ONLY: ShaderRef[] = [
  { file: 'FSR.glsl', only: '(EASU)' },
  {
    name: 'copy EASU',
    inline: [
      '//!DESC FSR EASU result (no sharpening)', '//!HOOK LUMA', '//!BIND EASUTEX', '//!WIDTH EASUTEX.w', '//!HEIGHT EASUTEX.h',
      'vec4 hook() { return EASUTEX_tex(EASUTEX_pos); }',
    ].join('\n'),
  },
];
/** CAS: plain bilinear 2x; CAS itself upsamples and sharpens in one pass, so it runs only last. */
const BILINEAR_X2: ShaderRef[] = [{
  name: 'bilinear x2',
  inline: [
    '//!DESC bilinear x2', '//!HOOK LUMA', '//!BIND HOOKED', '//!WIDTH 2 HOOKED.w *', '//!HEIGHT 2 HOOKED.h *',
    'vec4 hook() { return HOOKED_tex(HOOKED_pos); }',
  ].join('\n'),
}];

/** The shader chain of a non-Anime4K engine (Anime4K's own chain is built in gpu.ts). */
export function engineChain(engine: Exclude<Engine, 'anime4k'>, variant: string): EngineChain {
  switch (engine) {
    case 'anime4k-gan':
      return {
        plane: 'rgb',
        pre: variant === 'RM' ? [{ file: 'Anime4K_Restore_GAN_UL.glsl' }] : [],
        step: [{ file: variant === 'S' ? 'Anime4K_Upscale_GAN_x2_S.glsl' : 'Anime4K_Upscale_GAN_x2_M.glsl' }],
      };
    case 'artcnn': {
      const ds = variant.endsWith('_DS');
      const size = variant.startsWith('C4F32') ? 'C4F32' : 'C4F16';
      return ds
        ? { plane: 'ycbcr', pre: [], step: [{ file: `ArtCNN_${size}_DS_YCbCr.glsl` }] }
        : { plane: 'rgb', pre: [], step: [{ file: `ArtCNN_${size}_RGB.glsl` }] };
    }
    case 'fsrcnnx':
      return { plane: 'luma', pre: [], step: [{ file: variant === '16' ? 'FSRCNNX_x2_16-0-4-1.glsl' : 'FSRCNNX_x2_8-0-4-1.glsl' }] };
    case 'ravu':
      return { plane: 'luma', pre: [], step: [{ file: `ravu-lite-ar-${['r2', 'r3', 'r4'].includes(variant) ? variant : 'r3'}.hook` }] };
    case 'nnedi3':
      return { plane: 'luma', pre: [], step: [{ file: `nnedi3-nns${['16', '32', '64'].includes(variant) ? variant : '32'}-win8x4.hook` }] };
    case 'fsr': {
      // RCAS sharpness: 0 = strongest, each +1 halves it.
      const sharpness = variant === 'soft' ? '1.0' : variant === 'crisp' ? '0.0' : '0.2';
      return { plane: 'luma', pre: [], step: EASU_ONLY, last: [{ file: 'FSR.glsl', defines: { SHARPNESS: sharpness } }] };
    }
    case 'cas': {
      const sharpening = variant === 'low' ? '0.0' : variant === 'high' ? '1.0' : '0.5';
      return { plane: 'luma', pre: [], step: BILINEAR_X2, last: [{ file: 'CAS-scaled.glsl', defines: { SHARPENING: sharpening } }] };
    }
    default: {
      const never: never = engine;
      throw new Error(`Unknown engine ${String(never)}`);
    }
  }
}

/** Replace `#define NAME value` lines in a shader source (values are fixed strings from engineChain). */
export function applyDefines(source: string, defines: Record<string, string> | undefined): string {
  if (!defines) return source;
  let out = source;
  for (const [name, value] of Object.entries(defines)) {
    out = out.replace(new RegExp(`^(#define\\s+${name}\\s+)\\S+`, 'm'), `$1${value}`);
  }
  return out;
}

# Third-party notices

Anime4Nerd bundles the following third-party work.

## Anime4K (shaders)

- Source: https://github.com/bloc97/Anime4K
- Commit: 7684e9586f8dcc738af08a1cdceb024cc184f426 (2024-04-26)
- Files: `src/shaders/Anime4K_*.glsl`, copied verbatim from the `glsl/` directory
- License: MIT, Copyright (c) 2019-2021 bloc97 (full text in `src/shaders/LICENSE`)

Anime4K is the work of bloc97 and contributors. Anime4Nerd only loads these
shaders in a browser; it does not modify them.

The Anime4K GAN shaders (`shaders/Anime4K_Upscale_GAN_x2_S.glsl`,
`Anime4K_Upscale_GAN_x2_M.glsl`, `Anime4K_Restore_GAN_UL.glsl`) come from the
same commit under the same license.

## Other upscaling engines (shaders)

These ship as separate, unmodified files in the extension's `shaders/` folder,
and load only when the engine is picked in the popup. Exact upstream commits
are in `src/shaders/engines/SOURCE.txt`.

- **ArtCNN**: https://github.com/Artoriuz/ArtCNN, tag v1.4.2, `Legacy/`
  fragment-shader builds. MIT, Copyright (c) 2024 João Chrisóstomo
  (`shaders/LICENSE.ArtCNN`).
- **FSRCNNX**: https://github.com/igv/FSRCNN-TensorFlow, release 1.1.
  LGPL-3.0, Copyright (C) 2017-2021 igv (`shaders/LICENSE.LGPL-3.0`,
  `shaders/LICENSE.GPL-3.0`).
- **RAVU and NNEDI3**: https://github.com/bjin/mpv-prescalers, by bjin.
  LGPL-3.0 (`shaders/LICENSE.LGPL-3.0`, `shaders/LICENSE.GPL-3.0`).
- **AMD FidelityFX FSR 1 and CAS**: mpv ports by agyild
  (https://gist.github.com/agyild). MIT, Copyright (c) 2017-2021 Advanced
  Micro Devices, Inc.; the license text is in each file's header. Anime4Nerd
  sets the sharpness constant when it loads the file.

The LGPL-3.0 shaders are the complete source of those components. You can
replace any of them with a modified version by editing the file in the
extension's `shaders/` folder.

For the optional WebGPU backend, every shader above (Anime4K included) is also
shipped as a machine translation to WGSL (`shaders/*.wgsl.json`), generated at
build time by `tools/wgsl-gen.ts` with naga (https://github.com/gfx-rs/wgpu,
MIT/Apache-2.0, via the `naga-wasm` package; build tool only, not shipped). The
translations are derived from, and covered by the same licenses as, the shader
files they are generated from; the original GLSL ships alongside them.

## Store screenshot artwork (not shipped in the extension)

- Image: "A snapshot from the 2012 demo release from the Morevna Project"
- Author: Morevna Project (https://morevnaproject.org/)
- Source: https://commons.wikimedia.org/wiki/File:A_snapshot_from_the_2012_demo_release_from_the_Morevna_Project.png
- License: Creative Commons Attribution 3.0 Unported (https://creativecommons.org/licenses/by/3.0/)
- No endorsement by the Morevna Project is implied.
- Changes: scaled 2× with browser bilinear filtering (left) and with Anime4K
  A+A plus Darken Lines (right), cropped, and composited into a comparison image.
- Used only in the store listing screenshot `docs/store/anime4nerd-2-compare.png`;
  the credit is printed on the image.

## Build tooling (not shipped)

- esbuild (MIT) — bundler, development only
- TypeScript (Apache-2.0) — type checking, development only
- @types/chrome (MIT) — type definitions, development only

No runtime npm dependencies are included in the shipped extension.

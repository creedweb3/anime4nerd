# Third-party notices

Anime4Nerd bundles the following third-party work.

## Anime4K (shaders)

- Source: https://github.com/bloc97/Anime4K
- Commit: 7684e9586f8dcc738af08a1cdceb024cc184f426 (2024-04-26)
- Files: `src/shaders/Anime4K_*.glsl`, copied verbatim from the `glsl/` directory
- License: MIT, Copyright (c) 2019-2021 bloc97 (full text in `src/shaders/LICENSE`)

Anime4K is the work of bloc97 and contributors. Anime4Nerd only loads these
shaders in a browser; it does not modify them.

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

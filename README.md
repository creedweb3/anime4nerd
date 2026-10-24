# Anime4Nerd (browser extension)

Real-time 2x Anime4K upscaling of any `<video>` on a page, as a
Chrome/Edge/Brave extension you control.

It runs **bloc97's original Anime4K shaders** (`src/shaders/`, copied verbatim
from https://github.com/bloc97/Anime4K, MIT) in WebGL2. A small loader
(`src/mpv-hooks.ts`) reads the mpv `//!HOOK / //!BIND / //!SAVE / //!WIDTH /
//!HEIGHT / //!WHEN` directives and turns each pass into a fragment shader, so
no third-party port of the shaders is involved.

## Build

```bash
npm install
npm run build
```

Output goes to `dist/`.

## Install (Chrome / Edge / Brave)

From the Chrome Web Store:
https://chromewebstore.google.com/detail/anime4nerd/kblnmcdmlgeidaclnhjmcffefmkehkpm

From source:

1. Open `chrome://extensions` (or `brave://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked** → pick the `dist/` folder. (Or `npm run pack` and share
   `Anime4Nerd prod.zip`; it unzips to the same folder.)
4. Open a page with a video, click the extension icon, and flip the switch on
   the video card.

To limit it to certain sites, use the extension's "Site access" settings.

The switch is remembered per **site + stream host**, so once you turn on the
player on a site it stays on for the next episode. Presets and line effects are
global.

## Presets (the standard Anime4K mpv mappings)

| Preset | Shader chain |
|---|---|
| Mode A | Clamp_Highlights → Restore_CNN_VL → Upscale_CNN_x2_VL |
| Mode B | Clamp_Highlights → Restore_CNN_Soft_VL → Upscale_CNN_x2_VL |
| Mode C | Clamp_Highlights → Upscale_Denoise_CNN_x2_VL |
| A+A | Mode A → Restore_CNN_M |
| B+B | Mode B → Restore_CNN_Soft_M |
| C+A | Mode C → Restore_CNN_M |

Line effects append `Anime4K_Darken_HQ` and/or `Anime4K_Thin_HQ`.
Output is always exactly 2x the source resolution.

## How it works

- `src/content.ts` runs in every frame (`all_frames: true`), finds `<video>`
  elements (including inside shadow roots) and reports them to the popup. For a
  video whose source switch is on it lays a `<canvas>` over the video and
  drives one render per video frame with `requestVideoFrameCallback`.
  It suspends in picture-in-picture, native video fullscreen and hidden tabs,
  rebuilds on resize, and falls back to the plain video on any GPU error.
- `src/gpu.ts` is loaded lazily (`import(chrome.runtime.getURL('gpu.js'))`),
  builds the pass list for the chosen preset, compiles all programs in
  parallel (`KHR_parallel_shader_compile`), and per frame uploads the video
  frame, runs every pass into `RGBA16F` textures and blits the final `MAIN`
  texture to the canvas.
- Presets live in `chrome.storage.sync`; the per-source on/off map lives in
  `chrome.storage.local` (`anime4k-sources`).
- `src/background.ts` injects the content script into tabs that were already
  open when the extension was installed, one frame at a time.

## Video naming

Each row is labelled with what is playing, not just the host:

```
Attack on Titan
E1 - To You, in 2000 Years: The Fall of Shiganshina
```

Sources, in order of trust (`src/media-meta.ts`): schema.org JSON-LD
(`TVEpisode`, `Movie`, `VideoObject`), the player's Media Session metadata
(read inside the player frame, so cross-origin embeds work), Open Graph
`og:title`, then `document.title` / `h1` / URL heuristics (`S2E3`, `1x05`,
`Episode 5`, `?ep=5`, `/episode-5`). Site names and "Watch … Online" boilerplate
are stripped. For single videos (YouTube style) the second line is the channel.
Fixtures live in `test/meta-test.ts`.

## GPU meter

Each active video row shows live GPU cost measured with
`EXT_disjoint_timer_query_webgl2`: ms per frame, load (% of the frame budget at
the video's fps), rolling average/peak, a 48-sample bar graph, pass count, VRAM
held by the shader textures, and output size. Red bars mean the GPU took longer
than one video frame.

Reference numbers, RTX 2060, 1920×1080 source → 3840×2160, Chromium (ANGLE D3D11):

| Preset | GPU ms/frame | Passes | VRAM |
|---|---|---|---|
| A   | 15.1 | 39 | 704 MB |
| A+A | 23.7 | 47 | 1210 MB |
| C   | 13.2 | 22 | 435 MB |
| C+A | 15.8 | 30 | 941 MB |

A 24 fps video gives a 41.7 ms budget, so A uses ~36% of the GPU, A+A ~57%.

## Limitations

- **CORS.** Uploading a video frame to WebGL requires the video to be
  CORS-clean (`crossorigin` attribute + `Access-Control-Allow-Origin` on the
  media). Many web players already do this. For others you will see
  "This video source does not allow browser upscaling". DRM (Widevine) video
  can never be read.
- First start compiles ~40 large shaders: 5–10 s on first use, then cached by
  the browser.
- WebGL2 only (no WebGPU). Firefox/Safari untested.

## Local shader test

```bash
npx esbuild test/test.ts --bundle --format=esm --loader:.glsl=text --outfile=test/test.js
npx serve test
```

Open the page, pick a preset, press Run. It feeds a synthetic animated
line-art pattern through the renderer.

## Credits

- Anime4K shaders: bloc97 and contributors, MIT (`src/shaders/LICENSE`).

## Legal

- Extension code: MIT (`LICENSE`).
- Anime4K shaders: MIT, bloc97 (`src/shaders/LICENSE`, `THIRD_PARTY_NOTICES.md`).
- Privacy: `PRIVACY.md`. No data leaves the browser.
- Security model and user safety guide: `SECURITY.md`.
- Store listing draft: `docs/STORE_LISTING.md`.

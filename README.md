# Anime4Nerd (browser extension)

Real-time 2x–8x Anime4K upscaling of any `<video>` on a page, as a
Chrome/Edge/Brave and Firefox extension you control.

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

For Firefox:

```bash
npm run build:firefox   # writes dist-firefox/
npm run pack:firefox    # also writes "Anime4Nerd firefox.zip"
```

The Firefox build uses the same sources with a Firefox manifest
(`firefoxManifest()` in `build.mjs`): `background.scripts` instead of a service
worker, the add-on id `anime4nerd@creedweb3.github.io`, Firefox 140+ (Firefox
for Android 142+), and `data_collection_permissions: none`. `pack` and
`pack:firefox` call `tar -a` to write the zip, which needs bsdtar (Windows and
macOS ship it; GNU tar on Linux does not write zip).

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

## Install (Firefox)

From Firefox Add-ons: coming soon (Firefox 140 or newer).

From source, as a temporary add-on (removed when Firefox closes):

1. `npm run build:firefox`.
2. Open `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…** → pick `dist-firefox/manifest.json`.
4. Open a page with a video, click the extension icon, and flip the switch on
   the video card.

Site access is under `about:addons` → Anime4Nerd → Permissions. Firefox has no
GPU timer queries, so the popup shows "GPU timing not available in this
browser" instead of GPU ms per frame (it still says whether upscaling keeps up
with the video); everything else works as in Chrome, and
settings sync through Firefox Sync if you use it.

The switch is remembered per **site + stream host**, so once you turn on the
player on a site it stays on for the next episode. Presets, line effects and
the upscale factor are global.

In fullscreen the toolbar popup can't open, so a small ☰ button appears in the
player's top-right corner. It opens a menu with the on/off switch, presets,
line effects, upscale factor and a GPU frame-time graph, and fades out when the
mouse is idle.

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

## Upscale factor

The Anime4K networks are trained for exactly 2x, so larger factors chain extra
`Upscale_CNN_x2_M` passes, one per doubling:

- **auto** (default): 2x, or 4x when the video is shown at more than 2x its
  source size in device pixels (e.g. 720p fullscreen on a 1440p+ screen).
- **2x, 4x, 8x, 16x, 32x**: manual. The renderer uses the largest factor at or
  below the choice whose output fits the GPU's texture limit, stays at or under
  8K (7680×4320 pixels) and keeps all intermediate textures under 2 GB. The popup
  then shows e.g. `(8×) · 32× capped: GPU limit`. In practice 8x is reachable
  for 480p and smaller sources; above 4x the extra detail is mostly downscaled
  away by the browser.

## How it works

- `src/content.ts` runs in every frame (`all_frames: true`), finds `<video>`
  elements (including inside shadow roots) and reports them to the popup. For a
  video whose source switch is on it lays a `<canvas>` over the video and
  drives one render per video frame with `requestVideoFrameCallback`. (Firefox
  fires that callback only ~25 times a second on 60 fps video, so the Firefox
  build renders on the first animation frame after
  `getVideoPlaybackQuality().totalVideoFrames` changes.)
  It suspends in picture-in-picture, native video fullscreen and hidden tabs,
  rebuilds on resize, and falls back to the plain video on any GPU error.
- `src/fullscreen-menu.ts` is the on-video menu shown while a player
  container is fullscreen, in a closed shadow root inside the fullscreen
  element (or inside its open shadow root when the video lives there). It also
  shows when the whole frame fills the screen: an embedded player whose outer
  page fullscreened the iframe, or F11. Its clicks only count when they are real
  user clicks on an unmodified, visible menu.
- `src/fullscreen-redirect.ts` runs in the page's own JavaScript world
  (`"world": "MAIN"`) and uses no extension APIs. When the page fullscreens a
  `<video>` that is being upscaled (marked `data-a4k-on` by the content script),
  it fullscreens the video's parent instead, because nothing can be drawn over a
  bare fullscreen video. `content.css` makes the video fill the screen there.
- After an extension reload the old content script is orphaned; it removes its
  canvases and menu and stops as soon as its extension context is gone.
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

Firefox does not offer the timer query, so there the meter shows the output
frame rate and whether it keeps up with the video (frames drawn vs the video's
own frame rate), but no GPU time. Speed is about the same as Chrome. Same
RTX 2060, 1080p60 source: Mode A → 4K 57 fps in Firefox, 55 in Chrome; A+A → 4K
38 / 39; Mode A → 8K 34 / 31.

## Limitations

- **CORS.** Uploading a video frame to WebGL requires the video to be
  CORS-clean (`crossorigin` attribute + `Access-Control-Allow-Origin` on the
  media). Many web players already do this. For others you will see
  "This video source does not allow browser upscaling". DRM (Widevine) video
  can never be read.
- First start compiles ~40 large shaders: 5–10 s on first use, then cached by
  the browser.
- WebGL2 only (no WebGPU). Firefox 140+ is supported (separate build, see
  above); Safari is untested.
- The fullscreen button of the browser's own `<video controls>` does not go
  through the page's fullscreen API, so it still fullscreens the bare video:
  plain playback, no menu.

## Local shader test

```bash
npx esbuild test/test.ts --bundle --format=esm --loader:.glsl=text --outfile=test/test.js
npx serve test
```

Open the page, pick a preset, press Run. It feeds a synthetic animated
line-art pattern through the renderer. Query parameters: `w`/`h` set the source
size, `scale` the requested upscale factor (e.g. `?w=854&h=480&scale=8`).

`test/fullscreen-menu.html` runs the real content script on a fake player with
mocked `chrome.*` APIs. Copy `dist/content.js`, `dist/gpu.js`,
`dist/fullscreen-redirect.js` and `dist/content.css` next to it first. Open
`/fullscreen-menu?shadow=1` for a player inside a shadow root, and
`fullscreen-frame.html` for an outer page that fullscreens the player's iframe.
Real fullscreen needs a user gesture, e.g. a click or CDP `Runtime.evaluate`
with `userGesture: true`.

## Firefox smoke test

```bash
npm run build:firefox
node test/firefox-smoke.mjs
```

Needs `ffmpeg` on PATH and Playwright with its Firefox (`npm i -g playwright`,
then `npx playwright install firefox`). It runs headless, installs
`dist-firefox/` as a temporary add-on over Firefox's remote debugging protocol,
and checks same-origin VP9 and H.264, a CORS source, a cross-origin iframe, the
no-CORS message, a bare video file page and the fullscreen redirect.

## Credits

- Anime4K shaders: bloc97 and contributors, MIT (`src/shaders/LICENSE`).

## Legal

- Extension code: MIT (`LICENSE`).
- Anime4K shaders: MIT, bloc97 (`src/shaders/LICENSE`, `THIRD_PARTY_NOTICES.md`).
- Privacy: `PRIVACY.md`. No data leaves the browser.
- Security model and user safety guide: `SECURITY.md`.
- Store listing draft: `docs/STORE_LISTING.md`; Firefox Add-ons listing and
  reviewer notes: `docs/AMO_LISTING.md`.

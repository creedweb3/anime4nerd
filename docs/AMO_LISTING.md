# Firefox Add-ons (AMO) listing (draft)

Companion to `docs/STORE_LISTING.md` (Chrome Web Store). Upload `Anime4Nerd firefox.zip`
(from `npm run pack:firefox`) plus a source archive; see "Source code and notes to reviewer".

**Name:** Anime4Nerd

**Add-on URL slug:** anime4nerd (the AMO link becomes https://addons.mozilla.org/firefox/addon/anime4nerd/ if the slug is free)

**Summary (250 chars max):**
Real-time 2x–8x Anime4K upscaling for any web video. Runs the original bloc97 shaders in WebGL2 on your GPU. No data collection, no network requests, nothing leaves your browser.

**Categories:** Photos, Music & Videos

**Tags:** video (AMO picks tags from a fixed list; "video" is the one that fits. Add "youtube" only if it is wanted, the extension is not YouTube-specific.)

**Description:**

Anime4Nerd runs the open-source Anime4K shaders on any web video, live, in your browser. Switch a video on and it is restored and upscaled 2× (or more) on your GPU while it plays: cleaner lines, less blur, less noise.

What you get
• Six presets: Mode A / B / C and their stronger A+A / B+B / C+A variants
• Optional line effects: darken lines, thin lines
• Upscale factor: auto (4× when a small video is shown large), or 2× up to 32×, capped to what your GPU can hold
• Fullscreen menu: change preset, line effects and upscale factor without leaving fullscreen, including embedded players and F11
• Works on embedded players too (videos inside iframes are found automatically)
• Live performance panel: output frame rate and output size, and whether it keeps up with the video
• Per-site switch that is remembered, so the next episode is already upscaled
• Settings sync between your own browsers through Firefox Sync, if you use it

How it works
The original Anime4K GLSL shaders by bloc97 are loaded unchanged and run through WebGL2. Each video frame goes through the chosen chain of convolution passes and the result is drawn on a canvas over the player. The networks upscale exactly 2× per pass (1080p → 2160p); higher factors chain extra 2× passes.

Performance
Speed is about the same as in Chrome: on an RTX 2060, 1080p60 → 4K with Mode A runs at about 57 fps in Firefox (55 in Chrome). Firefox does not offer GPU timer queries to WebGL, so the popup shows "GPU timing not available in this browser" where Chrome shows GPU milliseconds per frame; it still tells you whether upscaling keeps up with the video.

Privacy
No data collection, no network requests, no accounts. It only finds videos on the page and does nothing until you switch one on. Everything stays on your machine. Full policy: https://anime4nerd.pages.dev/privacy

Requirements
Firefox 140 or newer and a GPU with WebGL2. The video must be served with CORS (most players do this). DRM video (Widevine) cannot be read by any extension.

Not affiliated with bloc97 or any streaming site. Anime4K is MIT licensed. Source code: https://github.com/creedweb3/anime4nerd

## Store fields

- Homepage: https://anime4nerd.pages.dev/
- Support site: https://github.com/creedweb3/anime4nerd/issues
- Support email: leave empty (issues on GitHub), or add one if wanted.
- License: MIT License
- Privacy policy: paste the text of `PRIVACY.md` (AMO stores the policy text itself, not a link). The same policy is online at https://anime4nerd.pages.dev/privacy.
- Data collection: the manifest declares `data_collection_permissions: { required: ["none"] }`, so AMO shows that the add-on collects no data.
- "This add-on is experimental": no. "Requires payment": no.
- Compatibility: Firefox desktop 140+. The manifest also sets Firefox for Android 142+ (`gecko_android`); only tick Android on upload once it has been tried on a phone (the smoke test covers desktop only).

## Permission justifications

AMO has no per-permission form; reviewers read the code and the notes to reviewer. Use these
in the notes (they are also in `PRIVACY.md`):

- `storage`: saves the preset, line effects and upscale factor (`storage.sync`, synced by Firefox Sync if the user has it on), the per-site on/off map (`storage.local`, key `anime4k-sources`) and a one-off "updated to x.y.z" flag for the What's new notice (`storage.local`). See `src/settings.ts` and `src/whats-new.ts`.
- `scripting`: on install or update, `src/background.ts` injects `content.css`, `content.js` and `fullscreen-redirect.js` into frames of tabs that were already open, so the user does not have to reload them. That is its only use.
- `webNavigation`: `webNavigation.getAllFrames` lists the frames of a tab. The background uses it to inject frame by frame (one refused frame does not stop the rest), and the popup uses it to ask each frame for its videos, because players are usually in iframes.
- Host permission `<all_urls>`: video players are embedded from many different domains (the page and the player's host differ), so the content script must run in every frame to find `<video>` elements, and must be able to read the frames of a video the user switches on. Until the user switches a video on in the popup, the content script only looks for `<video>` elements. Nothing is sent anywhere.

## Source code and notes to reviewer

The shipped JavaScript is bundled and minified by esbuild, so the source must be uploaded.

**Making the upload (maintainer):** build the upload zip from the same source archive the
reviewer gets, so the two match file for file:

```bash
git -c core.autocrlf=false archive --format=zip -o anime4nerd-source.zip HEAD
# unzip anime4nerd-source.zip into an empty folder, then in that folder:
npm ci
npm run pack:firefox
# upload "Anime4Nerd firefox.zip" as the add-on and anime4nerd-source.zip as the source
```

`core.autocrlf=false` keeps the archive's line endings as committed (LF). A Windows working
tree with `autocrlf=true` has CRLF in copied text files such as `THIRD_PARTY_NOTICES.md`, which
would make that file differ from a reviewer's build.

**Notes to reviewer (paste into the AMO field):**

```text
Anime4Nerd runs the Anime4K upscaling shaders over web <video> elements with WebGL2. It has no
network code, no remote code, no analytics and no accounts. The full source is attached and is
also at https://github.com/creedweb3/anime4nerd (MIT).

Build steps
1. Node.js 24 (built with Node 24.15.0, npm 11.12.1). Any OS; no other tools needed.
2. Unzip the source archive and, in its root folder, run:
     npm ci
     npm run build:firefox
3. The add-on is written to dist-firefox/. Its files match the uploaded zip file for file:
     unzip "Anime4Nerd firefox.zip" -d uploaded && diff -r uploaded dist-firefox
   ("npm run pack:firefox" also writes the zip itself; on Linux/macOS it needs the zip command.)

What the build does (build.mjs)
- esbuild bundles and minifies src/*.ts. Firefox build: chrome.* is defined as browser.*, and
  __FIREFOX__ is true (selects the Firefox render loop in src/content.ts).
- The .glsl shaders are bundled as text into gpu.js. They are bloc97's Anime4K shaders,
  copied unchanged into src/shaders/ from https://github.com/bloc97/Anime4K commit
  7684e9586f8dcc738af08a1cdceb024cc184f426 (MIT; src/shaders/LICENSE, src/shaders/SOURCE.txt,
  THIRD_PARTY_NOTICES.md). src/mpv-hooks.ts turns them into WebGL2 fragment shaders.
- The manifest is manifest.json with Firefox changes (firefoxManifest() in build.mjs):
  background.scripts instead of a service worker, gecko id anime4nerd@creedweb3.github.io,
  strict_min_version 140.0 (Android 142.0), data_collection_permissions none.
- No runtime npm dependencies. Dev dependencies: esbuild, typescript, @types/chrome,
  @webgpu/types.

Files in the package
- background.js: on install/update, injects the content scripts into tabs already open.
  Accepts no messages.
- content.js (+ content.css): runs in every frame, finds <video> elements, answers the
  popup, and draws the upscaled canvas over videos the user switched on.
- gpu.js: the WebGL2 renderer and the bundled shaders. Loaded with
  import(browser.runtime.getURL('gpu.js')) from the content script, which is why it is listed
  in web_accessible_resources. It is a file in the package, not remote code.
- fullscreen-redirect.js: a ~30-line content script in the page's MAIN world. It only wraps
  requestFullscreen so that a video being upscaled (marked data-a4k-on) fullscreens its parent
  element instead, because nothing can be drawn over a bare fullscreen video. It uses no
  extension APIs and sends nothing.
- popup.html/js/css: the toolbar popup. Page-derived strings are set with textContent; the one
  innerHTML use is a constant template without interpolation.

Permissions
- storage: preset, line effects and upscale factor (storage.sync); the per-site on/off map and
  a "what's new" flag (storage.local).
- scripting: injection into already-open tabs on install/update (background.js only).
- webNavigation: getAllFrames, to inject per frame and to let the popup query every frame,
  because video players are usually in iframes.
- <all_urls>: players are embedded from arbitrary domains, so the content script must run in
  every frame. It does nothing beyond finding <video> elements until the user switches a
  video on.

Testing
Open any page with a CORS-enabled <video> (for example a .webm or .mp4 file opened directly),
click the toolbar button and switch the video on. test/firefox-smoke.mjs is the automated
Firefox test (needs ffmpeg and Playwright's Firefox; see README.md).
```

## Screenshots

AMO takes 1280×800 screenshots (shown smaller). The Chrome set in `docs/store/` can be reused,
in the same order as the Chrome listing:

1. `anime4nerd-1-hero.png`
2. `anime4nerd-2-compare.png` (Morevna Project frame, CC BY 3.0, credited on the image)
3. `anime4nerd-6-fullscreen.png`
4. `anime4nerd-3-presets.png`
5. `anime4nerd-5-privacy.png`

The hero and fullscreen shots show the Chrome GPU meter (ms per frame), which Firefox does not
have. Either add a caption ("GPU timing is shown in Chrome; Firefox shows the frame rate")
or render Firefox variants from `docs/store/shots.html`. Do not upload
`anime4nerd-promo-440x280.png`: AMO has no promo tile.

Screenshot captions (optional):
1. The popup on a video, with presets and upscale factor.
2. Before / after: browser scaling vs Anime4K A+A with darken lines.
3. The fullscreen menu.
4. The six presets.
5. Privacy: nothing leaves your browser.

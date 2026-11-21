# Firefox Add-ons (AMO) listing (draft)

Companion to `docs/STORE_LISTING.md` (Chrome Web Store). Upload `Anime4Nerd firefox.zip`
(from `npm run pack:firefox`) plus a source archive; see "Source code and notes to reviewer".

**Name:** Anime4Nerd

**Add-on URL slug:** anime4nerd (the AMO link becomes https://addons.mozilla.org/firefox/addon/anime4nerd/ if the slug is free)

**Summary (250 chars max):**
Real-time 2x–8x Anime4K upscaling for any web video. Runs the original bloc97 shaders in WebGL2 on your GPU. Nothing about you is sent; the video never leaves your browser. Also upscales manga reader pages.

**Categories:** Photos, Music & Videos

**Tags:** video (AMO picks tags from a fixed list; "video" is the one that fits. Add "youtube" only if it is wanted, the extension is not YouTube-specific.)

**Description:**

Anime4Nerd runs the open-source Anime4K shaders on any web video, live, in your browser. Switch a video on and it is restored and upscaled 2× (or more) on your GPU while it plays: cleaner lines, less blur, less noise.

What you get
• Six presets: Mode A / B / C and their stronger A+A / B+B / C+A variants
• Optional line effects: darken lines, thin lines
• Upscale factor: auto (4× when a small video is shown large), or 2× up to 8×, capped to what your GPU can hold
• Fullscreen menu: change preset, line effects and upscale factor without leaving fullscreen, including embedded players and F11
• Works on embedded players too (videos inside iframes are found automatically)
• Live performance panel: output frame rate and output size, and whether it keeps up with the video
• Per-site switch that is remembered, so the next episode is already upscaled
• Manga mode: upscales the pages of manga readers once per chapter (Alt+M shows the originals)
• Color controls: brightness, contrast, saturation, temperature and more, with ready-made looks and saved profiles
• Settings sync between your own browsers through Firefox Sync, if you use it
• Something wrong? The bug icon in the popup opens a short report form with your version filled in; replies come back on the website, no account needed

How it works
The original Anime4K GLSL shaders by bloc97 are loaded unchanged and run through WebGL2. Each video frame goes through the chosen chain of convolution passes and the result is drawn on a canvas over the player. The networks upscale exactly 2× per pass (1080p → 2160p); higher factors chain extra 2× passes.

Performance
Speed is about the same as in Chrome: on an RTX 2060, 1080p60 → 4K with Mode A runs at about 57 fps in Firefox (55 in Chrome). Firefox does not offer GPU timer queries to WebGL, so the popup shows "GPU timing not available in this browser" where Chrome shows GPU milliseconds per frame; it still tells you whether upscaling keeps up with the video.

Privacy
No personal data is collected, nothing about you is sent, no accounts; the only downloads are the page images a manga reader already shows (manga mode). It only finds videos on the page and does nothing until you switch one on, and the video stays on your machine. The popup's bug icon and the page shown after removal open optional forms on our website; they send only what you write (and any screenshots you attach), and only when you press send. Full policy: https://anime4nerd.pages.dev/privacy

Requirements
Firefox 140 or newer and a GPU with WebGL2. The video must be served with CORS (most players do this). DRM video (Widevine) cannot be read by any extension.

Not affiliated with bloc97 or any streaming site. Anime4K is MIT licensed. Source code: https://github.com/creedweb3/anime4nerd

## Store fields

- Homepage: https://anime4nerd.pages.dev/
- Support site: https://anime4nerd.pages.dev/report
- Support email: leave empty (reports go through the support site), or add one if wanted.
- License: MIT License
- Privacy policy: paste the text of `PRIVACY.md` (AMO stores the policy text itself, not a link). The same policy is online at https://anime4nerd.pages.dev/privacy.
- Data collection: the manifest declares `data_collection_permissions: { required: ["none"] }`, so AMO shows that the add-on collects no data. The add-on itself sends nothing: `runtime.setUninstallURL` opens https://anime4nerd.pages.dev/uninstalled?v=<version> after removal, and the popup's bug icon opens https://anime4nerd.pages.dev/report?v=<version>&b=firefox in a tab. Both are website forms that send only when the user presses send (see `PRIVACY.md`). Mention this in the notes to reviewer.
- "This add-on is experimental": no. "Requires payment": no.
- Compatibility: Firefox desktop 140+ only. The manifest has no `gecko_android` key and Android must stay unticked on upload: the add-on has never been tested on a phone (the smoke test covers desktop only).

## Permission justifications

AMO has no per-permission form; reviewers read the code and the notes to reviewer. Use these
in the notes (they are also in `PRIVACY.md`):

- `storage`: saves the preset, line effects and upscale factor (`storage.sync`, synced by Firefox Sync if the user has it on), the per-site on/off map (`storage.local`, key `anime4k-sources`) and a one-off "updated to x.y.z" flag for the What's new notice (`storage.local`), and local usage counts (upscaled time and episodes, `storage.local` key `anime4k-rate`) that decide when the popup shows a "rate it" card linking to this add-on's reviews page; never synced or sent. See `src/settings.ts`, `src/whats-new.ts` and `src/rate-prompt.ts`.
- `scripting`: on install or update, `src/background.ts` injects `content.css`, `content.js` and `fullscreen-redirect.js` into frames of tabs that were already open, so the user does not have to reload them. That is its only use.
- `webNavigation`: `webNavigation.getAllFrames` lists the frames of a tab. The background uses it to inject frame by frame (one refused frame does not stop the rest), and the popup uses it to ask each frame for its videos, because players are usually in iframes.
- `webRequest` (manga mode): the background reads, with no blocking and no changes, the IP address that answered (`details.ip`) for two kinds of request: page and frame loads, and its own fetches of manga page images. Manga readers serve page images from other hosts without CORS, so the background downloads them for the content script; the address check makes sure a page cannot use this to read local network or cloud metadata addresses (a public name that resolves to a private address is refused). It also reads the `Location` header of its own fetches to check each redirect hop the same way. Nothing is recorded beyond the current session (`storage.session`) and nothing is sent anywhere.
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

**Notes to reviewer (paste into the AMO field; AMO allows at most 3000 characters):**

```text
Anime4Nerd 1.3.0 runs bloc97's Anime4K shaders (MIT, unchanged) over web <video> and manga reader page images with WebGL2. No remote code, no analytics, no accounts. Source attached; also https://github.com/creedweb3/anime4nerd. Full reviewer notes: docs/AMO_LISTING.md in the source archive.

BUILD (Node 24, npm 11; any OS)
  npm ci
  npm run build:firefox
Output is dist-firefox/, identical file for file to the uploaded zip:
  unzip "Anime4Nerd firefox.zip" -d uploaded && diff -r uploaded dist-firefox
esbuild bundles and minifies src/*.ts; .glsl shaders are bundled as text into gpu.js. Firefox manifest changes are in firefoxManifest() in build.mjs.

NEW IN 1.3.0
- Manga mode: background.js downloads manga page images the reader already shows (readers often serve them cross-origin without CORS): http(s) only, no cookies, 25 MB cap, timeout, max 5 redirects followed by hand. Local, private and cloud-metadata addresses are refused by name and by the address that answered.
- webRequest (new): read-only listeners (no blocking, no changes) read details.ip and the Location header for page/frame loads and the add-on's own image fetches, only for that address check. Kept in storage.session, never sent.
- Color controls: applied in the shader's final pass; settings in storage.local.

INNERHTML (the validator's 5 warnings)
- popup.js video card (src/popup.ts): constant template, no interpolation; page text is set later with textContent.
- popup.js color tab (src/popup-color.ts): slider rows and the profile menu are built as strings. The only non-constant text is the user's own profile names/ids, always passed through esc() (escapes & < > "). Everything else is a fixed key, a number or a constant SVG.
- content.js (src/fullscreen-color.ts): a fixed SVG icon.
No string from a web page reaches innerHTML.

WEBSITE PAGES (the add-on itself sends nothing)
- runtime.setUninstallURL opens https://anime4nerd.pages.dev/uninstalled?v=<version>.
- The popup's bug icon links to https://anime4nerd.pages.dev/report?v=<version>&b=firefox.
Their optional forms send only what the user types (and screenshots they attach) when they press send.

PERMISSIONS
- storage: settings, per-site on/off, color profiles, local usage counts for a "rate it" card. Never sent.
- scripting: injects content scripts into already-open tabs on install/update.
- webNavigation: getAllFrames (players live in iframes); onCommitted for the address check.
- <all_urls>: players and readers are embedded from any domain; nothing runs beyond finding videos until the user switches one on.

TESTING
Open a page with a CORS-enabled <video> (e.g. a .webm opened directly), click the toolbar button, switch the video on.
```

## Screenshots

AMO takes 1280×800 screenshots (shown smaller). The Chrome set in `docs/store/` can be reused,
in the same order as the Chrome listing:

1. `anime4nerd-firefox-1-hero.png`
2. `anime4nerd-2-compare.png` (Morevna Project frame, CC BY 3.0, credited on the image)
3. `anime4nerd-firefox-3-manga.png`
4. `anime4nerd-firefox-4-color.png`
5. `anime4nerd-5-privacy.png`

The `firefox-` shots run the Firefox build of the popup (`shots.html?s=hero&b=firefox`): no GPU
timer, so the popup shows frame rate instead of GPU milliseconds, and the hero names Firefox.
The compare and privacy slides are the same for both stores. Do not upload
`anime4nerd-promo-440x280.png`: AMO has no promo tile.

Screenshot captions:
1. The popup on a video, with presets and upscale factor.
2. Before / after: browser scaling vs Anime4K A+A with darken lines.
3. Manga mode: pages upscaled once per chapter, with a page map.
4. Color controls: ready-made looks and your own profiles.
5. Privacy: the video never leaves your browser.

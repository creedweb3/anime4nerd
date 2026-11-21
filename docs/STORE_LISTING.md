# Chrome Web Store listing (draft)

**Name:** Anime4Nerd: Anime Upscaler & Video Enhancer (Anime4K) (from `manifest.json`)

**Summary (132 chars max):**
Anime upscaler for any web video: real-time Anime4K 2x–8x upscaling on your GPU. Sharper lines, less blur. Runs locally. (from `manifest.json`)

**Category:** Entertainment (or Productivity)

**Description:**

An anime upscaler and video enhancer for the browser. Anime4Nerd runs the open-source Anime4K shaders on any web video, in real time. Switch a video on and it is restored and upscaled 2× (or more) on your GPU while it plays: sharper anime lines, less blur, less noise. A 1080p episode becomes 4K; 720p becomes 1440p, or 4K at 4×.

What you get
• Six presets: Mode A / B / C and their stronger A+A / B+B / C+A variants
• Optional line effects: darken lines, thin lines
• Upscale factor: auto (4× when a small video is shown large), or 2× up to 8×, capped to what your GPU can hold
• Fullscreen menu: change preset, line effects and upscale factor without leaving fullscreen, including embedded players and F11
• Works on embedded players too (videos inside iframes are found automatically)
• Live performance panel: GPU % per frame, ms, output fps, late frames, 2-second graph
• Per-site switch that is remembered, so the next episode is already upscaled
• Manga mode: upscales the pages of manga readers once per chapter (Alt+M shows the originals)
• Color controls: brightness, contrast, saturation, temperature and more, with ready-made looks and saved profiles
• Something wrong? The bug icon in the popup opens a short report form with your version filled in; replies come back on the website, no account needed

How it works
The original Anime4K GLSL shaders by bloc97 are loaded unchanged and run through WebGL2. Each video frame goes through the chosen chain of convolution passes and the result is drawn on a canvas over the player. The networks upscale exactly 2× per pass (1080p → 2160p); higher factors chain extra 2× passes.

Privacy
No personal data is collected, nothing about you is sent, no accounts; the only downloads are the page images a manga reader already shows (manga mode). It only finds videos on the page and does nothing until you switch one on, and the video stays on your machine. The popup's bug icon and the page shown after removal open optional forms on our website; they send only what you write (and any screenshots you attach), and only when you press send. Full policy: https://anime4nerd.pages.dev/privacy

Requirements
Chrome / Brave / Edge 116+, a GPU with WebGL2. The video must be served with CORS (most players do this). DRM video (Widevine) cannot be read by any extension.

Not affiliated with bloc97 or any streaming site. Anime4K is MIT licensed.
Screenshot credits: the before/after image uses "A snapshot from the 2012 demo release from the Morevna Project" by Morevna Project (morevnaproject.org), licensed CC BY 3.0 (creativecommons.org/licenses/by/3.0). Cropped and upscaled for comparison. No endorsement implied.

**Permission justifications (store form):**
- `storage`: saves the chosen preset, color settings and profiles, which sites and manga readers are switched on, whether the user has a report ticket on our website (yes or no), and local usage counts (upscaled time and episodes) that decide when the popup shows a "rate it" card. Stays on the device; nothing is sent.
- `scripting`: adds the upscaler to tabs that were already open at install, so no reload is needed.
- `webNavigation`: lists the frames of the current tab, because video players are usually embedded in iframes.
- `webRequest`: Manga mode only. Read-only listeners (no blocking, no changes) note which IP address answered a page load and the extension's own downloads of manga page images. Manga readers often serve page images from other hosts without CORS, so the extension downloads them itself; the address check makes sure a page cannot use those downloads to reach local or private network addresses. Nothing is sent anywhere.
- Host permission `<all_urls>`: video players and manga readers are embedded from many different domains (the page and the player's host differ), so the extension must be able to find a video or reader pages in any frame. It reads frames only from videos and readers the user switches on and sends nothing about the user anywhere.
- Single purpose: upscale anime video and manga pages on pages the user enables.

**Screenshots (1280×800, in `docs/store/`, uploaded for 1.3.0 in this order; the store allows 5):**
1. `anime4nerd-1-hero.png`: headline + the real 1.3.0 popup (upscale tab).
2. `anime4nerd-2-compare.png`: before/after wipe (A+A + darken lines) on a Morevna Project frame (CC BY 3.0, credited on the image).
3. `anime4nerd-3-manga.png`: manga mode, the real popup on a 30-page chapter with its page map.
4. `anime4nerd-4-color.png`: color controls, the real popup's color tab.
5. `anime4nerd-5-privacy.png`: privacy summary (nothing about you is sent; manga mode only downloads reader images).

Hero, manga and color show the real popup: `docs/store/shots.html` frames `test/popup-live.html?store=1`
(fictional names, no real shows). Render them over http from the repo root at 1280×800 (see the comment
at the top of `shots.html`); the earlier presets, performance and fullscreen images were retired in 1.3.0.

**Promo tile 440×280:** `docs/store/anime4nerd-promo-440x280.png` (regenerated for 1.1 from `shots.html?s=promo`, "2×–8×").

## Store fields

- Privacy policy URL: https://anime4nerd.pages.dev/privacy
- Homepage URL: https://anime4nerd.pages.dev/
- Support URL: https://anime4nerd.pages.dev/report

## Privacy practices tab

- Single purpose: Upscales web video and manga reader pages in real time with the Anime4K shaders, on videos and readers the user switches on.
- Remote code: No, I am not using remote code. All JavaScript and shaders ship in the package.
- Data usage: check none of the data types. The extension itself collects and transmits nothing.
  It only opens two website pages: https://anime4nerd.pages.dev/uninstalled?v=<version> after removal
  (`chrome.runtime.setUninstallURL`) and https://anime4nerd.pages.dev/report?v=<version>&b=chrome from
  the popup's bug icon. Their optional forms send what the user types and any screenshots they attach,
  only when they press send, and that text or those screenshots may contain personal data the user
  chooses to include. If a reviewer asks, say this and link the privacy policy.
- Certify all three: not sold to third parties; not used for unrelated purposes; not used for creditworthiness or lending.

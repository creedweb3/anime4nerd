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
• Upscale factor: auto (4× when a small video is shown large), or 2× up to 32×, capped to what your GPU can hold
• Fullscreen menu: change preset, line effects and upscale factor without leaving fullscreen, including embedded players and F11
• Works on embedded players too (videos inside iframes are found automatically)
• Live performance panel: GPU % per frame, ms, output fps, late frames, 2-second graph
• Per-site switch that is remembered, so the next episode is already upscaled
• Something wrong? The bug icon in the popup opens a short report form with your version filled in

How it works
The original Anime4K GLSL shaders by bloc97 are loaded unchanged and run through WebGL2. Each video frame goes through the chosen chain of convolution passes and the result is drawn on a canvas over the player. The networks upscale exactly 2× per pass (1080p → 2160p); higher factors chain extra 2× passes.

Privacy
No personal data is collected automatically; no network requests, no accounts. It only finds videos on the page and does nothing until you switch one on, and the video stays on your machine. The popup's bug icon and the page shown after removal open optional forms on our website; they send only what you write (and any screenshots you attach), and only when you press send. Full policy: https://anime4nerd.pages.dev/privacy

Requirements
Chrome / Brave / Edge 116+, a GPU with WebGL2. The video must be served with CORS (most players do this). DRM video (Widevine) cannot be read by any extension.

Not affiliated with bloc97 or any streaming site. Anime4K is MIT licensed.
Screenshot credits: the before/after image uses "A snapshot from the 2012 demo release from the Morevna Project" by Morevna Project (morevnaproject.org), licensed CC BY 3.0 (creativecommons.org/licenses/by/3.0). Cropped and upscaled for comparison. No endorsement implied.

**Permission justifications (store form):**
- `storage`: saves the chosen preset, which sites are switched on, and local usage counts (upscaled time and episodes) that decide when the popup shows a "rate it" card. Stays on the device; nothing is sent.
- `scripting`: adds the upscaler to tabs that were already open at install, so no reload is needed.
- `webNavigation`: lists the frames of the current tab, because video players are usually embedded in iframes.
- Host permission `<all_urls>`: video players are embedded from many different domains (the page and the player's host differ), so the extension must be able to find a `<video>` in any frame. It reads frames only from videos the user switches on and sends nothing anywhere.
- Single purpose: upscale video on pages the user enables.

**Screenshots (ready, 1280×800, in `docs/store/`, upload in this order; the store allows 5):**
1. `anime4nerd-1-hero.png`: headline + the popup, with the upscale row (regenerated for 1.1.0).
2. `anime4nerd-2-compare.png`: before/after wipe (A+A + darken lines) on a Morevna Project frame (CC BY 3.0, credited on the image).
3. `anime4nerd-6-fullscreen.png`: the fullscreen ☰ menu and upscale factors (new in 1.1.0).
4. `anime4nerd-3-presets.png`: the six presets explained.
5. `anime4nerd-5-privacy.png`: privacy summary.

`anime4nerd-4-performance.png` (the GPU meter explained) is retired from the upload: the hero and
fullscreen shots both show the meter. The 1.1.0 images are rendered from `docs/store/shots.html`
with headless Edge (command in the file).

The popup shows a fictional title ("Starlight Academy") on purpose: no real show names or frames.

**Promo tile 440×280:** `docs/store/anime4nerd-promo-440x280.png` (regenerated for 1.1 from `shots.html?s=promo`, "2×–8×").

## Store fields

- Privacy policy URL: https://anime4nerd.pages.dev/privacy
- Homepage URL: https://anime4nerd.pages.dev/
- Support URL: https://github.com/creedweb3/anime4nerd/issues

## Privacy practices tab

- Single purpose: Upscales web video in real time with the Anime4K shaders, on videos the user switches on.
- Remote code: No, I am not using remote code. All JavaScript and shaders ship in the package.
- Data usage: check none of the data types. The extension itself collects and transmits nothing.
  It only opens two website pages: https://anime4nerd.pages.dev/uninstalled?v=<version> after removal
  (`chrome.runtime.setUninstallURL`) and https://anime4nerd.pages.dev/report?v=<version>&b=chrome from
  the popup's bug icon. Their optional forms send what the user types and any screenshots they attach,
  only when they press send, and that text or those screenshots may contain personal data the user
  chooses to include. If a reviewer asks, say this and link the privacy policy.
- Certify all three: not sold to third parties; not used for unrelated purposes; not used for creditworthiness or lending.

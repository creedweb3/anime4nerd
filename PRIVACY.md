# Anime4Nerd — Privacy Policy

_Last updated: 2026-11-12_

**Short version: Anime4Nerd collects no personal data automatically. Everything runs inside your browser. The only way anything reaches us is an optional feedback or problem-report form on our website, and only when you fill it in and press send. What you type and the screenshots you attach can contain personal information if you include it, so please leave out anything private.**

## What the extension does

Anime4Nerd upscales video on web pages you choose, using your computer's GPU. To do that it needs to read video frames on those pages and draw the result over the video.

## Site access

At install your browser asks you to allow the extension on all websites. That is needed because video players are often embedded from other domains, so it cannot know in advance which site the video comes from. On every page it only looks for `<video>` elements. It does nothing to a video until you switch that video on in the popup, and you can restrict it to specific sites at any time in your browser's extension settings (Chrome, Edge, Brave: the extension's details → Site access; Firefox: `about:addons` → Anime4Nerd → Permissions).

## Data handled locally

- **Video frames** are read into GPU memory to be upscaled and are discarded immediately after each frame is drawn. They are never saved or sent anywhere.
- **Page metadata** (page title, headings, Open Graph tags, schema.org data, Media Session metadata) is read only when you open the popup, to label the video (for example "Attack on Titan · E1"). It stays in the popup and is not stored.
- **Settings** (chosen preset, line effects, upscale factor, which sites you switched on) are stored with the browser's extension storage. The preset, line effects and upscale factor may sync between your own browsers if you have Chrome sync or Firefox Sync turned on; the per-site switches stay on this device. The only other stored values are the version number of an update whose "what's new" note you have not seen yet, and the usage counts below. Nothing else is stored.
- **Usage counts**: the total time upscaling has run and how many videos were upscaled for at least 10 minutes, plus which "rate it" card you last dismissed or answered, whether you clicked it or said you already rated, and whether you had the extension before these counts were added. These are numbers only: no titles, sites or addresses. They stay on this device (never synced, never sent) and are used only to show that card in the popup. Removing the extension deletes them.
- **Performance numbers** (GPU time per frame, frame rate) are measured locally and shown in the popup. They are not recorded.

## Data leaving your device

The extension makes no network requests of its own. It has no analytics, no telemetry, no crash reporting, no remote configuration, and no accounts.

It opens two pages of our website, anime4nerd.pages.dev:

- **When you remove the extension**, your browser opens `/uninstalled?v=<version>`. The link carries only the version number you had.
- **When you click the bug icon** in the popup, a new tab opens `/report?v=<version>&b=<chrome or firefox>`.

Opening either page is an ordinary page visit. The pages load fonts from Google Fonts, and once you start using a form they load Cloudflare Turnstile (below). Each page has an optional form, and it sends only when you press send:

- **What is sent**: the reasons you ticked, the text you wrote, the version (and on the report page the browser), and on the report page up to 3 screenshots you chose. Screenshots are re-encoded as JPEG in your browser before sending, which removes photo metadata such as location; the server also refuses any image that still carries such metadata. A screenshot shows whatever was on your screen, so crop out anything private. Text and screenshots are stored as plain data with the date and time of sending, to the minute. No name, email, account or IP address is stored.
- **Abuse limits**: to cap how many answers one visitor can send per day, the site keeps a counter under a one-way hash of your IP address mixed with a secret and the date. IPv6 addresses are counted by their network (/64). The hash changes every day and the counter expires after two days; the IP address itself is never stored. Cloudflare Turnstile, an invisible check that loads when you start using the form, verifies the sender is not a bot.
- **Where it goes**: answers are stored with Cloudflare (Workers KV) and read only by the developer, to fix problems. Screenshots are deleted automatically after 60 days; text answers are kept until deleted. Nothing is shared or sold.

## Permissions explained

| Permission | Why |
|---|---|
| `storage` | Save your preset, the per-site on/off switch and the local usage counts |
| `scripting` | Add the upscaler to tabs that were already open when the extension was installed |
| `webNavigation` | Find the frames of the current tab, because players are often in iframes |
| Access to all sites | Find videos and read their frames on whatever site the player is hosted on |

## Third parties

The Anime4K shaders are open-source code by bloc97, run locally. The extension contacts no third-party service. The website is hosted on Cloudflare Pages, loads fonts from Google Fonts, and its forms use Cloudflare Turnstile; Cloudflare's and Google's privacy policies cover those page visits and checks.

## Changes

If this policy changes, the date above will be updated and the change described in the project's changelog.

## Contact

Open an issue at https://github.com/creedweb3/anime4nerd/issues.

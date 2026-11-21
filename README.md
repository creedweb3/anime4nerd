<div align="center">

<a href="https://anime4nerd.pages.dev/"><img src="docs/readme/banner.png" alt="Anime4Nerd: sharper anime, right in your browser" width="100%"></a>

<br>

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/kblnmcdmlgeidaclnhjmcffefmkehkpm?style=flat-square&label=chrome&labelColor=0b0b0b&color=9fd3a8&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/anime4nerd/kblnmcdmlgeidaclnhjmcffefmkehkpm)
[![Chrome users](https://img.shields.io/chrome-web-store/users/kblnmcdmlgeidaclnhjmcffefmkehkpm?style=flat-square&label=users&labelColor=0b0b0b&color=9fd3a8)](https://chromewebstore.google.com/detail/anime4nerd/kblnmcdmlgeidaclnhjmcffefmkehkpm)
[![Firefox Add-ons](https://img.shields.io/amo/v/anime4nerd?style=flat-square&label=firefox&labelColor=0b0b0b&color=9fd3a8&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/firefox/addon/anime4nerd/)
[![Latest release](https://img.shields.io/github/v/release/creedweb3/anime4nerd?style=flat-square&label=release&labelColor=0b0b0b&color=e4e4e4)](https://github.com/creedweb3/anime4nerd/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-e4e4e4?style=flat-square&labelColor=0b0b0b)](LICENSE)

**The original Anime4K neural upscaler, live on your own GPU.**<br>
Switch it on for any web video and every frame is restored and upscaled 2× to 8× while it plays.

[**Add to Chrome**](https://chromewebstore.google.com/detail/anime4nerd/kblnmcdmlgeidaclnhjmcffefmkehkpm) &nbsp;·&nbsp; [**Add to Firefox**](https://addons.mozilla.org/firefox/addon/anime4nerd/) &nbsp;·&nbsp; [**Website**](https://anime4nerd.pages.dev/) &nbsp;·&nbsp; [**Report a problem**](https://anime4nerd.pages.dev/report)

</div>

<br>

## ✦ What you get

<table>
<tr>
<td width="50%" valign="top"><img src="docs/store/anime4nerd-1-hero.png" alt="The popup on a video"><br><b>Any web video, one switch.</b> Six presets, line effects, 2× to 8× output, a live GPU meter, and a per-site switch that remembers the next episode.</td>
<td width="50%" valign="top"><img src="docs/store/anime4nerd-2-compare.png" alt="Before and after"><br><b>Cleaner lines, less blur.</b> bloc97's original Anime4K shaders, unchanged, run through WebGL2. No third-party port.</td>
</tr>
<tr>
<td width="50%" valign="top"><img src="docs/store/anime4nerd-3-manga.png" alt="Manga mode"><br><b>Manga mode.</b> Manga reader pages upscaled once per chapter, with a page map. <kbd>Alt</kbd>+<kbd>M</kbd> shows the originals.</td>
<td width="50%" valign="top"><img src="docs/store/anime4nerd-4-color.png" alt="Color controls"><br><b>Color controls.</b> Ten controls in VLC's units, five ready-made looks and your own profiles, also in the fullscreen menu.</td>
</tr>
</table>

<table>
<tr>
<td align="center" width="25%"><b>Private</b><br><sub>No account, no analytics. The video never leaves your machine.</sub></td>
<td align="center" width="25%"><b>Fullscreen menu</b><br><sub>Change anything without leaving fullscreen, even in embedded players.</sub></td>
<td align="center" width="25%"><b>Every browser</b><br><sub>Chrome, Edge, Brave 116+ and Firefox 140+ (desktop).</sub></td>
<td align="center" width="25%"><b>Open source</b><br><sub>MIT, like the Anime4K shaders it runs.</sub></td>
</tr>
</table>

## ✦ How it runs

<img src="docs/readme/pipeline.png" alt="Pipeline: video frame, clamp highlights, restore CNN, upscale x2, more x2 passes up to 8x, canvas over the player" width="100%">

## ✦ Install

<p align="center">
<a href="https://chromewebstore.google.com/detail/anime4nerd/kblnmcdmlgeidaclnhjmcffefmkehkpm"><img src="docs/readme/btn-chrome.png" alt="Add to Chrome" height="52"></a>&nbsp;&nbsp;
<a href="https://addons.mozilla.org/firefox/addon/anime4nerd/"><img src="docs/readme/btn-firefox.png" alt="Add to Firefox" height="52"></a>
</p>

<img src="docs/readme/steps.png" alt="1 Install, 2 Play any web video, 3 Flip the switch" width="100%">

## ✦ Build

```bash
npm install
npm run build            # Chrome, Edge, Brave  ->  dist/
npm run build:firefox    # Firefox              ->  dist-firefox/
npm run pack:firefox     # also writes "Anime4Nerd firefox.zip"
```

## ✦ Under the hood

<p>
<a href="docs/TECHNICAL.md#presets"><img src="docs/readme/doc-presets.png" alt="Presets" width="49%"></a>
<a href="docs/TECHNICAL.md#upscale-factor"><img src="docs/readme/doc-upscale.png" alt="Upscale factor" width="49%"></a>
<a href="docs/TECHNICAL.md#how-it-works"><img src="docs/readme/doc-how.png" alt="How it works" width="49%"></a>
<a href="docs/TECHNICAL.md#video-naming"><img src="docs/readme/doc-naming.png" alt="Video naming" width="49%"></a>
<a href="docs/TECHNICAL.md#gpu-meter"><img src="docs/readme/doc-gpu.png" alt="GPU meter" width="49%"></a>
<a href="docs/TECHNICAL.md#limitations"><img src="docs/readme/doc-limits.png" alt="Limitations" width="49%"></a>
<a href="docs/TECHNICAL.md#testing"><img src="docs/readme/doc-testing.png" alt="Testing" width="49%"></a>
<a href="docs/TECHNICAL.md#load-from-source"><img src="docs/readme/doc-source.png" alt="Load from source" width="49%"></a>
</p>

## ✦ License and privacy

<p>
<a href="LICENSE"><img src="docs/readme/lic-mit.png" alt="MIT license" width="24%"></a>
<a href="THIRD_PARTY_NOTICES.md"><img src="docs/readme/lic-anime4k.png" alt="Anime4K shaders, MIT" width="24%"></a>
<a href="PRIVACY.md"><img src="docs/readme/lic-privacy.png" alt="Privacy policy" width="24%"></a>
<a href="SECURITY.md"><img src="docs/readme/lic-security.png" alt="Security" width="24%"></a>
</p>

<div align="center">
<br>
<sub>Banner and before/after frame: "A snapshot from the 2012 demo release from the Morevna Project" by <a href="https://morevnaproject.org">Morevna Project</a>, <a href="https://creativecommons.org/licenses/by/3.0/">CC BY 3.0</a>, cropped and upscaled for comparison.<br>Store listings: <a href="docs/STORE_LISTING.md">Chrome Web Store</a> · <a href="docs/AMO_LISTING.md">Firefox Add-ons</a>. Not affiliated with bloc97 or any streaming site.</sub>
</div>

# Changelog

## Unreleased

### Added
- Firefox support (Firefox 140 or newer; the manifest also allows Firefox for
  Android 142+). `npm run build:firefox` writes `dist-firefox/` and
  `npm run pack:firefox` writes `Anime4Nerd firefox.zip`, from the same sources.
  Presets, line effects, upscale factors, the per-site switch and the
  fullscreen menu work as in Chrome; settings sync through Firefox Sync.
  `test/firefox-smoke.mjs` is a headless Firefox smoke test.

### Fixed
- Firefox: upscaling was capped at about 25 fps on 60 fps video, because
  Firefox calls `requestVideoFrameCallback` only about 25 times a second. The
  Firefox build now renders every decoded frame. 1080p60 → 4K, Mode A, RTX 2060:
  57 fps (Chrome: 55).
- Pages that are just a video file (a `.webm` or `.mp4` opened directly): the
  overlay no longer sets `position: relative` on `<body>` or `<html>`. In Firefox
  that collapsed the video to 0×0 and the page went black.
- Browsers without GPU timer queries (Firefox): the popup now says "GPU timing
  not available in this browser" instead of "no measurements yet" forever, and
  the GPU fields and graph make way for frame-rate figures: the video's fps,
  the share of its frames drawn, frames missed per second, and passes and VRAM.
  The top chip shows the frame rate drawn. The popup and the fullscreen menu
  say "keeping up" (97% or more of the video's frames drawn), "near limit"
  (90% or more) or "dropping frames".
- `npm run pack` / `pack:firefox` on Linux and macOS now write a real zip
  (Info-ZIP); GNU tar wrote a tar archive named `.zip`.

### Docs
- `PRIVACY.md` and `SECURITY.md` cover Firefox (site permissions, Firefox Sync,
  AMO signing). The privacy policy now also says that the per-site switches are
  not synced and names the stored "what's new" version flag.

## 1.1.1 (2026-10-26)

### Fixed
- The fullscreen menu now appears on more players:
  - Sites that fullscreen the bare `<video>`: for a video being upscaled, the
    player container goes fullscreen instead, so upscaling and the menu keep
    working. (The browser's own `<video controls>` button still fullscreens the
    bare video.)
  - Embedded players whose outer page fullscreens the whole iframe, and F11.
  - Players whose fullscreen element keeps the video in a shadow root.
- No more "Extension context invalidated" errors from a copy of the content
  script left behind by an extension reload, including from menu clicks.

## 1.1.0 (2026-10-26)

### Added
- Upscale factor: **auto** (default), 2×, 4×, 8×, 16×, 32×. Factors above 2×
  chain extra `Anime4K_Upscale_CNN_x2_M` passes, one per doubling. Auto uses 4×
  only when the video is shown at more than 2× its source size, such as 720p in
  fullscreen on a 1440p or 4K screen. A manual choice runs at the largest factor
  that fits the GPU texture limit, 8K output and a 2 GB texture budget; the
  popup then says e.g. `(8×) · 32× capped: GPU limit`.
- The video card shows the exact output size, e.g. `720p → 5120×2880 (4×)`.
- Fullscreen menu: a ☰ button in the top-right corner of a fullscreen player
  opens on/off, presets, line effects, upscale factor, output size and a GPU
  frame-time graph. It fades out when the mouse is idle and does not pass clicks
  through to the player.

### Fixed
- After the extension was reloaded or updated, the old content script kept
  running beside the new one: "Extension context invalidated" errors, two
  overlays on one video, and settings changes that seemed to have no effect. The
  old copy now removes its overlay and menu and stops.

### Security
- Review and page-side attack tests of the new features; see `SECURITY.md`.
  Hardened against pages restyling the fullscreen menu to capture clicks and
  against pages forging the takeover event.

## 1.0.1 (2026-10-20)

### Fixed
- Video with non-square pixels (anamorphic DVD sources, e.g. 704x480 shown as
  704x528) failed every frame with a WebGL error and showed a stale or blank
  canvas. Textures are now sized from the decoded frame.
- Rotated video and odd frame sizes upload and display correctly.
- WebGL upload errors are detected (checked once a second) and switch back to
  the normal video with a message, instead of leaving the status at Active.
- A removed video could restart a GPU renderer through leftover document
  listeners.
- Overlay placement: borders and scroll offsets of the player container,
  `object-position`, `object-fit: none | scale-down`, clipping for
  `object-fit: cover`, and players that move the video to another container.
- Picture-in-picture and fullscreen suspend now works for videos inside shadow
  roots.
- Quick settings toggles could overwrite each other; popup switches could stop
  updating after a press that was dragged off the card.

### Changed
- At most two videos per page are upscaled at once (playing, then larger
  videos first); the others report "Waiting".
- A stream that keeps changing frame size stops after three rebuilds in 30
  seconds instead of rebuilding forever.

### Added
- "What's new" notice: after an update the toolbar icon shows a NEW badge,
  and the next popup open shows a one-line banner linking to the release
  notes. Opening the popup clears both. No network requests; the site opens
  only if the link is clicked.
- `test/geometry.mjs`: loads the built extension into Edge or Chrome and checks
  anamorphic, rotated, odd-sized and square sources, overlay placement and the
  renderer cap.

## 1.0.0 (2026-10-18)

First release: real-time 2x Anime4K upscaling of web video in WebGL2 using
bloc97's original shaders, six presets, optional line darkening and thinning,
per-source on/off.

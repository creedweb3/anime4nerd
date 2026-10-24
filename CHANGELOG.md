# Changelog

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

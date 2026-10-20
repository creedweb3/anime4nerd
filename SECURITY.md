# Security

This document describes what Anime4Nerd can and cannot do, how it is protected,
what was reviewed, and how to use it safely. Last reviewed: 2026-10-20 (v1.0.1).

## Threat model in one paragraph

The extension's only job is to read video frames on sites you enable and draw an
upscaled copy over the player. It has no server, no network code, no accounts and
no analytics. The things that could go wrong are: a page you enabled tricking the
extension into doing something on another site, a page feeding it strings that
break the popup, a page making it eat CPU/GPU, or the published package being
tampered with. Each is addressed below.

## What the extension never does

- Never sends data anywhere. There is no `fetch`, `XMLHttpRequest`, `WebSocket`,
  `sendBeacon` or remote script in the code. You can verify with
  `grep -rE "fetch\(|XMLHttpRequest|WebSocket|sendBeacon" src/`.
- Never touches a video you did not switch on. The content script only looks for
  `<video>` elements; upscaling starts from your click in the popup. You can
  restrict the extension to chosen sites under extension settings → Site access.
- Never stores video frames, page text or URLs. Only the preset, two line-effect
  booleans and a per-site on/off map are stored.
- Never executes code from a page. Shaders are bundled constants; page strings are
  only ever shown as text.

## Protections in the code

| Risk | Protection |
|---|---|
| Popup HTML injection from page titles | All page-derived strings are inserted with `textContent`; the only `innerHTML` uses are constant templates. |
| A page spoofing extension messages | No `externally_connectable`, so web pages cannot message the extension. The background worker accepts no messages at all. |
| Broad site access | Required because players are embedded from arbitrary domains. The content script does no work beyond finding `<video>` elements until the user switches a video on. Users can narrow access per site in the browser. |
| Regex denial of service from long page strings | Every page string is capped at 300 characters (URLs at 2048) before any pattern runs; overlapping quantifiers were removed. |
| Deeply nested JSON-LD | Parser depth capped at 8 levels / 200 nodes; the handler is wrapped so a failure returns `null` instead of hanging the popup. |
| Oversized strings over the message channel | Titles, episode names and error messages are truncated before being sent to the popup. |
| DOM scan cost on busy pages | Video discovery is throttled to one scan per 300 ms. |
| GPU memory exhaustion | Sources above 1440p are refused with a message; only one idle renderer is kept warm; context loss is caught and reported. |
| Fingerprinting via extension files | `gpu.js` uses `use_dynamic_url`, so its URL changes per session. |
| Supply chain | Zero runtime npm dependencies in the shipped package. Build uses esbuild + TypeScript only. Shaders are copied verbatim from a pinned bloc97 commit (see `THIRD_PARTY_NOTICES.md`). |

## What was reviewed

An independent review pass (2026-10-17) covered: manifest permissions, message
handling trust, popup DOM injection, storage validation, regex complexity on
page-controlled input, resource exhaustion (timers, observers, GPU memory),
web-accessible resources, CSP, prototype pollution in JSON-LD parsing, and the
service-worker injection path. Findings were all low/medium severity, none
allowed data exfiltration, and all were fixed in v1.0.0. The per-site permission
flow was later replaced by install-time site access at the user's request.

A second pass (2026-10-20, v1.0.1) found no critical or high security issues. It
fixed a lifecycle bug where a removed video could restart a GPU renderer, capped
pages at two active renderers so a page full of videos cannot exhaust WebGL
contexts, and limited how often a stream that keeps changing size can force a
rebuild. Remaining low-severity notes: the overlay canvas and the parent's
`position: relative` are visible to the page (so a page can tell the extension is
active there), and frames without a host (`about:blank`, `srcdoc`) share one
on/off setting per media host.

## For people who install it

- Install only from the Chrome Web Store listing or from a zip whose source you
  trust. Unpacked installs run whatever is in the folder.
- Want it on fewer sites? `chrome://extensions` → Anime4Nerd → Details →
  Site access → "On specific sites", then add only the sites you watch on
  (and their player domains, which the popup shows on each video card).
- It only acts on a video after you switch that video on in the popup.
- It cannot and does not bypass DRM. If a video is protected, you will see
  "This video source does not allow browser upscaling".
- The extension cannot see or change what you type, your passwords, cookies, or
  other tabs. Its only access is reading pixels of videos on enabled pages.

## For the maintainer

- Keep the content script passive: no work beyond `<video>` discovery until the user switches a video on.
- Do not add `externally_connectable`, remote code, or any network call without
  updating `PRIVACY.md` and this file.
- Pin the bloc97 shader commit; re-run the review checklist above before a
  release that touches message handling or the popup renderer.
- Sign releases: the Chrome Web Store signs the CRX; for zips, publish a SHA-256
  next to the download.

## Reporting a vulnerability

Open an issue marked "security" or contact the maintainer privately. Please
include the browser version, the site, and steps to reproduce.

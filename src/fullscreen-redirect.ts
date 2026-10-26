// Runs in the page's own JavaScript world (manifest "world": "MAIN"), at document_start.
// When the page asks to fullscreen a <video> that Anime4Nerd is upscaling, fullscreen the video's
// parent element instead: a bare fullscreen video sits in the browser's top layer, where neither
// the upscaled canvas nor the fullscreen menu can be drawn. The content script marks such videos
// with data-a4k-on; every other element and video behaves exactly as before. No extension APIs here.
// Limitation: the browser's own <video controls> fullscreen button does not go through this API.

declare global { interface Window { __a4kFsPatched?: boolean } }

const MARK = 'data-a4k-on'; // set by the content script on videos being upscaled
const REDIRECTED = 'data-a4k-fs'; // set here on the parent; content.css sizes the video inside it

type FullscreenFn = (this: Element, options?: FullscreenOptions) => Promise<void> | void;

if (!window.__a4kFsPatched) {
  window.__a4kFsPatched = true;
  const proto = Element.prototype as unknown as Record<string, FullscreenFn | undefined>;
  const redirected = new Set<Element>();

  for (const name of ['requestFullscreen', 'webkitRequestFullscreen']) {
    const original = proto[name];
    if (typeof original !== 'function') continue;
    proto[name] = function patched(this: Element, options?: FullscreenOptions) {
      const parent = this instanceof HTMLVideoElement && this.hasAttribute(MARK) ? this.parentElement : null;
      if (!parent) return original.call(this, options);
      parent.setAttribute(REDIRECTED, '');
      redirected.add(parent);
      const result = original.call(parent, options);
      // If the container may not go fullscreen, fall back to the video itself, as the page asked.
      return result instanceof Promise ? result.catch(() => original.call(this, options)) : result;
    };
  }

  document.addEventListener('fullscreenchange', () => {
    for (const el of redirected) {
      if (el !== document.fullscreenElement) { el.removeAttribute(REDIRECTED); redirected.delete(el); }
    }
  }, true);
}

export {};

// Links to the Anime4Nerd site that carry the extension version (and browser) in the URL.
// The extension only opens these pages; their forms send answers only when the user presses send.

/** The project website. popup.html repeats it in its static fallback links. */
export const SITE = 'https://anime4nerd.pages.dev';
// The site accepts only three-part versions; anything else (a four-part manifest version, say)
// is left out of the link rather than rejected there.
const VERSION = /^\d+\.\d+\.\d+$/;

export type Browser = 'chrome' | 'firefox';

/** The browser this build ships for. */
export const BROWSER: Browser = __FIREFOX__ ? 'firefox' : 'chrome';

function link(path: string, params: Record<string, string>): string {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== ''));
  const s = q.toString();
  return `${SITE}/${path}${s ? `?${s}` : ''}`;
}

const cleanVersion = (version: string): string => (VERSION.test(version) ? version : '');

/** Page the browser opens after the extension is removed. */
export function uninstallUrl(version: string): string {
  return link('uninstalled', { v: cleanVersion(version) });
}

/** "Report a problem" page opened from the popup. */
export function reportUrl(version: string, browser: Browser): string {
  return link('report', { v: cleanVersion(version), b: browser });
}

// Site access: whether the browser lets Anime4Nerd run on a page and its player frames.
//
// Firefox (and Chrome's "on click" site access) can withhold an extension's access per site.
// Without it the content script is never injected, so the popup would only say "No video found
// yet". These helpers find which hosts still need access so the popup can offer to ask for it.

/** One `scheme://host/*` pattern per http(s) URL, in order, without repeats. Other URLs are skipped. */
export function accessOrigins(urls: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    let url: URL;
    try { url = new URL(raw ?? ''); } catch { continue; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    const pattern = `${url.protocol}//${url.hostname}/*`;
    if (!out.includes(pattern)) out.push(pattern);
  }
  return out;
}

/** The first missing host by name, the rest as a count: "tau-video.xyz and 2 more". */
export function accessLabel(missing: readonly string[]): string {
  if (!missing.length) return '';
  const host = missing[0].replace(/^https?:\/\//, '').replace(/\/\*$/, '');
  return missing.length > 1 ? `${host} and ${missing.length - 1} more` : host;
}

/** The patterns `has` does not confirm. A check that throws counts as granted: no false alarm. */
export async function missingAccess(
  origins: readonly string[],
  has: (origin: string) => Promise<boolean>,
): Promise<string[]> {
  const granted = await Promise.all(origins.map((o) => Promise.resolve().then(() => has(o)).catch(() => true)));
  return origins.filter((_, i) => !granted[i]);
}

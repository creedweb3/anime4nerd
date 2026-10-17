// Best-effort "what is playing" detection for the popup label.
// Order of trust: schema.org JSON-LD > Media Session API > Open Graph > title/h1/URL heuristics.

export interface MediaMeta {
  title: string | null; // series / movie / video title
  season: number | null;
  episode: number | null;
  episodeName: string | null;
  subtitle: string | null; // e.g. YouTube channel, used when there is no episode
  source: string; // which detector produced the title (for debugging)
}

/** Page strings are capped before any regex work; titles longer than this are not titles. */
const MAX_TEXT = 300;
const cap = (s: string | null | undefined): string | null => (s ? s.slice(0, MAX_TEXT) : null);

export const EMPTY_META: MediaMeta = {
  title: null, season: null, episode: null, episodeName: null, subtitle: null, source: 'none',
};

const EP_PATTERNS: RegExp[] = [
  /\bS(?:eason)?[\s\-_]*(\d{1,2})[\s.\-–—:_]*E(?:p(?:isode)?)?\.?[\s\-_]*(\d{1,4})\b/i, // S1E5, Season 1 Episode 5, season-1-episode-5
  /\b(\d{1,2})x(\d{1,4})\b/, // 1x05
  /\bEp(?:isode)?\.?[\s\-_]*(?:#\s*)?(\d{1,4})\b/i, // Episode 5, Ep. 5, Ep5, episode-5
  /[?&](?:ep|episode|e)=(\d{1,4})\b/i, // ?ep=5
  /\/(?:episode|ep)[-/](\d{1,4})\b/i, // /episode-5
];

/** Lower-case, unify dash/quote variants and whitespace so titles from different sources compare equal. */
function norm(s: string): string {
  return s.toLowerCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findEpisode(texts: (string | null | undefined)[]): { season: number | null; episode: number | null } {
  for (const t of texts) {
    if (!t) continue;
    for (const re of EP_PATTERNS) {
      const m = re.exec(t);
      if (!m) continue;
      if (m.length === 3) return { season: Number(m[1]), episode: Number(m[2]) };
      return { season: null, episode: Number(m[1]) };
    }
  }
  return { season: null, episode: null };
}

/** "Friends S08E05 The One with…" -> { series: "Friends", name: "The One with…" }. Null if no episode token inside. */
function splitAtEpisode(text: string): { series: string; name: string } | null {
  for (const re of EP_PATTERNS) {
    const mm = re.exec(text);
    if (!mm || mm.index === undefined) continue;
    const left = text.slice(0, mm.index).replace(/[\s\-–—:.|·(]+$/, '').trim();
    const right = text.slice(mm.index + mm[0].length).replace(/^[\s\-–—:.|·)]+/, '').trim();
    if (left) return { series: left, name: right };
  }
  return null;
}

/** Last meaningful path segment as a title guess: /watch/friends-season-8-episode-5 -> "Friends". */
function titleFromUrl(url: string): string | null {
  try {
    const segs = new URL(url).pathname.split('/').filter((x) => x && !/^(watch|stream|video|v|e|ep|episode|anime|series|movie|tv|play|embed)$/i.test(x) && !/^[A-Za-z0-9_]{16,}$/.test(x) && !/^\d+$/.test(x));
    if (!segs.length) return null;
    let s = decodeURIComponent(segs[segs.length - 1]).replace(/[-_+]+/g, ' ');
    s = s.replace(/\b(season|s)\s*\d+\b.*$/i, '').replace(/\b(episode|ep|e)\s*\d+\b.*$/i, '').replace(/\b\d+x\d+\b.*$/i, '').trim();
    s = s.replace(/\b(english|sub|subbed|dub|dubbed|online|free|hd|full)\b/gi, '').replace(/\s+/g, ' ').trim();
    if (s.length < 2) return null;
    return s.replace(/\b\w/g, (ch) => ch.toUpperCase());
  } catch { return null; }
}

function meta(name: string): string | null {
  const el = document.querySelector<HTMLMetaElement>(`meta[property="${name}"], meta[name="${name}"]`);
  const v = el?.content?.trim();
  return v || null;
}

function siteName(): string {
  const og = meta('og:site_name');
  if (og) return og;
  const host = location.hostname.replace(/^www\./, '').split('.');
  return host.length >= 2 ? host[host.length - 2] : host[0];
}

/** Strip "Watch X Online", " - Site", "| Site", "Episode N" tails etc. from a page title. */
export function cleanTitle(raw: string, site: string): string {
  let t = raw.trim();
  t = t.replace(/^\s*(watch|stream(?:ing)?|ver|regarder)\s+/i, '');
  // split on separators and drop segments that are just the site name or boilerplate
  const parts = t.split(/\s+[-|–—•·:]\s+/).map((p) => p.trim()).filter(Boolean);
  const boiler = /^(online|free|hd|english|sub(bed)?|dub(bed)?|watch online|anime|full episodes?)$/i;
  const kept = parts.filter((p) => p.toLowerCase() !== site.toLowerCase() && !boiler.test(p)
    && !new RegExp(`^${site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(p));
  t = kept[0] ?? parts[0] ?? t;
  t = t.replace(/\b(episode|ep)\.?\s*\d+.*$/i, '').trim();
  t = t.replace(/\s*[-|–—:]\s*$/, '').trim();
  return t;
}

function fromJsonLd(): MediaMeta | null {
  for (const s of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    let data: unknown;
    try { data = JSON.parse(s.textContent || ''); } catch { continue; }
    const nodes: Record<string, unknown>[] = [];
    const walk = (x: unknown, depth: number) => {
      if (depth > 8 || nodes.length > 200) return;
      if (Array.isArray(x)) { for (const item of x.slice(0, 50)) walk(item, depth + 1); return; }
      if (x && typeof x === 'object') {
        nodes.push(x as Record<string, unknown>);
        const g = (x as Record<string, unknown>)['@graph'];
        if (g) walk(g, depth + 1);
      }
    };
    walk(data, 0);
    for (const n of nodes) {
      const type = String(n['@type'] ?? '');
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? cap(v.trim()) : null);
      const num = (v: unknown) => (v !== undefined && v !== null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null);
      if (/TVEpisode|Episode/.test(type)) {
        const series = n.partOfSeries as Record<string, unknown> | undefined;
        const season = n.partOfSeason as Record<string, unknown> | undefined;
        return {
          title: str(series?.name) ?? str(n.name),
          season: num(season?.seasonNumber),
          episode: num(n.episodeNumber),
          episodeName: str(n.name),
          subtitle: null,
          source: 'json-ld',
        };
      }
      if (/^(Movie|VideoObject|TVSeries|CreativeWork)$/.test(type) && str(n.name)) {
        return { title: str(n.name), season: null, episode: null, episodeName: null, subtitle: str(n.author && (n.author as Record<string, unknown>).name), source: 'json-ld' };
      }
    }
  }
  return null;
}

export function mediaSessionMeta(): { title: string | null; artist: string | null; album: string | null } | null {
  try {
    const m = navigator.mediaSession?.metadata;
    if (!m || (!m.title && !m.artist)) return null;
    return { title: cap(m.title), artist: cap(m.artist), album: cap(m.album) };
  } catch { return null; }
}

/** Collect metadata for the current document (meant for the top frame). */
export function collectPageMeta(urlOverride?: string): MediaMeta {
  const site = siteName();
  const ld = fromJsonLd();
  const ms = mediaSessionMeta();
  const og = cap(meta('og:title'));
  const docTitle = cap(document.title) ?? '';
  const h1 = cap(document.querySelector('h1')?.textContent?.trim());
  const url = (urlOverride ?? location.href).slice(0, 2048);

  let out: MediaMeta = ld ? { ...ld } : { ...EMPTY_META };

  if (!out.title) {
    if (ms?.album && ms.title) { out.title = ms.album; out.episodeName = ms.title; out.source = 'media-session'; } else if (ms?.title && !ms.album && !og) { out.title = ms.title; out.subtitle = ms.artist; out.source = 'media-session'; }
  }
  const isSite = (t: string | null) => !t || norm(t) === norm(site) || norm(t) === norm(location.hostname.replace(/^www\./, ''));
  const tryTitle = (raw: string | null, src: string) => {
    if (out.title || !raw) return;
    let t = cleanTitle(raw, site);
    const sp = splitAtEpisode(t);
    if (sp) { t = sp.series; if (!out.episodeName && sp.name) out.episodeName = sp.name; }
    if (isSite(t)) return;
    out.title = t; out.source = src;
  };
  if (isSite(out.title)) out.title = null;
  tryTitle(og, 'og:title');
  tryTitle(docTitle, 'document.title');
  tryTitle(h1, 'h1');
  if (!out.title) { const u = titleFromUrl(url); if (u && !isSite(u)) { out.title = u; out.source = 'url'; } }

  if (out.episode === null) {
    const ep = findEpisode([h1, docTitle, og, url, ms?.title]);
    out.season = out.season ?? ep.season;
    out.episode = ep.episode;
  }

  if (!out.episodeName) {
    // The h1 is the episode name when it differs from the series title and is not just "Episode N".
    const cands = [h1, ms?.title].filter((c): c is string => !!c);
    const titleN = out.title ? norm(out.title) : '';
    for (const c of cands) {
      // Remove the series title and any "Episode N" / "S1E5" token; what remains is the episode name.
      // Work on a dash/case-normalised copy so "–" vs "-" differences do not defeat the match.
      let stripped = norm(c);
      if (titleN) stripped = stripped.split(titleN).join(' ');
      for (const re of EP_PATTERNS) stripped = stripped.replace(re, ' ');
      stripped = stripped.replace(/^[\s\-:.|·]+|[\s\-:.|·]+$/g, '').replace(/\s+/g, ' ').trim();
      if (!stripped || stripped === titleN) continue;
      // Recover original casing: find the stripped text inside the candidate, ignoring dash/case variants.
      const idx = norm(c).indexOf(stripped);
      out.episodeName = idx >= 0 ? c.slice(idx, idx + stripped.length).trim() : stripped;
      break;
    }
  }
  if (out.episodeName && out.title && norm(out.episodeName).includes(norm(out.title))) {
    const n = norm(out.episodeName).replace(norm(out.title), '').replace(/^[\s\-:.|·]+|[\s\-:.|·]+$/g, '').trim();
    out.episodeName = n || null;
  }
  if (out.episodeName && out.episode !== null) {
    // Drop a trailing "(N)" that just repeats the episode number.
    out.episodeName = out.episodeName.replace(new RegExp(`\\s*[(\\[]\\s*${out.episode}\\s*[)\\]]\\s*$`), '').trim();
  }
  if (out.subtitle === null && ms?.artist && !out.episode) out.subtitle = ms.artist;
  return out;
}

/** Two display lines: ["Title", "E5 - Episode name"]. Second line may be empty. */
export function formatMeta(m: MediaMeta, fallback: string): [string, string] {
  const title = m.title || fallback;
  let line2 = '';
  if (m.episode !== null) {
    const num = m.season !== null ? `S${m.season}E${m.episode}` : `E${m.episode}`;
    line2 = m.episodeName ? `${num} - ${m.episodeName}` : num;
  } else if (m.episodeName && m.episodeName !== title) {
    line2 = m.episodeName;
  } else if (m.subtitle) {
    line2 = m.subtitle;
  }
  return [title, line2];
}

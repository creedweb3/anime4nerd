// Manga mode: series / volume / chapter from the page title(s) and URL, for the popup card.
// Pure (no DOM) so it is unit-tested in test/manga-test.ts against real reader title formats.

import { MANGA_URL } from './manga-detect';

export interface MangaMeta {
  series: string | null;
  volume: string | null;
  chapter: string | null; // kept as text: "236.5"
  chapterTitle: string | null;
}

export interface MangaMetaInput {
  titles: string[]; // most trusted first: og:title, document.title, h1
  url: string;
  site: string; // og:site_name, if any
}

/** Titles longer than this are not titles; capped before any regex work. */
const MAX_TEXT = 300;
const NUM = String.raw`(\d+(?:\.\d+)?)`;

/** Chapter tokens, each with an optional volume in front ("Vol.41 Ch.364"). Group 1: volume, group 2: chapter. */
const CHAPTER_TOKENS: RegExp[] = [
  new RegExp(String.raw`(?:\bvol(?:ume)?\.?\s*(\d+)\s*[,:\-–—]?\s*)?\b(?:chapter|chap|ch)\.?\s*#?${NUM}`, 'i'),
  new RegExp(String.raw`()\b(?:episode|ep)\.?\s*#?${NUM}`, 'i'),
  new RegExp(String.raw`()第\s*${NUM}\s*[話话回]`),
  new RegExp(String.raw`()${NUM}\s*화`),
];
/**
 * "[#001] Haikyu!!" (MANGA Plus), "Haikyu!! #045": a # number at a word start. Ordinary titles use
 * "#1" too ("Top 10 anime #1"), so it only counts on a manga-looking URL.
 */
const HASH_TOKEN = new RegExp(String.raw`()(?:^|(?<=[\s[(]))#\s?(\d+(?:\.\d+)?)(?![\w.])`);

const SEPARATOR = /\s+[-|–—•·]\s+|\s*\|\s*/;
const BOILERPLATE = /^(read( manga)? online|manga online|read online|online( free)?|free|read|manga|manhwa|manhua|webtoons?|raw|english|official)$/i;
/** Names readers append to titles: "MangaDex", "Asura Scans", "Comick", "MANGA Plus", "MangaReader". */
const SITE_NAME = /^(manga ?(dex|reader|fire|nato|kakalot|see|plus|park|buddy|panda|town|hub)|comick|asura( scans)?|webtoons?|bato(\.to)?|.+ scans)$/i;
const READ_WRAPPER = /^\s*read\s+/i;
/** Doujinshi: "[Circle (Artist)] Title (Parody)". The bracket and the parody are not the title. */
const DOUJIN_CIRCLE = /^\s*\[[^\]#][^\]]*\]\s*/;
const DOUJIN_PARODY = /\s*\([^)]*\)\s*$/;

/** The title text to parse, and whether it was a doujinshi title. */
function prepare(raw: string): { text: string; doujin: boolean } {
  const text = raw.slice(0, MAX_TEXT).replace(READ_WRAPPER, '');
  const doujin = DOUJIN_CIRCLE.test(text);
  return { text: doujin ? text.replace(DOUJIN_CIRCLE, '') : text, doujin };
}
const tidySeries = (s: string | null, doujin: boolean) => (s && doujin ? s.replace(DOUJIN_PARODY, '') || s : s);

const clean = (s: string) => s.replace(/\s+/g, ' ').replace(/^[\s\-–—:|·•,\[\]()]+|[\s\-–—:|·•,\[(]+$/g, '').trim();
/** "001" -> "1", "007.5" -> "7.5" */
const chapterNumber = (s: string) => s.replace(/^0+(?=\d)/, '');

function isNoise(seg: string, site: string): boolean {
  const s = clean(seg);
  return !s || BOILERPLATE.test(s) || SITE_NAME.test(s) || (!!site && s.toLowerCase() === site.toLowerCase());
}

/** First segment of `text` that is neither boilerplate nor a site name. */
function firstReal(text: string, site: string): string | null {
  for (const seg of text.split(SEPARATOR)) if (!isNoise(seg, site)) return clean(seg);
  return null;
}

function fromTitle(raw: string, site: string, mangaUrl: boolean): MangaMeta | null {
  const { text, doujin } = prepare(raw);
  for (const re of mangaUrl ? [...CHAPTER_TOKENS, HASH_TOKEN] : CHAPTER_TOKENS) {
    const m = re.exec(text);
    if (!m || m.index === undefined) continue;
    const left = clean(text.slice(0, m.index));
    let right = text.slice(m.index + m[0].length);
    let chapterTitle: string | null = null;
    const titled = /^\s*:\s*(.+)$/.exec(right);
    if (titled) {
      const [head, ...rest] = titled[1].split(SEPARATOR);
      chapterTitle = clean(head) || null;
      right = rest.length ? ` - ${rest.join(' - ')}` : '';
    }
    const series = left && !isNoise(left, site) ? left : firstReal(right.replace(/^\s*(online( free)?|free)\b/i, ''), site);
    return { series: tidySeries(series || null, doujin), volume: m[1] || null, chapter: chapterNumber(m[2]), chapterTitle };
  }
  return null;
}

/** Series slug and chapter from the URL: /manga/kaguya-sama-love-is-war/chapter-281, ?episode_no=45. */
function fromUrl(url: string): { series: string | null; chapter: string | null } {
  let u: URL;
  try { u = new URL(url); } catch { return { series: null, chapter: null }; }
  const segs = u.pathname.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  let chapter: string | null = null;
  let at = -1;
  segs.forEach((s, i) => {
    const m = /^(?:chapter|chap|ch|episode|ep)[-_]?(\d+(?:[.-]\d+)?)$/i.exec(s);
    if (m && chapter === null) { chapter = m[1].replace('-', '.'); at = i; }
  });
  chapter ??= u.searchParams.get('episode_no') ?? u.searchParams.get('chapter');
  const slug = at > 0 ? segs[at - 1] : null;
  // Ids (uuids, hashes, "manga-ok991234") and route words are not names.
  const series = slug && /[a-z]/i.test(slug) && !/\d{4,}/.test(slug) && !/^[0-9a-f-]{8,}$/i.test(slug) && slug.length < 80
    && !/^(manga|read|reader|viewer|series|title|comic|webtoon)$/i.test(slug)
    ? slug.replace(/[-_+]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim()
    : null;
  return { series, chapter };
}

export function parseMangaMeta(input: MangaMetaInput): MangaMeta {
  const titles = input.titles.filter((t) => !!t && !!t.trim());
  for (const t of titles) {
    const meta = fromTitle(t, input.site, MANGA_URL.test(input.url));
    if (meta) return meta.series ? meta : { ...meta, series: fromUrl(input.url).series };
  }
  // No chapter in any title: the URL may still have one ("Reader" + /series-slug/chapter-281).
  const url = fromUrl(input.url);
  const first = titles.length ? prepare(titles[0]) : null;
  const titleSeries = first ? tidySeries(firstReal(first.text, input.site), first.doujin) : null;
  return {
    // A bare title ("Reader") loses to the URL slug; a doujinshi title is always the better name.
    series: first?.doujin && titleSeries ? titleSeries : url.chapter && url.series ? url.series : titleSeries ?? url.series,
    volume: null,
    chapter: url.chapter,
    chapterTitle: null,
  };
}

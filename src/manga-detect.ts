// Manga mode: decides whether a page is a manga / webtoon reader. Pure (no DOM) so it is
// unit-tested in test/manga-test.ts. Nothing is upscaled unless this says so, even on a site the
// user switched on: a safety stop for ordinary pages.
//
// Evidence, strongest first:
//   - layout: big pages of one width stacked in a column (or one page filling the screen) - always required;
//   - a chapter number (title / URL) or reader controls (next/previous chapter, a chapter or page list);
//   - on a manga-looking URL only: a page counter ("62 / 73") or numbered page files (001.jpg, 002.jpg).
// The weaker signals never qualify a page on their own: galleries have counters and numbered photos too.

export interface PageImage {
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
  left: number; // page coordinates of the rendered box
  top: number;
  src: string;
}

export interface PageCanvas { width: number; height: number; renderedWidth: number }

/** An image that has not loaded yet (lazy loading), by its box on the page. */
export interface PageSlot { renderedWidth: number; left: number; top: number }

export interface ReaderUi {
  chapterNav: boolean; // "Next chapter" / "Previous chapter" controls
  chapterList: boolean; // a <select> of chapters or pages
  counter: { current: number; total: number } | null; // "62 / 73"
}

export interface DetectInput {
  images: PageImage[];
  canvases: PageCanvas[];
  viewport: { width: number; height: number };
  url: string;
  hasChapter: boolean; // a chapter / episode number was found in the title or URL
  ui?: ReaderUi;
  placeholders?: PageSlot[];
}

export interface Detection {
  kind: 'images' | 'canvas' | null;
  pages: PageImage[]; // loaded pages, top to bottom
  total: number; // pages in the chapter as far as the page tells: counter, else loaded + still loading
  reasons: string[]; // why it counts, for the popup
}

/** A manga page is at least this big in the file and on screen (smaller: thumbnails, covers, ads). */
const MIN_NATURAL_W = 480;
const MIN_NATURAL_H = 400;
const MIN_RENDERED_W = 360;
/** Portrait: taller than wide by this much. Landscape photos and banners are not pages. */
const PORTRAIT = 1.15;
/** Pages of one chapter share a width; others count only within this spread of the common width. */
const SAME_WIDTH = 0.08;
/** Without a chapter number, this many same-width stacked pages on a manga-looking URL. */
const MIN_PAGES_NO_CHAPTER = 6;
/** ...or this many when a page counter or numbered page files back it up. */
const MIN_PAGES_SUPPORTED = 3;
/** Without a chapter number, the common-width pages must be this share of the big images. */
const UNIFORM_SHARE = 0.8;
/** A single page counts (one-page-at-a-time readers) when it fills this share of the viewport height. */
const SINGLE_PAGE_FILL = 0.5;
/** Page counters above this are not chapters. */
const MAX_PAGES = 2000;
/** URLs that look like a manga reader (also gates "#N" chapter numbers in manga-meta.ts). */
export const MANGA_URL = /manga|manhwa|manhua|webtoon|comic|chapter|\/read|reader|viewer/i;

const noUi: ReaderUi = { chapterNav: false, chapterList: false, counter: null };

// ---- reader-interface text -------------------------------------------------------------------

/** "62 / 73", "Page 3 of 18", "p. 5 / 40" -> { current, total }; anything else -> null. */
export function parsePageCounter(text: string): { current: number; total: number } | null {
  const m = /^\s*(?:(?:page|p\.?)\s*)?(\d{1,4})\s*(?:\/|of)\s*(\d{1,4})\s*$/i.exec(text);
  if (!m) return null;
  const current = Number(m[1]);
  const total = Number(m[2]);
  return current >= 1 && total >= 2 && current <= total && total <= MAX_PAGES ? { current, total } : null;
}

/** "Next chapter", "← Previous chapter", "Next ep.", "Chapter →" (but not "Next", "Next page"). */
export function isChapterNavText(text: string): boolean {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length > 40) return false;
  return /^\W*(next|prev(ious)?)\s+(chapter|chap|ch|episode|ep)\b\.?\W*$/i.test(t)
    || /^\W*(chapter|episode)\s*[→←»«›‹>]+\W*$/i.test(t);
}

const LIST_ITEM = /^\s*(?:(?:chapter|chap|ch|episode|ep|vol(?:ume)?|page|p)\.?\s*)?#?\s*\d+(?:\.\d+)?\b/i;

/** A <select> whose options are chapters or pages ("Chapter 1", "#001", "Ep. 3", "12"). */
export function looksLikeChapterList(options: string[]): boolean {
  if (options.length < 3) return false;
  // Only the start of an option matters; a capped length keeps a hostile page from stalling the check.
  return options.filter((o) => LIST_ITEM.test(o.slice(0, 60))).length / options.length >= 0.8;
}

/** Page files numbered in order: .../001.jpg, .../002.jpg (a gap or two is fine, random ids are not). */
export function sequentialNames(srcs: string[]): boolean {
  const nums: number[] = [];
  for (const s of srcs) {
    if (!/^https?:/.test(s)) continue;
    const name = s.split(/[?#]/)[0].split('/').pop() ?? '';
    const m = /(\d{1,4})(?:\.[a-z0-9]{2,5})?$/i.exec(name);
    if (m) nums.push(Number(m[1]));
  }
  if (nums.length < 3) return false;
  let steps = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i] - nums[i - 1] >= 1 && nums[i] - nums[i - 1] <= 2) steps++;
  return steps / (nums.length - 1) >= 0.7;
}

// ---- layout ----------------------------------------------------------------------------------

/** Images sharing the most common rendered width (within SAME_WIDTH). */
function dominantWidth(images: PageImage[]): PageImage[] {
  let best: PageImage[] = [];
  for (const ref of images) {
    const group = images.filter((i) => Math.abs(i.renderedWidth - ref.renderedWidth) <= ref.renderedWidth * SAME_WIDTH);
    if (group.length > best.length) best = group;
  }
  return best;
}

/** Pages read top to bottom in one column: lefts line up, tops increase. */
function stacked(pages: PageImage[]): boolean {
  const sorted = [...pages].sort((a, b) => a.top - b.top);
  return sorted.every((p, i) => i === 0 || (p.top > sorted[i - 1].top && Math.abs(p.left - sorted[0].left) <= sorted[0].renderedWidth * SAME_WIDTH));
}

/** Still-loading slots in the same column and width as the pages. */
function slotsInColumn(slots: PageSlot[], pages: PageImage[]): number {
  if (!pages.length) return 0;
  const ref = pages[0];
  return slots.filter((s) => Math.abs(s.renderedWidth - ref.renderedWidth) <= ref.renderedWidth * SAME_WIDTH
    && Math.abs(s.left - ref.left) <= ref.renderedWidth * SAME_WIDTH).length;
}

export function classifyPage(input: DetectInput): Detection {
  const ui = input.ui ?? noUi;
  const big = input.images.filter((i) => i.naturalWidth >= MIN_NATURAL_W && i.naturalHeight >= MIN_NATURAL_H && i.renderedWidth >= MIN_RENDERED_W);
  const portrait = (i: PageImage) => i.naturalHeight / i.naturalWidth >= PORTRAIT;
  const group = dominantWidth(big);
  const byTop = (list: PageImage[]) => [...list].sort((a, b) => a.top - b.top);
  const strong = input.hasChapter || ui.chapterNav || ui.chapterList;

  const found = (pages: PageImage[], why: string[]): Detection => {
    const sorted = byTop(pages);
    const reasons = [...why, `${sorted.length} stacked page${sorted.length === 1 ? '' : 's'}`];
    if (sequentialNames(sorted.map((p) => p.src))) reasons.push('numbered page files');
    if (ui.counter) reasons.push(`page counter ${ui.counter.current} / ${ui.counter.total}`);
    const loading = slotsInColumn(input.placeholders ?? [], sorted);
    return { kind: 'images', pages: sorted, total: Math.max(sorted.length, ui.counter?.total ?? 0, sorted.length + loading), reasons };
  };
  const strongReasons = [
    ...(input.hasChapter ? ['chapter number'] : []),
    ...(ui.chapterNav ? ['chapter navigation'] : []),
    ...(ui.chapterList ? ['chapter list'] : []),
  ];

  if (strong) {
    // Webtoon strips are often cut into short slices, so a same-width column of 3+ counts whatever its shape.
    const pages = group.length >= 3 && stacked(group) ? group : big.filter(portrait);
    const one = pages.length === 1 ? pages[0] : null;
    const fills = one && one.renderedWidth * (one.naturalHeight / one.naturalWidth) >= input.viewport.height * SINGLE_PAGE_FILL;
    if ((pages.length >= 2 && stacked(pages)) || fills) return found(pages, strongReasons);
  } else if (MANGA_URL.test(input.url)) {
    const pages = group.filter(portrait);
    const supported = !!ui.counter || sequentialNames(pages.map((p) => p.src));
    const needed = supported ? MIN_PAGES_SUPPORTED : MIN_PAGES_NO_CHAPTER;
    if (pages.length >= needed && pages.length >= big.length * UNIFORM_SHARE && stacked(pages)) {
      return found(pages, ['manga-style address']);
    }
  }

  // Readers that draw pages on a canvas (many official sites): detected, but not supported.
  if (strong && input.canvases.some((c) => c.width >= MIN_NATURAL_W && c.height >= MIN_NATURAL_H && c.renderedWidth >= MIN_RENDERED_W)) {
    return { kind: 'canvas', pages: [], total: ui.counter?.total ?? 0, reasons: [...strongReasons, 'pages drawn on a canvas'] };
  }
  return { kind: null, pages: [], total: 0, reasons: [] };
}

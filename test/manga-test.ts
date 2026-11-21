// Unit tests for manga mode's pure logic: title/chapter parsing (src/manga-meta.ts) and
// "is this a manga reader?" detection (src/manga-detect.ts). Runs in Node:
//   npx esbuild test/manga-test.ts --bundle --platform=node --format=esm --outfile=test/manga-test.js && node test/manga-test.js
import assert from 'node:assert/strict';
import { MangaMeta, parseMangaMeta } from '../src/manga-meta';
import { PageImage, classifyPage, isChapterNavText, looksLikeChapterList, parsePageCounter, sequentialNames } from '../src/manga-detect';
import { addressBlocked, isMetadataHost, isPrivateHost } from '../src/private-host';

const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

// ---- title and chapter ------------------------------------------------------------------

const meta = (titles: string[], url = 'https://example.com/', site = '') => parseMangaMeta({ titles, url, site });
const expectMeta = (got: MangaMeta, want: Partial<MangaMeta>) => {
  for (const [k, v] of Object.entries(want)) assert.deepEqual(got[k as keyof MangaMeta], v, `${k}: got ${JSON.stringify(got[k as keyof MangaMeta])}`);
};

test('MangaDex: "Ch. N - Series - Site"', () => {
  expectMeta(meta(['Ch. 172 - Chainsaw Man - MangaDex'], 'https://mangadex.org/chapter/3f5e9d2a-1b2c-4d5e-8f90-123456789abc/1', 'MangaDex'),
    { series: 'Chainsaw Man', chapter: '172', volume: null });
});
test('Manganato: "Series Chapter N - Site"', () => {
  expectMeta(meta(['Chainsaw Man Chapter 172 - Manganato'], 'https://chapmanganato.to/manga-ok991234/chapter-172'),
    { series: 'Chainsaw Man', chapter: '172' });
});
test('Asura: scanlator site name dropped', () => {
  expectMeta(meta(['Solo Leveling Chapter 200 - Asura Scans']), { series: 'Solo Leveling', chapter: '200' });
});
test('Webtoons: "Episode N | Series" counts as the chapter', () => {
  expectMeta(meta(['Episode 45 | Tower of God'], 'https://www.webtoons.com/en/fantasy/tower-of-god/season-3-ep-45/viewer?title_no=95&episode_no=45'),
    { series: 'Tower of God', chapter: '45' });
});
test('Comick: "Series - Chapter N - Site"', () => {
  expectMeta(meta(['Chainsaw Man - Chapter 172 - Comick']), { series: 'Chainsaw Man', chapter: '172' });
});
test('MANGA Plus: "Chapter N | SERIES | Site"', () => {
  expectMeta(meta(['Chapter 1100 | ONE PIECE | MANGA Plus'], 'https://mangaplus.shueisha.co.jp/viewer/1019000', 'MANGA Plus'),
    { series: 'ONE PIECE', chapter: '1100' });
});
test('volume, chapter and chapter title', () => {
  expectMeta(meta(['Berserk Vol.41 Ch.364: Lost Children - Read Online']),
    { series: 'Berserk', volume: '41', chapter: '364', chapterTitle: 'Lost Children' });
});
test('decimal chapters', () => {
  expectMeta(meta(['Jujutsu Kaisen Chapter 236.5 - MangaReader']), { series: 'Jujutsu Kaisen', chapter: '236.5' });
});
test('chapter title with a comma, boilerplate tail dropped', () => {
  expectMeta(meta(['One Piece Chapter 1100: Thank You, Bonney | Read Manga Online']),
    { series: 'One Piece', chapter: '1100', chapterTitle: 'Thank You, Bonney' });
});
test('Japanese 第N話', () => {
  expectMeta(meta(['チェンソーマン 第172話']), { series: 'チェンソーマン', chapter: '172' });
});
test('Korean N화', () => {
  expectMeta(meta(['나 혼자만 레벨업 200화']), { series: '나 혼자만 레벨업', chapter: '200' });
});
test('generic page title: series and chapter from the URL', () => {
  expectMeta(meta(['Reader'], 'https://example.com/manga/kaguya-sama-love-is-war/chapter-281'),
    { series: 'Kaguya Sama Love Is War', chapter: '281' });
});
test('"Read X Online Free" wrapper removed', () => {
  expectMeta(meta(['Read Chainsaw Man Chapter 172 Online Free - MangaFire']), { series: 'Chainsaw Man', chapter: '172' });
});
test('series page without a chapter', () => {
  expectMeta(meta(['Chainsaw Man - MangaDex'], 'https://mangadex.org/title/a77742b1', 'MangaDex'), { series: 'Chainsaw Man', chapter: null });
});
test('a later title with the chapter beats an earlier one without', () => {
  expectMeta(meta(['MangaReader - free manga', 'Chainsaw Man Chapter 172']), { series: 'Chainsaw Man', chapter: '172' });
});
test('numbers inside the series name are kept', () => {
  expectMeta(meta(['Mob Psycho 100 Chapter 101 - MangaReader']), { series: 'Mob Psycho 100', chapter: '101' });
  expectMeta(meta(['Kaiju No. 8 Chapter 100']), { series: 'Kaiju No. 8', chapter: '100' });
});
test('MANGA Plus: "[#001] Series | MANGA Plus"', () => {
  expectMeta(meta(['[#001] Haikyu!! | MANGA Plus', 'Haikyu!!'], 'https://mangaplus.shueisha.co.jp/viewer/1000331', 'MANGA Plus'),
    { series: 'Haikyu!!', chapter: '1' });
});
test('"Series #045" and leading zeros', () => {
  expectMeta(meta(['Haikyu!! #045'], 'https://reader.example/manga/haikyu/45'), { series: 'Haikyu!!', chapter: '45' });
  expectMeta(meta(['One Piece Chapter 007']), { series: 'One Piece', chapter: '7' });
});
test('a # inside a word is not a chapter', () => {
  expectMeta(meta(['C# for Beginners - Blog'], 'https://blog.example/viewer/1'), { chapter: null });
});
test('"#N" is not a chapter on an ordinary URL (rankings, hashtags)', () => {
  expectMeta(meta(['Top 10 anime #1 - Anime News'], 'https://news.example/2026/top-10'), { chapter: null });
  expectMeta(meta(['Haikyu!! #045'], 'https://fan.example/blog/post'), { chapter: null });
});
test('doujinshi: "[Circle (Artist)] Title (Parody)" keeps the title', () => {
  expectMeta(meta(['[Maraparte (Kojima Shoutarou)] Matsuri no Yoru ni (Black Clover) - Chapter 1 - Read Online']),
    { series: 'Matsuri no Yoru ni', chapter: '1' });
  expectMeta(meta(['[Maraparte (Kojima Shoutarou)] Matsuri no Yoru ni (Black Clover)'], 'https://r.example/manga/x/chapter-1'),
    { series: 'Matsuri no Yoru ni', chapter: '1' });
});
test('a trailing (...) stays in ordinary series names', () => {
  expectMeta(meta(['Re:Zero (Light Novel) Chapter 3']), { series: 'Re:Zero (Light Novel)', chapter: '3' });
});
test('URL ids are not taken for the series', () => {
  expectMeta(meta(['Chapter 12'], 'https://reader.example/series/6f1c2a9e8b7d4c3a/chapter-12'), { series: null, chapter: '12' });
});

// ---- detection ---------------------------------------------------------------------------

const page = (i: number, w = 900, h = 1300, left = 200, rendered = 800): PageImage => ({
  naturalWidth: w, naturalHeight: h, renderedWidth: rendered, left, top: i * (rendered * h / w + 10), src: `https://cdn.example/ch172/${i + 1}.jpg`,
});
const pages = (n: number, f: (i: number) => PageImage = (i) => page(i)) => Array.from({ length: n }, (_, i) => f(i));
const viewport = { width: 1200, height: 900 };

test('a chapter of stacked pages with a chapter in the title is manga', () => {
  const r = classifyPage({ images: pages(18), canvases: [], viewport, url: 'https://reader.example/x/chapter-172', hasChapter: true });
  assert.equal(r.kind, 'images');
  assert.equal(r.pages.length, 18);
});
test('a single-page reader (one big page on screen) with a chapter is manga', () => {
  const r = classifyPage({ images: [page(0, 900, 1300, 200, 600)], canvases: [], viewport, url: 'https://mangadex.org/chapter/abc/3', hasChapter: true });
  assert.equal(r.kind, 'images');
});
test('webtoon strips with an episode number are manga', () => {
  const r = classifyPage({ images: pages(30, (i) => page(i, 800, 1280, 300, 690)), canvases: [], viewport, url: 'https://www.webtoons.com/en/x/viewer?episode_no=45', hasChapter: true });
  assert.equal(r.kind, 'images');
});
test('many uniform pages on a manga URL count even without a chapter number', () => {
  const r = classifyPage({ images: pages(8), canvases: [], viewport, url: 'https://mangasite.example/read/oneshot', hasChapter: false });
  assert.equal(r.kind, 'images');
});
test('a news article with photos is not manga', () => {
  const photos = pages(6, (i) => page(i, 1600, 900, 300, 700)); // landscape
  assert.equal(classifyPage({ images: photos, canvases: [], viewport, url: 'https://news.example/2026/11/story', hasChapter: false }).kind, null);
});
test('a portrait photo gallery without manga signals is not manga', () => {
  const gallery = pages(12, (i) => page(i, 1000, 1500, 100 + (i % 3) * 350, 300)); // grid, small, not stacked
  assert.equal(classifyPage({ images: gallery, canvases: [], viewport, url: 'https://photos.example/album/42', hasChapter: false }).kind, null);
});
test('uneven image widths on a manga-ish URL are not manga', () => {
  const mixed = pages(8, (i) => page(i, 600 + i * 150, 1300, 200, 300 + i * 90));
  assert.equal(classifyPage({ images: mixed, canvases: [], viewport, url: 'https://blog.example/manga-reviews', hasChapter: false }).kind, null);
});
test('one tall image on a page without a chapter is not manga (posters, infographics)', () => {
  assert.equal(classifyPage({ images: [page(0, 900, 2400, 200, 800)], canvases: [], viewport, url: 'https://example.com/poster', hasChapter: false }).kind, null);
});
test('thumbnails and icons are ignored', () => {
  const thumbs = pages(20, (i) => page(i, 200, 300, (i % 5) * 220, 200));
  assert.equal(classifyPage({ images: thumbs, canvases: [], viewport, url: 'https://reader.example/x/chapter-1', hasChapter: true }).kind, null);
});
test('a canvas reader with a chapter is reported as unsupported', () => {
  const r = classifyPage({ images: [], canvases: [{ width: 1100, height: 1600, renderedWidth: 700 }], viewport, url: 'https://mangaplus.shueisha.co.jp/viewer/1', hasChapter: true });
  assert.equal(r.kind, 'canvas');
});
test('a canvas without manga signals is ignored (games, charts)', () => {
  const r = classifyPage({ images: [], canvases: [{ width: 1100, height: 1600, renderedWidth: 700 }], viewport, url: 'https://game.example/play', hasChapter: false });
  assert.equal(r.kind, null);
});

// ---- reader-interface signals ------------------------------------------------------------

test('page counters are read', () => {
  assert.deepEqual(parsePageCounter('62 / 73'), { current: 62, total: 73 });
  assert.deepEqual(parsePageCounter('  7/120 '), { current: 7, total: 120 });
  assert.deepEqual(parsePageCounter('Page 3 of 18'), { current: 3, total: 18 });
  assert.deepEqual(parsePageCounter('p. 5 / 40'), { current: 5, total: 40 });
});
test('things that are not page counters', () => {
  for (const t of ['1 / 1', '0 / 5', '80 / 73', 'Rated 4.5 / 5', '2026 / 11', 'page 3', '3 / 50000', 'Episode 1 / Chapter 2']) {
    assert.equal(parsePageCounter(t), null, t);
  }
});
test('chapter navigation text', () => {
  for (const t of ['Next Chapter', 'Prev Chapter', '← Previous chapter', 'Next Ep.', 'NEXT EPISODE', 'Chapter →', 'Next chap']) assert.equal(isChapterNavText(t), true, t);
  for (const t of ['Next', 'Next page', 'Read more', 'Previous post', 'Chapter 12: The Return']) assert.equal(isChapterNavText(t), false, t);
});
test('chapter dropdowns', () => {
  assert.equal(looksLikeChapterList(['Chapter 1', 'Chapter 2', 'Chapter 3']), true);
  assert.equal(looksLikeChapterList(['#001', '#002', '#003', '#004']), true);
  assert.equal(looksLikeChapterList(['Ep. 1', 'Ep. 2', 'Ep. 3']), true);
  assert.equal(looksLikeChapterList(['1', '2', '3', '4', '5']), true); // page pickers count too
  assert.equal(looksLikeChapterList(['English', 'Japanese', 'French']), false);
  assert.equal(looksLikeChapterList(['Small', 'Medium', 'Large', '1']), false);
  assert.equal(looksLikeChapterList(['Chapter 1', 'Chapter 2']), false); // too few to tell
});
test('sequential image names', () => {
  assert.equal(sequentialNames(['https://cdn.x/ch1/001.jpg', 'https://cdn.x/ch1/002.jpg', 'https://cdn.x/ch1/003.jpg']), true);
  assert.equal(sequentialNames(['https://cdn.x/p1.webp?t=9', 'https://cdn.x/p2.webp?t=9', 'https://cdn.x/p3.webp?t=9', 'https://cdn.x/p5.webp?t=9']), true);
  assert.equal(sequentialNames(['https://x/a.jpg', 'https://x/b.jpg', 'https://x/c.jpg']), false);
  assert.equal(sequentialNames(['https://x/IMG_2041.jpg', 'https://x/IMG_2098.jpg', 'https://x/IMG_2150.jpg']), false);
  assert.equal(sequentialNames(['blob:https://x/1', 'blob:https://x/2', 'blob:https://x/3']), false);
  assert.equal(sequentialNames(['https://x/1.jpg', 'https://x/2.jpg']), false); // too few to tell
});

const noUi = { chapterNav: false, chapterList: false, counter: null };
test('chapter navigation plus stacked pages is manga, even without a chapter number', () => {
  const r = classifyPage({ images: pages(2), canvases: [], viewport, url: 'https://reader.example/x/42', hasChapter: false, ui: { ...noUi, chapterNav: true } });
  assert.equal(r.kind, 'images');
  assert.ok(r.reasons.includes('chapter navigation'), r.reasons.join());
});
test('a page counter alone does not make a gallery manga', () => {
  const photos = pages(2, (i) => page(i, 1000, 1500));
  assert.equal(classifyPage({ images: photos, canvases: [], viewport, url: 'https://photos.example/trip', hasChapter: false, ui: { ...noUi, counter: { current: 3, total: 12 } } }).kind, null);
});
test('on a manga URL a page counter lowers the page count needed (3 instead of 6)', () => {
  const r = classifyPage({ images: pages(3), canvases: [], viewport, url: 'https://mangasite.example/read/oneshot', hasChapter: false, ui: { ...noUi, counter: { current: 1, total: 18 } } });
  assert.equal(r.kind, 'images');
  assert.equal(r.total, 18);
});
test('on a manga URL sequential page names lower the page count needed', () => {
  const r = classifyPage({ images: pages(3), canvases: [], viewport, url: 'https://mangasite.example/read/oneshot', hasChapter: false, ui: noUi });
  assert.equal(r.kind, 'images');
  assert.ok(r.reasons.includes('numbered page files'), r.reasons.join());
});
test('sequential names alone on an ordinary URL are not manga', () => {
  assert.equal(classifyPage({ images: pages(3), canvases: [], viewport, url: 'https://blog.example/post', hasChapter: false, ui: noUi }).kind, null);
});
test('the total comes from the counter or the placeholders still loading', () => {
  const withCounter = classifyPage({ images: pages(3), canvases: [], viewport, url: 'https://r.example/chapter-9', hasChapter: true, ui: { ...noUi, counter: { current: 62, total: 73 } } });
  assert.equal(withCounter.total, 73);
  const lazy = Array.from({ length: 10 }, (_, i) => ({ renderedWidth: 800, left: 200, top: 5000 + i * 1200 }));
  const sidebar = [{ renderedWidth: 300, left: 1000, top: 100 }];
  const withSlots = classifyPage({ images: pages(3), canvases: [], viewport, url: 'https://r.example/chapter-9', hasChapter: true, ui: noUi, placeholders: [...lazy, ...sidebar] });
  assert.equal(withSlots.total, 13);
  assert.equal(withSlots.pages.length, 3);
});
test('reasons say why a page counts', () => {
  const r = classifyPage({ images: pages(18), canvases: [], viewport, url: 'https://reader.example/x/chapter-172', hasChapter: true, ui: noUi });
  assert.ok(r.reasons.includes('chapter number') && r.reasons.includes('18 stacked pages') && r.reasons.includes('numbered page files'), r.reasons.join());
});

// ---- background fetch guard ------------------------------------------------------------

test('private and local addresses are blocked', () => {
  for (const h of ['localhost', 'app.localhost', 'nas.local', 'router', 'db.internal', '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '::ffff:192.168.0.1', 'fd12:3456::1', 'fe80::1']) {
    assert.equal(isPrivateHost(h), true, h);
  }
});
test('public hosts are allowed', () => {
  for (const h of ['uploads.mangadex.org', 'cdn.example.com', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '192.169.0.1']) {
    assert.equal(isPrivateHost(h), false, h);
  }
});

test('private-address bypass forms are blocked', () => {
  // Hostnames as new URL() normalises them: trailing dots, hex IPv4-mapped IPv6, NAT64, 6to4, site-local.
  for (const u of ['http://localhost./', 'http://nas.local./', 'http://metadata.google.internal./', 'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:10.0.0.1]/', 'http://[::]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:c0a8:101::1]/',
    'http://[fec0::1]/', 'http://[ff02::1]/', 'http://192.0.0.8/', 'http://198.18.0.1/', 'http://224.0.0.1/', 'http://255.255.255.255/',
    'http://2130706433/', 'http://0x7f.1/', 'http://printer.lan/', 'http://nas.home.arpa/', 'http://wiki.corp/', 'http://hr.intranet/']) {
    assert.equal(isPrivateHost(new URL(u).hostname), true, u);
  }
  assert.equal(isPrivateHost(''), true, 'empty host');
  assert.equal(isPrivateHost('not:an:address'), true, 'unparseable IPv6 fails closed');
});
test('public IPv6 and look-alike names stay allowed', () => {
  for (const u of ['http://[2606:4700:4700::1111]/', 'http://[2a00:1450:4001::200e]/', 'http://[::ffff:8.8.8.8]/', 'http://[64:ff9b::808:808]/',
    'https://cdn.example.com./', 'https://localhost.example.com/', 'https://corp.example.com/', 'http://198.20.0.1/', 'http://223.255.255.1/']) {
    assert.equal(isPrivateHost(new URL(u).hostname), false, u);
  }
});
test('cloud metadata addresses are never fetched, even for a local reader', () => {
  for (const h of ['169.254.169.254', '169.254.0.1', 'metadata.google.internal', 'metadata.google.internal.', '[fd00:ec2::254]', '[::ffff:a9fe:a9fe]']) {
    assert.equal(isMetadataHost(h), true, h);
  }
  for (const h of ['192.168.1.1', 'localhost', 'cdn.example.com', '[fd12:3456::1]']) assert.equal(isMetadataHost(h), false, h);
});
test('a response from a private address is refused unless the page came from the same address', () => {
  assert.equal(addressBlocked('127.0.0.1', false, '93.184.216.34'), true, 'public name resolving to loopback');
  assert.equal(addressBlocked('::1', false, undefined), true, 'page address unknown');
  assert.equal(addressBlocked('192.168.1.1', false, '127.0.0.1'), true, 'another private address than the page');
  assert.equal(addressBlocked(null, false, '93.184.216.34'), true, 'no address seen fails closed');
  assert.equal(addressBlocked('93.184.216.34', false, undefined), false, 'public address');
  assert.equal(addressBlocked('2606:4700::6810:1', false, undefined), false, 'public IPv6 address');
  assert.equal(addressBlocked('192.168.1.5', true, undefined), false, 'reader on a local address');
  assert.equal(addressBlocked('127.0.0.1', false, '127.0.0.1'), false, 'everything through a local proxy');
  assert.equal(addressBlocked('169.254.169.254', true, '169.254.169.254'), true, 'metadata address, always');
});
test('a chapter list with a huge whitespace run is checked quickly', () => {
  const evil = 'chapter' + ' '.repeat(200000) + 'x';
  const t0 = performance.now();
  assert.equal(looksLikeChapterList([evil, evil, evil]), false);
  assert.ok(performance.now() - t0 < 200, `took ${Math.round(performance.now() - t0)} ms`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n  ${e instanceof Error ? e.message : e}`); }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);

// Runs collectPageMeta() against saved page fixtures (title/h1/og/json-ld snippets) in an iframe-free way.
import { collectPageMeta, formatMeta } from '../src/media-meta';

interface Fixture { name: string; url: string; title: string; og?: string; site?: string; h1?: string; ld?: unknown; expect: [string, string] }

const fixtures: Fixture[] = [
  {
    name: 'anime site (watch page + h1)',
    url: 'https://www.animesite.test/watch/_M5c8G0B0FU11N8dzQdrk3h6j/starlight-academy?ep=1',
    title: 'Watch Starlight Academy - AnimeSite',
    h1: 'The Night Before: The Festival Begins (1)',
    expect: ['Starlight Academy', 'E1 - The Night Before: The Festival Begins'],
  },
  {
    name: 'youtube-like (og + json-ld VideoObject)',
    url: 'https://www.youtube.com/watch?v=abc',
    title: 'Some Video Title - YouTube',
    og: 'Some Video Title',
    site: 'YouTube',
    ld: { '@type': 'VideoObject', name: 'Some Video Title', author: { '@type': 'Person', name: 'Channel Name' } },
    expect: ['Some Video Title', 'Channel Name'],
  },
  {
    name: 'tv site with TVEpisode json-ld',
    url: 'https://example.tv/show/s2/e3',
    title: 'Show Name S2 E3 | ExampleTV',
    ld: { '@type': 'TVEpisode', name: 'The Return', episodeNumber: 3, partOfSeason: { '@type': 'TVSeason', seasonNumber: 2 }, partOfSeries: { '@type': 'TVSeries', name: 'Show Name' } },
    expect: ['Show Name', 'S2E3 - The Return'],
  },
  {
    name: 'anime site, title carries episode',
    url: 'https://anime.example/watch/one-piece-episode-1071',
    title: 'One Piece Episode 1071 English Subbed - AnimeExample',
    h1: 'One Piece Episode 1071',
    expect: ['One Piece', 'E1071'],
  },
  {
    name: 'reanime (observed, en-dash in h1)',
    url: 'https://reanime.to/watch/bleach-tybw-the-calamity/6',
    title: 'BLEACH: Thousand-Year Blood War - The Calamity Episode 6 - ReAnime',
    og: 'BLEACH: Thousand-Year Blood War - The Calamity',
    h1: 'BLEACH: Thousand-Year Blood War – The Calamity – Episode 6',
    expect: ['BLEACH: Thousand-Year Blood War', 'E6 - The Calamity'],
  },
  {
    name: 'cinejoy-like (og:title is the site name)',
    url: 'https://cinejoy.pk/watch/friends-season-8-episode-5',
    title: 'Cinejoy',
    og: 'Cinejoy',
    site: 'Cinejoy',
    h1: "Friends S08E05 The One with Rachel's Date",
    expect: ['Friends', "S8E5 - The One with Rachel's Date"],
  },
  {
    name: 'site name only, url slug fallback',
    url: 'https://cinejoy.pk/watch/friends-season-8-episode-5',
    title: 'Cinejoy',
    site: 'Cinejoy',
    expect: ['Friends', 'S8E5'],
  },
  {
    name: 'movie json-ld',
    url: 'https://movies.example/m/1',
    title: 'Watch Spirited Away Online Free | MoviesExample',
    ld: { '@type': 'Movie', name: 'Spirited Away' },
    expect: ['Spirited Away', ''],
  },
];

function applyFixture(f: Fixture) {
  document.title = f.title;
  document.head.querySelectorAll('meta[property], script[type="application/ld+json"]').forEach((e) => e.remove());
  document.body.querySelectorAll('h1').forEach((e) => e.remove());
  if (f.og) { const m = document.createElement('meta'); m.setAttribute('property', 'og:title'); m.content = f.og; document.head.append(m); }
  if (f.site) { const m = document.createElement('meta'); m.setAttribute('property', 'og:site_name'); m.content = f.site; document.head.append(m); }
  if (f.ld) { const s = document.createElement('script'); s.type = 'application/ld+json'; s.textContent = JSON.stringify(f.ld); document.head.append(s); }
  if (f.h1) { const h = document.createElement('h1'); h.textContent = f.h1; document.body.prepend(h); }
}

const out: Record<string, { got: [string, string]; want: [string, string]; ok: boolean; source: string }> = {};
for (const f of fixtures) {
  applyFixture(f);
  const m = collectPageMeta(f.url);
  const got = formatMeta(m, 'host');
  out[f.name] = { got, want: f.expect, ok: got[0] === f.expect[0] && got[1] === f.expect[1], source: m.source };
}
(window as any).metaResults = out;
document.body.insertAdjacentHTML('beforeend', `<pre style="color:#ddd;background:#111;padding:12px">${JSON.stringify(out, null, 2)}</pre>`);

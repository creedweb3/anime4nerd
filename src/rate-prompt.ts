// "Rate it" card in the popup (Chrome build only). The content script counts time spent
// actually upscaling and videos upscaled for at least EPISODE_SECONDS, and sends the totals to
// the background, which is the only writer of the stored counts. The popup shows one card per
// milestone in LEVEL_EPISODES until the user says they already rated. Nothing here leaves the
// browser: the counts live in chrome.storage.local and the store page only opens on a click.

export const REVIEW_URL = 'https://chromewebstore.google.com/detail/kblnmcdmlgeidaclnhjmcffefmkehkpm/reviews';
const RATE_KEY = 'anime4k-rate';

/** Episodes needed for card levels 1–4. */
export const LEVEL_EPISODES = [3, 12, 48, 200] as const;
/** Upscaled time after which a video counts as one episode. */
export const EPISODE_SECONDS = 600;
/** Per-message caps: content scripts report about once a minute. */
const MAX_SECONDS_PER_REPORT = 600;
const MAX_EPISODES_PER_REPORT = 5;

export interface RateState {
  seconds: number; // total time upscaling ran
  episodes: number; // videos upscaled for at least EPISODE_SECONDS
  shown: number; // highest level the user has answered (dismissed or clicked), 0–4
  clicked: boolean; // clicked "rate it" at least once
  rated: boolean; // said "already rated": never show again
  returning: boolean; // had the extension before counting existed
}

export const EMPTY_RATE: RateState = { seconds: 0, episodes: 0, shown: 0, clicked: false, rated: false, returning: false };

export type RateAction = 'dismiss' | 'clicked' | 'rated';

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

export function normalizeRate(raw: unknown): RateState {
  const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const shown = count(t.shown);
  return {
    seconds: count(t.seconds),
    episodes: Math.floor(count(t.episodes)),
    shown: Number.isInteger(shown) && shown <= LEVEL_EPISODES.length ? shown : 0,
    clicked: t.clicked === true,
    rated: t.rated === true,
    returning: t.returning === true,
  };
}

export function levelFor(episodes: number): number {
  return LEVEL_EPISODES.filter((n) => episodes >= n).length;
}

/** Level whose card should show now, or null. */
export function pendingLevel(s: RateState): number | null {
  if (s.rated) return null;
  const level = levelFor(s.episodes);
  return level > s.shown ? level : null;
}

export function addWatch(s: RateState, seconds: number, episodes: number): RateState {
  const sec = Math.min(count(seconds), MAX_SECONDS_PER_REPORT);
  const eps = Math.min(Math.floor(count(episodes)), MAX_EPISODES_PER_REPORT);
  return sec || eps ? { ...s, seconds: s.seconds + sec, episodes: s.episodes + eps } : s;
}

/** `level`: the card level the user saw (more episodes may have arrived since; those keep their own card). */
export function applyAction(s: RateState, action: RateAction, level: number = levelFor(s.episodes)): RateState {
  const seen = Number.isInteger(level) ? Math.min(Math.max(level, 0), levelFor(s.episodes)) : 0;
  const shown = Math.max(s.shown, seen);
  if (action === 'rated') return { ...s, shown, rated: true };
  if (action === 'clicked') return { ...s, shown, clicked: true };
  return { ...s, shown };
}

// --- card text ----------------------------------------------------------------------
interface LevelCopy { badges: string[]; first: string[]; second: string[] }

const FIRST_IMPRESSIONS = 'first impressions?';
const COPY: LevelCopy[] = [
  {
    badges: ['genin', 'rookie'],
    first: [FIRST_IMPRESSIONS, 'help other fans find sharper anime'],
    second: ['off to a good start, tell others?', 'liking it so far? let others know'],
  },
  {
    badges: ['chunin', 'training arc', 'regular'],
    first: ['your lines just got a power-up', 'liking the sharper lines?'],
    second: ['sharper lines suit you, tell others?', "it's growing on you, isn't it?"],
  },
  {
    badges: ['jonin', 'binge no jutsu', 'weeb'],
    first: ['that is about {seasons} full seasons.', 'just one more episode…'],
    second: ["you're hooked, tell others?", "that's a whole binge, worth a rating?"],
  },
  {
    badges: ['hokage', 'senpai', 'veteran'],
    first: ['that is {days} days of sharper anime.', 'notice me, senpai'],
    second: ['you clearly like it, tell others?', "you're basically senpai now, rate it?"],
  },
];

export interface RateCard {
  level: number;
  badge: string;
  big: string; // "12 episodes · 4.6 h"
  lines: [string, string];
  alreadyRated: boolean; // offer "✓ already rated" (they clicked "rate it" before)
}

function pick<T>(pool: T[], random: () => number): T {
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

function hours(seconds: number): string {
  const h = seconds / 3600;
  return h < 10 ? h.toFixed(1) : Math.round(h).toString();
}

export function cardFor(s: RateState, level: number, random: () => number = Math.random): RateCard {
  const copy = COPY[Math.max(1, Math.min(level, COPY.length)) - 1];
  const days = s.seconds / 86400;
  const usable = copy.first.filter((l) => !(s.returning && l === FIRST_IMPRESSIONS) && !(l.includes('{days}') && days < 1));
  const first = pick(usable, random)
    .replace('{seasons}', Math.max(1, Math.round(s.episodes / 12)).toString())
    .replace('{days}', days.toFixed(1));
  return {
    level,
    badge: pick(copy.badges, random),
    big: `${s.episodes} episode${s.episodes === 1 ? '' : 's'} · ${hours(s.seconds)} h`,
    lines: [first, pick(copy.second, random)],
    alreadyRated: s.clicked,
  };
}

// --- storage (background is the only writer) ---------------------------------------
export async function loadRate(): Promise<RateState> {
  return normalizeRate((await chrome.storage.local.get(RATE_KEY))[RATE_KEY]);
}

let rateChain: Promise<unknown> = Promise.resolve();

/** Background: apply a change to the stored counts; queued so reports from many tabs don't race. */
export function updateRate(change: (s: RateState) => RateState): Promise<void> {
  const run = rateChain.then(async () => {
    const next = change(await loadRate());
    await chrome.storage.local.set({ [RATE_KEY]: next });
  });
  rateChain = run.catch(() => {});
  return run;
}

/** Background, on update: users who had the extension before counting started skip "first impressions?". */
export async function markReturning(): Promise<void> {
  const has = RATE_KEY in (await chrome.storage.local.get(RATE_KEY));
  if (!has) await updateRate((s) => ({ ...s, returning: true }));
}

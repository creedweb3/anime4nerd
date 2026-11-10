// Manga mode (local prototype): which sites it is switched on for. Kept apart from manga.ts so
// the popup can read and flip it without bundling the page-processing code.

const KEY = 'a4k-manga';
/**
 * Version of the status the page script sends the popup. The popup always runs the newest code,
 * but a tab opened before an extension update still runs the old page script until it reloads;
 * a mismatch tells the popup to ask for a reload instead of misreading the reply.
 */
export const MANGA_PROTOCOL = 3;
export type MangaSites = Record<string, true>;

export async function loadMangaSites(): Promise<MangaSites> {
  const got = await chrome.storage.local.get(KEY);
  const v = got[KEY];
  return v && typeof v === 'object' ? v as MangaSites : {};
}

/** Switches several hosts in one write (one read-modify-write, so none is lost). */
export async function setMangaSites(hosts: string[], on: boolean): Promise<void> {
  const next: MangaSites = { ...await loadMangaSites() };
  for (const h of hosts) { if (on) next[h] = true; else delete next[h]; }
  await chrome.storage.local.set({ [KEY]: next });
}

export function onMangaSitesChanged(cb: (s: MangaSites) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEY in changes) cb((changes[KEY].newValue ?? {}) as MangaSites);
  });
}

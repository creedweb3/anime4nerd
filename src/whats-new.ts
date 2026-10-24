// "What's new" notice after an update. Chrome installs store updates silently, so the
// background marks the new version and shows a NEW badge; the next popup open shows a
// one-line banner linking to the release notes and clears both. No network requests:
// the site only opens if the user clicks the link.

const KEY = 'anime4k-whats-new';
export const WHATS_NEW_URL = 'https://anime4nerd.pages.dev/#changes';

function showBadge(): Promise<void> {
  return Promise.all([
    chrome.action.setBadgeText({ text: 'NEW' }),
    // Same monochrome as the popup (--fg on --bg).
    chrome.action.setBadgeBackgroundColor({ color: '#e4e4e4' }),
    chrome.action.setBadgeTextColor({ color: '#0b0b0b' }),
  ]).then(() => {});
}

/** Background: remember that this version is new to the user and badge the toolbar icon. */
export async function markUpdated(version: string): Promise<void> {
  await chrome.storage.local.set({ [KEY]: version });
  await showBadge();
}

/** Background: the badge does not survive a browser restart, so re-show it while unseen. */
export async function restoreBadge(): Promise<void> {
  if (await pendingWhatsNew()) await showBadge();
}

/** Version the user has not seen the notice for yet, or null. */
export async function pendingWhatsNew(): Promise<string | null> {
  const v = (await chrome.storage.local.get(KEY))[KEY];
  return typeof v === 'string' ? v : null;
}

/** Popup: the notice was shown; clear the flag and the badge. */
export async function clearWhatsNew(): Promise<void> {
  await chrome.storage.local.remove(KEY);
  await chrome.action.setBadgeText({ text: '' });
}

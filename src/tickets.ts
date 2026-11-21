// Report tickets, extension side. A report sent from the site hands out a ticket code that the
// site keeps in its own localStorage ("a4n-tickets", see site/assets/tickets.js). While the site
// is open, the content script notes only whether that list is empty, so the popup's report icon
// can open the tickets page instead of a new report. The codes themselves stay on the site, and
// the extension makes no network request for this: replies are counted on the site only.
import { SITE } from './site-links';

const SITE_KEY = 'a4n-tickets';
const KEY = 'a4n-has-tickets';
// The site fires this on its document whenever its list of codes changes.
const CHANGED_EVENT = 'a4n-tickets';
const CODE = /^A4N-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

export const TICKETS_URL = `${SITE}/tickets`;

export async function hasTickets(): Promise<boolean> {
  return (await chrome.storage.local.get(KEY))[KEY] === true;
}

function siteHasTickets(): boolean {
  try {
    const v = JSON.parse(localStorage.getItem(SITE_KEY) ?? '[]');
    return Array.isArray(v) && v.some((c) => typeof c === 'string' && CODE.test(c));
  } catch {
    return false;
  }
}

/** Content script, top frame of the site only: keeps the flag in step with the site's list. */
export function syncTicketsFromSite(): void {
  if (location.origin !== SITE || window.top !== window) return;
  const save = () => chrome.storage.local.set({ [KEY]: siteHasTickets() }).catch(() => {});
  save();
  document.addEventListener(CHANGED_EVENT, save);
}

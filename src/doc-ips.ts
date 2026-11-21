// Manga mode: which address each document came from (see fetchImage in background.ts). A frame
// key is `${tabId}:${frameId}`; a document key is `${tabId}:${documentId}`.
//
// The address comes from the response (webRequest), the document from the commit (webNavigation).
// Chrome sends the response first; Firefox may send the commit first, so whichever comes second
// files the address. A navigation that never replaces the document (a 204, a redirect, a
// download) must not change what its frame may read, and nothing an earlier navigation left may
// be filed under the document a later one commits.

export interface FiledIp { doc: string; ip: string }

/** Statuses that never commit a document. */
const noDocument = (status: number) => status === 204 || status === 205 || (status >= 300 && status < 400);
const sansHash = (url: string) => url.split('#')[0];

export class DocIps {
  private readonly responses = new Map<string, { url: string; ip?: string }>();
  private readonly commits = new Map<string, { url: string; doc: string }>();

  /** A new navigation starts in the frame: drop what earlier ones left. */
  beforeNavigate(frame: string): void {
    this.responses.delete(frame);
    this.commits.delete(frame);
  }

  /** A navigation response; returns the address to file if its document has already committed. */
  response(frame: string, rawUrl: string, status: number, ip: string | undefined): FiledIp | null {
    if (noDocument(status)) { this.responses.delete(frame); return null; }
    const url = sansHash(rawUrl);
    const commit = this.commits.get(frame);
    if (commit?.url !== url) { this.responses.set(frame, { url, ip }); return null; }
    this.commits.delete(frame);
    return ip ? { doc: commit.doc, ip } : null;
  }

  /** A document committed; returns the address to file now, if its response came first. */
  commit(frame: string, rawUrl: string, doc: string): string | undefined {
    const url = sansHash(rawUrl);
    const seen = this.responses.get(frame);
    this.responses.delete(frame);
    if (seen?.url === url) { this.commits.delete(frame); return seen.ip; }
    if (/^https?:/.test(url)) this.commits.set(frame, { url, doc }); // its response may still be on the way
    else this.commits.delete(frame);
    return undefined;
  }

  forgetTab(tabId: number): void {
    for (const m of [this.responses, this.commits]) for (const k of [...m.keys()]) if (k.startsWith(`${tabId}:`)) m.delete(k);
  }
}

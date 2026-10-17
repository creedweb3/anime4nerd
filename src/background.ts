// Service worker.
//
// Content scripts declared in the manifest only reach pages loaded after the extension is
// installed or updated. On install/update, inject into every frame of already-open tabs so the
// user does not have to reload. Frames are injected one at a time: a single allFrames call fails
// as a whole if any one frame (chrome://, the web store, a PDF viewer) refuses scripts.
// The content script guards against running twice.

async function injectTab(tabId: number): Promise<void> {
  let frames: { frameId: number }[] = [];
  try { frames = (await chrome.webNavigation.getAllFrames({ tabId })) ?? []; } catch { return; }
  for (const f of frames) {
    const target = { tabId, frameIds: [f.frameId] };
    await chrome.scripting.insertCSS({ target, files: ['content.css'] }).catch(() => {});
    await chrome.scripting.executeScript({ target, files: ['content.js'] }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  await Promise.allSettled(tabs.map((t) => (t.id ? injectTab(t.id) : Promise.resolve())));
});

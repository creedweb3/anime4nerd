/**
 * Size of the pixels the browser actually uploads for the video's current frame,
 * or null when no frame can be read (none decoded yet, mid-seek, CORS-tainted video,
 * no WebCodecs). For anamorphic (non-square-pixel) or cropped streams this differs
 * from videoWidth/videoHeight, which are the display size (e.g. a 704x480 DVD frame
 * shown as 704x528).
 */
export function decodedSize(video: HTMLVideoElement): { w: number; h: number } | null {
  try {
    const f = new VideoFrame(video);
    const w = f.visibleRect?.width ?? f.displayWidth;
    const h = f.visibleRect?.height ?? f.displayHeight;
    // visibleRect is before rotation, but the upload is in display orientation.
    // Older browsers lack VideoFrame.rotation; then infer it from videoWidth/videoHeight.
    const rotation = (f as VideoFrame & { rotation?: number }).rotation;
    f.close();
    const quarterTurn = rotation !== undefined
      ? rotation % 180 === 90
      : (video.videoWidth > video.videoHeight) !== (w > h) && video.videoWidth !== video.videoHeight;
    if (w && h) return quarterTurn ? { w: h, h: w } : { w, h };
  } catch {
    // No readable frame: callers decide whether to fall back.
  }
  return null;
}

/** decodedSize, falling back to the element's display size. */
export function uploadSize(video: HTMLVideoElement): { w: number; h: number } {
  return decodedSize(video) ?? { w: video.videoWidth, h: video.videoHeight };
}

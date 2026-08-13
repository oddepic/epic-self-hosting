export interface ReanchorOptions {
  startSeconds: number;
  currentTime: number;
  duration: number | null;
}

/**
 * Decide whether the video element must be re-anchored to a resume position
 * once playback has actually started.
 *
 * Jellyfin's own web client (`seekOnPlaybackStart`) re-seeks the element to the
 * resume position after the first `playing` event, on top of hls.js's
 * `startPosition` config. Without that second seek, a mid-stream start on a
 * `-copyts` transcode can leave the audio/video buffers misaligned (subs appear
 * early vs audio). Returns the target time to seek to, or `null` when no
 * re-anchor is needed (no resume or media not ready yet).
 *
 * NOTE: we deliberately re-anchor even when `currentTime` is already at the
 * resume position. hls.js's `startPosition` commonly lands the element clock on
 * the target while the audio/video buffers are still misaligned; the caller
 * must turn this into a real seek (see `use-player-engine`), so returning the
 * target here is correct in every resume case.
 */
export function reanchorTarget({
  startSeconds,
  currentTime,
  duration,
}: ReanchorOptions): number | null {
  if (startSeconds <= 0) return null;
  if (duration == null || !Number.isFinite(duration) || duration <= 0) return null;
  if (!Number.isFinite(currentTime)) return null;
  return Math.min(startSeconds, duration);
}

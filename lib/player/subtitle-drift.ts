/**
 * Subtitle drift compensation for Jellyfin HLS transcodes.
 *
 * Jellyfin's HLS segmenter (`-codec:a copy -copyts`, 3.003s segments) cannot
 * cut the copied AAC stream on frame boundaries, so the audio *content* is
 * placed progressively EARLIER in the stream relative to its PTS (which stays
 * video-aligned) at ~0.23–0.28% of playback position. External ASS subtitles
 * are content-timed, so JASSUB shows the line for content T at clock T, while
 * that line's audio is heard at clock T + drift → subtitles appear early.
 *
 * Since the audio/video buffers cannot be repaired client-side, we compensate
 * the subtitle clock: render each subtitle LATER by `rate × position` so the
 * text tracks the audio. The video element's clock stays untouched.
 *
 * JASSUB renders at `mediaTime + timeOffset`, so to delay a subtitle we must
 * pass a NEGATIVE timeOffset.
 */

/** Drift rate per second of playback position (calibrated 2026-08-12: browser
 *  audio-vs-source cross-correlation gave 0.00226 at 620s; direct transcode
 *  audio-vs-source correlation gave 0.00283 at 600s). */
export const SUBTITLE_DRIFT_RATE_PER_SECOND = 0.0026;

/**
 * NEGATIVE offset (seconds) to ADD to JASSUB's clock at the given playback
 * position, so subtitles render later and track the drifted audio.
 */
export function subtitleDriftOffsetSeconds(
  positionSeconds: number,
  ratePerSecond: number = SUBTITLE_DRIFT_RATE_PER_SECOND,
): number {
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return 0;
  return -(ratePerSecond * positionSeconds);
}

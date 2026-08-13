/**
 * Subtitle drift compensation for Jellyfin HLS transcodes.
 *
 * Jellyfin's HLS segmenter (`-codec:a copy -copyts`, 3.003s segments) cannot
 * cut the copied AAC stream on frame boundaries, so the audio *content*
 * drifts progressively EARLIER relative to its PTS labels (which stay
 * video-aligned) at ~0.23–0.28% of playback position. External ASS subtitles
 * are content-timed, so they render progressively early vs the audio.
 *
 * Since the audio/video buffers cannot be repaired client-side, we compensate
 * the subtitle clock: delay subtitle rendering by `rate × position` so the
 * text tracks the audio. The video element's clock stays untouched.
 */

/** Drift rate per second of playback position (calibrated 2026-08-12: browser
 *  audio-vs-source cross-correlation gave 0.00226 at 620s; direct transcode
 *  audio-vs-source correlation gave 0.00283 at 600s). */
export const SUBTITLE_DRIFT_RATE_PER_SECOND = 0.0026;

/**
 * Positive offset (seconds) to ADD to the subtitle clock at the given
 * playback position, so subtitles render later and track the drifted audio.
 */
export function subtitleDriftOffsetSeconds(
  positionSeconds: number,
  ratePerSecond: number = SUBTITLE_DRIFT_RATE_PER_SECOND,
): number {
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return 0;
  return ratePerSecond * positionSeconds;
}

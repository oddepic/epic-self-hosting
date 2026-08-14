// Jellyfin's HLS playlist advertises a uniform 3.003s per segment while ffmpeg
// emits occasional 71-frame (2.961s) segments, so the browser's playback clock
// runs ~0.1% fast and subtitles drift progressively early (Jellyfin #16730).
// Rate = 0.042s of drift per 14 segments ≈ 0.001s per second of playback.
export const SUBTITLE_DRIFT_RATE_PER_SECOND = 0.001;

// NEGATIVE offset (seconds) to add to JASSUB's clock at the given playback
// position, so subtitles render later and track the audio.
export function subtitleDriftOffsetSeconds(
  positionSeconds: number,
  ratePerSecond: number = SUBTITLE_DRIFT_RATE_PER_SECOND,
): number {
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return 0;
  return -(ratePerSecond * positionSeconds);
}

export const PROGRESS_CADENCE_MS = 15_000;

export const WATCHED_THRESHOLD = 0.95;

export function ticksFromSeconds(seconds: number): number {
  return Math.floor(seconds * 10_000_000);
}

export function secondsFromTicks(ticks: number): number {
  return ticks / 10_000_000;
}

export function shouldSaveNow(
  lastSaveAtMs: number,
  nowMs: number,
  cadenceMs: number = PROGRESS_CADENCE_MS,
): boolean {
  return nowMs - lastSaveAtMs >= cadenceMs;
}

export function isPastWatchedThreshold(
  positionSeconds: number,
  durationSeconds: number | null,
): boolean {
  if (durationSeconds == null || durationSeconds <= 0) return false;
  return positionSeconds / durationSeconds >= WATCHED_THRESHOLD;
}

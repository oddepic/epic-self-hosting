export interface SkipSegment {
  start: number;
  end: number;
}

export interface SkipSegments {
  intro: SkipSegment | null;
  credits: SkipSegment | null;
}

// Which skip button (if any) should be visible at a given playhead position.
// Intro takes precedence if the windows somehow overlap; credits is the ending.
export function activeSkipSegment(
  segments: SkipSegments | null | undefined,
  positionSeconds: number,
): { kind: "intro" | "credits"; end: number } | null {
  if (!segments) return null;
  if (
    segments.intro &&
    positionSeconds >= segments.intro.start &&
    positionSeconds < segments.intro.end
  ) {
    return { kind: "intro", end: segments.intro.end };
  }
  if (
    segments.credits &&
    positionSeconds >= segments.credits.start &&
    positionSeconds < segments.credits.end
  ) {
    return { kind: "credits", end: segments.credits.end };
  }
  return null;
}

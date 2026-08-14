import { describe, it, expect } from "vitest";
import { subtitleDriftOffsetSeconds, SUBTITLE_DRIFT_RATE_PER_SECOND } from "./subtitle-drift";

describe("subtitleDriftOffsetSeconds", () => {
  it("returns a negative offset that grows with position", () => {
    expect(subtitleDriftOffsetSeconds(600)).toBeCloseTo(-0.6, 6);
  });

  it("returns zero at the start of playback", () => {
    expect(subtitleDriftOffsetSeconds(0)).toBe(0);
  });

  it("returns zero for non-positive positions", () => {
    expect(subtitleDriftOffsetSeconds(-10)).toBe(0);
  });

  it("returns zero for non-finite positions", () => {
    expect(subtitleDriftOffsetSeconds(Number.NaN)).toBe(0);
    expect(subtitleDriftOffsetSeconds(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("scales with the configured rate", () => {
    expect(subtitleDriftOffsetSeconds(1000, 0.002)).toBeCloseTo(-2, 6);
  });

  it("uses the Jellyfin #16730 rate by default", () => {
    expect(SUBTITLE_DRIFT_RATE_PER_SECOND).toBe(0.001);
  });
});

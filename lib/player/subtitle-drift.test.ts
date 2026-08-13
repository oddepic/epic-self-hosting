import { describe, it, expect } from "vitest";
import { subtitleDriftOffsetSeconds, SUBTITLE_DRIFT_RATE_PER_SECOND } from "./subtitle-drift";

describe("subtitleDriftOffsetSeconds", () => {
  it("returns 0 at position 0", () => {
    expect(subtitleDriftOffsetSeconds(0)).toBe(0);
  });

  it("returns 0 for non-finite or non-positive positions", () => {
    expect(subtitleDriftOffsetSeconds(NaN)).toBe(0);
    expect(subtitleDriftOffsetSeconds(-5)).toBe(0);
    expect(subtitleDriftOffsetSeconds(Infinity)).toBe(0);
  });

  it("grows linearly with position", () => {
    expect(subtitleDriftOffsetSeconds(100)).toBeCloseTo(0.26, 6);
    expect(subtitleDriftOffsetSeconds(600)).toBeCloseTo(1.56, 6);
  });

  it("matches the calibrated rate at the measured points", () => {
    // Measured 2026-08-12: audio lags ~1.40s at 620s (browser ref) and
    // transcode content shift ~1.70s at 600s (direct segment decode).
    expect(subtitleDriftOffsetSeconds(620)).toBeCloseTo(1.612, 3);
    expect(subtitleDriftOffsetSeconds(600)).toBeCloseTo(1.56, 3);
  });

  it("honors a custom rate", () => {
    expect(subtitleDriftOffsetSeconds(100, 0.01)).toBeCloseTo(1, 6);
  });

  it("exposes the default rate", () => {
    expect(SUBTITLE_DRIFT_RATE_PER_SECOND).toBeGreaterThan(0.002);
    expect(SUBTITLE_DRIFT_RATE_PER_SECOND).toBeLessThan(0.003);
  });
});

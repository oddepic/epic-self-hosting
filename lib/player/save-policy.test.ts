import { describe, it, expect } from "vitest";
import {
  ticksFromSeconds,
  secondsFromTicks,
  shouldSaveNow,
  isPastWatchedThreshold,
  PROGRESS_CADENCE_MS,
} from "./save-policy";

describe("save-policy", () => {
  describe("tick conversions", () => {
    it("converts seconds to Jellyfin ticks (10MHz)", () => {
      expect(ticksFromSeconds(0)).toBe(0);
      expect(ticksFromSeconds(1)).toBe(10_000_000);
      expect(ticksFromSeconds(1220.5)).toBe(12_205_000_000);
    });

    it("converts ticks back to seconds", () => {
      expect(secondsFromTicks(0)).toBe(0);
      expect(secondsFromTicks(12_200_000_000)).toBe(1220);
    });

    it("round-trips position values", () => {
      expect(secondsFromTicks(ticksFromSeconds(947))).toBe(947);
    });
  });

  describe("shouldSaveNow", () => {
    it("returns false before the cadence elapses", () => {
      expect(shouldSaveNow(0, PROGRESS_CADENCE_MS - 1)).toBe(false);
    });

    it("returns true exactly at the cadence", () => {
      expect(shouldSaveNow(0, PROGRESS_CADENCE_MS)).toBe(true);
    });

    it("returns true after the cadence", () => {
      expect(shouldSaveNow(0, PROGRESS_CADENCE_MS + 5000)).toBe(true);
    });

    it("honours an explicit cadence", () => {
      expect(shouldSaveNow(0, 1500, 2000)).toBe(false);
      expect(shouldSaveNow(0, 2000, 2000)).toBe(true);
    });
  });

  describe("isPastWatchedThreshold", () => {
    it("is false at the start", () => {
      expect(isPastWatchedThreshold(0, 1440)).toBe(false);
    });

    it("is false below 95%", () => {
      expect(isPastWatchedThreshold(1300, 1440)).toBe(false);
    });

    it("is true at exactly 95%", () => {
      expect(isPastWatchedThreshold(1368, 1440)).toBe(true);
    });

    it("is true past 95% and at duration", () => {
      expect(isPastWatchedThreshold(1439, 1440)).toBe(true);
      expect(isPastWatchedThreshold(1440, 1440)).toBe(true);
    });

    it("is false when duration is unknown", () => {
      expect(isPastWatchedThreshold(1440, null)).toBe(false);
      expect(isPastWatchedThreshold(1440, 0)).toBe(false);
    });
  });
});

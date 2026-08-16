import { describe, it, expect } from "vitest";
import { activeSkipSegment } from "./skip-segments";

const segments = {
  intro: { start: 28, end: 119.04 },
  credits: { start: 1420, end: 1514.99 },
};

describe("activeSkipSegment", () => {
  it("returns the intro segment while the playhead is inside the intro window", () => {
    expect(activeSkipSegment(segments, 28)).toEqual({ kind: "intro", end: 119.04 });
    expect(activeSkipSegment(segments, 100)).toEqual({ kind: "intro", end: 119.04 });
  });

  it("returns the credits segment while the playhead is inside the credits window", () => {
    expect(activeSkipSegment(segments, 1420)).toEqual({ kind: "credits", end: 1514.99 });
    expect(activeSkipSegment(segments, 1500)).toEqual({ kind: "credits", end: 1514.99 });
  });

  it("is null outside every window", () => {
    expect(activeSkipSegment(segments, 0)).toBeNull();
    expect(activeSkipSegment(segments, 119.04)).toBeNull();
    expect(activeSkipSegment(segments, 500)).toBeNull();
    expect(activeSkipSegment(segments, 1514.99)).toBeNull();
  });

  it("is null when the episode has no segments", () => {
    expect(activeSkipSegment(null, 100)).toBeNull();
    expect(activeSkipSegment({ intro: null, credits: null }, 100)).toBeNull();
    expect(activeSkipSegment({ intro: null, credits: { start: 1420, end: 1514.99 } }, 100)).toBeNull();
  });
});

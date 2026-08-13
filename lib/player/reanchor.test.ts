import { describe, it, expect } from "vitest";
import { reanchorTarget } from "./reanchor";

describe("reanchorTarget", () => {
  it("returns null when there is no resume position", () => {
    expect(reanchorTarget({ startSeconds: 0, currentTime: 5, duration: 100 })).toBeNull();
    expect(reanchorTarget({ startSeconds: -1, currentTime: 5, duration: 100 })).toBeNull();
  });

  it("returns null when the media duration is not ready", () => {
    expect(reanchorTarget({ startSeconds: 60, currentTime: 0, duration: null })).toBeNull();
    expect(reanchorTarget({ startSeconds: 60, currentTime: 0, duration: NaN })).toBeNull();
    expect(reanchorTarget({ startSeconds: 60, currentTime: 0, duration: 0 })).toBeNull();
  });

  it("returns null when currentTime is not a number yet", () => {
    expect(reanchorTarget({ startSeconds: 60, currentTime: NaN, duration: 100 })).toBeNull();
  });

  it("returns the resume position when playback is far from it", () => {
    expect(reanchorTarget({ startSeconds: 782, currentTime: 0, duration: 1470 })).toBe(782);
    expect(reanchorTarget({ startSeconds: 782, currentTime: 5, duration: 1470 })).toBe(782);
  });

  it("returns the resume position even when the element clock already reads it", () => {
    // hls.js `startPosition` commonly lands currentTime on the resume position
    // while the A/V buffers are still misaligned — re-anchoring must still
    // return a target so the caller can force a real re-seek.
    expect(reanchorTarget({ startSeconds: 782, currentTime: 782, duration: 1470 })).toBe(782);
    expect(reanchorTarget({ startSeconds: 782, currentTime: 782.3, duration: 1470 })).toBe(782);
  });

  it("returns the resume position even when currentTime is just off it", () => {
    expect(reanchorTarget({ startSeconds: 782, currentTime: 781, duration: 1470 })).toBe(782);
    expect(reanchorTarget({ startSeconds: 782, currentTime: 783, duration: 1470 })).toBe(782);
  });

  it("clamps the target to the duration", () => {
    expect(reanchorTarget({ startSeconds: 1500, currentTime: 0, duration: 1470 })).toBe(1470);
  });
});
